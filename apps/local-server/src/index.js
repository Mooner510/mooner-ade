import http from 'node:http';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createLocalRuntime, LocalProcesses } from './runtime.js';
import { codexAuthenticated } from './agents.js';
import { fault, text, readText, serial } from './files.js';
import { validateUi, validateAppState, validAgentArgs } from './ui-state.js';
import { discoverRepositories } from './repositories.js';
import { connectPtyHost } from './pty-client.js';
import { runningCommands, terminalProcesses } from './terminal-processes.js';
import { createProcessTable } from './process-table.js';
import { uploadOverSsh } from './ssh-upload.js';
import { createRemoteAgent } from './remote-agent.js';
import { createRemoteClaude, parseRemote, remoteScript, runRemote } from './remote-claude.js';
import { createTerminalStatus } from './terminal-status.js';
import { createTerminalBuffer } from './terminal-buffer.js';
import { createTerminalSize, typedInput, validSize } from './terminal-size.js';
import { watchProjectFiles } from './project-watch.js';
import { chatMcpServers, deniedMcpTools, seedTerminalSession, setAgentMcpServers, syncClaudeSession, terminalAgentCommand, terminalSessionShell } from './terminal-sessions.js';
import { listCliSessions, importCliSession, defaultClaudeDir } from './cli-sessions.js';
import { readSessionStats, sessionFiles } from './chat-stats.js';
import { openChatSession, listChatSessions, listCommands, seedChat, seedFromTranscript, resolveModels, probeInit, probeAgentModels, readModelCatalog, fetchApiModelCatalog } from './chat.js';
import { spawnAgent } from './agent-spawn.js';
import { readClaudeCache, transcriptOf } from './claude-cache.js';
import { UI_FRAME_CSP, UI_FRAME_HTML } from './ui-frame.js';
import { UI_PROMPT } from './chat-ui-prompt.js';
import { claudeBusy } from './claude-busy.js';
import { createWakaTime, PULSE } from './wakatime.js';
import { createAgentKeys } from './agent-keys.js';
import { createAccountResolver, createUsage } from './usage.js';
import { detectShells, resolveShell, checkAgents } from './shells.js';
import { chooseFolder } from './folder-dialog.js';
import { createFeedbackStore } from './feedback-store.js';
import { runFeedbackDraft, FEEDBACK_MODELS, FEEDBACK_EFFORTS } from './feedback-agent.js';
import { createFeedbackQueue } from './feedback-queue.js';
import { DEFAULT_HUB_URL, anonymousDeviceId, postAnonymousFeedback } from './feedback-hub.js';

