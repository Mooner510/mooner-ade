import http from 'node:http';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { AdeEngine, AllowAllPolicy } from '@mooner/ade-core';
import { createLocalRuntime } from '@mooner/ade-runtime-local';
import { FileSessionStore } from '@mooner/ade-session-store';
import { RecordedAgentRunner } from '@mooner/ade-session-runner';
import { CodexAppAgent, ClaudeSdkAgent, CodexConnection, listClaudeModels, claudeAccount } from './agents.js';
import { fault, text, readText, saveText, serial, search, indexFiles, replaceInFile } from './files.js';
import { createLspManager } from './lsp.js';
import { validateUi } from './ui-state.js';
import { discoverRepositories } from './repositories.js';

const dataRoot = process.env.ADE_DATA_DIR || path.join(process.platform === 'win32' ? process.env.LOCALAPPDATA || os.homedir() : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'mooner-ade');
const webRoot = path.resolve(import.meta.dirname, '../../web/dist');
// pnpm can install node-pty's prebuilt spawn-helper without the executable bit, which makes every spawn fail (posix_spawnp).
if (process.platform !== 'win32') {
  try {
    const helper = path.join(path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    await fs.chmod(helper, 0o755);
  } catch { /* no prebuilt helper (source build) or node-pty missing; the readiness check reports it */ }
}
const pty = await import('node-pty').catch(() => null);
const ptyFactory = pty || { spawn() { throw fault('PTY_UNAVAILABLE', 'node-pty 설치 또는 네이티브 빌드를 확인하세요.'); } };
await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
const projects = new Map();
const opening = serial();
const registryWrite = serial();
const clients = new Set();
const lsp = createLspManager((id, message) => { const project = projects.get(id); if (project) broadcast(project, { type: 'lsp', message }); });
const sessions = new Set();
// Reusable local token (0600) so a second browser or a cleared cookie can reconnect without restarting the server.
const tokenFile = path.join(dataRoot, 'token');
let bootstrap = (await fs.readFile(tokenFile, 'utf8').catch(() => '')).trim();
if (!/^[a-f0-9]{64}$/.test(bootstrap)) {
  bootstrap = randomBytes(32).toString('hex');
  await fs.writeFile(tokenFile, bootstrap, { mode: 0o600 });
}
await fs.chmod(tokenFile, 0o600).catch(() => {});
let origin;
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
function broadcast(project, value) { for (const socket of clients) if (socket.projectId === project.id) send(socket, value); }
const errorValue = error => ({ code: error.code || 'OPERATION_FAILED', message: error.message || '작업에 실패했습니다.', retryable: ['EBUSY', 'EAGAIN', 'REVISION_CONFLICT'].includes(error.code), details: error.details });

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
    ? createLocalRuntime({ root: repo.worktreePath, scope: 'root', ptyFactory })
    : repo.sourceRuntime;
}

