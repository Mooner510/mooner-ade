import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fault } from './files.js';
import { resolveAgentCommand, spawnAgent } from './agent-spawn.js';
import { CODEX_KEY_ENV } from './agent-keys.js';
import { ARTIFACT_FLAG_SETTINGS, ASK_SKIPPED, askUserInput, approvalLine, buildClaudeArgs, cliPermissionMode, controlLine, EFFORTS, normalizeClaude, PERMISSION_MODES, planRevision, refusalWith, transcriptEvents, uiPermissionMode, userLine, validMessageUuid, wantsArtifact } from './chat-claude.js';
import { readCursorStoreUsage } from './cursor-context.js';
import { cleanCursorSummarizeOutput, isCursorSummarizeCommand, runCursorSummarize } from './cursor-summarize.js';
import { chatAgents, chatCapabilities, createChatProtocol, cursorEffortOption } from './chat-rpc.js';
import { cleanChatTitle, resolveChatTitle, segmentUserEvents } from './chat-title.js';
import { readAutoCompact, readClaudeSettingsLayers, writeAutoCompact } from './claude-auto-compact.js';
import { readSessionCache } from './claude-cache.js';
import { readClaudeDefaults } from './claude-defaults.js';
import { createLocalRuntime } from './runtime.js';
import { chatMcpServers } from './terminal-sessions.js';
import { UI_PROMPT } from './chat-ui-prompt.js';

const ID = /^[a-zA-Z0-9-]{1,128}$/;
const MAX_LINE = 8 * 1024 * 1024, KEEP_EVENTS = 4000, IDLE_MS = 10 * 60_000;
// Set once any Claude child echoed one of our plain messages back by its uuid (--replay-user-messages): from then on a turn that ended without the echo is known not to have taken the message in.
let echoesSeen = false;
const BACKGROUND_QUIET_MS = 3 * 60_000;
export const chatFolder = (directory, id) => {
  if (typeof id !== 'string' || !ID.test(id)) throw fault('INVALID_INPUT', '잘못된 채팅 ID입니다.');
  return path.join(directory, 'chat', id);
};
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
// Normal child end and intentional idle kill must not read as a failed agent. macOS often reports SIGTERM as exit 143 (128+15) with no signal name.
export const agentExitBenign = (code, signal) => code === 0 || signal === 'SIGTERM' || signal === 'SIGINT' || code === 143 || code === 130;
const addTokens = (base, extra) => ({ input: base.input + extra.input, output: base.output + extra.output, cacheRead: base.cacheRead + extra.cacheRead, cacheCreate: base.cacheCreate + extra.cacheCreate });
// The usual price ratios (output 5x input, cache read 0.1x, cache write 1.25x): one number per turn that the cost can be divided by.
const weigh = usage => usage.input + usage.output * 5 + usage.cacheRead * 0.1 + usage.cacheCreate * 1.25;
const mergeTurnUsage = (current, patch) => ({
  input: patch.input || current?.input || 0,
  output: patch.output || current?.output || 0,
  cacheRead: patch.cacheRead || current?.cacheRead || 0,
  cacheCreate: patch.cacheCreate || current?.cacheCreate || 0,
});

// One chat tab = one transcript + (while a turn or an approval is open) one `claude -p` child. The child starts on the first
// message and is resumed with `--resume <session id>` when it ended in between, so closing the app never loses the conversation.
// `env` and `executableArgs` may be functions, read at every launch, so a change (an API key turned on, a plugin added) reaches the next (re)start.
const argsOf = args => typeof args === 'function' ? args() : args;
// On Windows the agent's Bash tool runs Git Bash as a non-login shell, which sets no locale: its tools then treat UTF-8 as raw bytes, and
// `ls 존재하지않는폴더` reports the name as escaped bytes instead of text. With no locale variable at all, LC_CTYPE=C.UTF-8 fixes the encoding only;
// message language (LANG, LC_MESSAGES) stays as it was, and a locale the user set is never touched.
export function withUtf8Ctype(env, platform = process.platform) {
  if (platform === 'win32' && !env.LC_ALL && !env.LC_CTYPE && !env.LANG) env.LC_CTYPE = 'C.UTF-8';
  return env;
}