const dataRoot = process.env.ADE_DATA_DIR || path.join(process.platform === 'win32' ? process.env.LOCALAPPDATA || os.homedir() : path.join(os.homedir(), 'Library', 'Application Support'), 'mooner-ade');
const webRoot = path.resolve(import.meta.dirname, '../../web/dist');
// ADE_DEV=1 serves the web UI through an in-process Vite dev server (same origin, so cookie auth keeps working) instead of web/dist.
const devWeb = process.env.ADE_DEV === '1', devTokenEnv = process.env.ADE_DEV_TOKEN ?? ''; // read here: both are removed from the environment below
let vite = null;
// HMR rides on the HTTP server so a leftover dev server from a crashed app cannot block the next run on a fixed port.
async function startVite(httpServer) {
  if (!devWeb) return;
  const webDir = path.resolve(import.meta.dirname, '../../web');
  const { createServer } = await import(pathToFileURL(createRequire(path.join(webDir, 'package.json')).resolve('vite')).href);
  // A crashing MSYS tool (Git Bash) drops a locked <tool>.exe.stackdump into its working directory; watching it fails with EBUSY.
  vite = await createServer({ root: webDir, appType: 'spa', server: { middlewareMode: true, hmr: { server: httpServer }, watch: { ignored: ['**/*.stackdump'] } } });
  // Vite leaves its file watcher's 'error' event unhandled, so one unwatchable file would take down the whole server.
  vite.watcher.on('error', error => console.warn(`Vite 파일 감시 오류 (${error.code || 'WATCH_FAILED'}): ${error.path || error.message}`));
}
// pnpm can install node-pty's prebuilt spawn-helper without the executable bit, which makes every spawn fail (posix_spawnp).
if (process.platform !== 'win32') {
  try {
    const helper = path.join(path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    await fs.chmod(helper, 0o755);
  } catch { /* no prebuilt helper (source build) or node-pty missing; the readiness check reports it */ }
}
// With ADE_PTY_ENDPOINT (set by the app) terminals live in the pty-host process, so they outlive this server and an app update restart.
const ptyHost = process.env.ADE_PTY_ENDPOINT ? await connectPtyHost({ endpoint: process.env.ADE_PTY_ENDPOINT, token: process.env.ADE_PTY_TOKEN }).catch(error => { console.error(`pty-host 연결 실패, 서버 내부 PTY를 사용합니다: ${error.message}`); return null; }) : null;
// Another server took the host over, or the host ended: terminals opened from now on cannot be kept through a restart.
let ptyHostLost = false;
ptyHost?.onClose(() => { ptyHostLost = true; });
// Terminals inherit process.env: a server started from one (e.g. a test run) would otherwise take over the pty-host and orphan every live terminal.
// ADE_DEV likewise: an app launched from such a terminal would start in dev mode and look for Vite.
delete process.env.ADE_PTY_ENDPOINT; delete process.env.ADE_PTY_TOKEN; delete process.env.ADE_DEV; delete process.env.ADE_DEV_TOKEN;
// Same for Claude Code's session markers: an app launched from a Claude session would make every `claude` in its terminals a "child session" (no transcripts).
for (const name of ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']) delete process.env[name];
const localPty = ptyHost ? null : await import('node-pty').catch(() => null);
// A host that went away mid-run: new terminals open in this process instead (they are then not kept through a restart).
let fallbackPty = null;
const pty = ptyHost
  ? { spawn: async (...args) => ptyHostLost ? (fallbackPty ??= await import('node-pty')).spawn(...args) : ptyHost.factory.spawn(...args) }
  : localPty;
const ptyFactory = pty || { spawn() { throw fault('PTY_UNAVAILABLE', 'node-pty 설치 또는 네이티브 빌드를 확인하세요.'); } };
await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
const projects = new Map();
// The feedback inbox (feedback-store.js). Every screen is told when an item changes and fetches the list again.
const feedback = createFeedbackStore({ root: path.join(dataRoot, 'feedback'), onChange: id => { for (const socket of clients) send(socket, { type: 'feedback/changed', ...(id && { id }) }); } });
const feedbackIncoming = feedback.incomingDir;
await fs.mkdir(feedbackIncoming, { recursive: true, mode: 0o700 });
// Whether a plugin can submit for a signed-in account (pushed by the app as `feedback/status`). Without one, feedback goes to
// the Hub anonymously (feedback-hub.js), unless ADE_FEEDBACK_ANONYMOUS=0.
let pluginFeedback = { ok: false };
const feedbackAnonymous = process.env.ADE_FEEDBACK_ANONYMOUS !== '0', feedbackHubUrl = process.env.ADE_HUB_URL || DEFAULT_HUB_URL;
const feedbackAvailability = () => pluginFeedback.ok ? { ok: true, mode: 'account', ...(pluginFeedback.account && { account: pluginFeedback.account }) }
  : feedbackAnonymous ? { ok: true, mode: 'anonymous' }
  : { ok: false, reason: pluginFeedback.reason || '원격 접속 플러그인을 설치하고 로그인하면 피드백을 제출할 수 있습니다.' };
const feedbackRequests = new Map(); // id -> resolve, answers to `feedback/submit` sent to the app
let feedbackRequestId = 0;
function submitThroughApp(meta, images) {
  if (!process.connected) return Promise.resolve({ ok: false, error: { code: 'FEEDBACK_UNAVAILABLE', message: 'MoonerADE 앱이 아니어서 계정으로 제출할 수 없습니다.' } });
  const id = ++feedbackRequestId;
  return new Promise(resolve => {
    // A little longer than the app's own wait for the plugin, so its answer (even a timeout) arrives first.
    const timer = setTimeout(() => { feedbackRequests.delete(id); resolve({ ok: false, error: { code: 'FEEDBACK_TIMEOUT', message: '앱이 제출 결과를 알려 주지 않았습니다. 잠시 뒤 다시 제출하세요.' } }); }, 130_000);
    timer.unref();
    feedbackRequests.set(id, value => { clearTimeout(timer); resolve(value); });
    process.send({ type: 'feedback/submit', id, meta, images }, error => { if (error) feedbackRequests.get(id)?.({ ok: false, error: { code: 'FEEDBACK_UNAVAILABLE', message: error.message } }); });
  });
}
const feedbackRunning = new Set(); // ids with an AI draft in flight in this process
let feedbackDevice = null;
// "제출" puts the item in the persistent queue (feedback-queue.js), which sends it when it can: through the signed-in plugin,
// or anonymously at most once per 5 minutes. The item id is the Hub's idempotency key, so a resend never doubles an issue.
const feedbackQueue = createFeedbackQueue({
  store: feedback, stateFile: path.join(feedback.root, 'queue.json'), availability: feedbackAvailability,
  metaOf: item => ({ clientKey: item.id, title: item.title, body: item.body, source: item.source, appVersion, platform: `${process.platform}-${process.arch}` }),
  sendAccount: submitThroughApp,
  sendAnonymous: async (meta, images) => postAnonymousFeedback({ hubUrl: feedbackHubUrl, deviceId: feedbackDevice ??= await anonymousDeviceId(feedback.root), meta, images })
});
async function feedbackSubmit(id) {
  if (feedbackRunning.has(id)) throw fault('FEEDBACK_LOCKED', '이미 처리 중입니다.', 409);
  const item = await feedback.get(id);
  if (!item.body.trim()) throw fault('INVALID_INPUT', '내용을 쓴 뒤 제출하세요.');
  // No title written: the first line of the text becomes it.
  if (!item.title.trim()) await feedback.update(id, { title: item.body.split('\n').map(line => line.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '' });
  if (item.source !== 'human' && !item.reviewed) throw fault('FEEDBACK_UNREVIEWED', 'AI가 쓴 초안은 직접 확인한 뒤에 제출할 수 있습니다.', 409);
  const available = feedbackAvailability();
  if (!available.ok) throw fault('FEEDBACK_UNAVAILABLE', available.reason || '지금은 피드백을 제출할 수 없습니다.', 503);
  return feedbackQueue.enqueue(id);
}
async function feedbackAiDraft(id, input) {
  if (feedbackRunning.has(id)) throw fault('FEEDBACK_LOCKED', '이미 처리 중입니다.', 409);
  const note = typeof input.note === 'string' ? input.note.slice(0, 4000) : '', context = typeof input.context === 'string' ? input.context.slice(0, 8000) : '';
  feedbackRunning.add(id);
  let previous;
  try {
    const item = await feedback.get(id);
    previous = item.status;
    await feedback.setStatus(id, 'drafting', { error: undefined }, { from: ['draft', 'review', 'failed'] });
    const draft = await runFeedbackDraft({ cwd: feedback.folder(id), images: feedback.imagesOf(item).map(image => image.path), model: { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }[input.model] ?? (FEEDBACK_MODELS.includes(input.model) ? input.model : 'claude-haiku-5-5'), effort: FEEDBACK_EFFORTS.includes(input.effort) ? input.effort : 'low', title: item.title, body: item.body, note, context, env: pluginEnv });
    return await feedback.setStatus(id, 'review', { title: draft.title || item.title, body: draft.body, source: 'ai', reviewed: false });
  } catch (error) {
    if (previous) await feedback.setStatus(id, previous === 'failed' ? 'draft' : previous, { error: `AI 정리 실패: ${error.message}` }).catch(() => {});
    throw error;
  } finally { feedbackRunning.delete(id); }
}
// Agents' drafts arrive as files; picked up when they appear (watchFeedback, once the server is up) and whenever the list is read.
let feedbackImport = Promise.resolve();
const importFeedback = () => (feedbackImport = feedbackImport.then(() => feedback.importIncoming()).catch(error => { console.warn(`피드백 초안을 가져오지 못했습니다: ${error.message}`); return []; }));
async function watchFeedback() {
  await feedback.recover().catch(error => console.warn(`피드백 상태를 복구하지 못했습니다: ${error.message}`));
  try {
    let importTimer = null;
    const watcher = fsSync.watch(feedbackIncoming, () => { clearTimeout(importTimer); importTimer = setTimeout(() => void importFeedback(), 300); });
    watcher.on('error', error => { watcher.close(); console.warn(`피드백 폴더 감시 오류: ${error.message}`); });
    watcher.unref();
  } catch (error) { console.warn(`피드백 폴더를 감시할 수 없습니다: ${error.message}`); }
  void importFeedback();
  feedbackQueue.kick();
}
// Opening and closing are serialized per project only, so restoring many projects at startup does not queue them behind each other.
const openings = new Map();
const opening = id => { if (!openings.has(id)) openings.set(id, serial()); return openings.get(id); };
const registryWrite = serial();
const clients = new Set();
const sessions = new Set();
// The app window exchanges this per-process token for a session cookie; it is never written to disk.
// ADE_DEV=1 with ADE_DEV_TOKEN (64 hex chars) keeps the URL and the browser's session valid across the restarts `node --watch` does; without it every start is new.
const devToken = devWeb && /^[0-9a-f]{64}$/.test(devTokenEnv) ? devTokenEnv : '';
const bootstrap = devToken || randomBytes(32).toString('hex');
const devSession = devToken ? createHash('sha256').update(`ade-dev-session:${devToken}`).digest('hex') : '';
if (devSession) sessions.add(devSession);
const bootstrapMatches = token => typeof token === 'string' && token.length === bootstrap.length && timingSafeEqual(Buffer.from(token), Buffer.from(bootstrap));
// Earlier versions kept a reusable token for browser access.
await fs.rm(path.join(dataRoot, 'token'), { force: true });
let origin;
const appVersion = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8').catch(() => '{}')).version || '0.0.0';
const wakatime = createWakaTime({ version: appVersion });
const agentKeys = createAgentKeys({ file: path.join(dataRoot, 'agent-keys.json') });
await agentKeys.load();
const accounts = createAccountResolver();
const usage = createUsage({ version: appVersion, account: accounts });
let activeProjectId = '', wakatimeBackground = true, terminalShell = '', feedbackAgentTool = true;
function applyAppState(state) {
  activeProjectId = state?.activeProjectId || '';
  if (feedbackAgentTool !== (state?.settings?.feedbackAgentTool !== false)) { feedbackAgentTool = !feedbackAgentTool; applyMcpServers(); }
  terminalShell = typeof state?.settings?.terminalShell === 'string' ? state.settings.terminalShell : '';
  wakatime.configure(state?.settings?.wakatime === true);
  wakatimeBackground = state?.settings?.wakatimeBackground !== false;
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function writeJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
  finally { await fs.unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function send(socket, value) {
  if (socket.readyState !== 1) return;
  if (socket.bufferedAmount > 4 * 1024 * 1024) return socket.close(1013, 'Reconnect to replay');
  socket.send(JSON.stringify(value));
}
// Every outbound message carries its project so a socket subscribed to several projects can route it.
function broadcast(project, value) { for (const socket of clients) if (socket.projects.has(project.id)) send(socket, { ...value, projectId: project.id }); }
const errorValue = error => ({ code: error.code || 'OPERATION_FAILED', message: error.message || '작업에 실패했습니다.' });

// A live pid alone does not prove ownership: Windows reuses pids quickly, so a crashed server's lock can name an unrelated process.
// Running servers refresh their locks' mtime; a lock left untouched past LOCK_STALE_MS is abandoned.
const LOCK_STALE_MS = 2 * 60 * 1000;
async function lock(directory) {
  const file = path.join(directory, 'server.lock');
  try { const handle = await fs.open(file, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await fs.readFile(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw fault('PROJECT_LOCKED', '프로젝트 잠금 파일을 확인하세요.', 409);
    try { process.kill(pid, 0); }
    catch (probe) {
      if (probe.code === 'ESRCH') { await fs.unlink(file); return lock(directory); }
      throw probe;
    }
    if (Date.now() - (await fs.stat(file)).mtimeMs > LOCK_STALE_MS) { await fs.unlink(file); return lock(directory); }
    throw fault('PROJECT_LOCKED', '이 저장소를 연 서버가 이미 실행 중입니다.', 409);
  }
  return file;
}

async function repoWorktree(project, repo) {
  const target = path.join(project.directory, 'worktrees', repo.id);
  const branch = `ade/repo-${repo.id}`;
  const trees = await repo.sourceRuntime.git.worktrees();
  try {
    await fs.realpath(target);
    if (trees.some(tree => path.resolve(tree.worktree) === path.resolve(target))) return { path: target, branch };
    throw fault('WORKTREE_PATH_CONFLICT', 'worktree 경로에 다른 폴더가 있습니다.', 409);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (trees.some(tree => tree.branch === `refs/heads/${branch}`)) throw fault('WORKTREE_EXISTS', '저장소 worktree가 다른 경로에 있습니다.', 409);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const existingBranch = await repo.sourceRuntime.processes.exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo.path });
  if (existingBranch.exitCode === 0) {
    const added = await repo.sourceRuntime.processes.exec('git', ['worktree', 'add', '--', target, branch], { cwd: repo.path });
    if (added.exitCode !== 0) throw new Error(added.stderr.trim() || 'worktree 생성 실패');
  } else {
    await repo.sourceRuntime.git.createWorktree(target, branch);
  }
  return { path: target, branch };
}

function selectedRepository(project, input) {
  if (!project.multiRepo) return null;
  const repo = project.repositories.find(item => item.id === text(input.repositoryId, '저장소'));
  if (!repo) throw fault('NOT_FOUND', '저장소를 찾을 수 없습니다.', 404);
  return repo;
}

function repositoryRuntime(project, repo) {
  return repo.worktreeEnabled
    ? createLocalRuntime({ root: repo.worktreePath, ptyFactory })
    : repo.sourceRuntime;
}

async function openProject(requested) {
  const root = await fs.realpath(text(requested, '프로젝트 경로'));
  if (!(await fs.stat(root)).isDirectory()) throw fault('INVALID_PROJECT', '폴더를 선택하세요.');
  const runtime = createLocalRuntime({ root, ptyFactory });
  const discovered = await discoverRepositories(root, runtime.processes);
  const id = !discovered.multiRepo && discovered.repositories[0] ? discovered.repositories[0].id : createHash('sha256').update(root).digest('hex');
  return opening(id)(async () => {
    if (projects.has(id)) return projects.get(id);
    const directory = path.join(dataRoot, id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const lockFile = await lock(directory);
    try {
      const saved = await readJson(path.join(directory, 'state.json'), {});
      // Only the layout and per-repository worktree choices are kept; older versions also stored agent conversations here.
      const state = { ui: saved.ui || {}, gitRepositories: saved.gitRepositories || {} };
      state.ui.gitRepositoryId ||= discovered.repositories[0]?.id || '';
      const repositories = discovered.repositories.map(repo => ({
        ...repo,
        sourceRuntime: createLocalRuntime({ root: repo.path, ptyFactory }),
        worktreeEnabled: state.gitRepositories[repo.id]?.worktreeEnabled === true,
        worktreePath: path.join(directory, 'worktrees', repo.id),
        branch: `ade/repo-${repo.id}`
      }));
      const project = { id, root, directory, lockFile, runtime, state, multiRepo: discovered.multiRepo, repositories, terminals: new Map(), openingTerminals: 0, chats: new Map(), openingChats: 0, chatOpen: serial(), mutation: serial(), persist: serial(), fsVersion: 0, gitStats: new Map(), gitStatus: new Map() };
      project.save = () => project.persist(() => writeJson(path.join(directory, 'state.json'), state));
      for (const repo of repositories) if (repo.worktreeEnabled) await repoWorktree(project, repo);
      await project.save();
      await registryWrite(async () => {
        const recent = await readJson(path.join(dataRoot, 'recent.json'), []);
        const previous = recent.find(item => item.id === id);
        await writeJson(path.join(dataRoot, 'recent.json'), trimRecent([{ id, root, openedAt: Date.now(), ...(previous?.pinned ? { pinned: true } : {}) }, ...recent.filter(item => item.id !== id)]));
      });
      project.watcher = watchProject(project);
      // Adopt before registering: a snapshot taken in between would show live host terminals as dead and the UI would reopen/prune them.
      await adoptTerminals(project);
      projects.set(id, project);
      await adoptChats(project);
      return project;
    } catch (error) { await fs.unlink(lockFile); throw error; }
  });
}
function registerTerminal(project, id, native, cwd, initial = '', startedAt = Date.now()) {
  // Progress reports (OSC 9;4) name no program; they count as agent status once this terminal's agent is identified.
  const status = createTerminalStatus(data => native.write(data), () => terminal.agent);
  status.feed(initial, true);
  // Adopted terminals start above any sequence the window saw from a previous server, or it would drop their replay as stale.
  const remoteAgent = createRemoteAgent(); remoteAgent.feed(initial);
  // `stream` names this buffer, so a client's `since` offset is only honoured against the output it counted (an adopted
  // terminal keeps its id but starts a new buffer). `startedAt`/`activeAt`/`inputAt` tell remote devices when it was last used.
  const now = Date.now();
  const terminal = { native, cwd, buffer: createTerminalBuffer(undefined, initial), sequence: initial ? now : 0, exited: false, status, remoteAgent, pending: '', flushTimer: null,
    stream: randomUUID().slice(0, 8), startedAt: Number.isSafeInteger(startedAt) ? startedAt : now, activeAt: initial ? now : null, inputAt: null };
  project.terminals.set(id, terminal);
  // Every viewer draws at the PTY's real size, so each change goes to all of them (including the one that asked for it).
  terminal.sizing = createTerminalSize(native, validSize(native.size), size => broadcast(project, { type: 'terminal/size', id, ...size }));
  // The starting size too: a first report of the same size changes nothing, so it would never be announced otherwise.
  if (terminal.sizing.size) broadcast(project, { type: 'terminal/size', id, ...terminal.sizing.size });
  // A client subscribed before the terminal existed gets no replay for it, only every chunk from the first: naming the
  // buffer lets it count that output from 0 and later resubscribe with `since` (see `subscribe`).
  broadcast(project, { type: 'terminal/stream', id, stream: terminal.stream, offset: terminal.buffer.written, sequence: terminal.sequence });
  // Output goes out in 5 ms batches (as in VS Code): a busy TUI emits many small chunks, and each one cost a message, a parse and an xterm write.
  // `sequence` still counts every chunk, so a follow-up check against it also rejects output that is not sent yet.
  terminal.flush = () => {
    clearTimeout(terminal.flushTimer); terminal.flushTimer = null;
    if (!terminal.pending) return;
    const data = terminal.pending, current = status.status; terminal.pending = ''; terminal.statusKey = JSON.stringify(current);
    broadcast(project, { type: 'terminal', id, data, sequence: terminal.sequence, status: current });
  };
  native.onData(data => {
    status.feed(data); const remoteChanged = remoteAgent.feed(data);
    terminal.buffer.append(data); terminal.sequence++; terminal.pending += data; terminal.activeAt = Date.now();
    terminal.flushTimer ??= setTimeout(terminal.flush, 5);
    // Over ssh the output is the only evidence of the remote agent, so a start or exit is reported at once instead of on the next poll.
    if (remoteChanged && terminal.ssh && terminal.agent !== remoteAgent.agent) { terminal.agent = remoteAgent.agent; broadcast(project, { type: 'terminal/agent', id, agent: terminal.agent, ssh: true }); broadcastStatus(project, id, terminal); }
  });
  native.onExit(event => { terminal.flush(); terminal.exited = true; project.terminals.delete(id); broadcast(project, { type: 'terminal/exit', id, ...event }); });
  return terminal;
}
// The progress fallback depends on the identified agent, so a new identification can change the status without any new output.
function broadcastStatus(project, id, terminal) {
  const next = terminal.status.status, key = JSON.stringify(next);
  if (key !== terminal.statusKey) { terminal.statusKey = key; broadcast(project, { type: 'terminal/status', id, status: next }); }
}
// Terminals that kept running in the pty-host while the previous server was replaced come back under their old ids.
async function adoptTerminals(project) {
  if (!ptyHost) return;
  for (const item of await ptyHost.list().catch(() => [])) {
    if (item.meta?.projectId !== project.id || project.terminals.has(item.meta.id)) continue;
    try { const native = await ptyHost.attach(item.key); registerTerminal(project, item.meta.id, native, item.meta.cwd, native.initial, item.meta.startedAt); } catch { /* exited in the meantime */ }
  }
}
// Chat agents run in the pty-host when it can keep piped processes, so they outlive this server (an update, a dev reload, the app left in the
// background); a host lost mid-run leaves new agents in this process, as they used to be.
const chatProcHost = ptyHost?.procs ? {
  spawnProc: (file, args, { cwd, env, meta }) => ptyHostLost ? spawnAgent(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) : ptyHost.spawnProc(file, args, { cwd, env, meta }),
  attachProc: (key, after) => ptyHostLost ? Promise.reject(new Error('pty-host disconnected')) : ptyHost.attachProc(key, after)
} : null;
async function openChat(project, id, { cwd, agent, defaults }) {
  const chat = await openChatSession({ directory: project.directory, id, projectId: project.id, cwd, agent, env: chatEnv(agent), executableArgs: chatArgs(agent), procHost: chatProcHost,
    onEvent: event => broadcast(project, { type: 'chat/event', id, event }), onState: state => broadcast(project, { type: 'chat/state', id, state }),
    prepare: chatLaunchFiles, recover: () => checkAgents(), defaults });
  project.chats.set(id, chat);
  return chat;
}
// Chats whose agent a previous server left running in the pty-host are opened right away (not when a screen shows them), so their
// output goes on being handled and stored.
async function adoptChats(project) {
  if (!chatProcHost) return;
  for (const item of await ptyHost.listProcs().catch(() => [])) {
    const { chatId, projectId, agent } = item.meta ?? {};
    if (projectId !== project.id || typeof chatId !== 'string' || project.chats.has(chatId) || !['claude', 'codex', 'cursor'].includes(agent)) continue;
    await project.chatOpen(() => project.chats.has(chatId) ? null : openChat(project, chatId, { cwd: project.root, agent }))
      .catch(error => console.warn(`채팅 ${chatId}을 이어받지 못했습니다: ${error.message}`));
  }
}
// A chat is busy while it answers, waits for an approval or still runs a background subagent.
const chatBusy = chat => { const { status, liveTasks } = chat.state(); return status === 'working' || status === 'attention' || Boolean(liveTasks?.length); };
// Releases everything a project holds. Without `force`, live terminals make it refuse so work is not killed by accident.
// `detach` (server shutdown) leaves pty-host terminals running for the next server instead of killing them.
// `keepChats` (default: with `detach`) leaves hosted chat agents running too; a plain quit ends them.
function closeProject(project, { force = false, detach = false, keepChats = detach } = {}) {
  return opening(project.id)(async () => {
    if (projects.get(project.id) !== project) return;
    const liveTerminals = [...project.terminals.values()].filter(terminal => !terminal.exited).length;
    if (!force && liveTerminals) throw fault('PROJECT_BUSY', `실행 중인 터미널 ${liveTerminals}개가 있습니다.`, 409);
    const busyChats = [...project.chats.values()].filter(chatBusy).length;
    if (!force && busyChats) throw fault('PROJECT_BUSY', `응답 중이거나 백그라운드 작업이 있는 채팅 ${busyChats}개가 있습니다.`, 409);
    projects.delete(project.id);
    for (const socket of clients) socket.projects.delete(project.id);
    project.watcher?.close();
    for (const terminal of project.terminals.values()) detach ? terminal.native.detach() : terminal.native.close();
    project.terminals.clear();
    // Chats keep their transcript and Claude session id on disk; closing only ends the child, and the next message resumes it.
    // Detaching leaves a child that runs in the pty-host to the next server, with what it was doing.
    await Promise.all([...project.chats.values()].map(chat => keepChats ? chat.detach() : chat.close()));
    project.chats.clear();
    await project.save();
    await fs.unlink(project.lockFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  });
}
// What git's own writes touch: the .git folder (index, HEAD and packed-refs are replaced by renaming a lock file), index (add, reset),
// HEAD, logs/HEAD (every commit, checkout, merge, reset) and FETCH_HEAD. null when .git is not a folder here (a linked worktree, a subfolder).
const GIT_STAMP = ['index', 'HEAD', path.join('logs', 'HEAD'), 'FETCH_HEAD'];
async function gitStamp(root) {
  const dir = path.join(root, '.git'), folder = await fs.stat(dir).catch(() => null);
  if (!folder?.isDirectory()) return null;
  const times = await Promise.all(GIT_STAMP.map(name => fs.stat(path.join(dir, name)).then(stat => stat.mtimeMs, () => 0)));
  return [folder.mtimeMs, ...times].join(':');
}
function watchProject(project) {
  return watchProjectFiles(project.root, paths => { project.fsVersion++; broadcast(project, { type: 'fs', paths }); });
}
function snapshot(project) {
  return { id: project.id, root: project.root, multiRepo: project.multiRepo, repositories: project.repositories.map(({ id, name, path: repoPath, worktreeEnabled, worktreePath, branch }) => ({ id, name, path: repoPath, worktreeEnabled, worktreePath: worktreeEnabled ? worktreePath : null, branch: worktreeEnabled ? branch : null })), ui: project.state.ui,
    chats: [...project.chats].map(([id, chat]) => ({ id, state: chat.state() })),
    terminals: [...project.terminals].map(([id, terminal]) => ({ id, exited: terminal.exited, cwd: terminal.cwd, ...terminal.sizing.size, startedAt: terminal.startedAt, activeAt: terminal.activeAt, inputAt: terminal.inputAt })) };
}
// A GUI-launched app often inherits a PATH without the user's CLI install dirs (~/.local/bin, npm global), so add the usual ones.
{
  const home = os.homedir(), sep = path.delimiter;
  const extra = [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), '/usr/local/bin', '/opt/homebrew/bin'].filter(Boolean);
  const key = Object.keys(process.env).find(name => name.toLowerCase() === 'path') || 'PATH';
  const current = (process.env[key] || '').split(sep).filter(Boolean);
  const missing = extra.filter(dir => !current.some(item => path.resolve(item).toLowerCase() === path.resolve(dir).toLowerCase()) && fsSync.existsSync(dir));
  if (missing.length) process.env[key] = [...current, ...missing].join(sep);
}
// What approved plugins add to terminals opened from now on (docs/PLUGINS.md). It comes only from the main process over IPC,
// which has already limited each plugin to its declared env prefix, bin folder and MCP script.
let pluginTerminal = { node: null, plugins: [] };
function configurePlugins(config) {
  const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  const plugins = Array.isArray(config?.plugins) ? config.plugins.filter(plugin => plugin && typeof plugin.id === 'string' && plugin.env && typeof plugin.env === 'object' && strings(plugin.path) && Object.values(plugin.env).every(value => typeof value === 'string')
    && (plugin.mcp === null || (typeof plugin.mcp?.name === 'string' && typeof plugin.mcp.command === 'string' && strings(plugin.mcp.args) && (plugin.mcp.disabledTools === undefined || strings(plugin.mcp.disabledTools))))) : [];
  pluginTerminal = { node: typeof config?.node === 'string' ? config.node : null, plugins };
  applyMcpServers();
}
// MoonerADE's own MCP server for the agents it starts: `ade_feedback_draft` (feedback-mcp.js) leaves a draft in the feedback
// inbox for a person to review. Off with the setting "채팅 에이전트가 피드백 초안을 넣을 수 있게". It runs on the terminals' Node
// (outside the install folder, see the desktop's setupPlugins) when there is one.
function applyMcpServers() {
  const own = feedbackAgentTool ? [{ name: 'ade_feedback', command: pluginTerminal.node || process.execPath, args: [path.join(import.meta.dirname, 'feedback-mcp.js'), feedbackIncoming] }] : [];
  setAgentMcpServers([...own, ...pluginTerminal.plugins.map(plugin => plugin.mcp).filter(Boolean).filter(server => server.name !== 'ade_feedback')]);
}
const agentModelProbes = new Map();
let modelsProbe = null; // { at, root, promise } for chat/models; the default model can come from a project's own settings, so it is per project folder
const commandsProbes = new Map(); // cwd + config -> { at, promise }
// The only helper CLI start there is (see probeInit): its init event holds the folder's slash commands and the model it resolved, so the command menu and
// the default model share one answer per folder and hour. Never rejects; a failed answer (null) is dropped so the next call asks again.
const initProbes = new Map(); // cwd + config -> { at, promise }
function claudeInit(cwd, env, refresh = false) {
  const configDir = (typeof env === 'function' ? env() : env)?.CLAUDE_CONFIG_DIR ?? '', key = JSON.stringify([cwd, configDir, agentKeys.signature('claude')]);
  let cached = initProbes.get(key);
  if (!cached || refresh || Date.now() - cached.at > 3_600_000) {
    cached = { at: Date.now(), promise: probeInit({ env, cwd }) };
    initProbes.set(key, cached);
    void cached.promise.then(init => { if (!init && initProbes.get(key) === cached) initProbes.delete(key); });
    if (initProbes.size > 32) initProbes.delete(initProbes.keys().next().value);
  }
  return cached.promise;
}
// What a chat of `agent` launches with: the plugin environment plus the API key when the user chose one for that agent (Settings > AI 툴).
const chatEnv = agent => () => ({ ...pluginEnv(), ...agentKeys.launch(agent).env });
const chatArgs = agent => () => agentKeys.launch(agent).args;
// Claude's model list: with an API key the CLI keeps no catalog of its own, so ask the Models API (cached an hour per key); otherwise the CLI's catalog.
let apiCatalog = null; // { key, at, promise }
async function claudeCatalog(refresh = false) {
  const env = chatEnv('claude')(), apiKey = env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return readModelCatalog();
  if (!apiCatalog || apiCatalog.key !== apiKey || refresh || Date.now() - apiCatalog.at > 3_600_000) {
    const entry = { key: apiKey, at: Date.now(), promise: fetchApiModelCatalog({ apiKey, baseURL: env.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL }) };
    apiCatalog = entry;
    entry.promise.then(list => { if (!list.length && apiCatalog === entry) apiCatalog = null; }); // a failed request is retried next time
  }
  const list = await apiCatalog.promise;
  return list.length ? list : readModelCatalog();
}
function pluginEnv() {
  if (!pluginTerminal.plugins.length) return {};
  const env = {}, dirs = pluginTerminal.plugins.flatMap(plugin => plugin.path);
  for (const plugin of pluginTerminal.plugins) Object.assign(env, plugin.env);
  if (pluginTerminal.node) env.ADE_PLUGIN_NODE = pluginTerminal.node;
  // The same key the environment already uses (Path on Windows), or the terminal would get two.
  const key = Object.keys(process.env).find(name => name.toLowerCase() === 'path') || 'PATH';
  if (dirs.length) env[key] = [...dirs, process.env[key] || ''].filter(Boolean).join(path.delimiter);
  return env;
}
// A slow cold start or a busy machine must not read as "not installed": retry once with a generous timeout.
async function probe(processes, file, args) {
  let failure;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await processes.exec(file, args, { timeoutMs: 20000 }); }
    catch (error) { failure = error; if (error.code === 'ENOENT') break; }
  }
  throw failure;
}
async function readiness(root) {
  const result = {}, processes = new LocalProcesses({ cwd: root });
  for (const executable of ['codex', 'claude']) {
    let version;
    try {
      version = await probe(processes, executable, ['--version']);
      if (version.exitCode !== 0) throw new Error(`${executable} 실행 실패`);
    } catch (error) {
      const missing = error.code === 'ENOENT';
      result[executable] = { installed: !missing, authenticated: false, message: missing ? `${executable} 실행 파일을 PATH에서 찾을 수 없습니다.` : `${executable} 버전 확인에 실패했습니다: ${error.message}` };
      continue;
    }
    try {
      let authenticated = false;
      if (executable === 'codex') authenticated = await codexAuthenticated(root);
      else {
        const auth = await probe(processes, 'claude', ['auth', 'status', '--json']);
        authenticated = auth.exitCode === 0 && JSON.parse(auth.stdout).loggedIn === true;
      }
      result[executable] = { installed: true, authenticated, version: version.stdout.trim(), message: authenticated ? '준비됨' : `${executable} ${executable === 'codex' ? 'login' : 'auth login'} 실행 후 다시 확인하세요.` };
    } catch (error) { result[executable] = { installed: true, authenticated: false, version: version.stdout.trim(), message: `${executable} 로그인 상태를 확인하지 못했습니다: ${error.message}` }; }
  }
  return result;
}
// Each check starts the agent CLIs (several Node processes) and every project used to run it when it opened, so one reading
// is shared by all projects for a while; the "다시 확인" button forces a fresh one.
const READINESS_TTL = 10 * 60_000;
let agentReadiness = null;
async function cachedReadiness(root, force) {
  if (force || !agentReadiness || (agentReadiness.done && Date.now() - agentReadiness.at > READINESS_TTL)) {
    const entry = { at: Date.now(), done: false, value: readiness(root) };
    agentReadiness = entry;
    entry.value.then(() => { entry.done = true; entry.at = Date.now(); }, () => { if (agentReadiness === entry) agentReadiness = null; });
  }
  const result = await agentReadiness.value;
  return { ...result, pty: { installed: typeof pty?.spawn === 'function', message: pty ? 'node-pty 로드됨 · 실제 PTY 동작은 터미널을 열어 확인' : 'node-pty 설치 및 네이티브 빌드를 확인하세요.' } };
}

// `git status --short --branch` yields "## main...origin/main"; the UI and the integrate check need the bare name.
async function currentBranch(runtime) {
  const named = await runtime.processes.exec('git', ['branch', '--show-current']);
  if (named.exitCode === 0 && named.stdout.trim()) return named.stdout.trim();
  const head = await runtime.processes.exec('git', ['rev-parse', '--short', 'HEAD']);
  return head.exitCode === 0 ? `(HEAD ${head.stdout.trim()})` : '';
}
// The "## " header of `git status --branch`: "main...origin/main [ahead 1]", "No commits yet on main", or "HEAD (no branch)".
// null (detached HEAD) leaves the name to currentBranch.
function branchFromHeader(header) {
  const unborn = /^(?:No commits yet|Initial commit) on (.+)$/.exec(header);
  if (unborn) return unborn[1];
  if (!header || header.startsWith('HEAD (')) return null;
  return header.replace(/ \[[^\]]*\]$/, '').split('...')[0];
}
// CPU usage is the busy share between two samples, so each call reports the time since the previous one.
let cpuSample = os.cpus().map(cpu => ({ ...cpu.times }));
function systemInfo() {
  const now = os.cpus().map(cpu => ({ ...cpu.times }));
  let busy = 0, total = 0;
  now.forEach((times, index) => {
    const before = cpuSample[index] || times;
    const all = Object.values(times).reduce((a, b) => a + b, 0) - Object.values(before).reduce((a, b) => a + b, 0);
    total += all; busy += all - (times.idle - before.idle);
  });
  cpuSample = now;
  const memory = { total: os.totalmem(), used: os.totalmem() - os.freemem() };
  return { cpu: total > 0 ? Math.round(busy / total * 100) : 0, cores: now.length, memory, uptime: Math.round(os.uptime()), platform: process.platform, hostname: os.hostname() };
}
// `owner/repo`, https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git) are accepted; anything else could point git at another transport.
function parseGithubRepo(value) {
  const raw = text(value, 'GitHub 저장소').trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(raw);
  if (!match || match[2] === '.' || match[2] === '..') throw fault('INVALID_REPOSITORY', 'GitHub 저장소 주소를 확인하세요. (owner/repo 또는 https://github.com/owner/repo)');
  const ssh = raw.startsWith('git@');
  return { url: ssh ? raw : `https://github.com/${match[1]}/${match[2]}.git`, name: match[2] };
}
async function cloneProject(input) {
  const repo = parseGithubRepo(input.url);
  const parent = path.resolve(text(input.parent, '저장 위치'));
  const folder = input.name ? text(input.name, '폴더 이름').trim() : repo.name;
  if (!/^[A-Za-z0-9_.-]+$/.test(folder) || folder === '.' || folder === '..') throw fault('INVALID_NAME', '폴더 이름에는 영문, 숫자, . _ - 만 쓸 수 있습니다.');
  await fs.mkdir(parent, { recursive: true });
  const target = path.join(parent, folder);
  const existing = await fs.readdir(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing && existing.length) throw fault('TARGET_EXISTS', `${target} 폴더가 이미 있고 비어 있지 않습니다.`);
  await new Promise((resolve, reject) => {
    execFile('git', ['clone', '--', repo.url, target], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, _out, stderr) => {
      if (!error) return resolve();
      if (error.code === 'ENOENT') return reject(fault('GIT_MISSING', 'git이 설치되어 있지 않습니다.'));
      reject(fault('CLONE_FAILED', `클론하지 못했습니다. 비공개 저장소라면 git 인증(gh auth login 등)을 먼저 설정하세요.\n${String(stderr || error.message).trim().slice(-500)}`));
    });
  });
  const opened = await openProject(target);
  await rememberParent(parent);
  return opened;
}
// The parent folder of the last successful create/clone, kept on disk so it survives restarts (the browser origin may change
// between launches, so localStorage cannot hold it). Falls back to the home folder when it is unset or no longer exists.
async function rememberParent(parent) {
  await registryWrite(() => writeJson(path.join(dataRoot, 'picker.json'), { lastParent: parent })).catch(() => {});
}
async function defaultParent() {
  const saved = (await readJson(path.join(dataRoot, 'picker.json'), null).catch(() => null))?.lastParent;
  if (typeof saved === 'string' && saved) {
    const stat = await fs.stat(saved).catch(() => null);
    if (stat?.isDirectory()) return { path: saved };
  }
  return { path: os.homedir() };
}
// A fresh project: an empty folder under `parent`, optionally made a git repository, then opened like any other.
async function createProject(input) {
  const parent = path.resolve(text(input.parent, '만들 위치'));
  const folder = text(input.name, '프로젝트 이름').trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(folder) || folder === '.' || folder === '..') throw fault('INVALID_NAME', '프로젝트 이름에는 영문, 숫자, . _ - 만 쓸 수 있습니다.');
  await fs.mkdir(parent, { recursive: true });
  const target = path.join(parent, folder);
  const existing = await fs.readdir(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing && existing.length) throw fault('TARGET_EXISTS', `${target} 폴더가 이미 있고 비어 있지 않습니다.`);
  if (!existing) await fs.mkdir(target);
  if (input.git) {
    await new Promise((resolve, reject) => {
      execFile('git', ['init', '--', target], { windowsHide: true, timeout: 60_000 }, (error, _out, stderr) => {
        if (!error) return resolve();
        if (error.code === 'ENOENT') return reject(fault('GIT_MISSING', 'git이 설치되어 있지 않습니다.'));
        reject(fault('GIT_INIT_FAILED', `git 저장소를 만들지 못했습니다.\n${String(stderr || error.message).trim().slice(-500)}`));
      });
    }).catch(async error => {
      // Leave nothing behind for a folder this call made, so retrying with the same name works.
      if (!existing) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      throw error;
    });
  }
  const opened = await openProject(target);
  await rememberParent(parent);
  return opened;
}
// Pinned projects never age out; only the unpinned ones are capped.
function trimRecent(list) {
  let unpinned = 0;
  return list.filter(item => item.pinned || ++unpinned <= 30);
}
// The same plugin MCP servers the terminals give `claude`, passed as a --mcp-config file next to the chat's transcript, and
// the plugin tools the user turned off as deny rules in a --settings file.
// A built-in plugin's server (the agent bus) also gets the chat it serves (ADE_CHAT_*) and its tools are allowed without a prompt.
async function chatLaunchFiles(root, context) {
  const servers = chatMcpServers(context);
  // The interactive-UI instructions travel as a file too, so the argv stays short and a resumed session gets them again.
  const promptFile = context.interactiveUi ? path.join(root, 'ade-ui-prompt.md') : undefined;
  if (promptFile) await fs.writeFile(promptFile, UI_PROMPT, { mode: 0o600 });
  if (!servers.length) return { promptFile };
  const mcpFile = path.join(root, 'claude-mcp.json');
  await fs.writeFile(mcpFile, JSON.stringify({ mcpServers: Object.fromEntries(servers.map(server => [server.name, { type: 'stdio', command: server.command, args: server.args, ...(server.env && { env: server.env }) }])) }), { mode: 0o600 });
  const denied = deniedMcpTools(servers), allowed = servers.filter(server => server.autoApprove).map(server => `mcp__${server.name}`);
  if (!denied.length && !allowed.length) return { mcpFile, promptFile };
  const settingsFile = path.join(root, 'claude-settings.json');
  await fs.writeFile(settingsFile, JSON.stringify({ permissions: { ...(allowed.length && { allow: allowed }), ...(denied.length && { deny: denied }) } }), { mode: 0o600 });
  return { mcpFile, settingsFile, promptFile };
}
// Terminal -> chat for a Claude that is completely at rest: nothing running, no dialog open, no background task or wakeup pending.
// Anything that cannot be verified refuses (the Claude is left untouched). Only then is the process ended, so the session has one writer
// again, and the same session continues as a chat. A half-typed prompt in the composer is not detectable and is lost with the process.
const SWITCH_BLOCKED = { turn: '응답 중입니다', background: '백그라운드 작업이 실행 중입니다', waiting: '승인 또는 질문을 기다리고 있습니다', scheduled: '예약된 작업이 남아 있습니다', unknown: '상태를 확인할 수 없습니다' };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function terminalToChat(project, id, newId, workspace) {
  const refuse = why => fault('CHAT_SWITCH_UNSAFE', `Chat으로 전환할 수 없습니다: ${why}`, 409);
  const terminal = project.terminals.get(id);
  if (!terminal || terminal.exited || !terminal.native.pid) throw fault('NOT_FOUND', '터미널을 찾을 수 없습니다.', 404);
  const table = await processTable([terminal.native.pid]).catch(() => null);
  const found = table && terminalProcesses(table)(terminal.native.pid);
  if (!found || found.agent !== 'claude' || !found.agentPid) throw refuse('실행 중인 Claude Code를 찾지 못했습니다');
  if (found.ssh) throw refuse('SSH 터미널은 지원하지 않습니다');
  if (terminal.status.status?.state === 'working') throw refuse(SWITCH_BLOCKED.turn);
  const pid = found.agentPid, dir = await accounts.agentFolder('claude', pid, project.root).catch(() => null);
  if (!dir) throw refuse('Claude 설정 폴더를 찾지 못했습니다');
  const busy = await claudeBusy(dir, pid).catch(() => ({ busy: true, kind: 'unknown' }));
  if (busy.busy) throw refuse(SWITCH_BLOCKED[busy.kind] ?? SWITCH_BLOCKED.unknown);
  let live;
  try { live = JSON.parse(await fs.readFile(path.join(dir, 'sessions', `${pid}.json`), 'utf8')); } catch { throw refuse('세션 상태 파일을 읽을 수 없습니다'); }
  if (live?.pid !== pid || !/^[0-9a-f-]{36}$/i.test(live.sessionId ?? '') || typeof live.cwd !== 'string') throw refuse('세션 정보가 올바르지 않습니다');
  // `claude -p --resume` finds the session by its folder, and the chat opens inside the project: both must hold before anything is ended.
  const cwd = await workspace.resolve(live.cwd).catch(() => null);
  if (!cwd) throw refuse('Claude가 프로젝트 밖의 폴더에서 실행 중입니다');
  // No transcript on disk (nothing said yet, or it moved): the chat simply opens empty instead of refusing.
  const file = await transcriptOf(dir, live).catch(() => null);
  process.kill(pid, 'SIGTERM');
  for (let waited = 0; alive(pid) && waited < 3000; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
  if (alive(pid)) { process.kill(pid, 'SIGKILL'); await new Promise(resolve => setTimeout(resolve, 300)); }
  if (alive(pid)) throw fault('CHAT_SWITCH_FAILED', 'Claude를 종료하지 못해 전환을 중단했습니다.', 500);
  if (file) await seedFromTranscript({ directory: project.directory, id: newId, file, sessionId: live.sessionId, configDir: dir === path.join(os.homedir(), '.claude') ? undefined : dir });
  else await seedChat({ directory: project.directory, id: newId, events: [], meta: { addDirs: [] } });
  terminal.native.close(); project.terminals.delete(id);
  return { cwd };
}
// Where this project's `claude` keeps its history: the account its .envrc or running agent names, and always the default folder.
const cliConfigDirs = async project => [(await accounts('claude', project).catch(() => null))?.dir || defaultClaudeDir(), defaultClaudeDir()];
async function feedbackRoute(action, input) {
  const id = () => text(input.id, '피드백 ID', 64);
  const image = () => {
    if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(input.data)) throw fault('INVALID_INPUT', '이미지 데이터가 올바르지 않습니다.');
    return Buffer.from(input.data, 'base64');
  };
  switch (action) {
    case 'feedback/list': await importFeedback(); return { items: await feedback.list(), available: feedbackAvailability(), queue: await feedbackQueue.info() };
    case 'feedback/get': return feedback.get(id());
    case 'feedback/create': return feedback.create({ title: input.title, body: input.body });
    case 'feedback/update': return feedback.update(id(), { title: input.title, body: input.body, reviewed: input.reviewed });
    case 'feedback/delete': return feedback.remove(id());
    case 'feedback/image/add': return feedback.addImage(id(), image(), input.mime);
    case 'feedback/image/replace': return feedback.replaceImage(id(), input.name, image());
    case 'feedback/image/restore': return feedback.restoreImage(id(), input.name);
    case 'feedback/image/remove': return feedback.removeImage(id(), input.name);
    case 'feedback/image/move': return feedback.moveImage(id(), input.name, input.to);
    case 'feedback/ai-draft': return feedbackAiDraft(id(), input);
    case 'feedback/submit': return feedbackSubmit(id());
    case 'feedback/unqueue': return feedbackQueue.cancel(id());
    case 'feedback/status': return feedbackAvailability();
    default: throw fault('NOT_FOUND', '지원하지 않는 작업입니다.', 404);
  }
}
async function route(action, input, project) {
  if (action === 'system/info') return systemInfo();
  // The open chats the agent bus (a built-in plugin) can address: this project's, or every open project's.
  if (action === 'chat/peers') {
    const scope = input.scope === 'all' ? [...projects.values()] : project ? [project] : [];
    return scope.flatMap(item => [...item.chats.entries()].map(([id, chat]) => {
      const state = chat.state();
      return { id, projectId: item.id, project: path.basename(item.root), agent: chat.agent, title: state.chatTitle || '', status: state.status, cwd: chat.cwd, permissionMode: state.permissionMode, lastUser: chat.lastUserInstruction?.() ?? null };
    }));
  }
  if (action === 'recent/remove') {
    const root = text(input.root, '프로젝트 경로');
    return registryWrite(async () => {
      const file = path.join(dataRoot, 'recent.json'), recent = await readJson(file, []);
      const next = recent.filter(item => item.root !== root);
      await writeJson(file, next);
      return next;
    });
  }
  if (action === 'recent/pin') {
    return registryWrite(async () => {
      const file = path.join(dataRoot, 'recent.json'), recent = await readJson(file, []);
      const next = trimRecent(recent.map(item => item.root === input.root ? (input.pinned ? { ...item, pinned: true } : { id: item.id, root: item.root, ...(item.openedAt && { openedAt: item.openedAt }) }) : item));
      await writeJson(file, next);
      return next;
    });
  }
  if (action === 'project/clone') return snapshot(await cloneProject(input));
  if (action === 'project/create') return snapshot(await createProject(input));
  if (action === 'dialog/folder') return chooseFolder(input);
  if (action === 'wakatime/status') return wakatime.status();
  if (action === 'wakatime/config') return wakatime.writeConfig(input);
  if (action === 'agent-keys/status') return agentKeys.status();
  if (action === 'agent-keys/config') {
    const status = await agentKeys.write(input); agentModelProbes.clear(); modelsProbe = null; apiCatalog = null;
    // Chats already running were launched with the old key in their environment; they relaunch (same session) so the new one is used.
    for (const project of projects.values()) for (const chat of project.chats.values()) if (!input?.agent || chat.agent === input.agent) chat.relaunch?.();
    return status;
  }
  if (action === 'usage/status') return usage.status(input.provider, { force: input.force === true, project });
  if (action === 'agent/installed') return checkAgents();
  if (action.startsWith('feedback/')) return feedbackRoute(action, input);
  if (action === 'shell/list') { const shells = detectShells(); return { shells, default: resolveShell('', shells).id }; }
  if (action === 'home') return { path: os.homedir() };
  if (action === 'picker/parent') return defaultParent();
  if (action === 'recent') return readJson(path.join(dataRoot, 'recent.json'), []);
  if (action === 'project/open') return snapshot(await openProject(input.path));
  if (action === 'app/state') {
    const file = path.join(dataRoot, 'app-state.json');
    if (input.state === undefined) return readJson(file, { version: 1, openProjects: [], activeProjectId: '', settings: null });
    const state = validateAppState(input.state);
    await registryWrite(async () => {
      // When projects leave the open list, the previous list is kept once in app-state.prev.json so it can be restored by hand.
      const previous = await readJson(file, null).catch(() => null);
      if (previous?.openProjects?.some(item => !state.openProjects.some(next => next.id === item.id))) await writeJson(`${file.slice(0, -5)}.prev.json`, previous);
      await writeJson(file, state);
    });
    applyAppState(state);
    return {};
  }
  if (action === 'project/close') {
    if (!project) throw fault('NOT_FOUND', '프로젝트를 찾을 수 없습니다.', 404);
    await closeProject(project, { force: input.force === true });
    return {};
  }
  if (action === 'readiness') return cachedReadiness(project?.root || os.homedir(), input.force === true);
  if (!project) throw fault('NOT_FOUND', '프로젝트를 먼저 여세요.', 404);
  const repo = action.startsWith('git/') ? selectedRepository(project, input) : null;
  const runtime = repo ? (action === 'git/worktree-setting' || action === 'git/worktree/integrate' ? repo.sourceRuntime : repositoryRuntime(project, repo)) : project.runtime;
  const workspace = runtime.workspace;
  switch (action) {
    case 'snapshot': return snapshot(project);
    case 'ui': {
      project.state.ui = validateUi(input.ui); await project.save(); return {};
    }
    case 'git/status': {
      // This runs on every refresh, so the branch comes from the status header instead of separate git calls.
      // `git status` reads every file's metadata in the worktree, every few seconds per visible project. While the watcher saw no change
      // under the project and git's own files are untouched (gitStamp), the last answer stands, for at most 15 s: the watcher skips
      // build/output folders, which a few repositories do track.
      const fsVersion = project.fsVersion, stamp = !repo?.worktreeEnabled && project.watcher?.watching ? await gitStamp(workspace.root) : null;
      const last = project.gitStatus.get(workspace.root);
      if (stamp && last?.stamp === stamp && last.fsVersion === fsVersion && Date.now() - last.at < 15_000) return last.result;
      const output = await runtime.processes.exec('git', ['status', '--porcelain=v1', '-z', '--branch']);
      if (output.exitCode !== 0) throw new Error(output.stderr);
      const entries = output.stdout.split('\0'), changes = [];
      let header = '';
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]; if (!entry) continue;
        if (entry.startsWith('## ')) { header = entry.slice(3); continue; }
        const status = entry.slice(0, 2), file = entry.slice(3);
        const original = /[RC]/.test(status) ? entries[++index] : undefined;
        changes.push({ status, path: file, original });
      }
      // Line counts change only with the working tree (which the project watcher sees) or with what status reports, so while
      // neither changed a recent count is reused and an idle poll costs one git process instead of two (or three).
      // A worktree lives outside the watched project folder, so its counts are always read again.
      // Untracked files' line counts are kept the same way, so an idle poll reads none of them.
      const cached = project.gitStats.get(workspace.root);
      let stats, untracked;
      if (!repo?.worktreeEnabled && project.watcher?.watching && cached?.status === output.stdout && cached.fsVersion === fsVersion && Date.now() - cached.at < 30_000) ({ stats, untracked } = cached);
      else {
        const headDiff = await runtime.processes.exec('git', ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD']);
        stats = headDiff.exitCode === 0 ? [headDiff.stdout] : [
          (await runtime.processes.exec('git', ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--numstat'])).stdout,
          (await runtime.processes.exec('git', ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--cached', '--numstat'])).stdout
        ];
        untracked = new Map();
        for (const change of changes.filter(item => item.status === '??')) {
          try {
            const content = await readText(workspace, change.path);
            untracked.set(change.path, content ? content.split('\n').length - Number(content.endsWith('\n')) : 0);
          } catch (error) { if (!['BINARY_FILE', 'UNSUPPORTED_FILE'].includes(error.code)) throw error; }
        }
        project.gitStats.set(workspace.root, { status: output.stdout, fsVersion, at: Date.now(), stats, untracked });
      }
      let additions = 0, deletions = 0;
      const perFile = new Map();
      for (const line of stats.join('\n').split('\n')) {
        const [added, deleted, file] = line.split('\t');
        if (/^\d+$/.test(added)) additions += Number(added);
        if (/^\d+$/.test(deleted)) deletions += Number(deleted);
        if (file && /^\d+$/.test(added) && /^\d+$/.test(deleted)) {
          const [a, d] = perFile.get(file) || [0, 0];
          perFile.set(file, [a + Number(added), d + Number(deleted)]);
        }
      }
      for (const change of changes) {
        const counts = perFile.get(change.path);
        if (counts) [change.added, change.deleted] = counts;
      }
      for (const change of changes) {
        const lines = change.status === '??' ? untracked.get(change.path) : undefined;
        if (lines !== undefined) { additions += lines; change.added = lines; change.deleted = 0; }
      }
      const result = { branch: branchFromHeader(header) ?? await currentBranch(runtime), changes, clean: changes.length === 0, additions, deletions };
      if (stamp) project.gitStatus.set(workspace.root, { stamp, fsVersion, at: Date.now(), result });
      return result;
    }
    case 'git/show': {
      text(input.path, '경로'); await workspace.resolve(input.path);
      if (input.working) return { content: await readText(workspace, input.path).catch(() => '') };
      const result = await runtime.processes.exec('git', ['--literal-pathspecs', 'show', `${input.staged ? '' : 'HEAD'}:${input.path}`]);
      return { content: result.exitCode === 0 ? result.stdout : '' };
    }
    case 'git/branches': {
      const result = await runtime.processes.exec('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
      if (result.exitCode !== 0) throw new Error(result.stderr);
      return { branches: result.stdout.split('\n').filter(Boolean) };
    }
    case 'git/checkout': return project.mutation(async () => {
      const branch = text(input.branch, '브랜치', 256);
      if (branch.startsWith('-')) throw fault('INVALID_INPUT', '브랜치 이름이 올바르지 않습니다.');
      const result = await runtime.processes.exec('git', ['switch', branch, '--']);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || '브랜치 전환 실패'); return {};
    });
    case 'git/worktree-setting': return project.mutation(async () => {
      if (!repo || typeof input.enabled !== 'boolean') throw fault('INVALID_INPUT', '저장소 worktree 설정을 확인하세요.');
      if (input.enabled === repo.worktreeEnabled) return {};
      if (input.enabled) await repoWorktree(project, repo);
      else {
        const status = await createLocalRuntime({ root: repo.worktreePath, ptyFactory }).git.status();
        if (!status.clean) throw fault('WORKTREE_DIRTY', 'worktree 변경을 먼저 커밋하거나 통합하세요.', 409);
        await repo.sourceRuntime.git.removeWorktree(repo.worktreePath);
      }
      repo.worktreeEnabled = input.enabled;
      project.state.gitRepositories[repo.id] = { worktreeEnabled: input.enabled };
      await project.save();
      return {};
    });
    case 'git/worktree/integrate': return project.mutation(async () => {
      if (!repo?.worktreeEnabled || input.confirm !== repo.branch) throw fault('INVALID_INPUT', '통합할 worktree 브랜치를 확인하세요.');
      const worktreeStatus = await createLocalRuntime({ root: repo.worktreePath, ptyFactory }).git.status();
      if (!worktreeStatus.clean) throw fault('WORKTREE_DIRTY', 'worktree 변경을 먼저 커밋하세요.', 409);
      await repo.sourceRuntime.git.integrateWorktree(repo.branch);
      return {};
    });
    case 'terminal/open': {
      if (project.terminals.size + project.openingTerminals >= 32) throw fault('TERMINAL_LIMIT', '프로젝트당 최대 32개 터미널을 지원합니다.');
      if ([...projects.values()].reduce((sum, item) => sum + item.terminals.size + item.openingTerminals, 0) >= 128) throw fault('TERMINAL_LIMIT', '열린 프로젝트 전체에서 최대 128개 터미널을 지원합니다.');
      project.openingTerminals++;
      try {
        const handoff = input.restoreId && project.chats.get(input.restoreId);
        const cwd = handoff && input.agent === handoff.agent && input.path === handoff.cwd && handoff.state().status === 'idle' ? handoff.cwd : input.path ? await workspace.resolve(text(input.path, '경로')) : workspace.root;
        if (!(await fs.stat(cwd)).isDirectory()) throw fault('INVALID_INPUT', '폴더를 선택하세요.');
        const id = randomUUID();
        if (input.restoreId !== undefined && input.agent === undefined) throw fault('INVALID_INPUT', '복구할 에이전트를 지정하세요.');
        // The chosen shell may have been uninstalled since it was saved; resolveShell then falls back to the automatic pick.
        const shell = resolveShell(terminalShell).path;
        const sessionShell = await terminalSessionShell(project.directory, id, shell);
        if (input.args !== undefined && !validAgentArgs(input.args)) throw fault('INVALID_INPUT', '잘못된 실행 인자입니다.');
        const command = input.agent === undefined ? undefined : [await terminalAgentCommand(project.directory, id, input.agent, input.restoreId, sessionShell.tracked), input.args?.trim()].filter(Boolean).join(' ');
        // xterm handles ConEmu's OSC 9;4 progress; an inherited Windows Terminal identity suppresses Claude's reports.
        // node-pty sets TERM only off Windows; without it (and WT_SESSION) CLIs fall back to ASCII glyphs, e.g. Claude's `>` prompt instead of `❯`.
        const native = await runtime.terminal.open({ shell, cwd, args: sessionShell.args, env: { ConEmuANSI: 'ON', WT_SESSION: '', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'MoonerADE', ...pluginEnv(), ...(typeof input.configDir === 'string' && path.isAbsolute(input.configDir) && input.configDir.length <= 1024 && !input.configDir.includes('\0') && { [input.agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: input.configDir }), ...sessionShell.env }, meta: { projectId: project.id, id, cwd, startedAt: Date.now() } });
        registerTerminal(project, id, native, cwd);
        return { id, ...(command && { command }) };
      } finally { project.openingTerminals--; }
    }
    case 'terminal/close': {
      const terminal = project.terminals.get(input.id);
      terminal?.native.close(); project.terminals.delete(input.id); return {};
    }
    case 'chat/open': return project.chatOpen(async () => {
      const id = text(input.id, '채팅 ID', 128);
      if (input.agent !== undefined && !['claude', 'codex', 'cursor'].includes(input.agent)) throw fault('INVALID_INPUT', '잘못된 에이전트입니다.');
      let chat = project.chats.get(id);
      if (!chat) {
        if (project.chats.size + project.openingChats >= 16) throw fault('CHAT_LIMIT', '프로젝트당 최대 16개 채팅을 지원합니다.');
        project.openingChats++;
        try {
          const cwd = input.path ? await workspace.resolve(text(input.path, '경로')) : workspace.root;
          if (!(await fs.stat(cwd)).isDirectory()) throw fault('INVALID_INPUT', '폴더를 선택하세요.');
          chat = await openChat(project, id, { cwd, agent: input.agent === undefined ? 'claude' : input.agent, defaults: input.defaults && typeof input.defaults === 'object' ? input.defaults : undefined });
        } finally { project.openingChats--; }
      }
      if (input.agent !== undefined && chat.agent !== input.agent) throw fault('INVALID_INPUT', '저장된 대화의 에이전트가 다릅니다.');
      return { id, agent: chat.agent, user: os.userInfo().username, ...chat.replay(input.since) };
    });
    case 'chat/sessions': return listChatSessions({ directory: project.directory, agent: input.agent ?? 'claude', exclude: input.exclude });
    // Conversations from the plain `claude` CLI in this project (Claude only: its transcript is the one format ADE reads).
    // Session statistics (Claude only): read from the transcript the CLI keeps, nothing is sent anywhere.
    case 'chat/stats': {
      const chat = project.chats.get(input.id);
      if (!chat) throw fault('NOT_FOUND', '채팅을 찾을 수 없습니다.', 404);
      const ref = chat.sessionRef();
      if (ref.agent !== 'claude') throw fault('CHAT_UNSUPPORTED', '세션 통계는 Claude 채팅에서만 볼 수 있습니다.', 409);
      if (!ref.sessionId) throw fault('NOT_FOUND', '아직 시작하지 않은 대화입니다. 메시지를 한 번 보낸 뒤 열어 보세요.', 404);
      const dirs = [...new Set([ref.configDir, ...await cliConfigDirs(project)].filter(Boolean))];
      const files = await sessionFiles({ sessionId: ref.sessionId, configDirs: dirs, cwds: [...new Set([ref.cwd, ref.worktreePath, workspace.root].filter(Boolean))] });
      if (!files.length) throw fault('NOT_FOUND', '이 세션의 기록 파일을 찾지 못했습니다. (/clear 했거나 CLI가 기록을 지웠을 수 있습니다)', 404);
      return { sessionId: ref.sessionId, ...await readSessionStats(files) };
    }
    case 'chat/cli-sessions': return listCliSessions({ directory: project.directory, cwd: workspace.root, configDirs: await cliConfigDirs(project) });
    case 'chat/import-cli': return importCliSession({ directory: project.directory, id: text(input.newId, '채팅 ID', 128), sessionId: input.sessionId, cwd: workspace.root, configDirs: await cliConfigDirs(project) });
    case 'chat/retry': {
      const chat = project.chats.get(input.id);
      if (!chat) throw fault('NOT_FOUND', '채팅을 찾을 수 없습니다.', 404);
      await chat.retry();
      return {};
    }
    case 'chat/send': {
      const chat = project.chats.get(input.id);
      if (!chat) throw fault('NOT_FOUND', '채팅을 찾을 수 없습니다.', 404);
      const images = Array.isArray(input.images) ? input.images : [];
      const mimes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      if (images.length > 4 || images.some(image => !image || !mimes.includes(image.mime) || typeof image.data !== 'string' || image.data.length > 2_500_000 || !/^[A-Za-z0-9+/=]+$/.test(image.data))) throw fault('INVALID_INPUT', '이미지는 4장 이하의 PNG/JPEG/GIF/WebP만 보낼 수 있습니다.');
      // Small JPEG thumbnails the chat shows in the thread (the full images only go to the agent). Anything malformed is just dropped.
      const previews = (Array.isArray(input.previews) ? input.previews : []).slice(0, images.length).filter(url => typeof url === 'string' && url.length <= 150_000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(url));
      chat.setInteractiveUi(input.interactiveUi);
      await chat.send(input.text, images.map(({ mime, data }) => ({ mime, data })), { steer: input.steer === true, artifact: input.artifact === true, previews });
      return {};
    }
    case 'chat/branch': {
      const chat = project.chats.get(input.id);
      if (!chat) throw fault('NOT_FOUND', '채팅을 찾을 수 없습니다.', 404);
      await seedChat({ directory: project.directory, id: text(input.newId, '채팅 ID', 128), ...chat.branchSnapshot(input.uuid) });
      return {};
    }
    case 'chat/rewind': {
      const chat = project.chats.get(input.id);
      if (!chat) throw fault('NOT_FOUND', '채팅을 찾을 수 없습니다.', 404);
      await chat.rewind(input.uuid);
      return {};
    }
    case 'chat/cancel-steer': return { cancelled: await project.chats.get(input.id)?.cancelSteer() === true };
    case 'chat/interrupt': await project.chats.get(input.id)?.interrupt({ sendSteers: input.sendSteers === true }); return {};
    case 'chat/stop-task': await project.chats.get(input.id)?.stopTask(String(input.toolUseId ?? '')); return {};
    case 'chat/approve': {
      const chat = project.chats.get(input.id);
      if (!chat) throw fault('NOT_FOUND', '채팅을 찾을 수 없습니다.', 404);
      await chat.approve(text(input.requestId, '승인 ID', 200), { allow: input.allow === true, always: input.always === true, answers: input.answers, message: typeof input.message === 'string' ? input.message.trim().slice(0, 4000) || undefined : undefined, mode: typeof input.mode === 'string' ? input.mode : undefined });
      return {};
    }
    case 'chat/set': {
      const chat = project.chats.get(input.id);
      if (!chat) throw fault('NOT_FOUND', '채팅을 찾을 수 없습니다.', 404);
      await chat.set({ configOption: input.configOption, model: input.model, effort: input.effort, worktree: input.worktree, addDirs: input.addDirs, permissionMode: input.permissionMode, sandbox: input.sandbox, network: input.network, runEverything: input.runEverything });
      return {};
    }
    case 'chat/rename': {
      const chat = project.chats.get(input.id);
      if (!chat) throw fault('NOT_FOUND', '채팅을 찾을 수 없습니다.', 404);
      return chat.rename(text(input.title, '이름', 200));
    }
    case 'chat/autocompact': {
      const chat = project.chats.get(input.id);
      if (!chat) throw fault('NOT_FOUND', '채팅을 찾을 수 없습니다.', 404);
      return chat.setAutoCompact(text(input.value, '창 크기', 40));
    }
    case 'chat/warm': await project.chats.get(input.id)?.warm(); return {};
    case 'chat/reset': await project.chats.get(input.id)?.reset({ force: input.force === true }); return {};
    case 'chat/close': {
      const chat = project.chats.get(input.id);
      if (chat) { project.chats.delete(input.id); await chat.close({ forget: input.forget === true, ...(typeof input.archiveAs === 'string' && { archiveAs: input.archiveAs }) }); }
      return {};
    }
    // Concrete model behind each alias (see resolveModels). Cached for an hour.
    case 'chat/models': {
      const agent = input.agent ?? 'claude';
      if (!['claude', 'codex', 'cursor'].includes(agent)) throw fault('INVALID_INPUT', '잘못된 에이전트입니다.');
      if (agent !== 'claude') {
        const key = JSON.stringify([agent, workspace.root, pluginEnv().CODEX_HOME ?? '', pluginEnv().CURSOR_CONFIG_DIR ?? '', agentKeys.signature(agent)]);
        let cached = agentModelProbes.get(key);
        if (!cached || input.refresh === true || Date.now() - cached.at > 3_600_000) {
          cached = { at: Date.now(), promise: probeAgentModels({ agent, cwd: workspace.root, env: chatEnv(agent), executableArgs: chatArgs(agent) }) };
          agentModelProbes.set(key, cached);
          cached.promise.catch(() => { if (agentModelProbes.get(key) === cached) agentModelProbes.delete(key); });
          if (agentModelProbes.size > 32) agentModelProbes.delete(agentModelProbes.keys().next().value);
        }
        const result = await cached.promise;
        const chat = project.chats.get(input.id); if (chat?.agent === agent) chat.loadCatalog(result.catalog, result.models[''], result.configOptions);
        return result;
      }
      if (!modelsProbe || modelsProbe.root !== workspace.root || input.refresh === true || Date.now() - modelsProbe.at > 3_600_000) {
        const entry = { at: Date.now(), root: workspace.root, promise: resolveModels({ env: chatEnv('claude'), cwd: workspace.root, init: () => claudeInit(workspace.root, chatEnv('claude'), input.refresh === true) }).catch(() => ({})) };
        modelsProbe = entry;
        entry.promise.then(models => { if (!Object.keys(models).length && modelsProbe === entry) modelsProbe = null; }); // a failed probe is retried next time
      }
      const [probed, catalog] = await Promise.all([modelsProbe.promise, claudeCatalog(input.refresh === true)]);
      // An alias the settings don't pin (always the case with an API key in a fresh HOME) is the newest model of its family, so the picker
      // shows "haiku" as that model's row instead of a second, unversioned "Haiku".
      const models = { ...probed };
      for (const alias of ['opus', 'sonnet', 'haiku']) if (!models[alias]) { const row = catalog.find(item => item.main && item.family === alias); if (row) models[alias] = row.id; }
      const chat = project.chats.get(input.id); if (chat?.agent === 'claude') chat.loadCatalog(catalog, models['']);
      return { models, catalog };
    }
    // Just the model list (claudeCatalog: the CLI's own, or the Models API with an API key); cheap or cached, so the "more models" window reads it fresh each time it opens.
    case 'chat/model-catalog': {
      if (input.agent && input.agent !== 'claude') return route('chat/models', input, project);
      return { catalog: await claudeCatalog() };
    }
    case 'terminal/to-chat': return terminalToChat(project, text(input.id, '터미널 ID', 128), text(input.newId, '채팅 ID', 128), workspace);
    // Chat -> terminal, step 1: end the chat's child (refused unless idle) and make its session the restore source; the caller then opens the terminal with `restoreId` and closes the chat.
    case 'chat/to-terminal': {
      const id = text(input.id, '채팅 ID', 128), chat = project.chats.get(id);
      if (!chat) throw fault('NOT_FOUND', '채팅을 찾을 수 없습니다.', 404);
      const { agent, sessionId, configDir } = await chat.handoff({ force: input.force === true });
      await seedTerminalSession(project.directory, id, sessionId, agent);
      return { agent, restoreId: id, cwd: chat.cwd, ...(configDir && { configDir }) };
    }
    case 'chat/commands': {
      const agent = input.agent ?? 'claude';
      if (!['claude', 'codex', 'cursor'].includes(agent)) throw fault('INVALID_INPUT', '잘못된 에이전트입니다.');
      const cwd = input.path ? await workspace.resolve(text(input.path, '경로')) : workspace.root;
      const configDir = typeof input.configDir === 'string' && path.isAbsolute(input.configDir) ? input.configDir : '';
      const env = { ...pluginEnv(), ...(configDir ? { [agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: configDir } : {}) };
      const extraNames = Array.isArray(input.names) ? input.names.filter(name => typeof name === 'string') : [];
      // Names come from a running chat's own init event; without them the shared init answer (claudeInit) stands in until a chat has started.
      const key = JSON.stringify([agent, cwd, configDir, extraNames]);
      let cached = commandsProbes.get(key);
      if (!cached || input.refresh === true || Date.now() - cached.at > 600_000) {
        cached = { at: Date.now(), promise: (async () => listCommands(cwd, os.homedir(), { env, names: extraNames.length || agent !== 'claude' ? extraNames : (await claudeInit(cwd, env, input.refresh === true))?.slashCommands, agent, probe: false }))() };
        commandsProbes.set(key, cached);
        cached.promise.catch(() => { if (commandsProbes.get(key) === cached) commandsProbes.delete(key); });
        if (commandsProbes.size > 32) commandsProbes.delete(commandsProbes.keys().next().value);
      }
      return cached.promise;
    }
    case 'files/list': {
      // For @-mentions in the chat composer: tracked plus untracked-but-not-ignored files, with their folders.
      // ponytail: git-only, a non-git folder returns nothing; add a readdir walk if that matters.
      const cwd = input.path ? await workspace.resolve(text(input.path, '경로')) : workspace.root;
      const result = await runtime.processes.exec('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd, timeoutMs: 10_000, maxOutputBytes: 32 * 1024 * 1024 }).catch(() => null);
      if (!result || result.exitCode !== 0) return { files: [] };
      const files = result.stdout.split('\0').filter(Boolean).slice(0, 50_000), dirs = new Set();
      for (const file of files) for (let at = file.indexOf('/'); at > 0; at = file.indexOf('/', at + 1)) dirs.add(file.slice(0, at + 1));
      return { files: [...dirs, ...files] };
    }
    case 'terminal/follow-up': {
      const prompt = text(input.prompt, '후속 입력', 16000), requestId = text(input.requestId, '요청 ID', 100);
      if (!prompt.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(prompt) || !Number.isSafeInteger(input.sequence)) throw fault('INVALID_INPUT', '후속 입력을 확인하세요.');
      const terminal = project.terminals.get(input.id);
      if (!terminal || terminal.exited || !terminal.native.pid) return { accepted: false };
      if (terminal.lastFollowUp === requestId) return { accepted: true };
      const table = await processTable([terminal.native.pid]);
      const agentProcess = table && terminalProcesses(table)(terminal.native.pid);
      if (terminal.lastFollowUp === requestId) return { accepted: true };
      // Recheck after ps: a CLI may have exited or redrawn its composer since the window observed completion.
      if (!agentProcess || agentProcess.agent !== 'claude' || agentProcess.ssh || terminal.exited || project.terminals.get(input.id) !== terminal || terminal.sequence !== input.sequence) return { accepted: false };
      terminal.native.write(`\x1b[200~${prompt}\x1b[201~\r`);
      terminal.lastFollowUp = requestId;
      return { accepted: true };
    }
    default: throw fault('NOT_FOUND', '지원하지 않는 작업입니다.', 404);
  }
}

function trusted(request, requireOrigin = true) {
  return request.headers.host === new URL(origin).host && (!requireOrigin || request.headers.origin === origin);
}
function authenticated(request) {
  const match = /(?:^|;\s*)ade_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '');
  return match && sessions.has(match[1]);
}
// Feedback images (8 MB, base64) are the only requests allowed past 3 MB.
async function body(request, limit = 3 * 1024 * 1024) {
  if (request.headers['content-type'] !== 'application/json') throw fault('INVALID_CONTENT_TYPE', 'JSON 요청만 허용됩니다.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw fault('PAYLOAD_TOO_LARGE', '요청이 너무 큽니다.', 413); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault('INVALID_JSON', '잘못된 JSON입니다.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('INVALID_INPUT', '객체 요청이 필요합니다.');
  return value;
}
const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', devWeb ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    if (closing) throw fault('SHUTTING_DOWN', '서버가 종료 중입니다.', 503);
    if (!trusted(request, false)) throw fault('UNTRUSTED_HOST', '잘못된 Host입니다.', 403);
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'POST' || !trusted(request)) throw fault('UNTRUSTED_ORIGIN', '동일 출처 POST만 허용됩니다.', 403);
      const input = await body(request, url.pathname.startsWith('/api/feedback/image/') ? 12 * 1024 * 1024 : undefined);
      let value;
      if (url.pathname === '/api/auth') {
        if (!authenticated(request)) {
          if (!bootstrapMatches(input.token)) throw fault('UNAUTHORIZED', '앱을 다시 시작하세요.', 401);
          const token = devSession || randomBytes(32).toString('hex'); sessions.add(token);
          response.setHeader('Set-Cookie', `ade_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        }
        value = {};
      } else {
        if (!authenticated(request)) throw fault('UNAUTHORIZED', '로컬 인증이 필요합니다.', 401);
        value = await route(url.pathname.slice(5), input, projects.get(input.projectId));
      }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value));
    } else {
      if (request.method !== 'GET') throw fault('NOT_FOUND', '경로가 없습니다.', 404);
      // Interactive chat UIs run in an iframe on this page; it has its own, much tighter CSP and needs no session.
      if (url.pathname === '/ade-ui-frame.html') { response.setHeader('Content-Security-Policy', UI_FRAME_CSP.replace('font-src data:', `font-src data: http://${request.headers.host}`)); response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(UI_FRAME_HTML); return; }
      // Feedback screenshots for the inbox: same session cookie as the API, names checked by the store.
      if (url.pathname.startsWith('/feedback-file/')) {
        if (!authenticated(request)) throw fault('UNAUTHORIZED', '로컬 인증이 필요합니다.', 401);
        const [, , id, name] = url.pathname.split('/');
        const file = feedback.filePath(decodeURIComponent(id ?? ''), decodeURIComponent(name ?? ''));
        const content = await fs.readFile(file);
        response.setHeader('Content-Type', file.endsWith('.png') ? 'image/png' : 'image/jpeg');
        response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        response.end(content);
        return;
      }
      // The app's font files are public; an interactive UI frame (opaque origin) loads them too, which needs CORS.
      if (/\.(woff2?|ttf)$/.test(url.pathname)) response.setHeader('Access-Control-Allow-Origin', '*');
      if (vite) {
        await new Promise((resolve, reject) => { response.once('close', resolve); vite.middlewares(request, response, error => reject(error || fault('NOT_FOUND', '경로가 없습니다.', 404))); });
        return;
      }
      const pathname = decodeURIComponent(url.pathname);
      const file = path.resolve(webRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(webRoot + path.sep)) throw fault('INVALID_PATH', '잘못된 경로입니다.', 403);
      const content = await fs.readFile(file);
      response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.png': 'image/png', '.map': 'application/json' })[path.extname(file)] || 'application/octet-stream');
      response.end(content);
    }
  } catch (error) {
    response.statusCode = error.status || (error.code === 'ENOENT' ? 404 : 400);
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: errorValue(error) }));
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
server.on('upgrade', (request, socket, head) => {
  // With ADE_DEV=1 Vite's own listener (hmr.server is this server) answers its HMR sockets (/?token=…, protocol vite-hmr / vite-ping), so this handler must
  // not close them: they get the same same-origin + signed-in check as /ws and are then left to Vite. Without it every edit needed a manual reload.
  const hmr = devWeb && /^vite-(hmr|ping)$/.test(request.headers['sec-websocket-protocol'] ?? '');
  if ((request.url !== '/ws' && !hmr) || !trusted(request) || !authenticated(request)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  if (hmr) return;
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
});
// Pasted images are files the agent CLI reads by path. They live in the app's own folder (not the shared temp folder, where
// any local user could read them), are removed after a day, and the folder is kept under a size cap, oldest first.
const pasteDir = path.join(dataRoot, 'paste');
const PASTE_TTL_MS = 24 * 60 * 60_000, PASTE_TOTAL_BYTES = 256 * 1024 * 1024;
async function prunePastes(incoming = 0) {
  const entries = await fs.readdir(pasteDir, { withFileTypes: true }).catch(() => []);
  const files = (await Promise.all(entries.filter(entry => entry.isFile() && /^paste-[\w-]+\.\w+$/.test(entry.name)).map(async entry => {
    const file = path.join(pasteDir, entry.name);
    return fs.stat(file).then(stat => ({ file, size: stat.size, mtimeMs: stat.mtimeMs }), () => null);
  }))).filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((sum, item) => sum + item.size, 0) + incoming;
  for (const item of files) {
    if (Date.now() - item.mtimeMs < PASTE_TTL_MS && total <= PASTE_TOTAL_BYTES) continue;
    await fs.rm(item.file, { force: true }).catch(() => {}); total -= item.size;
  }
}
const pasteTimer = setInterval(() => void prunePastes(), 60 * 60_000);
pasteTimer.unref();
void prunePastes();
async function savePaste(bytes, name) {
  await fs.mkdir(pasteDir, { recursive: true, mode: 0o700 });
  await prunePastes(bytes.length);
  const file = path.join(pasteDir, name);
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  return file;
}
// A client that went away no longer owns any terminal's size; whoever types or resizes next takes it.
function releaseSizes(client) { for (const project of projects.values()) for (const terminal of project.terminals.values()) terminal.sizing.release(client); }
// One message from a client: the window's /ws socket, or a plugin's workspace session.
async function handleClientMessage(socket, message) {
  let projectId;
  try {
    if (!message || typeof message !== 'object') throw fault('INVALID_INPUT', '잘못된 메시지입니다.');
    projectId = message.projectId;
    const project = projects.get(message.projectId);
    if (!project) throw fault('NOT_FOUND', '프로젝트가 없습니다.', 404);
    if (message.type === 'subscribe') {
      // Subscriptions are additive: one socket streams every open project.
      if (socket.projects.size >= 64) throw fault('INVALID_INPUT', '구독할 수 있는 프로젝트 수를 초과했습니다.');
      // Unsent output is already in the replay; flushing it first keeps it from arriving twice.
      for (const terminal of project.terminals.values()) terminal.flush();
      socket.projects.add(project.id);
      const tagged = value => send(socket, { ...value, projectId: project.id });
      tagged({ type: 'snapshot', snapshot: snapshot(project) });
      // The size comes before the replay, so a client draws the replayed screen at the size it was written for.
      // `since` ({[id]: {stream, offset}}) names the output a client already holds (a phone coming back to a project): it
      // gets only what came after, as an `append` replay, instead of the whole buffer again.
      const since = message.since && typeof message.since === 'object' && !Array.isArray(message.since) ? message.since : {};
      for (const [id, terminal] of project.terminals) {
        if (terminal.sizing.size) tagged({ type: 'terminal/size', id, ...terminal.sizing.size });
        const held = Object.hasOwn(since, id) && since[id]?.stream === terminal.stream ? terminal.buffer.since(since[id].offset) : null;
        tagged({ type: 'terminal/replay', id, data: held ?? terminal.buffer.text, ...(held !== null && { append: true }), stream: terminal.stream, offset: terminal.buffer.written,
          sequence: terminal.sequence, exited: terminal.exited, status: terminal.status.status });
      }
      for (const [id, terminal] of project.terminals) if (terminal.ssh) tagged({ type: 'terminal/ssh', id, ssh: true });
      for (const [id, terminal] of project.terminals) if ('agent' in terminal) tagged({ type: 'terminal/agent', id, agent: terminal.agent, ssh: terminal.ssh });
      for (const [id, terminal] of project.terminals) if (terminal.cache?.value) tagged({ type: 'terminal/cache', id, cache: terminal.cache.value });
    } else if (message.type === 'unsubscribe') {
      socket.projects.delete(project.id);
      for (const terminal of project.terminals.values()) terminal.sizing.release(socket);
    } else if (socket.projects.has(project.id)) {
      const terminal = project.terminals.get(message.id);
      // Input and resize events can still arrive while the client removes an exited pane.
      if (!terminal || terminal.exited) return;
      if (message.type === 'terminal/input') {
        if (typeof message.data !== 'string' || message.data.length > 16384) throw fault('INVALID_INPUT', '잘못된 터미널 입력입니다.');
        if (typedInput(message.data)) { terminal.sizing.input(socket); terminal.inputAt = Date.now(); }
        terminal.native.write(message.data);
      } else if (message.type === 'terminal/paste-image') {
        // Agent CLIs take an image by file path; write the pasted clipboard image to a file and type its path.
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[message.mime];
        if (!ext || typeof message.data !== 'string') throw fault('INVALID_INPUT', '지원하지 않는 이미지입니다.');
        const bytes = Buffer.from(message.data, 'base64');
        if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw fault('INVALID_INPUT', '이미지 크기가 올바르지 않습니다.');
        terminal.sizing.input(socket); terminal.inputAt = Date.now();
        const name = `paste-${randomUUID()}.${ext}`;
        // Over ssh the CLI runs on the remote host, which cannot read a local path; the image goes there through the same ssh setup.
        if (terminal.ssh && terminal.sshCommand) {
          const remote = await uploadOverSsh(terminal.sshCommand, bytes, name).catch(error => {
            throw fault('INVALID_INPUT', `원격 서버로 이미지를 보내지 못했습니다 (키 인증 또는 ControlMaster 연결이 필요합니다): ${error.message}`);
          });
          const quoted = remote.windows ? (/\s/.test(remote.path) ? `"${remote.path}"` : remote.path)
            : /[^\w@%+=:,./-]/.test(remote.path) ? `'${remote.path.replaceAll("'", `'\\''`)}'` : remote.path;
          if (!terminal.exited) terminal.native.write(`${quoted} `);
          return;
        }
        const file = await savePaste(bytes, name);
        if (!terminal.exited) terminal.native.write(/\s/.test(file) ? (process.platform === 'win32' ? `"${file}" ` : `'${file.replaceAll("'", `'\\''`)}' `) : `${file} `);
      } else if (message.type === 'terminal/resize') {
        // The size this client would like; terminal-size.js decides whether the PTY takes it now.
        const size = validSize(message);
        if (!size) throw fault('INVALID_INPUT', '잘못된 터미널 크기입니다.');
        terminal.sizing.want(socket, size.cols, size.rows, message.claim === true);
      }
      else throw fault('INVALID_INPUT', '잘못된 메시지입니다.');
    }
  } catch (error) { send(socket, { type: 'error', error: errorValue(error), ...(typeof projectId === 'string' && { projectId }) }); }
}
wss.on('connection', socket => {
  socket.projects = new Set();
  clients.add(socket);
  socket.on('close', () => { clients.delete(socket); releaseSizes(socket); });
  socket.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return send(socket, { type: 'error', error: errorValue(fault('INVALID_JSON', '잘못된 JSON입니다.')) }); }
    void handleClientMessage(socket, message);
  });
});
// Workspace sessions of plugins that declared the `workspace` permission (docs/PLUGINS.md). The app relays them over IPC; a
// session joins `clients` like a window does, so it gets the same broadcasts, and its requests go through the same handlers.
const PLUGIN_SESSIONS = 16, PLUGIN_TERMINALS = 8, PLUGIN_BUFFER = 8 * 1024 * 1024;
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,39}$/, SESSION_ID = /^[\w-]{1,64}$/;
const pluginSessions = new Map(); // `${plugin}\0${session}` -> client
const toApp = (value, done) => { if (process.connected) process.send(value, done); else done?.(); };
const pluginTerminals = plugin => [...projects.values()].reduce((sum, project) => sum + [...project.terminals.values()].filter(terminal => terminal.openedBy === plugin && !terminal.exited).length, 0);
function openPluginSession(plugin, session) {
  const key = `${plugin}\0${session}`;
  let pending = 0, closed = false;
  const client = {
    plugin,
    projects: new Set(),
    get readyState() { return closed ? 3 : 1; },
    // Bytes handed to the IPC channel and not yet written; a session that stops reading is closed, as a slow window is.
    get bufferedAmount() { return pending; },
    send(text) {
      if (closed) return;
      pending += text.length;
      toApp({ type: 'plugin/workspace', plugin, op: 'message', session, text }, () => { pending -= text.length; });
    },
    close() {
      if (closed) return;
      closed = true;
      clients.delete(client); pluginSessions.delete(key); releaseSizes(client);
      toApp({ type: 'plugin/workspace', plugin, op: 'closed', session });
    }
  };
  pluginSessions.set(key, client); clients.add(client);
}
async function pluginApi(plugin, action, input) {
  if (typeof action !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) throw fault('INVALID_INPUT', '잘못된 요청입니다.');
  if (action === 'terminal/open' && pluginTerminals(plugin) >= PLUGIN_TERMINALS) throw fault('TERMINAL_LIMIT', `플러그인은 터미널을 최대 ${PLUGIN_TERMINALS}개까지 열 수 있습니다.`);
  const value = await route(action, input, projects.get(input.projectId));
  if (action === 'terminal/open' && value?.id) {
    const terminal = projects.get(input.projectId)?.terminals.get(value.id);
    if (terminal) terminal.openedBy = plugin;
  }
  return value;
}
function pluginWorkspace(message) {
  const { plugin, op, session } = message;
  if (!PLUGIN_ID.test(plugin ?? '')) return;
  if (op === 'close-all') { for (const client of [...pluginSessions.values()]) if (client.plugin === plugin) client.close(); return; }
  if (!SESSION_ID.test(session ?? '')) return;
  const key = `${plugin}\0${session}`, client = pluginSessions.get(key);
  if (op === 'open') {
    if (client) return; // already open
    if ([...pluginSessions.values()].filter(item => item.plugin === plugin).length >= PLUGIN_SESSIONS) return toApp({ type: 'plugin/workspace', plugin, op: 'closed', session });
    openPluginSession(plugin, session);
  } else if (op === 'close') client?.close();
  else if (op === 'send') { if (client) void handleClientMessage(client, message.message); }
  else if (op === 'api') {
    const id = message.id;
    if (!Number.isSafeInteger(id)) return;
    const reply = result => toApp({ type: 'plugin/workspace', plugin, op: 'api-result', session, id, ...result });
    if (!client) return reply({ ok: false, error: { code: 'NOT_FOUND', message: '세션이 없습니다.' } });
    pluginApi(plugin, message.action, message.input ?? {}).then(value => reply({ ok: true, value: value ?? null }), error => reply({ ok: false, error: errorValue(error) }));
  }
}
// Keeps a plugin session that stopped reading from piling up output in this process.
const pluginBufferTimer = setInterval(() => { for (const client of [...pluginSessions.values()]) if (client.bufferedAmount > PLUGIN_BUFFER) client.close(); }, 1000);
pluginBufferTimer.unref();
// While a window is connected the ADE counts as in use: the active project gets an app heartbeat, as "ai coding" when one of its
// agents is working, and with `wakatimeBackground` so do other projects whose agents are working.
// wakatime-cli also picks up Claude/Codex transcripts on each call.
applyAppState(await readJson(path.join(dataRoot, 'app-state.json'), null));
applyMcpServers();
const agentWorking = project => [...project.terminals.values()].some(terminal => !terminal.exited && terminal.status.status?.state === 'working');
let wakatimeTurn = 0;
function wakatimePulse() {
  if (!wakatime.enabled || !clients.size) return;
  const beat = (project, category) => ({ entity: 'MoonerADE', entityType: 'app', folder: project.root, project: path.basename(project.root), category });
  const active = projects.get(activeProjectId), beats = active ? [beat(active, agentWorking(active) ? 'ai coding' : 'coding')] : [];
  if (wakatimeBackground) for (const project of projects.values()) if (project !== active && agentWorking(project)) beats.push(beat(project, 'ai coding'));
  if (beats.length < 2) { if (beats.length) wakatime.heartbeat(beats[0]); return; }
  // WakaTime credits each heartbeat with the time until the next one across all projects, so busy projects take turns every tick to split it evenly.
  wakatime.heartbeat({ ...beats[wakatimeTurn++ % beats.length], force: true });
}
const wakatimeTimer = setInterval(wakatimePulse, PULSE / 4);
wakatimeTimer.unref();
// Heartbeat for lock(): keeps this server's locks fresh so only abandoned ones age out.
const lockTimer = setInterval(() => {
  const now = new Date();
  for (const project of projects.values()) fs.utimes(project.lockFile, now, now).catch(() => {});
}, LOCK_STALE_MS / 4);
lockTimer.unref();
function publishCache(project, id, terminal, value) {
  const key = JSON.stringify(value ?? null);
  if (key !== (terminal.cacheKey ?? 'null')) { terminal.cacheKey = key; broadcast(project, { type: 'terminal/cache', id, cache: value ?? null }); }
}
// A Claude over ssh is read from its own host: session state (busy/idle) and the transcript behind the cache timer, one ssh call per poll.
// Failures (a password prompt, a host that is down) back off instead of retrying every few seconds.
const ANSI_TEXT = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\x5c)|\x1b[()][A-Za-z0-9]/g;
async function pollRemoteClaude(project, id, terminal) {
  const remote = terminal.remoteClaude ??= createRemoteClaude();
  let output;
  try { output = await runRemote(terminal.sshCommand, remoteScript(remote.request)); }
  catch { terminal.remoteRetry = Date.now() + 30_000; return; }
  if (terminal.exited || !terminal.ssh || terminal.agent !== 'claude' || terminal.remoteClaude !== remote) return;
  const screen = terminal.buffer.text.slice(-16384).replace(ANSI_TEXT, '');
  const { state, cache } = remote.update(parseRemote(output), screen);
  terminal.remoteCache = cache;
  terminal.status.setRemote(state);
  broadcastStatus(project, id, terminal);
  publishCache(project, id, terminal, cache);
}
// Both pollers below look again only after a terminal printed something since their last look, or after QUIET_RECHECK_MS: an agent starting,
// working, finishing or an ssh session opening all print, and a quiet terminal (most of them, most of the time) then costs nothing.
const QUIET_RECHECK_MS = 30_000;
const quiet = (terminal, key) => terminal.activeAt === terminal[key]?.activeAt && Date.now() - terminal[key].at < QUIET_RECHECK_MS;
const remoteTimer = setInterval(() => {
  for (const project of projects.values()) for (const [id, terminal] of project.terminals) {
    if (terminal.exited || !terminal.ssh || terminal.agent !== 'claude' || !terminal.sshCommand || terminal.remotePolling || Date.now() < (terminal.remoteRetry ?? 0) || quiet(terminal, 'remoteLook')) continue;
    terminal.remotePolling = true; terminal.remoteLook = { activeAt: terminal.activeAt, at: Date.now() };
    void pollRemoteClaude(project, id, terminal).catch(() => {}).finally(() => { terminal.remotePolling = false; });
  }
}, 4000);
remoteTimer.unref();
// A terminal is "over ssh" while an ssh client runs anywhere below its shell. One process listing per tick serves every terminal.
const processTable = createProcessTable();
let sshPolling = false;
let sshLook = { key: '', at: 0 };
const sshTimer = setInterval(async () => {
  if (sshPolling || ![...projects.values()].some(project => [...project.terminals.values()].some(terminal => !terminal.exited))) return;
  const live = [...projects.values()].flatMap(project => [...project.terminals.values()].filter(terminal => !terminal.exited && terminal.native.pid));
  // One process listing serves every terminal, so it is skipped only while none of them opened, closed or printed (see QUIET_RECHECK_MS).
  const key = live.map(terminal => `${terminal.native.pid}:${terminal.activeAt}`).join(',');
  if (key === sshLook.key && Date.now() - sshLook.at < QUIET_RECHECK_MS) return;
  sshLook = { key, at: Date.now() };
  sshPolling = true;
  try {
    const roots = live.map(terminal => terminal.native.pid);
    const table = await processTable(roots); if (!table) return;
    const inspect = terminalProcesses(table);
    for (const project of projects.values()) for (const [id, terminal] of project.terminals) {
      if (terminal.exited || !terminal.native.pid) continue;
      const found = inspect(terminal.native.pid), { agentPid, ssh, sshCommand } = found, changedSsh = ssh !== Boolean(terminal.ssh);
      terminal.sshCommand = sshCommand;
      // An agent seen before the ssh session ended belongs to that remote host; the next session starts clean.
      if (changedSsh && !ssh) terminal.remoteAgent.reset();
      // Over ssh the agent's own OSC 7501 status report (app=claude-code) is as good as a banner, and survives a lost banner or title.
      const agent = ssh ? terminal.remoteAgent.agent ?? terminal.status.reported?.agent ?? null : found.agent;
      if (terminal.agent && agent !== terminal.agent && !ssh && terminal.status.reported?.agent !== agent) {
        terminal.status.clear();
        terminal.statusKey = 'null'; broadcast(project, { type: 'terminal/status', id, status: null });
      }
      // Each project may run Claude under its own account, whose folder holds this process's session file and transcript.
      let cache = null;
      if (agent === 'claude' && agentPid && !ssh) {
        const dir = await accounts.agentFolder('claude', agentPid, project.root).catch(() => null);
        if (dir) {
          await syncClaudeSession(project.directory, id, agentPid, dir).catch(() => {});
          cache = await readClaudeCache(dir, agentPid, terminal.cache).catch(() => null);
        }
      }
      terminal.cache = cache;
      // Over ssh the remote poller below owns the cache and the session state; it stops once the agent or the ssh session is gone.
      if (!(ssh && agent === 'claude') && terminal.remoteClaude) { terminal.remoteClaude = null; terminal.status.setRemote(null); }
      publishCache(project, id, terminal, ssh && agent === 'claude' ? terminal.remoteCache ?? null : cache?.value ?? null);
      if (ssh !== Boolean(terminal.ssh)) { terminal.ssh = ssh; broadcast(project, { type: 'terminal/ssh', id, ssh }); }
      // Usage readings look up which account this agent runs under.
      terminal.agentPid = !ssh && agentPid || null;
      if (terminal.agent !== agent || changedSsh) { terminal.agent = agent; broadcast(project, { type: 'terminal/agent', id, agent, ssh }); broadcastStatus(project, id, terminal); }
    }
  } catch (error) { console.warn(`터미널 프로세스 확인 실패: ${error.message}`); } finally { sshPolling = false; }
}, 3000);
sshTimer.unref();
// Whether anything in any open project would be cut off by restarting the app (the auto-updater asks over IPC before it does).
// Each reason names where it is and what runs: a working agent, a Claude with a background task or wakeup still pending, a command in a plain shell.
// Anything that cannot be verified counts as busy rather than being guessed idle; a terminal over ssh is only busy while its agent reports working.
async function busyReport() {
  const live = [...projects.values()].flatMap(project => [...project.terminals].filter(([, terminal]) => !terminal.exited).map(([id, terminal]) => ({ project, id, terminal })));
  // A plugin's workspace session in the middle of work would lose it to a restart just like a terminal would.
  const reasons = [...pluginSessions.values()].map(client => ({ project: '', terminal: client.plugin, kind: 'plugin' }));
  // A chat turn is a child of this server, so any restart (update or dev reload) ends it; an idle chat resumes from its session id and costs nothing.
  // Unless it runs in the pty-host: then it goes on through the restart like a terminal.
  const chats = [...projects.values()].flatMap(project => [...project.chats].map(([id, chat]) => ({ project, id, chat })));
  for (const { project, id, chat } of chats) if (chatBusy(chat)) reasons.push({ project: path.basename(project.root), terminal: id.slice(0, 6), kind: 'turn', agent: chat.agent, ...(chat.hosted && !ptyHostLost && { keeps: true }) });
  // Terminals in the pty-host keep running through an app restart; the updater then only waits for what does not.
  const keepsTerminals = Boolean(ptyHost && !ptyHostLost), keepsChats = Boolean(chatProcHost && !ptyHostLost);
  const kept = [];
  // `live`: what quitting would end (or leave running in the background), for the app's quit question.
  const running = chats.filter(item => item.chat.running);
  const liveCount = { terminals: live.length, chats: running.length, answering: running.filter(item => chatBusy(item.chat)).length };
  const report = () => ({ busy: reasons.length + kept.length > 0, keepsTerminals, keepsChats, live: liveCount, reasons: [...reasons, ...kept.map(item => keepsTerminals ? { ...item, keeps: true } : item)] });
  if (!live.length) return report();
  const table = await processTable(live.filter(item => item.terminal.native.pid).map(item => item.terminal.native.pid)).catch(() => null);
  const inspect = table && terminalProcesses(table);
  for (const { project, id, terminal } of live) {
    const where = { project: path.basename(project.root), terminal: terminal.cwd ? path.basename(terminal.cwd) : id.slice(0, 6) };
    const found = inspect && terminal.native.pid ? inspect(terminal.native.pid) : { agent: terminal.agent, agentPid: terminal.agentPid, ssh: Boolean(terminal.ssh), descendants: null };
    const working = terminal.status.status?.state === 'working';
    if (found.ssh) { if (working) kept.push({ ...where, kind: 'turn', agent: terminal.agent ?? undefined }); continue; }
    if (found.agent === 'claude' && found.agentPid) {
      if (working) { kept.push({ ...where, kind: 'turn', agent: 'claude' }); continue; }
      const dir = await accounts.agentFolder('claude', found.agentPid, project.root).catch(() => null);
      const result = dir ? await claudeBusy(dir, found.agentPid).catch(error => ({ busy: true, kind: 'unknown', detail: error.message })) : { busy: true, kind: 'unknown', detail: 'Claude 설정 폴더를 찾지 못했습니다' };
      if (result.busy) kept.push({ ...where, agent: 'claude', kind: result.kind, ...(result.detail && { detail: result.detail }) });
      continue;
    }
    if (found.agent) { if (working) kept.push({ ...where, kind: 'turn', agent: found.agent }); continue; }
    if (!found.descendants) { kept.push({ ...where, kind: working ? 'turn' : 'unknown', ...!working && { detail: '프로세스 목록을 읽지 못했습니다' } }); continue; }
    const [command] = runningCommands(found.descendants);
    if (command) {
      const first = command.command.match(/^"([^"]*)"|^\S+/) ?? [], name = (first[1] ?? first[0] ?? '').replaceAll('\\', '/').split('/').pop().replace(/\.exe$/i, '');
      kept.push({ ...where, kind: 'command', detail: name });
    }
  }
  return report();
}
await startVite(server);
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.ADE_PORT) || 0, '127.0.0.1', resolve); });
origin = `http://127.0.0.1:${server.address().port}`;
void watchFeedback();
console.log(`무너에이드: ${origin}/#token=${bootstrap}`);
let closing = false;
// The 3 s poll records each Claude's session id; one last pass means an update restart resumes the conversation as it is now, not as of a few seconds ago.
// Bounded, because the app force-kills the server 5 s after asking it to stop.
async function syncSessionsBeforeExit() {
  const syncs = [];
  for (const project of projects.values()) for (const [id, terminal] of project.terminals) {
    if (terminal.exited || terminal.ssh || terminal.agent !== 'claude' || !terminal.agentPid) continue;
    syncs.push(accounts.agentFolder('claude', terminal.agentPid, project.root).then(dir => dir && syncClaudeSession(project.directory, id, terminal.agentPid, dir)).catch(() => {}));
  }
  await Promise.race([Promise.all(syncs), new Promise(resolve => setTimeout(resolve, 2000).unref())]);
}
// `keep: false` (the user quit the app): chats end instead of being left to the next server. Anything else (update, dev reload, background) keeps them.
async function shutdown({ keep = true } = {}) {
  if (closing) return; closing = true; clearInterval(sshTimer); clearInterval(remoteTimer); clearInterval(wakatimeTimer); clearInterval(lockTimer); clearInterval(pasteTimer); clearInterval(pluginBufferTimer); feedbackQueue.stop();
  for (const client of [...pluginSessions.values()]) client.close();
  await syncSessionsBeforeExit();
  processTable.close();
  // One project failing to release must not leave the rest locked.
  for (const project of [...projects.values()]) await closeProject(project, { force: true, detach: true, keepChats: keep }).catch(error => console.error(`프로젝트 종료 실패 ${project.root}: ${error.message}`));
  for (const client of clients) client.close(); wss.close(); server.close(); ptyHost?.close(); void vite?.close();
}
// Exit explicitly: the IPC channel to the app would otherwise keep the process alive after shutdown.
process.on('SIGINT', () => void shutdown().finally(() => process.exit(0))); process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
// Every terminal lives in this process (outside `pnpm dev`), so one stray error in a callback must not end all of them.
process.on('uncaughtException', error => console.error(`처리되지 않은 오류: ${error?.stack || error}`));
process.on('unhandledRejection', error => console.error(`처리되지 않은 거부: ${error?.stack || error}`));
// The app asks over IPC because Windows has no SIGTERM for child processes.
process.on('message', message => {
  if (message?.type === 'shutdown') void shutdown({ keep: message.keep !== false }).finally(() => process.exit(0));
  else if (message?.type === 'busy?') {
    const answer = report => process.send?.({ type: 'busy', id: message.id, ...report });
    busyReport().then(answer, error => answer({ busy: true, reasons: [{ project: '', terminal: '', kind: 'unknown', detail: error.message }] }));
  }
  else if (message?.type === 'plugins/terminal') configurePlugins(message.config);
  else if (message?.type === 'feedback/status' && message.status && typeof message.status === 'object') {
    const status = message.status;
    pluginFeedback = status.ok === true
      ? { ok: true, ...(typeof status.account === 'string' && { account: status.account.slice(0, 100) }) }
      : { ok: false, ...(typeof status.reason === 'string' && { reason: status.reason.slice(0, 200) }) };
    for (const socket of clients) send(socket, { type: 'feedback/changed' });
    feedbackQueue.kick();
  }
  else if (message?.type === 'feedback/result') feedbackRequests.get(message.id)?.(message), feedbackRequests.delete(message.id);
  // A plugin host (in the main process) relays its workspace sessions to this process this way.
  else if (message?.type === 'plugin/workspace') pluginWorkspace(message);
});