async function openProject(requested) {
  return opening(async () => {
    const root = await fs.realpath(text(requested, '프로젝트 경로'));
    if (!(await fs.stat(root)).isDirectory()) throw fault('INVALID_PROJECT', '폴더를 선택하세요.');
    const runtime = createLocalRuntime({ root, scope: 'root', ptyFactory });
    const discovered = await discoverRepositories(root, runtime.processes);
    const id = !discovered.multiRepo && discovered.repositories[0] ? discovered.repositories[0].id : createHash('sha256').update(root).digest('hex');
    if (projects.has(id)) return projects.get(id);
    const directory = path.join(dataRoot, id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const lockFile = await lock(directory);
    try {
      const store = new FileSessionStore(path.join(directory, 'runs'));
      const recovered = await store.recoverAll();
      const state = await readJson(path.join(directory, 'state.json'), { conversations: [], ui: {} });
      state.gitRepositories ||= {};
      state.ui ||= {};
      state.ui.gitRepositoryId ||= discovered.repositories[0]?.id || '';
      if (discovered.multiRepo) for (const conversation of state.conversations) {
        conversation.cwd = root; conversation.branch = null; conversation.workspaceMode = 'shared';
      }
      for (const conversation of state.conversations) {
        const runs = recovered.filter(record => record.session.conversationId === conversation.id);
        conversation.runs = runs.map(record => record.session.id);
        conversation.activeRun = null;
        for (const record of runs.sort((a, b) => a.session.startedAt - b.session.startedAt)) {
          const native = record.events.findLast(event => event.kind === 'session' && event.threadId);
          if (native) conversation.threadId = native.threadId;
        }
      }
      const engine = new AdeEngine({ runtime, policy: new AllowAllPolicy(), agents: [new CodexAppAgent(), new ClaudeSdkAgent()] });
      const repositories = discovered.repositories.map(repo => ({
        ...repo,
        sourceRuntime: createLocalRuntime({ root: repo.path, scope: 'root', ptyFactory }),
        worktreeEnabled: state.gitRepositories[repo.id]?.worktreeEnabled === true,
        worktreePath: path.join(directory, 'worktrees', repo.id),
        branch: `ade/repo-${repo.id}`
      }));
      const project = { id, root, directory, lockFile, runtime, engine, store, state, multiRepo: discovered.multiRepo, repositories, runner: new RecordedAgentRunner({ engine, store }), terminals: new Map(), jobs: new Map(), mutation: serial(), persist: serial() };
      project.save = () => project.persist(() => writeJson(path.join(directory, 'state.json'), state));
      for (const repo of repositories) if (repo.worktreeEnabled) await repoWorktree(project, repo);
      await project.save();
      await registryWrite(async () => {
        const recent = await readJson(path.join(dataRoot, 'recent.json'), []);
        await writeJson(path.join(dataRoot, 'recent.json'), [{ id, root }, ...recent.filter(item => item.id !== id)].slice(0, 20));
      });
      project.watcher = watchProject(project);
      projects.set(id, project);
      return project;
    } catch (error) { await fs.unlink(lockFile); throw error; }
  });
}
function watchProject(project) {
  let timer; const changed = new Set();
  try {
    return fsSync.watch(project.root, { recursive: true }, (_event, name) => {
      if (!name || /(^|[\\/])(\.git|node_modules|dist|\.idea)([\\/]|$)/.test(name)) return;
      changed.add(name.split(path.sep).join('/'));
      clearTimeout(timer);
      timer = setTimeout(() => { broadcast(project, { type: 'fs', paths: [...changed].slice(0, 200) }); changed.clear(); }, 150);
    });
  } catch { return null; } // ponytail: no recursive watch on this platform; clients keep polling.
}
async function snapshot(project) {
  return { id: project.id, root: project.root, multiRepo: project.multiRepo, repositories: project.repositories.map(({ id, name, path: repoPath, worktreeEnabled, worktreePath, branch }) => ({ id, name, path: repoPath, worktreeEnabled, worktreePath: worktreeEnabled ? worktreePath : null, branch: worktreeEnabled ? branch : null })), ...project.state,
    runs: (await project.store.list()).sort((a, b) => a.startedAt - b.startedAt), approvals: project.engine.approvalRequests,
    terminals: [...project.terminals].map(([id, terminal]) => ({ id, exited: terminal.exited, cwd: terminal.cwd })) };
}
async function readiness(project, providers = ['codex', 'claude']) {
  const result = {};
  for (const executable of providers) {
    try {
      if (executable === 'claude') {
        const account = await claudeAccount(project.root);
        result.claude = { installed: true, authenticated: account.authenticated, version: `agent-sdk · ${account.label}`, message: account.authenticated ? '준비됨' : 'claude auth login 실행 후 다시 확인하세요.' };
        continue;
      }
      const version = await project.runtime.processes.exec(executable, ['--version'], { timeoutMs: 5000 });
      if (version.exitCode !== 0) throw new Error(`${executable} 실행 실패`);
      let authenticated = false;
      const rpc = new CodexConnection(project.root);
      try { await rpc.initialize(); authenticated = Boolean((await rpc.call('account/read')).account); }
      finally { rpc.close(); }
      result[executable] = { installed: true, authenticated, version: version.stdout.trim(), message: authenticated ? '준비됨' : 'codex login 실행 후 다시 확인하세요.' };
    } catch (error) { result[executable] = { installed: false, authenticated: false, message: `${executable} 설치·버전·로그인을 확인하세요: ${error.message}` }; }
  }
  result.pty = { installed: typeof pty?.spawn === 'function', message: pty ? 'node-pty 로드됨 · 실제 PTY 동작은 터미널을 열어 확인' : 'node-pty 설치 및 네이티브 빌드를 확인하세요.' };
  return result;
}

async function startRun(project, input) {
  const requestedAgent = input.agentId || project.state.conversations.find(item => item.id === input.conversationId)?.agentId || 'codex';
  if (!['codex', 'claude'].includes(requestedAgent)) throw fault('INVALID_INPUT', 'Agent를 확인하세요.');
  let conversation = project.state.conversations.find(item => item.id === input.conversationId && !item.closedAt);
  if (conversation && conversation.agentId !== requestedAgent) conversation = null;
  const createdConversation = !conversation;
  if (!conversation) {
    if (!['shared', 'worktree'].includes(input.workspaceMode || 'shared')) throw fault('INVALID_INPUT', '작업 모드를 확인하세요.');
    const id = randomUUID(), workspaceMode = project.multiRepo ? 'shared' : input.workspaceMode || 'shared';
    const cwd = workspaceMode === 'worktree' ? path.join(project.directory, 'worktrees', id) : project.root;
    if (workspaceMode === 'worktree') { await fs.mkdir(path.dirname(cwd), { recursive: true }); await project.runtime.git.createWorktree(cwd, `ade/${id}`); }
    conversation = { id, agentId: requestedAgent, title: text(input.prompt, '질문', 100000).trim().replace(/\s+/g, ' ').slice(0, 72), cwd,
      branch: workspaceMode === 'worktree' ? `ade/${id}` : null, workspaceMode, runs: [], activeRun: null };
    project.state.conversations.push(conversation);
  }
  if (project.jobs.has(conversation.id)) throw fault('RUN_ACTIVE', '이 대화는 이미 실행 중입니다.', 409);
  text(input.prompt, '질문', 100000);
  if (conversation.removed) throw fault('WORKTREE_REMOVED', '제거된 작업 경로입니다. 새 대화를 만드세요.');
  // Reserve before any await: two HTTP requests must not start the same conversation.
  project.jobs.set(conversation.id, null);
  try {
    const catalog = await listAgentModels(project, requestedAgent);
    const selectedModel = input.model || null, selectedEffort = input.effort || null;
    const modelInfo = selectedModel && catalog.models.find(model => model.id === selectedModel);
    if (selectedModel && !modelInfo) throw fault('INVALID_MODEL', '선택한 모델을 사용할 수 없습니다. 모델 목록을 새로고침하세요.');
    if (selectedEffort && (!modelInfo || !modelInfo.efforts.includes(selectedEffort))) throw fault('INVALID_EFFORT', '선택한 Effort를 해당 모델에서 지원하지 않습니다.');
    conversation.model = selectedModel; conversation.effort = selectedEffort;
    const ready = await readiness(project, [conversation.agentId]);
    if (closing) throw fault('SHUTTING_DOWN', '서버가 종료 중입니다.', 503);
    if (!ready[conversation.agentId]?.authenticated) throw fault('PROVIDER_UNAVAILABLE', ready[conversation.agentId]?.message || '제공자를 사용할 수 없습니다.');
    const iterator = project.runner.runAgent(conversation.agentId, input.prompt, {
      cwd: project.multiRepo ? project.root : conversation.cwd, threadId: conversation.threadId, projectId: project.id,
      model: selectedModel || undefined, effort: selectedEffort || undefined,
      fullAccess: input.fullAccess === true,
      conversationId: conversation.id, approvalMode: 'interactive',
      onApprovalRequest: () => broadcast(project, { type: 'approvals', approvals: project.engine.approvalRequests })
    });
    const first = await iterator.next();
    if (closing) { await iterator.return(); throw fault('SHUTTING_DOWN', '서버가 종료 중입니다.', 503); }
    if (first.done) throw new Error('Agent did not start');
    conversation.activeRun = first.value.sessionId;
    conversation.runs.push(first.value.sessionId);
    try { await project.save(); }
    catch (error) { await iterator.return(); throw error; }
    broadcast(project, { type: 'event', event: first.value });
    broadcast(project, { type: 'snapshot', snapshot: await snapshot(project) });
    const job = (async () => {
      try {
        for await (const event of iterator) {
          if (event.kind === 'session') { conversation.threadId = event.threadId; await project.save(); }
          broadcast(project, { type: 'event', event });
        }
      } catch (error) { broadcast(project, { type: 'error', error: errorValue(error) }); }
      finally {
        conversation.activeRun = null;
        project.jobs.delete(conversation.id);
        await project.save();
        broadcast(project, { type: 'snapshot', snapshot: await snapshot(project) });
      }
    })();
    project.jobs.set(conversation.id, job);
    void job.catch(error => broadcast(project, { type: 'error', error: errorValue(error) }));
    return { runId: conversation.activeRun, conversationId: conversation.id };
  } catch (error) {
    project.jobs.delete(conversation.id);
    if (createdConversation && !conversation.runs.length) {
      project.state.conversations = project.state.conversations.filter(item => item.id !== conversation.id);
      if (conversation.branch) await project.runtime.git.removeWorktree(conversation.cwd).catch(() => {});
    }
    throw error;
  }
}

async function listAgentModels(project, agentId) {
  if (agentId === 'claude') return { agentId, models: await listClaudeModels(project.root) };
  const rpc = new CodexConnection(project.root);
  try { await rpc.initialize(); return { agentId, models: await rpc.listModels() }; }
  finally { rpc.close(); }
}

// `git status --short --branch` yields "## main...origin/main"; the UI and the integrate check need the bare name.
async function currentBranch(runtime) {
  const named = await runtime.processes.exec('git', ['branch', '--show-current']);
  if (named.exitCode === 0 && named.stdout.trim()) return named.stdout.trim();
  const head = await runtime.processes.exec('git', ['rev-parse', '--short', 'HEAD']);
  return head.exitCode === 0 ? `(HEAD ${head.stdout.trim()})` : '';
}
function workspaceFor(project, input) {
  if (!input.conversationId) return project.runtime;
  const conversation = project.state.conversations.find(c => c.id === input.conversationId && !c.removed);
  if (!conversation) throw fault('NOT_FOUND', '작업 경로가 없습니다.', 404);
  return createLocalRuntime({ root: conversation.cwd, scope: 'root', ptyFactory });
}
async function route(action, input, project) {
  if (action === 'recent') return readJson(path.join(dataRoot, 'recent.json'), []);
  if (action === 'project/open') return snapshot(await openProject(input.path));
  if (action === 'readiness') return readiness(project || { root: os.homedir(), runtime: createLocalRuntime({ root: os.homedir() }) });
  if (!project) throw fault('NOT_FOUND', '프로젝트를 먼저 여세요.', 404);
  const repo = ['git/status', 'git/diff', 'git/show', 'git/discard', 'git/branches', 'git/checkout', 'git/stage', 'git/unstage', 'git/commit', 'worktrees', 'git/worktree-setting', 'git/worktree/integrate'].includes(action)
    ? selectedRepository(project, input) : null;
  const runtime = repo ? (action === 'git/worktree-setting' || action === 'git/worktree/integrate' ? repo.sourceRuntime : repositoryRuntime(project, repo)) : workspaceFor(project, input);
  const workspace = runtime.workspace;
  switch (action) {
    case 'snapshot': return snapshot(project);
    case 'agents/catalog': return Promise.all(['codex', 'claude'].map(async agentId => {
      try { return await listAgentModels(project, agentId); }
      catch (error) { return { agentId, models: [], error: error.message }; }
    }));
    case 'readiness': return readiness(project);
    case 'ui': {
      project.state.ui = validateUi(input.ui); await project.save(); return {};
    }
    case 'files/list': return workspace.listFiles(input.path || '.');
    case 'files/mkdir': return project.mutation(async () => { const target = await workspace.resolve(text(input.path, '경로')); await fs.mkdir(target); return {}; });
    case 'files/read': return readText(workspace, input.path);
    case 'files/index': return indexFiles(workspace);
    case 'files/search': return search(workspace, input.query, input);
    case 'files/replace': return project.mutation(async () => {
      const result = await replaceInFile(workspace, text(input.path, '경로'), input.revision, input);
      if (result.count) broadcast(project, { type: 'file', path: input.path, owner: 'editor' }); return result;
    });
    case 'files/save': return project.mutation(async () => {
      const result = await saveText(workspace, input.path, input.content, input.revision);
      broadcast(project, { type: 'file', path: input.path, owner: 'editor' }); return result;
    });
    case 'files/rename': return project.mutation(async () => {
      const from = await workspace.resolve(text(input.path, '경로')), to = await workspace.resolve(text(input.to, '새 경로'));
      const stat = await fs.lstat(from);
      if (stat.isFile() && typeof input.revision === 'string') {
        const old = await readText(workspace, input.path);
        if (old.revision !== input.revision) throw fault('REVISION_CONFLICT', '파일이 변경되었습니다.', 409, old);
      }
      if (await fs.lstat(to).then(() => true, () => false)) throw fault('ALREADY_EXISTS', '같은 이름이 이미 있습니다.', 409);
      if (to.startsWith(from + path.sep)) throw fault('INVALID_INPUT', '폴더를 자기 자신 안으로 옮길 수 없습니다.');
      await fs.mkdir(path.dirname(to), { recursive: true });
      await workspace.resolve(input.to);
      await fs.rename(from, to); return {};
    });
    case 'files/delete': return project.mutation(async () => {
      const target = await workspace.resolve(text(input.path, '경로'));
      if (target === workspace.root) throw fault('INVALID_INPUT', '프로젝트 루트는 삭제할 수 없습니다.');
      const stat = await fs.lstat(target);
      if (stat.isFile() && typeof input.revision === 'string') {
        const current = await readText(workspace, input.path);
        if (current.revision !== input.revision) throw fault('REVISION_CONFLICT', '파일이 변경되었습니다.', 409, current);
      }
      await fs.rm(target, { recursive: true }); return {};
    });
    case 'git/status': {
      const output = await runtime.processes.exec('git', ['status', '--porcelain=v1', '-z']);
      if (output.exitCode !== 0) throw new Error(output.stderr);
      const entries = output.stdout.split('\0'), changes = [];
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]; if (!entry) continue;
        const status = entry.slice(0, 2), file = entry.slice(3);
        const original = /[RC]/.test(status) ? entries[++index] : undefined;
        changes.push({ status, path: file, original });
      }
      const headDiff = await runtime.processes.exec('git', ['--literal-pathspecs', 'diff', '--numstat', 'HEAD']);
      const stats = headDiff.exitCode === 0 ? [headDiff.stdout] : [
        (await runtime.processes.exec('git', ['--literal-pathspecs', 'diff', '--numstat'])).stdout,
        (await runtime.processes.exec('git', ['--literal-pathspecs', 'diff', '--cached', '--numstat'])).stdout
      ];
      let additions = 0, deletions = 0;
      for (const line of stats.join('\n').split('\n')) {
        const [added, deleted] = line.split('\t');
        if (/^\d+$/.test(added)) additions += Number(added);
        if (/^\d+$/.test(deleted)) deletions += Number(deleted);
      }
      for (const change of changes.filter(item => item.status === '??')) {
        try {
          const { content } = await readText(workspace, change.path);
          additions += content ? content.split('\n').length - Number(content.endsWith('\n')) : 0;
        } catch (error) { if (!['BINARY_FILE', 'UNSUPPORTED_FILE'].includes(error.code)) throw error; }
      }
      return { ...(await runtime.git.status()), branch: await currentBranch(runtime), changes, additions, deletions };
    }
    case 'git/diff': {
      if (input.path) await workspace.resolve(input.path);
      if (input.untracked) return { diff: (await readText(workspace, input.path)).content };
      const result = await runtime.processes.exec('git', ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', ...(input.staged ? ['--cached'] : []), '--', ...(input.path ? [input.path] : [])]);
      if (result.exitCode !== 0) throw new Error(result.stderr);
      return { diff: result.stdout };
    }
    case 'git/stage': case 'git/unstage': return project.mutation(async () => {
      if (!Array.isArray(input.files) || !input.files.length || input.files.length > 1000) throw fault('INVALID_INPUT', '파일을 선택하세요.');
      for (const file of input.files) { text(file); await workspace.resolve(file); }
      const result = await runtime.processes.exec('git', ['--literal-pathspecs', ...(action.endsWith('/stage') ? ['add'] : ['restore', '--staged']), '--', ...input.files]);
      if (result.exitCode !== 0) throw new Error(result.stderr); return {};
    });
    case 'git/show': {
      text(input.path, '경로'); await workspace.resolve(input.path);
      if (input.working) return { content: await readText(workspace, input.path).then(file => file.content, () => '') };
      const result = await runtime.processes.exec('git', ['--literal-pathspecs', 'show', `${input.staged ? '' : 'HEAD'}:${input.path}`]);
      return { content: result.exitCode === 0 ? result.stdout : '' };
    }
    case 'git/discard': return project.mutation(async () => {
      if (!Array.isArray(input.files) || !input.files.length || input.files.length > 1000) throw fault('INVALID_INPUT', '파일을 선택하세요.');
      for (const file of input.files) {
        text(file); const target = await workspace.resolve(file);
        if (target === workspace.root) throw fault('INVALID_INPUT', '프로젝트 루트는 되돌리거나 삭제할 수 없습니다.');
        const tracked = await runtime.processes.exec('git', ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', file]);
        if (tracked.exitCode === 0) {
          const result = await runtime.processes.exec('git', ['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', file]);
          if (result.exitCode !== 0) throw new Error(result.stderr);
        } else await fs.rm(target, { recursive: true, force: true });
      }
      return {};
    });
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
    case 'git/commit': return project.mutation(async () => ({ commit: await runtime.git.commit(text(input.message, '커밋 메시지')) }));
    case 'git/worktree-setting': return project.mutation(async () => {
      if (!repo || typeof input.enabled !== 'boolean') throw fault('INVALID_INPUT', '저장소 worktree 설정을 확인하세요.');
      if (input.enabled === repo.worktreeEnabled) return {};
      if (input.enabled) await repoWorktree(project, repo);
      else {
        const status = await createLocalRuntime({ root: repo.worktreePath, scope: 'root', ptyFactory }).git.status();
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
      const worktreeStatus = await createLocalRuntime({ root: repo.worktreePath, scope: 'root', ptyFactory }).git.status();
      if (!worktreeStatus.clean) throw fault('WORKTREE_DIRTY', 'worktree 변경을 먼저 커밋하세요.', 409);
      await repo.sourceRuntime.git.integrateWorktree(repo.branch);
      return {};
    });
    case 'conversation/create': return project.mutation(async () => {
      if (!['codex', 'claude'].includes(input.agentId) || !['shared', 'worktree'].includes(input.workspaceMode)) throw fault('INVALID_INPUT', '제공자와 작업 모드를 확인하세요.');
      const title = text(input.title, '대화 제목', 200);
      const id = randomUUID(), branch = `ade/${id}`;
      const workspaceMode = project.multiRepo ? 'shared' : input.workspaceMode;
      const cwd = workspaceMode === 'worktree' ? path.join(project.directory, 'worktrees', id) : project.root;
      if (workspaceMode === 'worktree') { await fs.mkdir(path.dirname(cwd), { recursive: true }); await project.runtime.git.createWorktree(cwd, branch); }
      const conversation = { id, agentId: input.agentId, title, cwd, branch: workspaceMode === 'worktree' ? branch : null, workspaceMode, runs: [], activeRun: null };
      project.state.conversations.push(conversation); await project.save(); return conversation;
    });
    case 'conversation/close': case 'conversation/reopen': return project.mutation(async () => {
      const conversation = project.state.conversations.find(item => item.id === text(input.conversationId));
      if (!conversation) throw fault('NOT_FOUND', '대화를 찾을 수 없습니다.', 404);
      if (action === 'conversation/close') conversation.closedAt = Date.now();
      else delete conversation.closedAt;
      await project.save(); broadcast(project, { type: 'snapshot', snapshot: await snapshot(project) }); return {};
    });
    case 'run/start': return startRun(project, input);
    case 'run/stop': {
      if (!(await project.store.load(text(input.runId)))) throw fault('NOT_FOUND', '실행이 없습니다.', 404);
      return { stopped: project.runner.stopAgent(input.runId) };
    }
    case 'run/events': return project.runner.replay(text(input.runId), { afterSequence: input.afterSequence || 0 });
    case 'approval': {
      if (typeof input.approved !== 'boolean') throw fault('INVALID_INPUT', '승인 결정을 확인하세요.');
      const decided = await project.engine.decideApproval(text(input.id), input.approved);
      if (!decided) throw fault('APPROVAL_EXPIRED', '만료되거나 취소된 승인입니다.', 409);
      broadcast(project, { type: 'approvals', approvals: project.engine.approvalRequests }); return {};
    }
    case 'worktrees': return runtime.git.worktrees();
    case 'worktree/remove': case 'worktree/integrate': return project.mutation(async () => {
      const conversation = project.state.conversations.find(c => c.id === input.conversationId && c.branch && !c.removed);
      if (!conversation || input.confirm !== conversation.branch) throw fault('INVALID_INPUT', '대상 브랜치를 확인하세요.');
      if (project.jobs.has(conversation.id) || [...project.terminals.values()].some(t => !t.exited && t.cwd === conversation.cwd)) throw fault('WORKTREE_BUSY', '작업과 터미널을 먼저 종료하세요.', 409);
      if (!(await runtime.git.status()).clean) throw fault('WORKTREE_DIRTY', '작업 경로의 변경을 먼저 커밋하세요.', 409);
      if (action === 'worktree/remove') { await project.runtime.git.removeWorktree(conversation.cwd); conversation.removed = true; }
      else {
        if ((await currentBranch(project.runtime)) !== input.targetBranch) throw fault('TARGET_CHANGED', '통합 대상 브랜치가 변경되었습니다. 다시 확인하세요.', 409);
        await project.runtime.git.integrateWorktree(conversation.branch);
      }
      await project.save(); return {};
    });
    case 'terminal/open': {
      if (project.terminals.size >= 32) throw fault('TERMINAL_LIMIT', '최대 32개 터미널을 지원합니다.');
      const cwd = input.path ? await workspace.resolve(text(input.path, '경로')) : workspace.root;
      if (!(await fs.stat(cwd)).isDirectory()) throw fault('INVALID_INPUT', '폴더를 선택하세요.');
      const native = await runtime.terminal.open({ cwd });
      const id = randomUUID(), terminal = { native, cwd, buffer: '', sequence: 0, exited: false };
      project.terminals.set(id, terminal);
      native.onData(data => { terminal.buffer = (terminal.buffer + data).slice(-262144); terminal.sequence++; broadcast(project, { type: 'terminal', id, data, sequence: terminal.sequence }); });
      native.onExit(event => { terminal.exited = true; broadcast(project, { type: 'terminal/exit', id, ...event }); });
      return { id };
    }
    case 'terminal/close': {
      const terminal = project.terminals.get(input.id); if (!terminal) throw fault('NOT_FOUND', '터미널이 없습니다.', 404);
      terminal.native.close(); project.terminals.delete(input.id); return {};
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
async function body(request) {
  if (request.headers['content-type'] !== 'application/json') throw fault('INVALID_CONTENT_TYPE', 'JSON 요청만 허용됩니다.', 415);
  const chunks = []; let size = 0;
  const limit = request.url === '/api/ui' ? 64 * 1024 * 1024 : 3 * 1024 * 1024;
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
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    if (closing) throw fault('SHUTTING_DOWN', '서버가 종료 중입니다.', 503);
    if (!trusted(request, false)) throw fault('UNTRUSTED_HOST', '잘못된 Host입니다.', 403);
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'POST' || !trusted(request)) throw fault('UNTRUSTED_ORIGIN', '동일 출처 POST만 허용됩니다.', 403);
      const input = await body(request);
      let value;
      if (url.pathname === '/api/auth') {
        if (!authenticated(request)) {
          if (!bootstrap || input.token !== bootstrap) throw fault('UNAUTHORIZED', '서버에 표시된 접속 링크를 사용하세요.', 401);
          const token = randomBytes(32).toString('hex'); sessions.add(token);
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
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws' || !trusted(request) || !authenticated(request)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
});
wss.on('connection', socket => {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
  socket.on('message', async raw => {
    try {
      const message = JSON.parse(raw.toString());
      const project = projects.get(message.projectId);
      if (!project) throw fault('NOT_FOUND', '프로젝트가 없습니다.', 404);
      if (message.type === 'subscribe') {
        socket.projectId = project.id;
        send(socket, { type: 'snapshot', snapshot: await snapshot(project) });
        for (const session of await project.store.list()) {
          for (const event of await project.runner.replay(session.id, { afterSequence: message.cursors?.[session.id] || 0 })) send(socket, { type: 'event', event });
        }
        for (const [id, terminal] of project.terminals) send(socket, { type: 'terminal/replay', id, data: terminal.buffer, sequence: terminal.sequence, exited: terminal.exited });
      } else if (message.type === 'lsp/reset') {
        if (socket.projectId === project.id) lsp.close(project.id);
      } else if (message.type === 'lsp') {
        if (socket.projectId !== project.id || !message.message || typeof message.message !== 'object') throw fault('INVALID_INPUT', '잘못된 LSP 메시지입니다.');
        lsp.send(project.id, project.root, message.message);
      } else if (socket.projectId === project.id) {
        const terminal = project.terminals.get(message.id);
        if (!terminal || terminal.exited) throw fault('TERMINAL_EXITED', '터미널이 종료되었습니다.');
        if (message.type === 'terminal/input') {
          if (typeof message.data !== 'string' || message.data.length > 16384) throw fault('INVALID_INPUT', '잘못된 터미널 입력입니다.');
          terminal.native.write(message.data);
        } else if (message.type === 'terminal/resize') {
          if (![message.cols, message.rows].every(n => Number.isInteger(n) && n >= 1 && n <= 1000)) throw fault('INVALID_INPUT', '잘못된 터미널 크기입니다.');
          terminal.native.resize(message.cols, message.rows);
        }
        else throw fault('INVALID_INPUT', '잘못된 메시지입니다.');
      }
    } catch (error) { send(socket, { type: 'error', error: errorValue(error) }); }
  });
});
// Snapshot polling expires approval buttons even when a provider emits no further events.
const timer = setInterval(() => { for (const project of projects.values()) broadcast(project, { type: 'approvals', approvals: project.engine.approvalRequests }); }, 1000);
timer.unref();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.ADE_PORT) || 0, '127.0.0.1', resolve); });
origin = `http://127.0.0.1:${server.address().port}`;
console.log(`무너에이드: ${origin}/#token=${bootstrap}`);
let closing = false;
async function shutdown() {
  if (closing) return; closing = true; clearInterval(timer);
  for (const project of projects.values()) {
    for (const session of project.engine.sessions) project.engine.stopAgent(session.id);
    project.watcher?.close(); lsp.close(project.id);
    for (const terminal of project.terminals.values()) terminal.native.close();
    await Promise.allSettled([...project.jobs.values()]);
    await project.save(); await fs.unlink(project.lockFile);
  }
  for (const client of clients) client.close(); wss.close(); server.close();
}
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