// `procHost` (the pty-host's piped processes, pty-client.js) runs the agent outside this server: `detach()` then leaves it running for the
// next server, which takes it over from `live.json` exactly where this one stopped reading. Without it the agent is a child of this server.
export async function openChatSession({ directory, id, projectId, cwd, agent = 'claude', env = {}, spawnProcess = spawnAgent, procHost = null, executable = agent === 'cursor' ? 'cursor-agent' : agent, executableArgs = [], onEvent, onState, prepare, recover, defaults, quietMs = BACKGROUND_QUIET_MS }) {
  if (!chatAgents.includes(agent)) throw fault('INVALID_INPUT', '지원하지 않는 에이전트입니다.');
  const root = chatFolder(directory, id);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const metaFile = path.join(root, 'meta.json'), logFile = path.join(root, 'events.jsonl'), liveFile = path.join(root, 'live.json');
  // Read once: whatever happens next, it must not be taken over twice.
  const handed = await fs.readFile(liveFile, 'utf8').then(JSON.parse, () => null);
  if (handed) await fs.rm(liveFile, { force: true });
  const saved = await fs.readFile(metaFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  // Claude: meta holds only what the user picked in this chat. Unset model/effort/permissionMode mean "whatever a plain `claude` would use" (settings.json), so no flag is passed.
  const meta = { sessionId: undefined, configDir: undefined, model: undefined, effort: undefined, worktree: false, addDirs: [], permissionMode: agent === 'claude' ? undefined : 'default', sandbox: null, network: false, runEverything: false, costBase: 0, resumeAt: undefined, fork: false, ...JSON.parse(saved ?? '{}') };
  // Settings' defaults for a brand-new chat; a saved chat keeps what it has. Only modes this agent can apply, and never bypassPermissions.
  if (saved === null && defaults) {
    const caps = chatCapabilities(agent);
    if (caps.permissionModes.includes(defaults.permissionMode) && defaults.permissionMode !== 'bypassPermissions') meta.permissionMode = defaults.permissionMode;
    if (EFFORTS.includes(defaults.effort)) meta.effort = defaults.effort;
  }
  if (saved !== null && (meta.agent ?? 'claude') !== agent) throw fault('INVALID_INPUT', '저장된 대화의 에이전트가 다릅니다.');
  cwd = meta.cwd ?? cwd;
  let events = [], seq = 0;
  try {
    for (const line of (await fs.readFile(logFile, 'utf8')).split('\n')) { if (!line) continue; try { const event = JSON.parse(line); events.push(event); seq = Math.max(seq, event.seq); } catch { /* torn last line after a crash */ } }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  events = events.slice(-KEEP_EVENTS);

  const state = { agent, capabilities: chatCapabilities(agent), status: 'idle', model: meta.model ?? null, effort: meta.effort ?? null, worktree: meta.worktree === true, addDirs: meta.addDirs, permissionMode: meta.permissionMode ?? 'default', sandbox: meta.sandbox ?? null, network: meta.network === true, runEverything: meta.runEverything === true, sessionId: meta.sessionId ?? null, costUsd: agent === 'claude' ? meta.costBase : null, turns: 0, durationMs: 0,
    contextTokens: 0, contextWindow: null, autoCompact: null, tokens: zero(), slashCommands: [], commandInfo: [], tools: [], pending: 0, error: null, startedAt: Date.now(),
    segmentTitles: { custom: '', ai: '', agent: '' }, chatTitle: '', liveTasks: [] }; // liveTasks: subagents (Agent call ids) running in the current child
  // apiKey: this chat's CLI runs on an API key (Settings > AI 툴, or the user's own environment), not the CLI login. The UI then shows "API Usage"
  // instead of a share of the plan's limits. Read from what the child is launched with, so it follows the setting from the next start on.
  state.cwd = meta.worktreePath ?? cwd; // the folder the CLI runs in: the UI shows file paths under it as relative paths
  const usesApiKey = launch => Boolean(agent === 'claude' ? launch.ANTHROPIC_API_KEY : agent === 'codex' ? launch[CODEX_KEY_ENV] : launch.CURSOR_API_KEY);
  state.apiKey = usesApiKey({ ...process.env, ...(typeof env === 'function' ? env() : env) });
  // A turn is several API calls: `turnDone` holds the calls already finished, `turnUsage` the one streaming (`liveId`). result.usage is the whole turn, so it replaces both.
  // The API reports a message's real output_tokens only once, at its end (message_delta), so while it streams the shown output is the larger of that report and an
  // estimate: the CLI's thinking estimate plus the streamed text / tool input (`streamBytes`, ~4 bytes a token, so it runs under the real count and never overshoots).
  let costPerUnit = 0;
  let turnUsage = null, thinkingTokens = 0, streamBytes = 0, outputFinal = false, turnDone = zero(), liveId = null;
  const resetLive = () => { turnUsage = null; thinkingTokens = 0; streamBytes = 0; outputFinal = false; turnDone = zero(); liveId = null; };
  const nextMessage = id => { if (id == null || id !== liveId) { if (turnUsage) turnDone = addTokens(turnDone, turnUsage); turnUsage = null; thinkingTokens = 0; streamBytes = 0; outputFinal = false; liveId = id ?? null; } };
  // The transcript with rewinds applied, and the last request not yet answered. Both are read on every state publish (token updates included),
  // so they are kept until the next stored event instead of being rebuilt from up to 6000 events each time. Callers must not mutate them.
  let retainedCache = null, unansweredCache;
  const invalidate = () => { retainedCache = null; unansweredCache = undefined; };
  function retainedEvents() {
    if (retainedCache) return retainedCache;
    let kept = [];
    for (const event of events) {
      if (event.kind === 'rewind') { const at = kept.findIndex(item => item.kind === 'message' && item.uuid === event.uuid); if (at >= 0) kept = kept.slice(0, at + 1); }
      else kept.push(event);
    }
    return retainedCache = kept;
  }
  // An alias ("sonnet") has no catalog row of its own: the family's first (newest) row stands in, else Auto Compact would be judged against 200k and switched off.
  const maxContextForModel = model => (model && /\[1m\]|-1m\b/i.test(model) ? 1_000_000 : (state.capabilities.catalog?.find(item => item.id === model) ?? state.capabilities.catalog?.find(item => item.family === model))?.window) || state.contextWindow || 200_000;
  // Where this chat's Claude Code keeps its settings and transcripts: the chat's own account, else the one a plain `claude` in this environment would use.
  const configDirOf = () => meta.configDir || (typeof env === 'function' ? env() : env)?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  // Several refreshes can be in flight (open, catalog, init, result); only the newest one's answer is applied.
  // "auto" is the one window ADE works out itself. Claude Code tunes its own "auto" per account and, for a 1M model, may not compact before the full window,
  // so the window the gauge shows is handed to the CLI (CLAUDE_CODE_AUTO_COMPACT_WINDOW) at launch. A window the user set in settings or env is left to the CLI.
  let compactGeneration = 0, launchedWindow = null;
  const handedWindow = compact => (compact?.source === 'auto' ? compact.window : null);
  const refreshAutoCompact = async (model = state.model) => {
    if (agent !== 'claude') { if (state.autoCompact) { state.autoCompact = null; publish(); } return; }
    const generation = ++compactGeneration, configDir = configDirOf();
    const next = await readAutoCompact(configDir, cwd, model, maxContextForModel(model));
    if (generation !== compactGeneration) return;
    const prev = JSON.stringify(state.autoCompact), ready = JSON.stringify(next);
    if (prev !== ready) { state.autoCompact = next; publish(); }
    // The running child was started with another window (the model turned out different): the next message resumes the session with the right one.
    if (child && handedWindow(next) !== launchedWindow) { restartWhenQuiet(); }
  };
  void refreshAutoCompact();
  // The prompt cache's clock, read from the session's transcript (the same reading the terminal's cache timer uses): `state.cache` = the last main-thread
  // request, its cache lifetime and the context size it read. Read when a turn ends or the context is compacted, not on a timer: the countdown itself runs in the page.
  let cacheReading = null, cacheBusy = false, cacheLater = null;
  const refreshCache = async () => {
    if (agent !== 'claude' || closed || !state.sessionId || cacheBusy) return;
    cacheBusy = true;
    try {
      const configDir = configDirOf();
      cacheReading = await readSessionCache(configDir, { sessionId: state.sessionId, cwd: meta.worktreePath ?? cwd }, cacheReading, { idle: false });
      const next = cacheReading?.value ?? null;
      if (!closed && JSON.stringify(next) !== JSON.stringify(state.cache ?? null)) { state.cache = next; publish(); }
    } catch { /* an unreadable transcript keeps the last reading */ } finally { cacheBusy = false; }
  };
  // The CLI writes the transcript a moment after it reports the result.
  const refreshCacheSoon = () => { clearTimeout(cacheLater); cacheLater = setTimeout(() => void refreshCache(), 500); cacheLater.unref?.(); };
  // Until the CLI's init event names the real model and mode, show what a plain `claude` would use here (settings.json). Never stored, never passed as a flag.
  if (agent === 'claude') void readClaudeDefaults(configDirOf(), cwd).then(found => {
    if (closed) return;
    let changed = false;
    if (meta.effort === undefined && state.effort === null && found.effort) { state.effort = found.effort; changed = true; }
    if (meta.permissionMode === undefined && !state.sessionId && found.permissionMode && state.permissionMode === 'default') { state.permissionMode = found.permissionMode; changed = true; }
    if (!meta.model && !state.model && found.model) { state.model = found.model; changed = true; }
    if (changed) publish();
  });
  // Cursor setting changes run one after another on the ACP session (they never wait for the running turn); `configuring` is true while any is in flight.
  let configuring = false, configChain = Promise.resolve(), configCount = 0;
  let child = null, protocol = null, closed = false, turnOpen = false, turnSeq = 0, restartAfterTurn = false, idleTimer = null, writing = Promise.resolve(), publishTimer = null, lastCommandOutput = null;
  let reopened = false, activityTimer = null; // reopened: the turn is "open" only because background output arrived after a `result`
  if (agent === 'claude' && state.sessionId) void refreshCache(); // a reopened chat shows the cache clock it had
  // Claude: the message streaming right now per subagent ('' = main thread). Text deltas name no message; they belong to the latest start of their own stream.
  const streamIds = new Map(), toolInputSize = new Map();
  const taskIds = new Map(), approvals = new Map(), controls = new Map(), steers = new Map(); // steers: uuid -> { text, images, previews } sent into a running turn, not yet taken in by it
  let cursorAcpUsageAt = 0, cursorStorePoll = null, cursorStoreUntil = 0;
  const stopCursorStorePoll = () => { if (cursorStorePoll) { clearInterval(cursorStorePoll); cursorStorePoll = null; } };
  const noteCursorAcpUsage = event => {
    if (agent !== 'cursor' || event.contextSource === 'store') return;
    if (event.contextTokens > 0) cursorAcpUsageAt = Date.now();
  };
  const refreshCursorStoreContext = async () => {
    if (agent !== 'cursor' || closed || process.env.CURSOR_STORE_CONTEXT === '0') return;
    const sessionId = state.sessionId ?? meta.sessionId;
    if (!sessionId) return;
    if (cursorAcpUsageAt && Date.now() - cursorAcpUsageAt < 5_000) return;
    const reading = await readCursorStoreUsage(sessionId).catch(() => null);
    if (!reading) return;
    if (cursorAcpUsageAt && Date.now() - cursorAcpUsageAt < 60_000 && state.contextTokens > 0 && reading.contextTokens <= state.contextTokens) return;
    if (reading.contextTokens === state.contextTokens && (reading.contextWindow ?? state.contextWindow) === state.contextWindow) return;
    emit({ kind: 'usage', contextTokens: reading.contextTokens, contextWindow: reading.contextWindow ?? state.contextWindow, contextSource: 'store' });
  };
  const startCursorStorePoll = (untilMs = Date.now() + 90_000) => {
    if (agent !== 'cursor' || process.env.CURSOR_STORE_CONTEXT === '0') return;
    cursorStoreUntil = Math.max(cursorStoreUntil, untilMs);
    if (cursorStorePoll) return;
    void refreshCursorStoreContext();
    cursorStorePoll = setInterval(() => {
      if (Date.now() > cursorStoreUntil) { stopCursorStorePoll(); return; }
      void refreshCursorStoreContext();
    }, 8_000);
    cursorStorePoll.unref?.();
  };

  const refreshChatTitle = () => {
    const kept = retainedEvents();
    const since = kept.findLastIndex(event => event.kind === 'divider');
    state.chatTitle = resolveChatTitle(state.segmentTitles, segmentUserEvents(kept, since));
  };
  const snapshotMeta = () => ({ configValues: meta.configValues, agent, cwd, worktreePath: meta.worktreePath, configDir: meta.configDir, resumeAt: meta.resumeAt, fork: meta.fork || undefined, sessionId: state.sessionId ?? undefined, model: meta.model, lastModel: state.model ?? undefined, effort: meta.effort, worktree: meta.worktree, addDirs: meta.addDirs, permissionMode: meta.permissionMode, prePlanMode: meta.prePlanMode, sandbox: meta.sandbox ?? undefined, network: meta.network || undefined, runEverything: meta.runEverything || undefined, interactiveUi: meta.interactiveUi, artifact: meta.artifact || undefined, costBase: typeof state.costUsd === 'number' ? state.costUsd : meta.costBase, title: state.chatTitle }); // the file keeps the running total, so a crash or kill keeps the cost
  const saveMeta = () => {
    const data = JSON.stringify(snapshotMeta());
    const saved = writing.then(async () => { await fs.writeFile(`${metaFile}.tmp`, data, { mode: 0o600 }); await fs.rename(`${metaFile}.tmp`, metaFile); });
    writing = saved.catch(reportStorage); return saved;
  };
  const tokensShown = () => {
    const reported = turnUsage ?? zero();
    const live = outputFinal ? reported : { ...reported, output: Math.max(reported.output, thinkingTokens + (streamBytes >> 2)) };
    return addTokens(addTokens(state.tokens, turnDone), live);
  };
  // The CLI reports the cost only in a turn's result, so while a turn runs the cost is the committed one plus the in-flight tokens at the last turn's price per unit.
  // ponytail: no estimate before the first result of this process (no price known yet); a built-in price table would give one.
  const shown = () => {
    const tokens = tokensShown(), live = weigh(tokens) - weigh(state.tokens);
    return { ...state, tokens, costUsd: typeof state.costUsd === 'number' && costPerUnit && live > 0 ? state.costUsd + live * costPerUnit : state.costUsd, pending: approvals.size, recoverable: canRetryTurn() };
  };
  const publish = () => { clearTimeout(publishTimer); publishTimer = null; onState?.(shown()); };
  // Live token counts change many times a second; they go out at most every 150ms. Status changes still use publish() and go out at once.
  const publishSoon = () => { if (publishTimer) return; publishTimer = setTimeout(publish, 150); publishTimer.unref?.(); };
  // The last request since the last /clear, unless a successful result answered it.
  function lastUnansweredUser() {
    if (unansweredCache !== undefined) return unansweredCache;
    const kept = retainedEvents();
    let answered = false;
    for (let at = kept.length - 1; at >= 0; at--) {
      const event = kept[at];
      if (event.kind === 'divider') break;
      if (event.kind === 'result' && event.status === 'success') answered = true;
      else if (event.kind === 'user') return unansweredCache = answered ? null : event;
    }
    return unansweredCache = null;
  }
  function canRetryTurn() {
    if (closed || turnOpen || approvals.size || configuring) return false;
    const last = lastUnansweredUser();
    return Boolean(last?.text?.trim() && !last.images);
  }
  const setStatus = () => {
    state.status = closed ? 'closed' : approvals.size ? 'attention' : turnOpen ? 'working' : 'idle'; state.pending = approvals.size; publish();
    // An idle child holds a few hundred MB; the conversation resumes from its session id, so it can go.
    clearTimeout(idleTimer);
    // Background subagents live in the child: it is kept while any of them runs (a silent leak of `liveTasks` ends with the child's exit or the chat's close).
    if (child && quiet()) { const proc = child; idleTimer = setTimeout(() => { if (child === proc && quiet()) proc.kill('SIGTERM'); }, IDLE_MS); idleTimer.unref(); }
  };
  // The view of the world the status line shows, derived from events so that a replayed transcript gives the same numbers.
  function fold(event, replay = false) {
    if (event.kind === 'session') {
      state.sessionId = event.sessionId ?? state.sessionId; state.model = event.model ?? state.model;
      // Claude: a session event only reports the mode the child started with (replayed, or arriving after a later switch); a mode the user picked is in meta and wins.
      if (event.permissionMode !== undefined && (agent !== 'claude' || meta.permissionMode === undefined)) { const mode = uiPermissionMode(event.permissionMode); state.permissionMode = mode; if (agent !== 'claude') meta.permissionMode = mode; }
      if (event.slashCommands?.length) state.slashCommands = event.slashCommands.map(item => typeof item === 'string' ? item : item?.name).filter(name => typeof name === 'string');
      if (Array.isArray(event.commands)) state.commandInfo = event.commands.flatMap(item => {
        if (!item || typeof item.name !== 'string' || !/^[\w:.-]+$/.test(item.name)) return [];
        const hint = typeof item.hint === 'string' ? item.hint.slice(0, 120) : '';
        return [{ name: item.name, description: typeof item.description === 'string' ? item.description.slice(0, 200) : '', ...(hint ? { hint } : {}) }];
      });
      if (event.tools?.length) state.tools = event.tools;
    } else if (event.kind === 'capabilities') state.capabilities = event.capabilities;
    else if (event.kind === 'settings') { if (event.permissionMode !== undefined) state.permissionMode = event.permissionMode; if (event.effort !== undefined) state.effort = event.effort; }
    else if (event.kind === 'usage') {
      if (event.tokens) state.tokens = event.tokens;
      state.contextTokens = event.contextTokens ?? state.contextTokens; state.contextWindow = event.contextWindow ?? state.contextWindow;
      if (event.contextSource === 'acp' || event.contextSource === 'store') state.contextUsageSource = event.contextSource;
      state.capabilities = { ...state.capabilities, context: true, tokens: Boolean(event.tokens) || state.capabilities.tokens };
    } else if (event.kind === 'message' && event.usage && !event.parentToolUseId) {
      state.contextTokens = event.usage.input + event.usage.cacheRead + event.usage.cacheCreate + event.usage.output;
    } else if (event.kind === 'result') {
      state.turns += 1; state.durationMs += event.durationMs ?? 0; if (event.contextWindow) state.contextWindow = event.contextWindow;
      if (event.usage) for (const key of Object.keys(state.tokens)) state.tokens[key] += event.usage[key]; resetLive();
      // shortcut: total_cost_usd is read as cumulative per process; `costBase` carries earlier processes over a --resume.
      if (!replay && event.costUsd != null) { const spent = weigh(event.usage ?? zero()); if (spent > 0 && meta.costBase + event.costUsd > state.costUsd) costPerUnit = (meta.costBase + event.costUsd - state.costUsd) / spent; state.costUsd = meta.costBase + event.costUsd; void saveMeta().catch(() => {}); } // saveMeta reports its own failure
      if (event.status === 'failed') state.error = event.text || '실패했습니다.'; else state.error = null;
    } else if (event.kind === 'compact') { if (event.postTokens != null) state.contextTokens = event.postTokens;
    } else if (event.kind === 'divider') {
      state.tokens = zero(); state.turns = 0; state.durationMs = 0; state.contextTokens = 0; resetLive(); state.cache = null; cacheReading = null;
      state.segmentTitles = { custom: '', ai: '', agent: '' }; refreshChatTitle();
      if (!replay) void refreshAutoCompact();
    } else if (event.kind === 'title') {
      const source = event.source === 'custom' || event.source === 'ai' ? event.source : 'agent';
      const text = cleanChatTitle(event.text);
      if (text) state.segmentTitles = { ...state.segmentTitles, [source]: text };
      refreshChatTitle();
    } else if (event.kind === 'user') refreshChatTitle();
    else if (event.kind === 'error') state.error = event.message;
  }
  for (const event of retainedEvents()) fold(event, true);
  // Replaying old init events would show the model the child started with, not the one picked since (set_model sends no new init): the pick is stored, so it wins.
  if (meta.model) state.model = meta.model;
  refreshChatTitle();
  state.sessionId = meta.sessionId ?? null;
  function emit(event, { store = true } = {}) {
    const stamped = store ? { ...event, seq: ++seq, at: Date.now() } : event;
    if (store) {
      events.push(stamped); if (events.length > KEEP_EVENTS * 1.5) events = events.slice(-KEEP_EVENTS);
      invalidate();
      writing = writing.then(() => fs.appendFile(logFile, JSON.stringify(stamped) + '\n', { mode: 0o600 })).catch(reportStorage);
      fold(stamped);
    }
    onEvent?.(stamped);
  }
  const live = () => { if (closed) throw fault('NOT_FOUND', '닫힌 채팅입니다.', 404); };

  // A steering message is "applied" when the CLI echoes it back (--replay-user-messages) at the moment the running turn takes it in.
  function dropSteers(emitCancelled = true) {
    for (const [uuid, item] of steers) if (emitCancelled) emit({ kind: 'steer', phase: 'cancelled', uuid, text: item.text });
    steers.clear();
  }
  // Approvals that can no longer be answered (interrupt, child gone, /clear) are withdrawn on the screen too, not only forgotten here.
  function clearApprovals() {
    for (const requestId of approvals.keys()) emit({ kind: 'approval', phase: 'cancel', requestId });
    approvals.clear();
  }
  function handleRaw(raw) {
    if (raw?.type === 'user' && raw.isReplay === true) {
      if (inflight && raw.uuid === inflight.uuid) { inflight.acked = true; echoesSeen = true; }
      const steer = steers.get(raw.uuid);
      if (steer) { steers.delete(raw.uuid); emit({ kind: 'steer', phase: 'applied', uuid: raw.uuid, text: steer.text, images: steer.images, previews: steer.previews }); return; }
      // Any other echo is our own message coming back; only what a local slash command printed in it is new.
      for (const event of normalizeClaude(raw)) if (event.kind === 'command_output') handleEvent(event);
      return;
    }
    // A reply to something we asked (set_model, interrupt, ...).
    if (raw?.type === 'control_response') { controls.get(raw.response?.request_id)?.(raw.response); controls.delete(raw.response?.request_id); }
    if (protocol) { protocol.handle(raw); return; }
    for (const event of normalizeClaude(raw)) handleEvent(event);
  }
  function handleEvent(event) {
      eventCount += 1;
      if (event.kind === 'usage') noteCursorAcpUsage(event);
      if (event.kind === 'approval') {
        // A Write request says whether it creates the file or replaces one, so its card can read "새 파일" or "덮어쓰기".
        if (event.phase === 'request' && event.tool === 'Write' && typeof event.input?.file_path === 'string') event.exists = existsSync(path.resolve(cwd, event.input.file_path));
        if (event.phase === 'request') approvals.set(event.requestId, event); else approvals.delete(event.requestId);
        emit(event); setStatus(); return;
      }
      if (event.kind === 'delta') {
        if (!protocol) {
          const stream = event.parentToolUseId ?? '';
          if (event.phase === 'start') { if (event.messageId) streamIds.set(stream, event.messageId); if (!stream) { nextMessage(event.messageId); thinkingTokens = 0; } }
          else if (event.phase === 'thinkingTokens') { thinkingTokens = Number(event.tokens) || 0; publishSoon(); }
          else if (event.phase === 'usage') {
            // A subagent's usage is not this conversation's context; the status line only follows the main thread. Usage itself is not drawn, so it is not sent.
            if (event.usage && !stream) { turnUsage = mergeTurnUsage(turnUsage, event.usage); if (event.final) outputFinal = true; publishSoon(); }
            return;
          } else if (event.messageId === undefined && streamIds.has(stream)) event = { ...event, messageId: streamIds.get(stream) };
          // Thinking text is not counted: the CLI sends its token estimate instead (a CLI that streamed both would count it twice).
          if (!stream && (event.phase === 'text' || event.phase === 'toolInput')) { streamBytes += Buffer.byteLength(String(event.text ?? '')); publishSoon(); }
          // A Write's whole file arrives as tool input; the card only needs the first few KB for its summary.
          if (event.phase === 'toolInput') {
            const slot = `${event.messageId}:${event.index}`, size = (toolInputSize.get(slot) ?? 0) + (event.text?.length ?? 0);
            toolInputSize.set(slot, size); if (size > 8192 + (event.text?.length ?? 0)) return;
          }
        }
        emit(event, { store: false }); return;
      }
      if (event.kind === 'task' && event.phase !== 'progress') { trackTask(event); publishSoon(); }
      if (event.kind === 'raw' || (event.kind === 'task' && event.phase === 'progress')) { emit(event, { store: false }); return; } // progress ticks often: live only
      // The CLI may print the same command output both in its echo and as a message of its own: it is shown once.
      if (event.kind === 'command_output') { const same = `${turnSeq}\0${event.isError}\0${event.text}`; if (lastCommandOutput === same) return; lastCommandOutput = same; }
      emit(event);
      noteBackgroundActivity(event);
      if (event.kind === 'message' && event.usage && !event.parentToolUseId && agent === 'claude') { nextMessage(event.id); turnUsage = { ...event.usage, output: Math.max(event.usage.output, turnUsage?.output ?? 0) }; publishSoon(); }
      if (event.kind === 'session') {
        meta.sessionId = state.sessionId ?? undefined; meta.resumeAt = undefined; meta.fork = false;
        if (agent === 'claude') void refreshAutoCompact(event.model ?? state.model);
        void saveMeta().catch(reportStorage); publish();
      }
      if (event.kind === 'capabilities' || event.kind === 'usage' || event.kind === 'settings' || event.kind === 'compact') publish();
      if (event.kind === 'compact' && agent === 'claude') refreshCacheSoon();
      // A steer the turn never took in (it finished first) becomes the next turn on its own: stay working until it has run.
      if (event.kind === 'result') {
        clearTimeout(activityTimer); reopened = false;
        streamIds.clear(); toolInputSize.clear(); resetLive(); turnOpen = steers.size > 0; setStatus();
        if (agent === 'claude' && event.contextWindow) void refreshAutoCompact();
        if (agent === 'claude') refreshCacheSoon();
        if (agent === 'cursor') startCursorStorePoll(Date.now() + 45_000);
        if (quiet() && restartAfterTurn) restart();
        // ponytail: one automatic resend, text/images of the last message only; a command that prints nothing is not resent (starts with `/`).
        // A message the CLI took in is echoed back by its uuid before the turn runs. Claude can accept a line yet drop it when its own startup turn (the notice for background
        // tasks a resumed session left behind) ends first: a result without the echo, and nothing produced, is not an answer to it. Until an echo was ever seen the empty
        // result is the only evidence. Not at once: a line the CLI only queued behind its own turn starts to run (events arrive) within moments, and sending it again would answer it twice.
        if (agent === 'claude' && inflight && !inflight.acked && !inflight.retried && event.status === 'success' && !inflight.text.startsWith('/') && child
          && (echoesSeen || (!inflight.produced && !event.text))) {
          const sent = inflight, seen = eventCount;
          setTimeout(() => {
            if (inflight !== sent || sent.acked || eventCount !== seen || turnOpen || !child || closed) return;
            sent.retried = true; sent.uuid = randomUUID(); turnOpen = true; reopened = false; turnSeq += 1; setStatus();
            void write(userLine(sent.text, sent.images, sent.uuid)).catch(() => { turnOpen = false; setStatus(); });
          }, 1500).unref();
        }
      }
      else if (inflight && ['message', 'command_output', 'compact', 'approval'].includes(event.kind)) inflight.produced = true;
  }
  // Background sub-agents keep running after a turn's `result`, and their hand-back starts a new turn on its own (no user line, no steer). Their output is
  // activity: without this the chat showed "idle" (no stop button, no working indicator) while messages kept arriving. The next `result` closes it again;
  // if none comes (a silent child) the quiet timer drops back to idle, and any later output reopens it.
  function noteBackgroundActivity(event) {
    if (protocol || closed || !child || !['message', 'tool_result', 'session'].includes(event.kind)) return;
    if (!turnOpen) { turnOpen = true; reopened = true; setStatus(); }
    if (reopened) { clearTimeout(activityTimer); activityTimer = setTimeout(() => { if (reopened && turnOpen && !approvals.size) { reopened = false; turnOpen = steers.size > 0; setStatus(); } }, quietMs); activityTimer.unref(); }
  }
  // A subagent counts as running only while the child that started it lives: after a crash or an ADE restart nothing reports its end.
  const trackTask = event => { const live = new Set(state.liveTasks); if (event.phase === 'start') { live.add(event.toolUseId); if (event.taskId) taskIds.set(event.toolUseId, event.taskId); } else { live.delete(event.toolUseId); taskIds.delete(event.toolUseId); } state.liveTasks = [...live];
    // The last background task ended without a turn of its own: the pending restart or the idle countdown can go on now.
    if (event.phase !== 'start' && !live.size) { if (restartAfterTurn && quiet()) restart(); else setStatus(); }
  };
  const reportStorage = error => { state.error = `채팅 저장 실패: ${error.message}`; publish(); };

  // total_cost_usd restarts at 0 in every process, so what a replaced child had cost is carried by costBase. The child's own close handler does not run
  // this (it sees it was already replaced), hence every place that drops the child calls it.
  let prePlanMode = meta.prePlanMode ?? 'default'; // kept in meta so a plan approved after reopening goes back to the mode before it
  const carryCost = () => { if (typeof state.costUsd === 'number') meta.costBase = state.costUsd; };

  // Nothing in the child would be cut off: no turn, no approval, no background subagent.
  const quiet = () => !turnOpen && !approvals.size && state.liveTasks.length === 0;
  // A launch flag changed: replace the child now when quiet, else once the turn and its background tasks are over.
  function restartWhenQuiet() { if (quiet()) restart(); else { restartAfterTurn = true; state.restartPending = true; } }
  // Ends the child on purpose (restart, handoff, close). child is nulled first, so its close handler returns early: the subagents/tasks it took with it are
  // dropped here, or `quiet()` stays false (no idle kill, stale task UI).
  function dropChild() { const proc = child; child = null; protocol?.dispose(); protocol = null; carryCost(); state.liveTasks = []; taskIds.clear(); proc.kill('SIGTERM'); return proc; }
  // --effort is a startup flag: a running child is replaced (the next message resumes the session) once it is not mid-turn.
  function restart() {
    restartAfterTurn = false; state.restartPending = false;
    if (child) dropChild();
    setStatus();
  }
  // One start at a time: warm-up, a setting change and a send may arrive together, and none may use the child before it is initialized.
  let starting = null;
  // The message of the turn in flight and whether anything came back for it. A freshly resumed Claude child first runs its own turn (e.g. the notice for background tasks the
  // old child left behind) and can end it with an empty `result` while our line is lost: that is no answer, so the message is sent once more.
  let inflight = null, eventCount = 0;
  function start() { if (starting) return starting; if (child) return Promise.resolve(); return starting = startNow().finally(() => { starting = null; }); }
  async function startNow() {
    if (closed) throw fault('NOT_FOUND', '닫힌 채팅입니다.', 404);
    if (agent !== 'claude' && meta.worktree && !meta.worktreePath) {
      const target = path.join(directory, 'worktrees', `chat-${id}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await createLocalRuntime({ root: cwd }).git.createWorktree(target, `ade/chat-${id}`);
      meta.worktreePath = target; cwd = state.cwd = target; await saveMeta();
    }
    // Without a pick the CLI would follow ~/.claude/settings.json at every (re)start, so a change made in another project (or a terminal `/model`) would silently
    // switch this conversation on its next resume. The model and Effort it is running with are pinned to the chat instead.
    if (agent === 'claude') { let pinned = false; if (!meta.model && state.model) { meta.model = state.model; pinned = true; } if (meta.effort === undefined && state.effort && state.capabilities.efforts.includes(state.effort)) { meta.effort = state.effort; pinned = true; } if (pinned) await saveMeta(); }
    const extra = agent === 'claude' && prepare ? await prepare(root, { chatId: id, projectId, agent, interactiveUi: meta.interactiveUi === true }) : {};
    const args = [...argsOf(executableArgs), ...(agent === 'claude' ? buildClaudeArgs({ sessionId: meta.sessionId, model: meta.model, effort: meta.effort, worktree: meta.worktree, addDirs: meta.addDirs, permissionMode: meta.permissionMode, resumeAt: meta.resumeAt, fork: meta.fork, ...extra }) : agent === 'codex' ? ['app-server'] : [...(meta.sandbox ? ['--sandbox', meta.sandbox] : []), 'acp'])];
    if (agent !== 'claude') protocol = createChatProtocol(agent, { write, emit: handleEvent });
    if (agent === 'claude') {
      // Resolved right now (the catalog and the model may have arrived after the chat was opened), so the CLI starts with the window the gauge shows.
      const model = meta.model ?? state.model, compactNow = await readAutoCompact(configDirOf(), cwd, model, maxContextForModel(model));
      launchedWindow = handedWindow(compactNow);
      if (JSON.stringify(state.autoCompact) !== JSON.stringify(compactNow)) { state.autoCompact = compactNow; publish(); }
    }
    // shell:false and argv only: the message text never reaches a shell.
    const run = () => {
      const launchEnv = withUtf8Ctype({ ...process.env, ...(typeof env === 'function' ? env() : env), NO_COLOR: '1' });
      state.apiKey = usesApiKey(launchEnv);
      if (agent === 'claude' && launchedWindow) launchEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(launchedWindow);
      if (agent === 'codex') { meta.configDir ??= launchEnv.CODEX_HOME || path.join(os.homedir(), '.codex'); launchEnv.CODEX_HOME = meta.configDir; }
      if (agent === 'claude' && meta.configDir) launchEnv.CLAUDE_CONFIG_DIR = meta.configDir;
      // Once a chat has used Artifact every restart and resume keeps it on, so the tools do not vanish (the CLI cannot take them back mid-session anyway).
      if (agent === 'claude' && meta.artifact) launchEnv.CLAUDE_CODE_ARTIFACT = '1';
      // With --mcp-config (the agent bus) the CLI holds its init event until every MCP server of the user has connected, up to ~30s when one is slow or
      // unreachable (measured with claude 2.1.322: init 1.1s without the flag, 29.7s with it). The bus connects in ~1s; a late server just joins later.
      // ponytail: a user's own server slower than this misses the first turn's tool list; set CLAUDE_CODE_MCP_STARTUP_WAIT_MS in the environment ADE starts with to wait longer.
      if (agent === 'claude') launchEnv.CLAUDE_CODE_MCP_STARTUP_WAIT_MS ??= '3000';
      if (procHost) { const resolved = resolveAgentCommand(executable, args, { env: launchEnv }); return procHost.spawnProc(resolved.file, resolved.args, { cwd, env: launchEnv, meta: { chatId: id, projectId, agent } }); }
      return spawnProcess(executable, args, { cwd, env: launchEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    };
    let proc = run();
    // The app may have been started before `claude` was installed or before its PATH was known: let the caller refresh PATH once.
    const spawned = await new Promise(resolve => { proc.once('spawn', () => resolve(true)); proc.once('error', error => resolve(error)); });
    if (spawned !== true) {
      if (spawned.code === 'ENOENT' && recover && await recover().then(() => true, () => false)) { proc = run(); const again = await new Promise(resolve => { proc.once('spawn', () => resolve(true)); proc.once('error', error => resolve(error)); }); if (again !== true) throw fault('AGENT_UNAVAILABLE', `${executable} 명령을 시작하지 못했습니다. 설치와 로그인을 확인하세요.`, 503); }
      else throw fault('AGENT_UNAVAILABLE', `${executable} 명령을 시작하지 못했습니다. 설치와 로그인을 확인하세요.`, 503);
    }
    attach(proc);
    if (protocol) {
      try {
        await protocol.initialize(meta, cwd, chatMcpServers({ chatId: id, projectId, agent }), meta.interactiveUi === true ? UI_PROMPT : undefined);
        await saveMeta();
        if (agent === 'cursor') startCursorStorePoll();
      } catch (error) { restart(); throw error; }
    }
  }
  async function resendLastUser() {
    live();
    if (configuring) await configChain;
    if (turnOpen || approvals.size) throw fault('CHAT_BUSY', '응답이 끝난 뒤 다시 시도하세요.', 409);
    const last = lastUnansweredUser();
    if (!last?.text?.trim()) throw fault('INVALID_INPUT', '다시 시도할 메시지가 없습니다.', 409);
    if (last.images > 0) throw fault('CHAT_UNSUPPORTED', '이미지가 포함된 요청은 자동 복구할 수 없습니다. 같은 내용을 다시 보내세요.', 409);
    state.error = null; turnOpen = true; reopened = false; turnSeq += 1;
    try {
      await start();
      if (protocol) await protocol.send(last.text, []);
      else await write(userLine(last.text));
    } catch (error) { turnOpen = false; if (protocol) restart(); setStatus(); throw error; }
    setStatus();
  }
  function attach(proc) {
    child = proc; state.liveTasks = []; taskIds.clear(); // a replaced child took its subagents with it
    let buffer = '', stderr = '';
    const decoder = new StringDecoder('utf8');
    proc.stdout.on('data', chunk => {
      if (child !== proc || closed) return;
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line) continue;
        if (Buffer.byteLength(line) > MAX_LINE) { emit({ kind: 'error', message: '응답 한 줄이 너무 큽니다.' }); proc.kill('SIGTERM'); return; }
        let raw; try { raw = JSON.parse(line); } catch { emit({ kind: 'raw', original: 'unparsed' }, { store: false }); continue; }
        try { handleRaw(raw); } catch (error) { emit({ kind: 'error', message: error.message }); proc.kill('SIGTERM'); }
      }
      if (Buffer.byteLength(buffer) > MAX_LINE) { buffer = ''; emit({ kind: 'error', message: '응답 한 줄이 너무 큽니다.' }); proc.kill('SIGTERM'); }
    });
    proc.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    proc.stdin.on('error', () => {}); // EPIPE once the child is gone; the exit handler reports it
    proc.once('close', (code, signal) => {
      if (child !== proc) return;
      const wasTurn = turnOpen;
      child = null; protocol?.dispose(); protocol = null; turnOpen = false; reopened = false; clearTimeout(activityTimer); meta.costBase = state.costUsd; clearApprovals(); controls.clear(); dropSteers(); streamIds.clear(); toolInputSize.clear(); state.liveTasks = []; // A turn cut off before its result still spent these tokens.
      nextMessage(null); state.tokens = addTokens(state.tokens, turnDone); resetLive();
      const abort = !closed && !agentExitBenign(code, signal);
      const fail = (message, { store = true } = {}) => {
        state.error = message;
        if (store) emit({ kind: 'error', message, recoverable: canRetryTurn() });
        publish();
      };
      if (abort) {
        const recoverable = Boolean(wasTurn && meta.sessionId && canRetryTurn());
        fail(recoverable
          ? `${agent} 연결이 끊겼습니다 (${code ?? signal ?? '오류'}). 세션 복구를 시도하거나 다시 보내세요.`
          : `${agent}가 종료되었습니다 (${code ?? signal}). 설치와 로그인을 확인하세요.`, { store: true });
      } else if (state.error) { state.error = null; publish(); }
      void saveMeta().catch(reportStorage); setStatus();
    });
    setStatus();
  }
  const write = line => new Promise((resolve, reject) => child.stdin.write(line, error => error ? reject(error) : resolve()));
  const control = (request, timeoutMs = 5000) => new Promise(resolve => {
    if (!child) return resolve(null);
    const requestId = randomUUID(), timer = setTimeout(() => { controls.delete(requestId); resolve(null); }, timeoutMs);
    controls.set(requestId, response => { clearTimeout(timer); resolve(response); });
    void write(controlLine(requestId, request)).catch(() => { clearTimeout(timer); controls.delete(requestId); resolve(null); });
  });
  // Turns the Artifact tools on for this chat. A running CLI takes it as a flag-settings update (no restart); one that is not started yet gets it as env at launch.
  // If the update is refused nothing is remembered, so the next message tries again.
  async function enableArtifact() {
    if (child) { const response = await control({ subtype: 'apply_flag_settings', settings: ARTIFACT_FLAG_SETTINGS }); if (response?.subtype !== 'success') return; }
    meta.artifact = true;
  }

  await saveMeta(); setStatus();
  if (handed) await takeOver(handed);
  // The agent a stopped server left running in the pty-host: attached again with the turn, approvals and background tasks it had.
  async function takeOver(saved) {
    let proc = null;
    try { if (saved.v === 1 && procHost && typeof saved.procKey === 'string') proc = await procHost.attachProc(saved.procKey, saved.ack); } catch { /* gone meanwhile */ }
    if (proc?.missing) { proc.kill('SIGTERM'); proc = null; }
    if (!proc) {
      if (saved.turnOpen || saved.approvals?.length) { state.error = '이전 서버에서 응답을 이어받지 못했습니다. 세션 복구를 시도하거나 다시 보내세요.'; emit({ kind: 'error', message: state.error, recoverable: canRetryTurn() }); publish(); }
      return;
    }
    if (agent !== 'claude') { protocol = createChatProtocol(agent, { write, emit: handleEvent }); protocol.restore(saved.protocol ?? {}); }
    attach(proc);
    turnOpen = saved.turnOpen === true; reopened = saved.reopened === true; turnSeq = saved.turnSeq ?? 0; inflight = saved.inflight ?? null;
    restartAfterTurn = state.restartPending = saved.restartAfterTurn === true; launchedWindow = saved.launchedWindow ?? null; lastCommandOutput = saved.lastCommandOutput ?? null;
    for (const event of saved.approvals ?? []) approvals.set(event.requestId, event);
    for (const [uuid, item] of saved.steers ?? []) steers.set(uuid, item);
    for (const [toolUseId, taskId] of saved.taskIds ?? []) taskIds.set(toolUseId, taskId);
    state.liveTasks = saved.liveTasks ?? [];
    if (reopened) noteBackgroundActivity({ kind: 'message' });
    if (agent === 'cursor') startCursorStorePoll();
    setStatus();
  }
  return {
    id, agent, get cwd() { return cwd; },
    // Server shutdown: an agent running in the pty-host stays, and live.json tells the next server how far this one read and what was open.
    // Everything is taken in the same tick as the last line handled, so nothing is read twice or lost. Without the host it is a plain close.
    async detach() {
      if (closed) return;
      const proc = child;
      if (!proc?.detach || !proc.pid) return this.close();
      const saved = { v: 1, procKey: proc.key, ack: proc.lastLine, turnOpen, reopened, turnSeq, inflight, restartAfterTurn, launchedWindow, lastCommandOutput,
        approvals: [...approvals.values()], steers: [...steers], taskIds: [...taskIds], liveTasks: state.liveTasks, protocol: protocol?.snapshot() };
      proc.detach();
      closed = true; child = null; protocol = null; carryCost();
      clearTimeout(idleTimer); clearTimeout(activityTimer); clearTimeout(publishTimer); clearTimeout(cacheLater); stopCursorStorePoll();
      await writing.catch(() => {});
      await saveMeta().catch(() => {});
      await fs.writeFile(liveFile, JSON.stringify(saved), { mode: 0o600 });
    },
    // Whether an agent process is running for this chat right now (the app's quit question counts them).
    get running() { return Boolean(child); },
    // Whether that process would outlive this server (it runs in the pty-host).
    get hosted() { return Boolean(child?.detach); },
    // /rename: the chat's own title (wins over the AI/agent titles until /clear); stored as a custom-title event like the CLI's.
    rename(title) {
      const text = cleanChatTitle(title).slice(0, 60);
      if (!text) throw fault('INVALID_INPUT', '이름을 입력하세요.');
      emit({ kind: 'title', source: 'custom', text }); publish();
      return { title: state.chatTitle };
    },
    // /autocompact: saved like the CLI's own command, so it works while a turn runs; a running child that was handed another window is replaced after the turn.
    async setAutoCompact(value) {
      if (agent !== 'claude') throw fault('CHAT_UNSUPPORTED', 'Auto Compact 창은 Claude 채팅에서만 바꿀 수 있습니다.', 409);
      const model = meta.model ?? state.model;
      try { await writeAutoCompact(configDirOf(), model, value, maxContextForModel(model)); } catch (cause) { throw fault('INVALID_INPUT', cause.message); }
      await refreshAutoCompact(model);
      return { autoCompact: state.autoCompact };
    },
    loadCatalog(catalog, defaultModel, configOptions = []) {
      if (agent === 'cursor' && child) return;
      state.capabilities.catalog = catalog;
      const selected = catalog.find(item => item.id === (meta.model ?? defaultModel));
      if (agent === 'cursor') {
        if (!meta.model) { state.capabilities.configOptions = configOptions; state.model = defaultModel ?? state.model; }
        const effort = cursorEffortOption(state.capabilities.configOptions ?? []);
        state.capabilities.efforts = effort?.options.map(item => item.value) ?? [];
        state.effort = effort?.currentValue ?? null;
      } else state.capabilities.efforts = selected?.efforts ?? (agent === 'claude' ? chatCapabilities('claude').efforts : []);
      state.capabilities.images = selected?.images !== false;
      publish();
      // The window comes from this catalog; without a refresh the gauge stayed on the full window (e.g. 9% of 1M) until the first turn finished.
      if (agent === 'claude') void refreshAutoCompact();
    },
    retry: () => resendLastUser(),
    state: shown,
    // The latest thing the user typed in this chat (not a message from another agent). The agent bus quotes it to the chat it messages, so the receiver
    // sees what the user actually asked for instead of taking the sender's word for it.
    lastUserInstruction() {
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i], said = event.kind === 'user' || (event.kind === 'steer' && event.phase === 'applied') ? event.text : null;
        if (typeof said === 'string' && said.trim() && !said.startsWith('[ADE agent bus]')) return { text: said.trim().slice(0, 300), at: event.at };
      }
      return null;
    },
    // The API key (or the choice to use one) changed: a running child still has the old one in its environment, so it is replaced (same session)
    // right away when idle, or once the running turn ends. The next message starts a child with the new key.
    relaunch() { if (child) { restartWhenQuiet(); } },
    replay: since => ({ events: events.filter(event => event.seq > (Number.isSafeInteger(since) ? since : 0)), seq, state: shown(),
      approvals: [...approvals.values()] }),
    // `steer` sends into the running turn: the CLI folds the line into that turn (one `result` for both; checked with claude 2.1.322),
    // so turn state is left alone. ponytail: a steer racing the turn's last event may open a second turn, status then flickers idle once.
    async send(text, images = [], { steer = false, artifact = false, previews = [] } = {}) {
      live();
      if (configuring && !(turnOpen && steer)) await configChain;
      if (typeof text !== 'string' || !text.trim() || text.length > 200_000 || text.includes('\0')) throw fault('INVALID_INPUT', '메시지를 확인하세요.');
      if (turnOpen && steer && child) {
        if (!state.capabilities.steer) throw fault('CHAT_UNSUPPORTED', state.capabilities.limitations.steer, 409);
        const uuid = randomUUID(); steers.set(uuid, { text, images: images.length, previews, data: images });
        emit({ kind: 'steer', phase: 'queued', uuid, text, images: images.length, previews });
        try { if (protocol) { await protocol.send(text, images, { steer: true }); steers.delete(uuid); emit({ kind: 'steer', phase: 'applied', uuid, text, images: images.length, previews }); } else await write(userLine(text, images, uuid)); } catch (error) { steers.delete(uuid); emit({ kind: 'steer', phase: 'cancelled', uuid, text }); throw error; }
        return;
      }
      if (turnOpen) throw fault('CHAT_BUSY', '이전 응답이 끝난 뒤 보내세요.', 409);
      state.error = null; turnOpen = true; reopened = false; turnSeq += 1;
      // The message is shown right away; starting the process (slow on the first turn) must not delay it.
      emit({ kind: 'user', text, images: images.length, previews }); inflight = { text, images, uuid: randomUUID(), acked: false, produced: false, retried: false };
      try {
        if (agent === 'claude' && !meta.artifact && (artifact || wantsArtifact(text))) await enableArtifact();
        await start(); await saveMeta();
        if (agent === 'cursor') startCursorStorePoll(Date.now() + 600_000);
        if (agent === 'cursor' && isCursorSummarizeCommand(text) && protocol) {
          if (images.length) throw fault('CHAT_UNSUPPORTED', '컨텍스트 압축 명령에는 이미지를 붙일 수 없습니다.', 409);
          const sessionId = state.sessionId ?? meta.sessionId;
          const preTokens = state.contextTokens, startedAt = Date.now();
          emit({ kind: 'delta', phase: 'compacting', active: true });
          restart();
          try {
            const output = await runCursorSummarize({ executable, executableArgs: argsOf(executableArgs), sessionId, cwd, env, spawnProcess });
            const after = await readCursorStoreUsage(sessionId).catch(() => null);
            emit({ kind: 'delta', phase: 'compacting', active: false });
            emit({ kind: 'compact', trigger: 'manual', preTokens: preTokens || null, postTokens: after?.contextTokens ?? null });
            const cleaned = cleanCursorSummarizeOutput(output);
            if (cleaned) emit({ kind: 'command_output', text: cleaned, isError: false });
            emit({ kind: 'result', status: 'success', text: '', costUsd: null, durationMs: Date.now() - startedAt });
            if (after?.contextTokens) emit({ kind: 'usage', contextTokens: after.contextTokens, contextWindow: after.contextWindow ?? state.contextWindow, contextSource: 'store' });
          } catch (error) {
            emit({ kind: 'delta', phase: 'compacting', active: false });
            emit({ kind: 'result', status: 'failed', text: error.message ?? '컨텍스트 압축이 실패했습니다.', costUsd: null, durationMs: Date.now() - startedAt });
            turnOpen = false;
            try { await start(); } catch { restart(); }
            setStatus();
            throw error;
          }
          turnOpen = false;
          setStatus();
          if (agent === 'cursor') startCursorStorePoll(Date.now() + 45_000);
          return;
        }
        if (protocol) await protocol.send(text, images);
        else await write(userLine(text, images, inflight.uuid));
      }
      catch (error) { turnOpen = false; if (protocol) restart(); setStatus(); throw error; }
      setStatus();
    },
    async approve(requestId, answer) {
      live();
      const pending = approvals.get(requestId);
      if (!pending || !child) throw fault('NOT_FOUND', '이미 처리된 승인입니다.', 404);
      if (pending.questions && answer.allow) {
        if (!answer.answers || typeof answer.answers !== 'object' || Array.isArray(answer.answers)) throw fault('INVALID_INPUT', '질문에 답변하세요.');
        for (const question of pending.questions) {
          const values = answer.answers[question.id];
          if (!Array.isArray(values) || !values.length || values.length > (question.allowMultiple ? 32 : 1) || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 4000 || value.includes('\0') || (question.options?.length && !question.allowOther && !question.options.some(option => option.id === value)))) throw fault('INVALID_INPUT', '질문 답변을 확인하세요.');
        }
      }
      // Approving a Claude plan can also pick the mode to work in (auto, accept edits); anything else just returns to the mode before the plan.
      const planMode = agent === 'claude' && pending.tool === 'ExitPlanMode' && answer.allow === true && answer.mode ? answer.mode : undefined;
      if (planMode !== undefined && (!PERMISSION_MODES.includes(planMode) || planMode === 'plan' || planMode === 'bypassPermissions')) throw fault('INVALID_INPUT', '계획 승인 후 사용할 수 없는 권한 모드입니다.');
      if (protocol) await protocol.approve(requestId, answer);
      else {
        // A Claude question is answered inside the tool input; skipping it tells the model so, instead of the generic "rejected, STOP" refusal.
        const asking = pending.tool === 'AskUserQuestion' && pending.questions;
        await write(approvalLine(requestId, { allow: answer.allow === true, input: asking && answer.allow ? askUserInput(pending.input, pending.questions, answer.answers) : pending.input,
          message: pending.tool === 'ExitPlanMode' && answer.message ? planRevision(answer.message) : answer.message ? (asking ? answer.message : refusalWith(answer.message)) : asking ? ASK_SKIPPED : undefined, suggestions: answer.always === true ? pending.suggestions : [], mode: planMode }));
      }
      // Approving a plan makes the CLI leave plan mode (back to what it was before); it says nothing about it, so the mode chip is moved here.
      if (agent === 'claude' && pending.tool === 'ExitPlanMode' && answer.allow === true && state.permissionMode === 'plan') { meta.permissionMode = state.permissionMode = planMode ?? prePlanMode; void saveMeta().catch(() => {}); publish(); }
      approvals.delete(requestId);
      emit({ kind: 'approval', phase: 'answer', requestId, tool: pending.tool, allow: answer.allow === true });
      setStatus();
    },
    // Ends one background task (shell, Monitor, subagent) on its own, without interrupting the turn. toolUseId is the Agent/Bash/Monitor call that started it.
    async stopTask(toolUseId) {
      live();
      const taskId = taskIds.get(toolUseId);
      if (!child || !taskId) throw fault('CHAT_TASK', '이 작업을 찾을 수 없습니다. 이미 끝났을 수 있습니다.', 404);
      const response = await control({ subtype: 'stop_task', task_id: taskId });
      if (response?.subtype === 'error') throw fault('CHAT_TASK', `작업을 중단하지 못했습니다: ${response.error}`, 409);
      if (!response) throw fault('CHAT_TASK', '작업을 중단하지 못했습니다. 응답이 없습니다.', 504);
      // The CLI normally reports the end itself; if it did not, say so here so the row does not keep spinning.
      if (state.liveTasks.includes(toolUseId)) handleEvent({ kind: 'task', phase: 'end', toolUseId, status: 'stopped', report: '' });
    },
    // `sendSteers` (Esc while steering messages wait): stop the work, then send those messages right away as the next turn instead of handing them back to the input box.
    async interrupt({ sendSteers = false } = {}) {
      live();
      if (!child) return;
      if (protocol) { await protocol.interrupt(); return; }
      const held = [];
      if (sendSteers && state.capabilities.cancelSteer) for (const [uuid, item] of [...steers]) {
        const response = await control({ subtype: 'cancel_async_message', message_uuid: uuid }, 3000);
        if (response?.response?.cancelled === true && steers.delete(uuid)) { held.push(item); emit({ kind: 'steer', phase: 'cancelled', uuid, text: item.text, resent: true }); }
      }
      clearApprovals(); dropSteers();
      const proc = child, turn = turnSeq, response = await control({ subtype: 'interrupt' }, 3000);
      // The turn closes with the `result` the CLI sends for the interrupt; closing it here let that late result end the *next* turn instead.
      // No answer, or no result soon after: end the child; the close handler ends the turn and the next message resumes the session.
      if (!response) { if (child === proc) proc.kill('SIGTERM'); }
      else setTimeout(() => { if (child === proc && turnOpen && turnSeq === turn) proc.kill('SIGTERM'); }, 5000).unref();
      setStatus();
      if (!held.length) return;
      for (let i = 0; i < 100 && turnOpen; i += 1) await new Promise(resolve => setTimeout(resolve, 100)); // the interrupted turn's `result` (or the killed child) closes it
      const text = held.map(item => item.text).join('\n\n');
      try { await this.send(text, held.flatMap(item => item.data), { previews: held.flatMap(item => item.previews ?? []) }); }
      catch (error) { emit({ kind: 'steer', phase: 'cancelled', uuid: '', text }); throw error; } // not sent: the text goes back into the input box
    },
    // Whether the agent is told about UI blocks is decided once, by the setting at the chat's first message, and kept: a later change would rewrite the system prompt
    // and make the whole conversation miss the prompt cache. Chats that already had a session (older ones) never get it. Cursor has no system-prompt channel.
    setInteractiveUi(value) {
      if (meta.interactiveUi === undefined && !state.sessionId && !child && typeof value === 'boolean') meta.interactiveUi = value;
    },
    async warm() { live(); if (agent === 'cursor' && !closed && !child && !turnOpen) await start(); },
    async set({ model, effort, worktree, addDirs, permissionMode, configOption, sandbox, network, runEverything }) {
      live();
      if (runEverything !== undefined && (agent !== 'cursor' || typeof runEverything !== 'boolean')) throw fault(agent === 'cursor' ? 'INVALID_INPUT' : 'CHAT_UNSUPPORTED', agent === 'cursor' ? 'Run Everything 설정을 확인하세요.' : 'Run Everything은 Cursor에서만 설정할 수 있습니다.', agent === 'cursor' ? 400 : 409);
      if (configOption !== undefined && (agent !== 'cursor' || !configOption || typeof configOption !== 'object' || typeof configOption.configId !== 'string' || typeof configOption.value !== 'string' || configOption.configId.length > 200 || configOption.value.length > 200)) throw fault('INVALID_INPUT', '모델 옵션을 확인하세요.');
      if (agent !== 'claude') {
        const caps = state.capabilities;
        if (worktree !== undefined && typeof worktree !== 'boolean') throw fault('INVALID_INPUT', '워크트리 설정을 확인하세요.');
        if ((network !== undefined && agent !== 'codex') || (sandbox !== undefined && !caps.sandboxes?.length)) throw fault('CHAT_UNSUPPORTED', '이 설정은 Codex(샌드박스·네트워크)와 Cursor(샌드박스)에서만 바꿀 수 있습니다.', 409);
        if (sandbox !== undefined && sandbox !== null && !caps.sandboxes?.includes(sandbox)) throw fault('INVALID_INPUT', '지원하지 않는 샌드박스입니다.');
        if (network !== undefined && typeof network !== 'boolean') throw fault('INVALID_INPUT', '네트워크 설정을 확인하세요.');
        if (permissionMode !== undefined && !caps.permissionModes.includes(permissionMode)) throw fault('INVALID_INPUT', '지원하지 않는 권한 모드입니다.');
        if (model !== undefined && model !== null && !(typeof model === 'string' && /^[\w.\[\],=:-]{1,200}$/.test(model))) throw fault('INVALID_INPUT', '잘못된 모델입니다.');
        if (effort != null && !caps.efforts.includes(effort)) throw fault('INVALID_INPUT', '선택한 모델이 지원하지 않는 Effort입니다.');
        if (worktree !== undefined && (meta.sessionId || child)) throw fault('INVALID_INPUT', '워크트리는 대화 시작 전에만 정할 수 있습니다.');
        if (addDirs !== undefined) {
          if (!caps.addDirs) throw fault('CHAT_UNSUPPORTED', caps.limitations.addDirs, 409);
          if (!Array.isArray(addDirs) || addDirs.length > 8 || !addDirs.every(item => typeof item === 'string' && path.isAbsolute(item) && item.length <= 1024 && !item.includes('\0'))) throw fault('INVALID_INPUT', '잘못된 폴더 목록입니다.');
          for (const dir of addDirs) if (!(await fs.stat(dir).then(info => info.isDirectory(), () => false))) throw fault('INVALID_INPUT', `폴더를 찾을 수 없습니다: ${dir}`);
        }
        // Run Everything is answered by this app (the ACP permission requests are accepted), so it applies at once, even mid-turn. Sandbox is a launch
        // flag: it is stored now and the process is replaced when the turn ends (or now, when idle).
        if (agent === 'cursor' && (sandbox !== undefined || runEverything !== undefined)) {
          if ([model, effort, configOption, permissionMode, worktree, addDirs].some(value => value !== undefined)) throw fault('INVALID_INPUT', '모델 설정은 한 번에 하나씩 바꾸세요.');
          if (runEverything !== undefined) { meta.runEverything = state.runEverything = runEverything; protocol?.setRunEverything?.(runEverything); }
          if (sandbox !== undefined) {
            meta.sandbox = state.sandbox = sandbox ?? null;
            if (child) { restartWhenQuiet(); }
          }
          await saveMeta(); publish(); return;
        }
        if (agent === 'cursor' && (model !== undefined || effort !== undefined || configOption !== undefined || permissionMode !== undefined)) {
          if ([model, effort, configOption, permissionMode].filter(value => value !== undefined).length > 1 || worktree !== undefined || addDirs !== undefined) throw fault('INVALID_INPUT', '모델 설정은 한 번에 하나씩 바꾸세요.');
          const apply = async () => {
            await start();
            await protocol.configure({ model, permissionMode, configOption: effort !== undefined ? { configId: state.capabilities.effortConfigId, value: effort } : configOption });
            if (model !== undefined) { meta.model = model ?? undefined; meta.configValues = {}; meta.effort = undefined; }
            if (permissionMode !== undefined) meta.permissionMode = permissionMode;
            if (configOption || effort !== undefined) {
              meta.model = state.model ?? meta.model;
              const option = configOption ?? { configId: state.capabilities.effortConfigId, value: effort };
              meta.configValues = { ...meta.configValues, [option.configId]: option.value };
            }
            await saveMeta();
          };
          configCount += 1; configuring = state.configuring = true; publish();
          const run = configChain.then(apply);
          configChain = run.catch(() => {});
          try { await run; } finally { if (--configCount === 0) { configuring = false; state.configuring = false; } publish(); }
          return;
        }
        for (const [key, value] of Object.entries({ model, effort, worktree, addDirs, permissionMode, sandbox, network })) if (value !== undefined) { meta[key] = value ?? undefined; state[key] = value; }
        // Codex gets the approval policy, reviewer and sandbox with every turn, so those never need a restart (which would also wait for the running turn).
        const permissionOnly = agent === 'codex' && [model, effort, worktree, addDirs].every(value => value === undefined) && [permissionMode, sandbox, network].some(value => value !== undefined);
        if (agent === 'codex' && [permissionMode, sandbox, network].some(value => value !== undefined)) await protocol?.setPermissions({ permissionMode, sandbox, network });
        if (model !== undefined) { const chosen = caps.catalog.find(item => item.id === model) ?? (model === null ? caps.catalog[0] : undefined); caps.efforts = chosen?.efforts ?? []; caps.images = chosen?.images !== false; meta.effort = undefined; state.effort = null; }
        if (child && !permissionOnly) { restartWhenQuiet(); }
        await saveMeta(); publish(); return;
      }
      if (permissionMode !== undefined) {
        if (!PERMISSION_MODES.includes(permissionMode)) throw fault('INVALID_INPUT', '잘못된 권한 모드입니다.');
        if (child) {
          const response = await control({ subtype: 'set_permission_mode', mode: cliPermissionMode(permissionMode) });
          if (!response || response.subtype !== 'success') throw fault('AGENT_PROTOCOL', '권한 모드를 적용하지 못했습니다. Claude Code 버전과 설정을 확인하세요.', 502);
        }
        if (permissionMode === 'plan' && state.permissionMode !== 'plan') meta.prePlanMode = prePlanMode = state.permissionMode;
        meta.permissionMode = state.permissionMode = permissionMode;
      }
      if (model !== undefined) {
        if (model !== null && !(typeof model === 'string' && /^[\w.\[\]-]{1,100}$/.test(model))) throw fault('INVALID_INPUT', '잘못된 모델입니다.');
        meta.model = model ?? undefined;
        if (model === null) {
          // "Default model": the running CLI has no way to go back to its default, so it is restarted without --model (same session). Until the next
          // answer's init event reports the real model, none is shown as chosen.
          state.model = null;
          if (child) { restartWhenQuiet(); }
        } else {
          state.model = model;
          if (child) await control({ subtype: 'set_model', model });
        }
      }
      if (effort !== undefined) {
        if (effort !== null && !EFFORTS.includes(effort)) throw fault('INVALID_INPUT', '잘못된 Effort입니다.');
        meta.effort = effort ?? undefined; state.effort = effort;
        if (child) { restartWhenQuiet(); }
      }
      if (worktree !== undefined) {
        // Only a conversation that has not started yet can move into a worktree.
        if (meta.sessionId || child) throw fault('INVALID_INPUT', '워크트리는 새 대화를 시작하기 전에만 정할 수 있습니다.');
        meta.worktree = state.worktree = worktree === true;
      }
      if (addDirs !== undefined) {
        if (!Array.isArray(addDirs) || addDirs.length > 8 || !addDirs.every(item => typeof item === 'string' && path.isAbsolute(item) && item.length <= 1024)) throw fault('INVALID_INPUT', '잘못된 폴더 목록입니다.');
        for (const dir of addDirs) if (!(await fs.stat(dir).then(info => info.isDirectory(), () => false))) throw fault('INVALID_INPUT', `폴더를 찾을 수 없습니다: ${dir}`);
        meta.addDirs = state.addDirs = [...new Set(addDirs)];
        if (child) { restartWhenQuiet(); }
      }
      if (model !== undefined) void refreshAutoCompact(state.model);
      await saveMeta(); publish();
    },
    // The state to start a Branch from: the transcript up to one assistant message, and the settings that make `claude` resume there as a fork.
    branchSnapshot(uuid) {
      live();
      if (!state.capabilities.branch) throw fault('CHAT_UNSUPPORTED', state.capabilities.limitations.branch, 409);
      if (turnOpen || approvals.size) throw fault('CHAT_BUSY', '응답이 끝난 뒤 분기할 수 있습니다.', 409);
      const at = events.findIndex(event => event.kind === 'message' && event.uuid === uuid);
      const kept = retainedEvents(), selected = kept.findIndex(event => event.kind === 'message' && event.uuid === uuid);
      if ((agent === 'claude' && !validMessageUuid(uuid)) || !meta.sessionId || at < 0 || selected < 0 || (agent === 'codex' && (!events[at].turnId || kept.slice(selected + 1).some(event => event.kind === 'message' && event.turnId === events[at].turnId)))) throw fault('INVALID_INPUT', '이 지점에서는 분기할 수 없습니다.');
      return { events: kept.slice(0, selected + 1), meta: { agent, cwd, worktree: meta.worktree, worktreePath: meta.worktreePath, configDir: meta.configDir, sessionId: meta.sessionId, resumeAt: agent === 'codex' ? events[at].turnId : uuid, fork: true, model: meta.model, effort: meta.effort, addDirs: meta.addDirs, permissionMode: meta.permissionMode } };
    },
    // Rewind: drop everything after one assistant message. The next message starts a fork of the session at that point (conversation only; files Claude already changed stay).
    async rewind(uuid) {
      live();
      if (turnOpen || approvals.size) throw fault('CHAT_BUSY', '응답이 끝난 뒤 되돌릴 수 있습니다.', 409);
      const snapshot = this.branchSnapshot(uuid);
      restart();
      meta.resumeAt = snapshot.meta.resumeAt; meta.fork = true;
      emit({ kind: 'rewind', uuid }); await saveMeta(); setStatus();
    },
    // Chat -> terminal: only while nothing runs. The child is ended (and waited for), so the session has a single writer again when the terminal resumes it.
    async handoff({ force = false } = {}) {
      live();
      if (turnOpen || approvals.size || steers.size) throw fault('CHAT_BUSY', '응답이 끝난 뒤 전환할 수 있습니다.', 409);
      if (state.liveTasks.length && !force) throw fault('CHAT_BACKGROUND', '백그라운드 작업이 실행 중입니다. 전환하면 종료됩니다.', 409);
      if (!meta.sessionId) throw fault('INVALID_INPUT', '아직 시작하지 않은 대화입니다. 새 터미널을 여세요.', 409);
      if (meta.resumeAt) throw fault('INVALID_INPUT', '되돌린 직후에는 전환할 수 없습니다. 메시지를 한 번 보낸 뒤 전환하세요.', 409);
      if (child) {
        const proc = dropChild();
        await new Promise(resolve => { if (proc.exitCode !== null || proc.signalCode) return resolve(); const timer = setTimeout(resolve, 3000); proc.once('close', () => { clearTimeout(timer); resolve(); }); });
        if (proc.exitCode === null && !proc.signalCode) throw fault('CHAT_SWITCH_FAILED', 'Claude를 종료하지 못해 전환을 중단했습니다.', 500);
      }
      setStatus();
      return { agent, sessionId: meta.sessionId, configDir: meta.configDir };
    },
    // Where this conversation's transcript lives, for the statistics view.
    sessionRef() { return { agent, sessionId: state.sessionId ?? meta.sessionId ?? null, configDir: meta.configDir, cwd, worktreePath: meta.worktreePath }; },
    // Esc on a queued steering message: the CLI withdraws it if the running turn has not taken it in yet (cancel_async_message).
    async cancelSteer() {
      live();
      if (!state.capabilities.cancelSteer) throw fault('CHAT_UNSUPPORTED', state.capabilities.limitations.cancelSteer, 409);
      const uuid = [...steers.keys()].at(-1), item = steers.get(uuid);
      if (!item || !child) return false;
      const response = await control({ subtype: 'cancel_async_message', message_uuid: uuid }, 3000);
      if (response?.response?.cancelled !== true) return false;
      steers.delete(uuid); emit({ kind: 'steer', phase: 'cancelled', uuid, text: item.text });
      return true;
    },
    // /clear: forget the Claude-side session and start a fresh one; the old transcript stays as history above a divider.
    async reset({ force = false } = {}) {
      live();
      if (configuring) throw fault('CHAT_BUSY', '모델 설정을 적용 중입니다.', 409);
      if (turnOpen || approvals.size) throw fault('CHAT_BUSY', '응답이 끝난 뒤 새 대화를 시작할 수 있습니다.', 409);
      if (state.liveTasks.length && !force) throw fault('CHAT_BACKGROUND', '백그라운드 작업이 실행 중입니다. 새 대화를 시작하면 종료됩니다.', 409);
      if (state.sessionId) await seedChat({ directory, id: randomUUID(), events: retainedEvents(), meta: snapshotMeta() });
      restart();
      meta.resumeAt = undefined; meta.fork = false;
      clearApprovals(); dropSteers(false); turnOpen = false; meta.sessionId = undefined; meta.costBase = 0; state.sessionId = null; state.costUsd = agent === 'claude' ? 0 : null; state.contextTokens = 0; state.tokens = zero(); resetLive(); state.turns = 0; state.durationMs = 0;
      emit({ kind: 'divider', reason: 'clear' }); await saveMeta(); setStatus();
    },
    async close({ forget = false, archiveAs } = {}) {
      if (closed) return;
      closed = true; clearTimeout(idleTimer); clearTimeout(activityTimer); stopCursorStorePoll();
      if (child) { const proc = dropChild(); setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 3000).unref(); }
      await writing.catch(() => {});
      if (forget) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      else { await saveMeta(); if (archiveAs) await fs.rename(root, chatFolder(directory, archiveAs)); } // archiveAs: the transcript moves to another id so this id can start over as another agent
    }
  };
}

// Only this project's stored Chat sessions are listed; the provider's private CLI history stays with its CLI.
export async function listChatSessions({ directory, agent, exclude }) {
  if (!chatAgents.includes(agent)) throw fault('INVALID_INPUT', '잘못된 에이전트입니다.');
  const root = path.join(directory, 'chat');
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID.test(entry.name) || entry.name === exclude) continue;
    try {
      const file = path.join(root, entry.name, 'meta.json'), meta = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!meta || (meta.agent ?? 'claude') !== agent || typeof meta.sessionId !== 'string' || !meta.sessionId) continue;
      sessions.push({ id: entry.name, sessionId: meta.sessionId, title: typeof meta.title === 'string' && meta.title ? meta.title : `대화 ${String(meta.sessionId).slice(0, 8)}`, model: [meta.lastModel, meta.model].find(value => typeof value === 'string' && value) ?? null, updatedAt: (await fs.stat(file)).mtimeMs });
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Writes a new chat's folder from a Branch snapshot; `openChatSession` then loads it like any stored chat.
export async function seedChat({ directory, id, events, meta }) {
  const root = chatFolder(directory, id);
  if (await fs.stat(path.join(root, 'meta.json')).then(() => true, () => false)) throw fault('INVALID_INPUT', '이미 있는 채팅입니다.');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, 'events.jsonl'), events.map(event => JSON.stringify(event) + '\n').join(''), { mode: 0o600 });
  await fs.writeFile(path.join(root, 'meta.json'), JSON.stringify({ ...meta, costBase: 0 }), { mode: 0o600 });
}

// Cursor publishes its catalog on a new ACP session; this empty session makes no model call.
export async function probeAgentModels({ agent, cwd, env = {}, spawnProcess = spawnAgent, executable = agent === 'cursor' ? 'cursor-agent' : agent, executableArgs = [], timeoutMs = 30_000 }) {
  if (!['codex', 'cursor'].includes(agent)) throw fault('INVALID_INPUT', '잘못된 에이전트입니다.');
  const proc = spawnProcess(executable, [...argsOf(executableArgs), agent === 'codex' ? 'app-server' : 'acp'], { cwd, env: { ...process.env, ...(typeof env === 'function' ? env() : env), NO_COLOR: '1' }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', catalog = [], configOptions = [], model = null;
  const decoder = new StringDecoder('utf8');
  const protocol = createChatProtocol(agent, { write: line => new Promise((resolve, reject) => proc.stdin.write(line, error => error ? reject(error) : resolve())),
    emit: event => { if (event.kind === 'capabilities') { catalog = event.capabilities.catalog; configOptions = event.capabilities.configOptions; } if (event.kind === 'session' && event.model) model = event.model; } });
  proc.stderr.resume(); proc.stdin.on('error', () => {});
  proc.on('error', () => protocol.dispose()); proc.on('close', () => protocol.dispose());
  proc.stdout.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > MAX_LINE) { protocol.dispose(); proc.kill(); return; }
    let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); try { protocol.handle(JSON.parse(line)); } catch {} }
  });
  const timer = setTimeout(() => { protocol.dispose(); proc.kill(); }, timeoutMs);
  try { await protocol.initialize({ discoverOnly: true, addDirs: [], permissionMode: 'default' }, cwd); return { models: model ? { '': model } : {}, catalog, configOptions }; }
  finally { clearTimeout(timer); protocol.dispose(); proc.kill(); const force = setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 3000); force.unref(); }
}

// A terminal's Claude conversation continued as a chat: its transcript becomes the stored events, and `claude -p --resume` takes over the same session.
// `configDir` keeps the account whose folder holds that session. ponytail: only the last 16 MB of a transcript are read (the chat keeps 4000 events anyway).
export async function seedFromTranscript({ directory, id, file, sessionId, configDir, model }) {
  const handle = await fs.open(file, 'r');
  let text;
  try { const { size } = await handle.stat(), length = Math.min(size, 16 * 1024 * 1024), buffer = Buffer.alloc(length); await handle.read(buffer, 0, length, size - length); text = buffer.toString('utf8'); } finally { await handle.close(); }
  const events = transcriptEvents(text).map((event, index) => ({ ...event, seq: index + 1, at: event.at ?? Date.now() }));
  const last = events.findLast(event => event.kind === 'message' && /^claude-/.test(event.model ?? ''));
  await seedChat({ directory, id, events, meta: { sessionId, configDir, model: model ?? last?.model, addDirs: [] } });
  return events.length;
}

export { collectCommandMetadata, listCommands, lookupCommandMeta, mergeCommandCatalog, parseCommandFrontmatter, probeInit, probeSlashCommands } from './slash-commands.js';

// What each alias means comes from the CLI's own catalog (`provider_alias_targets`, fetched with the user's login):
// { alias: { default, perProvider: { bedrock, vertex, ... } } }. Read from the file, so it costs no CLI start.
const idLike = value => typeof value === 'string' && /^[\w.-]{1,100}$/.test(value);
export async function readAliasTargets(home = os.homedir()) {
  const dir = path.join(home, '.claude', 'cache', 'model-catalog');
  let best = null;
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!name.endsWith('-cc.json')) continue;
    try {
      const file = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')), targets = file?.catalog?.config?.provider_alias_targets;
      if (targets && typeof targets === 'object' && Number(file.fetchedAt) > (best?.at ?? 0)) best = { at: Number(file.fetchedAt), targets };
    } catch {}
  }
  return Object.fromEntries(Object.entries(best?.targets ?? {}).flatMap(([alias, item]) => idLike(item?.default)
    ? [[alias, { default: item.default, perProvider: Object.fromEntries(Object.entries(item.per_provider ?? {}).filter(([, id]) => idLike(id))) }]] : []));
}

const PROVIDER_FLAGS = { CLAUDE_CODE_USE_BEDROCK: 'bedrock', CLAUDE_CODE_USE_VERTEX: 'vertex', CLAUDE_CODE_USE_FOUNDRY: 'foundry' };

// { '': default model, opus, sonnet, haiku }, one way for everything and no helper child for the aliases: an ANTHROPIC_DEFAULT_*_MODEL override wins,
// then the catalog entry for the provider in use. The default is the `model` setting (alias or id); only when none is set does `init()` (one CLI start,
// the same answer the command menu uses) name the account's default. An alias nothing resolves is left out; the picker then shows its plain name.
export async function resolveModels({ env = {}, cwd = os.tmpdir(), home = os.homedir(), init } = {}) {
  const merged = { ...process.env, ...(typeof env === 'function' ? env() : env) };
  const [targets, layers] = await Promise.all([readAliasTargets(home), readClaudeSettingsLayers(merged.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), cwd)]);
  const get = key => merged[key] ?? layers.env[key];
  const provider = Object.entries(PROVIDER_FLAGS).find(([flag]) => ['1', 'true'].includes(String(get(flag)).toLowerCase()))?.[1];
  const target = alias => (provider && targets[alias]?.perProvider[provider]) || targets[alias]?.default;
  const models = {};
  for (const alias of ['opus', 'sonnet', 'haiku']) { const id = get(`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`) ?? target(alias); if (id) models[alias] = id; }
  const wanted = get('ANTHROPIC_MODEL') ?? layers.settings.model;
  const known = typeof wanted === 'string' ? models[wanted] ?? target(wanted) ?? (/^claude-[\w.-]+$/.test(wanted) ? wanted : null) : null;
  const model = known ?? (await init?.())?.model;
  if (model) models[''] = model;
  return models;
}

// Every model an Anthropic API key can use, from the Models API. With an API key the CLI never writes its catalog (below), so without this the
// picker only had the opus/sonnet/haiku aliases. Same shape as readModelCatalog; `main` marks the newest model of each family (the quick menu).
// [] when the request fails (bad key, offline), so the caller falls back to the CLI catalog.
const API_FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];
export async function fetchApiModelCatalog({ apiKey, baseURL, timeoutMs = 10_000, Client } = {}) {
  if (!apiKey) return [];
  try {
    Client ??= (await import('@anthropic-ai/sdk')).default;
    const client = new Client({ apiKey, ...(baseURL && { baseURL }), timeout: timeoutMs, maxRetries: 1 });
    const models = [];
    for await (const item of client.models.list({ limit: 100 })) { models.push(item); if (models.length >= 64) break; }
    const rows = models.flatMap(item => {
      const id = item?.id, raw = typeof item?.display_name === 'string' ? item.display_name.trim() : '';
      if (typeof id !== 'string' || !/^[\w.-]{1,100}$/.test(id)) return [];
      // "Claude Opus 5.5" -> "Opus 5.5"; the old "Claude 3.5 Haiku" order -> "Haiku 3.5".
      let name = (raw || id).replace(/^Claude\s+/i, '');
      const old = /^(\d[\d.]*)\s+([A-Za-z]+)$/.exec(name); if (old) name = `${old[2]} ${old[1]}`;
      if (name.length > 40) return [];
      const words = name.toLowerCase().split(/\s+/), family = (words.find(word => API_FAMILIES.includes(word)) ?? words[0]).replace(/[^a-z0-9]/g, '').slice(0, 20);
      return [{ id, name, family, window: Number(item.max_input_tokens) || 0, main: false, created: Date.parse(item.created_at) || 0 }];
    });
    const newest = new Map();
    for (const row of rows) if (API_FAMILIES.includes(row.family) && (!newest.has(row.family) || row.created > newest.get(row.family).created)) newest.set(row.family, row);
    return rows.map(({ created, ...row }) => ({ ...row, main: newest.get(row.family)?.id === row.id }));
  } catch { return []; }
}

// Every model the CLI offers right now. The CLI keeps its own catalog (fetched with the user's login, refreshed about hourly while it runs) in
// ~/.claude/cache/model-catalog/*-cc.json; only the model list is read from the newest one: id, name, family, context window. Nothing else in the
// file (and no credential) is used. [] when the CLI has no catalog yet or its format changed.
export async function readModelCatalog(home = os.homedir()) {
  const dir = path.join(home, '.claude', 'cache', 'model-catalog');
  let best = null;
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!name.endsWith('-cc.json')) continue;
    try {
      const file = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')), models = file?.catalog?.config?.models;
      if (Array.isArray(models) && Number(file.fetchedAt) > (best?.at ?? 0)) best = { at: Number(file.fetchedAt), models };
    } catch {}
  }
  return (best?.models ?? []).slice(0, 64).flatMap(item => {
    const id = item?.id, name = item?.name;
    if (typeof id !== 'string' || typeof name !== 'string' || !/^[\w.-]{1,100}$/.test(id) || name.length > 40) return [];
    const family = String(typeof item.runtime?.family === 'string' ? item.runtime.family : name.split(' ')[0]).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    return [{ id, name, family, window: Number(item.runtime?.max_input_tokens) || 0, main: item.section === 'main' }];
  });
}
