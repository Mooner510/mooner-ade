import { slimEvents } from './chat-replay.js';
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fault } from './files.js';
import { resolveAgentCommand, spawnAgent } from './agent-spawn.js';
import { conversationDigest, runBtw } from './chat-btw.js';
import { CODEX_KEY_ENV } from './agent-keys.js';
import { autoDenialReason, pendingBlocked, retryText, sessionRule } from './auto-denial.js';
import { alwaysSuggestions, ARTIFACT_FLAG_SETTINGS, sessionRuleStrings, toolAllowable, toolSuggestions, ASK_SKIPPED, askUserInput, approvalLine, buildClaudeArgs, claudePeerMessage, cliPermissionMode, controlLine, EFFORTS, normalizeClaude, isPickedModel, PERMISSION_MODES, worktreeMove, planRevision, refusalWith, transcriptEvents, uiPermissionMode, userLine, validMessageUuid, wantsArtifact } from './chat-claude.js';
import { cursorAutoCompact, cursorStorePath, readCursorStoreUsage } from './cursor-context.js';
import { backupCursorStore, cursorConfigDir, exportCursorSession, forkCursorSession, readCursorBilledUsage, snapshotCursorSession } from './cursor-sessions.js';
import { cleanCursorSummarizeOutput, isCursorSummarizeCommand, runCursorSummarize } from './cursor-summarize.js';
import { claudeMcp, isTrusted } from './mcp-trust.js';
import { chatAgents, chatCapabilities, createChatProtocol, cursorEffortOption } from './chat-rpc.js';
import { cursorSurface } from './cursor-model-cache.js';
import { cleanChatTitle, resolveChatTitle, segmentUserEvents } from './chat-title.js';
import { autoCompactDisabled, readAutoCompact, readClaudeSettingsLayers, writeAutoCompact } from './claude-auto-compact.js';
import { IDLE_LEAD, idleCompactDue, idleCompactOn, idleCompactSkip } from './chat-idle-compact.js';
import { readSessionCache } from './claude-cache.js';
import { chatEventStats, eventWeightSince, subagentExtra, withSubagents } from './chat-stats.js';
import { readClaudeDefaults } from './claude-defaults.js';
import { chatMcpServers } from './terminal-sessions.js';
import { chatPrompt } from './chat-prompt.js';
import { createChatTextStore } from './chat-text.js';
import { readLastLines, renameRetry } from './file-util.js';
import { evaluateLimit, limitOptions, limitView, normalizeLimit, POLL_MS } from './chat-limit.js';
import { interactiveHint, pendingShellRuns, runShell, SHELL_MAX_COMMAND, SHELL_TIMEOUT_MS, shellContext, wantsTerminal } from './chat-shell.js';
import { createTurnSnapshots } from './chat-snapshots.js';
import { createChatWorktree, detectWorktree, moveClaudeSession, moveNote, readOwnWorktree, samePath, worktreeStatus, writeOwnWorktree } from './chat-worktree.js';

const ID = /^[a-zA-Z0-9-]{1,128}$/;
const MAX_LINE = 8 * 1024 * 1024, KEEP_EVENTS = 4000, IDLE_MS = 10 * 60_000;
// Set once any Claude child echoed one of our plain messages back by its uuid (--replay-user-messages): from then on a turn that ended without the echo is known not to have taken the message in.
let echoesSeen = false;
const isClaudeCompact = text => /^\/compact(?:\s|$)/.test(text);
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
const contextReading = event => {
  if (event.kind === 'usage') return event.contextTokens;
  if (event.kind === 'compact') return event.postTokens;
  if (event.kind === 'message' && event.usage && !event.parentToolUseId) {
    const { input, cacheRead, cacheCreate, output } = event.usage;
    return input + cacheRead + cacheCreate + output;
  }
};

// One chat tab = one transcript + (while a turn or an approval is open) one `claude -p` child. The child starts on the first
// message and is resumed with `--resume <session id>` when it ended in between, so closing the app never loses the conversation.
// `env` and `executableArgs` may be functions, read at every launch, so a change (an API key turned on, a plugin added) reaches the next (re)start.
const argsOf = (args, auth) => typeof args === 'function' ? args(auth) : args;
// On Windows the agent's Bash tool runs Git Bash as a non-login shell, which sets no locale: its tools then treat UTF-8 as raw bytes, and
// `ls 존재하지않는폴더` reports the name as escaped bytes instead of text. With no locale variable at all, LC_CTYPE=C.UTF-8 fixes the encoding only;
// message language (LANG, LC_MESSAGES) stays as it was, and a locale the user set is never touched.
export function withUtf8Ctype(env, platform = process.platform) {
  if (platform === 'win32' && !env.LC_ALL && !env.LC_CTYPE && !env.LANG) env.LC_CTYPE = 'C.UTF-8';
  return env;
}

// `procHost` (the pty-host's piped processes, pty-client.js) runs the agent outside this server: `detach()` then leaves it running for the
// next server, which takes it over from `live.json` exactly where this one stopped reading. Without it the agent is a child of this server.
export async function openChatSession({ directory, id, projectId, cwd, agent = 'claude', env = {}, spawnProcess = spawnAgent, procHost = null, keyAvailable = () => true, spend = null, executable = agent === 'cursor' ? 'cursor-agent' : agent, executableArgs = [], onEvent, onState, prepare, recover, defaults, account, quietMs = BACKGROUND_QUIET_MS, shell = null, shellEnv = null, shellTimeoutMs = SHELL_TIMEOUT_MS, cursorModels = null, trusted = () => [], readUsage = null, limitPollMs = POLL_MS, idleCompact = () => null, idleLead = IDLE_LEAD, chatText = createChatTextStore(directory), onLedger = null }) {
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
  // `env` and `executableArgs` get this chat's own login choice, so an open chat keeps its login whatever Settings says for new chats.
  const envNow = () => typeof env === 'function' ? env(meta.auth) : env;
  const cursorCheckpoints = new Map();
  let cursorSnapshot = Promise.resolve();
  const cursorDirOf = () => meta.configDir || cursorConfigDir({ ...process.env, ...envNow() });
  // Last catalog and per-model options, so the bar is filled before cursor-agent answers. `null` in tests and for other agents.
  const cursorModelCache = agent === 'cursor' && typeof cursorModels === 'function' ? cursorModels(cursorDirOf()) : null;
  // Settings' defaults for a brand-new chat; a saved chat keeps what it has. Only modes this agent can apply, and never bypassPermissions.
  if (saved === null && defaults) {
    const caps = chatCapabilities(agent);
    if (caps.permissionModes.includes(defaults.permissionMode) && defaults.permissionMode !== 'bypassPermissions') meta.permissionMode = defaults.permissionMode;
    if (typeof defaults.model === 'string' && (agent === 'cursor' ? /^[\w.\[\],=:-]{1,200}$/ : /^[\w.\[\]-]{1,100}$/).test(defaults.model)) meta.model = defaults.model;
    if (EFFORTS.includes(defaults.effort)) meta.effort = defaults.effort;
    if (defaults.auth === 'login' || defaults.auth === 'key') meta.auth = defaults.auth;
  }
  if (saved !== null && (meta.agent ?? 'claude') !== agent) throw fault('INVALID_INPUT', '저장된 대화의 에이전트가 다릅니다.');
  cwd = meta.cwd ?? cwd;
  let events = [], seq = 0;
  try {
    // Only the tail is read: the log on disk keeps every event (history, stats and reviews can read it whole), a chat shows the last KEEP_EVENTS, and `seq` only grows.
    for (const line of await readLastLines(logFile, KEEP_EVENTS)) { if (!line) continue; try { const event = JSON.parse(line); events.push(event); seq = Math.max(seq, event.seq); } catch { /* torn last line after a crash */ } }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  events = events.slice(-KEEP_EVENTS);

  const state = { agent, capabilities: chatCapabilities(agent), status: 'idle', model: meta.model ?? null, effort: meta.effort ?? null, worktree: meta.worktree === true, addDirs: meta.addDirs, permissionMode: meta.permissionMode ?? 'default', sandbox: meta.sandbox ?? null, network: meta.network === true, runEverything: meta.runEverything === true, sessionId: meta.sessionId ?? null, costUsd: agent === 'claude' ? meta.costBase : null, turns: 0, durationMs: 0,
    contextTokens: 0, contextWindow: null, autoCompact: null, tokens: zero(), slashCommands: [], commandInfo: [], tools: [], pending: 0, error: null, startedAt: Date.now(),
    segmentTitles: { custom: '', ai: '', agent: '' }, chatTitle: '', liveTasks: [] }; // liveTasks: subagents (Agent call ids) running in the current child
  // apiKey: this chat's CLI runs on an API key (Settings > AI 툴, or the user's own environment), not the CLI login. The UI then shows "API Usage"
  // instead of a share of the plan's limits. Read from what the child is launched with, so it follows the setting from the next start on.
  state.cwd = meta.worktreePath ?? cwd; // the folder the CLI runs in: the UI shows file paths under it as relative paths
  state.worktreeInfo = null; // the git worktree this chat works in or keeps, with its status (refreshWorktree, chat-worktree.js)
  const usesApiKey = launch => Boolean(agent === 'claude' ? launch.ANTHROPIC_API_KEY : agent === 'codex' ? launch[CODEX_KEY_ENV] : launch.CURSOR_API_KEY);
  // A chat made before the choice existed keeps what it runs on now: a later change of the setting for new chats must not move it.
  if (meta.auth !== 'login' && meta.auth !== 'key') meta.auth = usesApiKey({ ...process.env, ...(typeof env === 'function' ? env(undefined) : env) }) ? 'key' : 'login';
  state.apiKey = usesApiKey({ ...process.env, ...envNow() });
  // The key this chat runs on right now (the setting, or the user's own environment) and what that key has cost across ALL chats (api-spend.js): the API Usage
  // figure is the key's total, so every chat on the same key shows the same, growing number. Without a ledger (tests) it is this chat's own spend.
  const keyNow = () => { const launch = { ...process.env, ...envNow() }; return agent === 'claude' ? launch.ANTHROPIC_API_KEY : agent === 'codex' ? launch[CODEX_KEY_ENV] : launch.CURSOR_API_KEY; };
  const keyTotal = () => spend ? spend.total(agent, keyNow()) : (meta.apiCostUsd ?? 0);
  // Spend recorded by a version that kept it per chat joins the key's total once, the first time the key is known.
  const adoptOwnSpend = () => {
    if (!spend || meta.apiCostAdopted || !(meta.apiCostUsd > 0) || !state.apiKey || !keyNow()) return;
    spend.add(agent, keyNow(), meta.apiCostUsd); meta.apiCostAdopted = true;
  };
  adoptOwnSpend();
  // auth: the login this chat starts on (kept by /clear). lastAuth: the login its last turn ran on, so the composer can ask before a turn changes it.
  // apiCostUsd: what the turns that ran on the API key cost: real money, unlike the cost of a plan's turns.
  state.auth = meta.auth; state.lastAuth = meta.lastAuth ?? null; state.apiCostUsd = meta.apiCostUsd ?? 0;
  // A turn is several API calls: `turnDone` holds the calls already finished, `turnUsage` the one streaming (`liveId`). result.usage is the whole turn, so it replaces both.
  // The API reports a message's real output_tokens only once, at its end (message_delta), so while it streams the shown output is the larger of that report and an
  // estimate: the CLI's thinking estimate plus the streamed text / tool input (`streamBytes`, ~4 bytes a token, so it runs under the real count and never overshoots).
  const btwRuns = new Map(); // /btw questions in flight, by the id the UI gave them (to cancel)
  let costPerUnit = 0, subCostCache = { seq: -1, price: -1, cost: 0 };
  const subLive = new Map(); // a subagent's usage while its message is still streaming (not stored yet)
  // Dollars of subagent usage the last total_cost_usd does not cover yet (a background agent that kept running after the result).
  const uncoveredCost = () => {
    if (subCostCache.seq !== seq || subCostCache.price !== costPerUnit) subCostCache = { seq, price: costPerUnit, cost: subagentExtra(events, { unitPrice: costPerUnit }).cost };
    let live = subCostCache.cost;
    if (costPerUnit > 0) for (const usage of subLive.values()) live += weigh(usage) * costPerUnit;
    return live;
  };
  let turnUsage = null, thinkingTokens = 0, streamBytes = 0, outputFinal = false, turnDone = zero(), liveId = null;
  const resetLive = () => { turnUsage = null; thinkingTokens = 0; streamBytes = 0; outputFinal = false; turnDone = zero(); liveId = null; };
  const nextMessage = id => { if (id == null || id !== liveId) { if (turnUsage) turnDone = addTokens(turnDone, turnUsage); turnUsage = null; thinkingTokens = 0; streamBytes = 0; outputFinal = false; liveId = id ?? null; } };
  // The transcript with rewinds applied, and the last request not yet answered. Both are read on every state publish (token updates included),
  // so they are kept until the next stored event instead of being rebuilt from up to 6000 events each time. Callers must not mutate them.
  let retainedCache = null, unansweredCache;
  const invalidate = () => { retainedCache = null; unansweredCache = undefined; };
  const through = (list, index) => {
    const end = list[index].seq;
    return list.filter((event, at) => at <= index || (event.kind === 'peer_message' && event.beforeSeq <= end));
  };
  function retainedEvents() {
    if (retainedCache) return retainedCache;
    let kept = [];
    for (const event of events) {
      if (event.kind === 'rewind') {
        const at = kept.findIndex(item => item.kind === 'message' && item.uuid === event.uuid);
        const checkpoint = agent === 'cursor' ? kept.findIndex(item => item.kind === 'cursor_checkpoint' && item.uuid === event.uuid) : -1;
        if (at >= 0) kept = through(kept, Math.max(at, checkpoint));
      }
      else kept.push(event);
    }
    return retainedCache = kept;
  }
  function rewoundClaudeContext(kept, rewind) {
    for (let i = kept.length - 1; i >= 0; i--) {
      const event = kept[i];
      if (event.kind === 'divider') return event.seq > rewind.seq ? 0 : null;
      const reading = contextReading(event);
      if (Number.isFinite(reading)) return reading;
    }
    return null;
  }
  // An alias ("sonnet") has no catalog row of its own: the family's first (newest) row stands in, else Auto Compact would be judged against 200k and switched off.
  const maxContextForModel = model => (model && /\[1m\]|-1m\b/i.test(model) ? 1_000_000 : (state.capabilities.catalog?.find(item => item.id === model) ?? state.capabilities.catalog?.find(item => item.family === model))?.window) || state.contextWindow || 200_000;
  // The CLI settles on the concrete model once it starts (modelSettings is then read under that id), so an alias is looked up as the model it stands for
  // from the start; judged by its own key ("sonnet") the gauge would show a window that vanishes with the first reply.
  const concreteModel = model => model && !state.capabilities.catalog?.some(item => item.id === model) ? state.capabilities.catalog?.find(item => item.family === model)?.id ?? model : model;
  // Where this chat's Claude Code keeps its settings and transcripts: the chat's own account, else the one a plain `claude` in this environment would use.
  const configDirOf = () => meta.configDir || envNow()?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  // Several refreshes can be in flight (open, catalog, init, result); only the newest one's answer is applied.
  // Only a window the user set (settings or env) is shown; "auto" is left to Claude Code, and the CLI reads the setting itself.
  let compactGeneration = 0;
  const refreshAutoCompact = async (model = state.model) => {
    if (agent !== 'claude') { if (state.autoCompact) { state.autoCompact = null; publish(); } return; }
    const generation = ++compactGeneration, configDir = configDirOf();
    const next = await readAutoCompact(configDir, cwd, concreteModel(model), maxContextForModel(model));
    if (generation !== compactGeneration) return;
    const prev = JSON.stringify(state.autoCompact), ready = JSON.stringify(next);
    if (prev !== ready) { state.autoCompact = next; publish(); }
  };
  void refreshAutoCompact();
  // The prompt cache's clock, read from the session's transcript (the same reading the terminal's cache timer uses): `state.cache` = the last main-thread
  // request, its cache lifetime and the context size it read. Claude resets that clock at the start of every main-thread API call, so a main-thread
  // response re-reads the transcript (a subagent's usage does not), and so does a turn end or a compact. The countdown itself runs in the page.
  let cacheReading = null, cacheBusy = false, cacheLater = null;
  const peerMessages = new Set(events.filter(event => event.kind === 'peer_message').map(event => event.uuid));
  function recordPeerMessage(event) {
    if (peerMessages.has(event.uuid)) return;
    // The CLI can write this to its transcript without emitting a user frame. Put it before the reply if the reply already arrived.
    const after = event.receivedAt && events.find(item => item.at >= event.receivedAt && (item.kind === 'user' || (item.kind === 'steer' && item.phase === 'applied') || (item.kind === 'message' && !item.parentToolUseId)));
    peerMessages.add(event.uuid);
    emit({ ...event, ...(after && { beforeSeq: after.seq, ...(after.kind === 'message' && { beforeMessageId: after.id }) }) });
  }
  const refreshCache = async () => {
    if (agent !== 'claude' || closed || !state.sessionId || cacheBusy) return;
    cacheBusy = true;
    try {
      const sessionId = state.sessionId;
      cacheReading = await readSessionCache(configDirOf(), { sessionId, cwd: meta.worktreePath ?? cwd }, cacheReading, { idle: false, onTranscript(text) {
        if (closed || state.sessionId !== sessionId || meta.resumeAt) return;
        const boundary = events.findLast(event => event.kind === 'divider' || event.kind === 'rewind')?.at ?? 0;
        const earliest = events[0]?.at ?? 0;
        for (const line of text.split('\n')) {
          if (!line.includes('cross-session-message') && !line.includes('"peer"')) continue;
          let raw; try { raw = JSON.parse(line); } catch { continue; }
          const peer = claudePeerMessage(raw);
          if (peer?.receivedAt > boundary && peer.receivedAt >= earliest) recordPeerMessage(peer);
        }
      } });
      await syncIdleCompact();
    } catch { /* an unreadable transcript keeps the last reading */ } finally { cacheBusy = false; }
  };
  // Idle auto-compact (chat-idle-compact.js): one timer per cache window, armed after every reading of the cache. `state.cache.compactAt` is when it is due (the chip says
  // "자동 Compact 예정"). The timer is the only thing that sends the /compact; when it fires every condition is looked at again, and the window gets no second chance.
  // idleCompactTried: the `at` of the window whose chance was used (sent or skipped). The CLI's compact_boundary marks a compact we sent as "manual": the chip calls it automatic.
  let idleCompactTimer = null, idleCompactSeq = 0, idleCompactTried = 0;
  const stopIdleCompact = () => { idleCompactSeq += 1; clearTimeout(idleCompactTimer); idleCompactTimer = null; };
  const idleSetting = () => ({ on: idleCompactOn(meta.idleCompact, idleCompact()), minK: idleCompact()?.minK });
  // What stops a compact for reasons outside the cache's own numbers; `fire`: also what only matters at the moment it would be sent (work in progress).
  async function idleCompactBlock(fire) {
    if (closed || !state.sessionId) return 'closed';
    if (fire && (!quiet() || steers.size)) return 'busy';
    if (limitBypass || meta.limit?.stop || (meta.limit && evaluateLimit(meta.limit, { cost: shown().costUsd, windows: null }).hit)) return 'limit';
    const { settings, env } = await readClaudeSettingsLayers(configDirOf(), meta.worktreePath ?? cwd);
    return autoCompactDisabled(settings, env) ? 'auto-compact-off' : null;
  }
  async function syncIdleCompact() {
    const seq = ++idleCompactSeq; clearTimeout(idleCompactTimer); idleCompactTimer = null;
    const base = cacheReading?.value ?? null, { on, minK } = idleSetting();
    let due = agent === 'claude' ? idleCompactDue({ on, minK, cache: base, lead: idleLead }) : undefined;
    if (due !== undefined && (base.at === idleCompactTried || await idleCompactBlock(false))) due = undefined;
    if (seq !== idleCompactSeq || closed) return;
    const shownCache = !base ? null : due !== undefined ? { ...base, compactAt: due } : base.compacted && base.at === idleCompactTried ? { ...base, compacted: { ...base.compacted, trigger: 'auto' } } : base;
    if (JSON.stringify(shownCache) !== JSON.stringify(state.cache ?? null)) { state.cache = shownCache; publish(); }
    if (due !== undefined) { idleCompactTimer = setTimeout(() => void fireIdleCompact(base), Math.max(0, due - Date.now())); idleCompactTimer.unref?.(); }
  }
  async function fireIdleCompact(base) {
    idleCompactTimer = null;
    const cache = cacheReading?.value;
    if (!cache || cache.at !== base.at) return;
    const { on, minK } = idleSetting(), skip = idleCompactSkip({ on, minK, cache, lead: idleLead, now: Date.now(), tried: idleCompactTried, busy: await idleCompactBlock(true) });
    idleCompactTried = cache.at;
    if (skip) { void syncIdleCompact(); return; }
    try { await chatApi.send('/compact', [], { idle: true }); } catch { /* refused (busy, stopped by a limit): not tried again in this window */ }
  }
  // The CLI writes the transcript a moment after it reports the response.
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
  // While a picked model is still being applied, ACP echoes the model the process started with. Those echoes are dropped so the bar does not jump back.
  // `cursorSurfaceLive` flips once that pick is echoed, and only then do the new model's Effort and options replace the ones on screen (one change, not two).
  let cursorModelHold = null, cursorSurfaceLive = true, cursorModeHold = null, cursorAppliedModel = null;
  const copiedBlobs = new Set(); // blob ids already archived for this chat; later checkpoints only copy what is new
  let child = null, protocol = null, closed = false, turnOpen = false, followText = '', turnSeq = 0, restartAfterTurn = false, idleTimer = null, writing = Promise.resolve(), publishTimer = null, lastCommandOutput = null;
  let reopened = false, activityTimer = null; // reopened: the turn is "open" only because background output arrived after a `result`
  // Claude: the message streaming right now per subagent ('' = main thread). Text deltas name no message; they belong to the latest start of their own stream.
  const streamIds = new Map(), toolInputSize = new Map();
  const taskIds = new Map(), approvals = new Map(), controls = new Map(), steers = new Map(); // steers: uuid -> { text, images, previews } sent into a running turn, not yet taken in by it
  const subTools = new Set(); // tool calls a subagent made; their results are not this conversation's turn
  let cursorAcpUsageAt = 0, cursorStorePoll = null, cursorStoreUntil = 0, cursorSummaryCount = null, cursorManualCompact = false;
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
    const reading = await readCursorStoreUsage(sessionId, { storePath: id => cursorStorePath(id, { env: { CURSOR_CONFIG_DIR: cursorDirOf() } }) }).catch(() => null);
    if (!reading) return;
    // /summarize emits its own divider. While that runs, a store poll must not add a second "자동 압축".
    const noted = cursorManualCompact ? { count: cursorSummaryCount, event: null } : cursorAutoCompact(cursorSummaryCount, reading, state.contextTokens);
    if (!cursorManualCompact) cursorSummaryCount = noted.count;
    if (noted.event) emit(noted.event);
    if (!noted.event && cursorAcpUsageAt && Date.now() - cursorAcpUsageAt < 60_000 && state.contextTokens > 0 && reading.contextTokens <= state.contextTokens) return;
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
  const snapshotMeta = () => ({ configValues: meta.configValues, agent, cwd, worktreePath: meta.worktreePath, configDir: meta.configDir, resumeAt: meta.resumeAt, fork: meta.fork || undefined, sessionId: state.sessionId ?? undefined, model: meta.model, lastModel: state.model ?? undefined, effort: meta.effort, worktree: meta.worktree, addDirs: meta.addDirs, permissionMode: meta.permissionMode, prePlanMode: meta.prePlanMode, sandbox: meta.sandbox ?? undefined, network: meta.network || undefined, runEverything: meta.runEverything || undefined, interactiveUi: meta.interactiveUi, fileLinks: meta.fileLinks || undefined, mediaBlocks: meta.mediaBlocks || undefined, colorChips: meta.colorChips || undefined, sessionAllow: meta.sessionAllow?.length ? meta.sessionAllow : undefined, allowTools: meta.allowTools?.length ? meta.allowTools : undefined, apiCostAdopted: meta.apiCostAdopted || undefined, artifact: meta.artifact || undefined, costBase: typeof state.costUsd === 'number' ? state.costUsd : meta.costBase, auth: meta.auth, lastAuth: meta.lastAuth, apiCostUsd: meta.apiCostUsd || undefined, limit: meta.limit, idleCompact: typeof meta.idleCompact === 'boolean' ? meta.idleCompact : undefined, title: state.chatTitle }); // the file keeps the running total, so a crash or kill keeps the cost
  // Most calls (every send, every child close) find nothing changed: identical content is not written again. A failed write is forgotten so the next call retries.
  let lastMeta = null;
  const saveMeta = () => {
    const data = JSON.stringify(snapshotMeta());
    if (data === lastMeta) return writing;
    lastMeta = data;
    const saved = writing.then(async () => {
      const temporary = `${metaFile}.tmp`;
      await fs.writeFile(temporary, data, { mode: 0o600 });
      // Windows can refuse the replace for a moment while something reads meta.json; retried, and the temp file does not stay behind on a final failure.
      try { await renameRetry(temporary, metaFile); } catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
    });
    writing = saved.catch(error => { if (lastMeta === data) lastMeta = null; reportStorage(error); }); return saved;
  };
  // Limits (chat-limit.js). limitNow: the last window readings for the chip. limitBypass: the automatic compact after a stop runs outside the limit.
  let limitNow = {}, limitTimer = null, limitBypass = false;
  const hasWindowRule = () => Boolean(meta.limit?.share || meta.limit?.usage);
  const tokensShown = () => {
    const reported = turnUsage ?? zero();
    const live = outputFinal ? reported : { ...reported, output: Math.max(reported.output, thinkingTokens + (streamBytes >> 2)) };
    return addTokens(addTokens(state.tokens, turnDone), live);
  };
  // The CLI reports the session cost in a turn's result (that total includes subagents that finished before it). While a turn runs, add the in-flight main-thread
  // tokens at the last turn's price, plus subagent usage the total does not cover yet. ponytail: no estimate before the first priced result.
  const shown = () => {
    const tokens = tokensShown(), live = weigh(tokens) - weigh(state.tokens), base = typeof state.costUsd === 'number' ? state.costUsd + uncoveredCost() : state.costUsd;
    const inflight = typeof base === 'number' && costPerUnit && live > 0 ? live * costPerUnit : 0;
    // The API Usage figure grows with the running turn too (the in-flight part is billed to the key), so it moves live like the session cost.
    const costUsd = typeof base === 'number' ? base + inflight : base;
    const mcpServers = chatMcpServers({ chatId: id, projectId, agent }).map(server => ({ name: server.name, disabledTools: [...(server.disabledTools ?? [])], autoApprove: server.autoApprove === true }));
    return { ...state, tokens, costUsd, apiCostUsd: state.apiKey ? keyTotal() + inflight : state.apiCostUsd, pending: approvals.size, recoverable: canRetryTurn(), mcpServers,
      limit: meta.limit ? limitView(meta.limit, { ...limitNow, ...(typeof costUsd === 'number' && { cost: costUsd }) }) : null, limitOptions: limitOptions({ agent, cost: state.capabilities.cost, apiKey: state.apiKey }),
      ...(agent === 'claude' && { idleCompact: { chat: typeof meta.idleCompact === 'boolean' ? meta.idleCompact : null, on: idleSetting().on } }) };
  };
  // Every publish (usage and result events, live token ticks) looks at the chat's own cost, so a cost limit stops the turn while it runs, with no polling.
  const publish = () => {
    clearTimeout(publishTimer); publishTimer = null;
    const view = shown(), hit = meta.limit && !meta.limit.stop && !limitBypass ? limitStep(view.costUsd, null) : null;
    if (hit) stopByLimit(hit); else onState?.(view);
  };
  // Another chat spent on the key this one runs on: repaint, so the shared API Usage figure moves here too.
  const unsubscribeSpend = spend?.subscribe(id => { if (!closed && state.apiKey && id === spend.idOf(agent, keyNow())) publishSoon(); });
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
  // Turn snapshots (chat-snapshots.js): the work folder as a git commit when a turn starts and ends, for the turn's change card and Rewind's
  // file restore. The folder is read at every snapshot (the agent can move into a worktree). Off with ADE_TURN_SNAPSHOTS=0.
  const workFolder = () => state.cwd || meta.worktreePath || cwd;
  const turnSnaps = process.env.ADE_TURN_SNAPSHOTS === '0' ? null : createTurnSnapshots({ chatId: id, folder: workFolder, emit: event => emit(event), events: () => events });
  // The turn's last main-thread answer, which the change card hangs under and Rewind names.
  const lastAnswer = () => {
    for (let at = events.length - 1; at >= 0; at--) {
      const event = events[at];
      if (event.kind === 'message' && !event.parentToolUseId && event.role !== 'user') return { uuid: event.uuid, messageId: event.id };
      if (event.kind === 'user' || event.kind === 'divider') break;
    }
    return {};
  };
  let snapTurn = false;
  const noteTurnEdge = () => { if (!turnSnaps || closed || turnOpen === snapTurn) return; snapTurn = turnOpen; if (turnOpen) turnSnaps.turnStarted(); else void turnSnaps.turnEnded(lastAnswer()); };
  const snapFault = error => { throw error?.reason ? fault(`SNAPSHOT_${String(error.reason).toUpperCase().replace(/-/g, '_')}`, error.message, 409) : error; };
  const answerOf = uuid => ({ uuid, messageId: events.find(event => event.kind === 'message' && event.uuid === uuid)?.id });
  const setStatus = () => {
    noteTurnEdge();
    state.status = closed ? 'closed' : approvals.size ? 'attention' : turnOpen ? 'working' : 'idle'; state.pending = approvals.size; syncLimitPoll(); publish();
    // An idle Claude or Codex child holds a few hundred MB; the conversation resumes from its session id, so it can go.
    // Cursor's process takes several seconds to start, so it stays for the life of the chat. Closing the chat still stops it.
    clearTimeout(idleTimer);
    // Background subagents live in the child: it is kept while any of them runs (a silent leak of `liveTasks` ends with the child's exit or the chat's close).
    if (child && quiet() && agent !== 'cursor') { const proc = child; idleTimer = setTimeout(() => { if (child === proc && quiet()) proc.kill('SIGTERM'); }, IDLE_MS); idleTimer.unref(); }
  };
  // The view of the world the status line shows, derived from events so that a replayed transcript gives the same numbers.
  function fold(event, replay = false) {
    const reading = contextReading(event);
    if (Number.isFinite(reading)) state.contextTokens = reading;
    if (event.kind === 'session') {
      state.sessionId = event.sessionId ?? state.sessionId;
      if (!(cursorModelHold !== null && event.model && event.model !== cursorModelHold)) {
        state.model = event.model ?? state.model;
        if (cursorModelHold !== null && event.model === cursorModelHold) cursorSurfaceLive = true;
      }
      // Claude: a session event only reports the mode the child started with (replayed, or arriving after a later switch); a mode the user picked is in meta and wins.
      if (event.permissionMode !== undefined && (agent !== 'claude' || meta.permissionMode === undefined) && !(cursorModeHold && uiPermissionMode(event.permissionMode) !== cursorModeHold)) { const mode = uiPermissionMode(event.permissionMode); state.permissionMode = mode; if (agent !== 'claude') meta.permissionMode = mode; }
      if (event.slashCommands?.length) state.slashCommands = event.slashCommands.map(item => typeof item === 'string' ? item : item?.name).filter(name => typeof name === 'string');
      if (Array.isArray(event.commands)) state.commandInfo = event.commands.flatMap(item => {
        if (!item || typeof item.name !== 'string' || !/^[\w:.-]+$/.test(item.name)) return [];
        const hint = typeof item.hint === 'string' ? item.hint.slice(0, 120) : '';
        return [{ name: item.name, description: typeof item.description === 'string' ? item.description.slice(0, 200) : '', ...(hint ? { hint } : {}) }];
      });
      if (event.tools?.length) state.tools = event.tools;
    } else if (event.kind === 'cursor_checkpoint') {
      cursorCheckpoints.set(event.uuid, event.file);
      state.capabilities = { ...state.capabilities, branch: true, rewind: true };
    } else if (event.kind === 'capabilities' && cursorModelHold !== null && !cursorSurfaceLive) { /* the model the process started with; the picked model's options follow */ }
    else if (event.kind === 'capabilities') {
      state.capabilities = { ...event.capabilities, ...(cursorCheckpoints.size && { branch: true, rewind: true }),
        ...(state.capabilities.tokens && { tokens: true }), ...(state.capabilities.cost && { cost: true }) };
      if (agent === 'cursor' && state.model && state.capabilities.configOptions?.length) cursorModelCache?.note({ model: state.model, catalog: state.capabilities.catalog, configOptions: state.capabilities.configOptions });
    }
    else if (event.kind === 'worktree') { if (typeof event.path === 'string' && (event.phase === 'enter' || event.phase === 'exit')) state.cwd = event.path; }
    else if (event.kind === 'settings') {
      if (event.permissionMode !== undefined && !(cursorModeHold && event.permissionMode !== cursorModeHold)) state.permissionMode = event.permissionMode;
      if (event.effort !== undefined && (cursorModelHold === null || cursorSurfaceLive)) state.effort = event.effort;
    }
    else if (event.kind === 'usage') {
      if (event.tokens) state.tokens = event.tokens;
      state.contextWindow = event.contextWindow ?? state.contextWindow;
      if (event.contextSource === 'acp' || event.contextSource === 'store') state.contextUsageSource = event.contextSource;
      state.capabilities = { ...state.capabilities, context: true, tokens: Boolean(event.tokens) || state.capabilities.tokens };
      if (Number.isFinite(event.costUsd) && event.costUsd >= 0) { state.costUsd = event.costUsd; state.capabilities.cost = true; }
    } else if (event.kind === 'result') {
      state.turns += 1; state.durationMs += event.durationMs ?? 0; if (event.contextWindow) state.contextWindow = event.contextWindow;
      if (event.usage) for (const key of Object.keys(state.tokens)) state.tokens[key] += event.usage[key]; resetLive();
      // costUsd is the session total (sessionCost turns the CLI's per-process total into it, also for a child that started its count from 0).
      if (!replay && event.costUsd != null) { const spent = weigh(event.usage ?? zero()); if (spent > 0 && event.costUsd > state.costUsd) costPerUnit = (event.costUsd - state.costUsd) / spent; state.costUsd = event.costUsd; void saveMeta().catch(() => {}); } // saveMeta reports its own failure
      else if (event.turnCostUsd > 0) { const spent = weigh(event.usage ?? zero()); if (spent > 0) costPerUnit = event.turnCostUsd / spent; } // a reopened chat still prices subagent usage that landed after the last result
      if (event.status === 'failed') state.error = event.text || '실패했습니다.'; else state.error = null;
    } else if (event.kind === 'rewind' && agent === 'claude') {
      const kept = retainedEvents();
      state.contextTokens = rewoundClaudeContext(kept, event);
      const window = kept.findLast(item => (item.kind === 'usage' || item.kind === 'result') && item.contextWindow)?.contextWindow ?? null;
      if (state.contextWindow !== window) {
        state.contextWindow = window;
        void refreshAutoCompact();
      }
    } else if (event.kind === 'divider') {
      subLive.clear();
      state.tokens = zero(); state.turns = 0; state.durationMs = 0; state.contextTokens = 0; resetLive(); state.cache = null; cacheReading = null; stopIdleCompact(); idleCompactTried = 0;
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
  // A rewind marker is absent from the retained transcript; consult the log so a missing reading also stays pending on reopen.
  const lastClaudeRewind = agent === 'claude' && events.findLast(event => event.kind === 'rewind');
  if (lastClaudeRewind) state.contextTokens = rewoundClaudeContext(retainedEvents(), lastClaudeRewind);
  // Replaying old init events would show the model the child started with, not the one picked since (set_model sends no new init): the pick is stored, so it wins.
  if (meta.model) state.model = meta.model;
  // A new Cursor chat has no capabilities in the log yet. Paint the last list (and this model's options, if seen) before the process starts.
  if (agent === 'cursor' && !state.capabilities.catalog.length) {
    const surface = cursorSurface(cursorModelCache?.get(), state.model);
    if (surface) {
      state.capabilities = { ...state.capabilities, catalog: surface.catalog, ...(surface.configOptions.length && { configOptions: surface.configOptions, efforts: surface.efforts, ...(surface.effortConfigId && { effortConfigId: surface.effortConfigId }) }) };
      if (!state.model && surface.model) state.model = surface.model;
      if (surface.configOptions.length && meta.effort === undefined) state.effort = surface.effort;
    }
  }
  if (agent === 'codex' && meta.effort !== undefined) state.effort = meta.effort;
  if (agent === 'claude' && meta.permissionMode !== undefined) state.permissionMode = meta.permissionMode; // a mode picked since (or reported by the CLI) wins over older events
  refreshChatTitle();
  state.sessionId = meta.sessionId ?? null;
  let surfaceSuppressed = false;
  // A stale Cursor model echo must not reach the page: the client would paint it, then paint the pick again.
  const suppressedCursorSurface = event => agent === 'cursor' && cursorModelHold !== null && !cursorSurfaceLive && (event.kind === 'capabilities' || (event.kind === 'settings' && event.effort !== undefined && event.permissionMode === undefined) || (event.kind === 'session' && event.model && event.model !== cursorModelHold));
  function emit(event, { store = true } = {}) {
    surfaceSuppressed = suppressedCursorSurface(event);
    if (surfaceSuppressed) { if (event.sessionId) state.sessionId = event.sessionId; return; }
    // total_cost_usd is the session total; this turn's own cost is the step from the total before it (not when the old total is unknown: a session carried over from the CLI).
    const turnCost = store && event.kind === 'result' && event.costUsd != null && (state.costUsd > 0 || state.turns === 0) ? event.costUsd - state.costUsd : 0;
    const stamped = store ? { ...event, ...(turnCost > 0 && { turnCostUsd: turnCost }), ...(event.kind === 'result' && { auth: state.apiKey ? 'key' : 'login' }), seq: ++seq, at: Date.now() } : event;
    if (store) {
      if (event.kind === 'result') {
        meta.lastAuth = state.lastAuth = stamped.auth;
        if (stamped.auth === 'key' && turnCost > 0) {
          meta.apiCostUsd = state.apiCostUsd = (meta.apiCostUsd ?? 0) + turnCost;
          if (spend && keyNow()) { if (meta.apiCostAdopted) spend.add(agent, keyNow(), turnCost); else adoptOwnSpend(); } // adopting adds the whole own spend, this turn included
        }
        void saveMeta().catch(() => {});
      }
      events.push(stamped); if (events.length > KEEP_EVENTS * 1.5) events = events.slice(-KEEP_EVENTS);
      invalidate();
      const ledgerKind = stamped.kind === 'result' || stamped.kind === 'title' || stamped.kind === 'rewind' || stamped.kind === 'compact';
      writing = writing.then(() => fs.appendFile(logFile, JSON.stringify(stamped) + '\n', { mode: 0o600 })).then(() => {
        // The ledger reads the file after the line is durable. A failure here must not block the chat log.
        if (onLedger && ledgerKind) void Promise.resolve(onLedger({ file: logFile, projectId, chatId: id, agent, configDir: meta.configDir || '', auth: stamped.auth || (state.apiKey ? 'key' : 'login'), cwd: meta.worktreePath || cwd, sessionId: state.sessionId || meta.sessionId || '', apiKey: state.apiKey ? keyNow() : '' })).catch(() => {});
      }).catch(reportStorage);
      fold(stamped);
    }
    onEvent?.(stamped);
  }
  const live = () => { if (closed) throw fault('NOT_FOUND', '닫힌 채팅입니다.', 404); };

  // `!command` (chat-shell.js): the user's own shell commands. Each run is a `shell` start event, live `output` ticks (not stored) and an `end` event that holds the
  // whole output. Finished runs ride along with the user's next message (`sent`), so the agent knows what the user ran.
  let shuttingDown = false;
  const shellRuns = new Map(); // run id -> { abort(), done }
  let shellTaken = 0; // how many runs the last takeShellContext put ahead of a message; the message's own event says so ("콘솔 N건 포함")
  const takeShellContext = text => {
    shellTaken = 0;
    if (text.startsWith('/')) return '';
    const runs = pendingShellRuns(retainedEvents());
    if (!runs.length) return '';
    shellTaken = runs.length;
    emit({ kind: 'shell', phase: 'sent', ids: runs.map(run => run.id) });
    return shellContext(runs);
  };
  function startShell(command, { timeoutMs = shellTimeoutMs } = {}) {
    live();
    const text = typeof command === 'string' ? command.trim() : '';
    if (!text) throw fault('INVALID_INPUT', '실행할 명령을 입력하세요. 예: !git status', 400);
    if (text.length > SHELL_MAX_COMMAND || text.includes('\0')) throw fault('INVALID_INPUT', '명령을 확인하세요.', 400);
    const hint = interactiveHint(text);
    if (hint) throw fault('SHELL_INTERACTIVE', hint, 409);
    if (shellRuns.size >= 4) throw fault('CHAT_BUSY', '실행 중인 셸 명령이 너무 많습니다. 하나가 끝난 뒤 다시 실행하세요.', 409);
    const runId = randomUUID(), controller = new AbortController(), where = state.cwd || cwd;
    const picked = typeof shell === 'function' ? shell() : shell ?? { id: 'sh', label: 'sh', path: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh' };
    const accountEnv = meta.configDir ? { [agent === 'codex' ? 'CODEX_HOME' : agent === 'cursor' ? 'CURSOR_CONFIG_DIR' : 'CLAUDE_CONFIG_DIR']: meta.configDir } : {};
    const launchEnv = withUtf8Ctype({ ...process.env, ...(typeof shellEnv === 'function' ? shellEnv() : shellEnv ?? {}), ...accountEnv });
    emit({ kind: 'shell', phase: 'start', id: runId, command: text, cwd: where, shell: picked.label ?? picked.id });
    // Live output goes out in batches (a chatty command would otherwise send an event per chunk).
    let batch = { stdout: '', stderr: '' }, flushTimer = null;
    const flush = () => { clearTimeout(flushTimer); flushTimer = null; for (const stream of ['stdout', 'stderr']) if (batch[stream]) { emit({ kind: 'shell', phase: 'output', id: runId, stream, text: batch[stream] }, { store: false }); batch[stream] = ''; } };
    const done = runShell({ command: text, cwd: where, env: launchEnv, shell: picked, timeoutMs, signal: controller.signal,
      onOutput: (stream, chunk) => { batch[stream] += chunk; flushTimer ??= setTimeout(flush, 80); } })
      .then(result => {
        flush();
        if (closed) return result;
        emit({ kind: 'shell', phase: 'end', id: runId, status: result.status === 'stopped' && shuttingDown ? 'interrupted' : result.status, exitCode: result.exitCode, signal: result.signal, ms: result.ms, stdout: result.stdout, stderr: result.stderr,
          ...(result.error && { error: result.error }), ...(wantsTerminal(result.stdout, result.stderr) && { needsTerminal: true }) });
        return result;
      }).finally(() => { shellRuns.delete(runId); });
    shellRuns.set(runId, { abort: () => controller.abort(), done });
    return { id: runId, done };
  }
  // The server is going away (or the chat is closing): running commands end, and the card says so instead of spinning forever.
  const endShells = async () => {
    shuttingDown = true; const runs = [...shellRuns.values()]; for (const run of runs) run.abort();
    await Promise.all(runs.map(run => run.done.catch(() => {})));
  };

  // A steer becomes a transcript message when the CLI echoes it back from the running turn.
  function applySteer(uuid) {
    const steer = steers.get(uuid);
    if (!steer) return false;
    steers.delete(uuid);
    emit({ kind: 'steer', phase: 'applied', uuid, text: steer.text, images: steer.images, previews: steer.previews, shells: steer.shells });
    return true;
  }
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
      const own = inflight && raw.uuid === inflight.uuid;
      if (own) { inflight.acked = true; echoesSeen = true; }
      if (applySteer(raw.uuid)) return;
      for (const event of normalizeClaude(raw)) if (event.kind === 'command_output' || (!own && event.kind === 'peer_message')) handleEvent(event);
      return;
    }
    // A reply to something we asked (set_model, interrupt, ...).
    if (raw?.type === 'control_response') { controls.get(raw.response?.request_id)?.(raw.response); controls.delete(raw.response?.request_id); }
    if (protocol) { protocol.handle(raw); return; }
    if (raw?.type === 'result' && !raw.is_error && turnOpen && inflight && isClaudeCompact(inflight.text)) {
      // On resume, Claude can finish a startup turn while the user's /compact is still queued.
      const ids = raw.user_message_uuids ?? (raw.user_message_uuid ? [raw.user_message_uuid] : []);
      if (ids.length ? !ids.includes(inflight.uuid) : raw.local_command !== 'compact' && !inflight.acked && !inflight.compacted) return;
    }
    for (const event of normalizeClaude(raw, meta.model ?? state.model)) handleEvent(event.kind === 'result' && Number.isFinite(event.costUsd) ? { ...event, costUsd: sessionCost(event.costUsd) } : event);
  }
  // Claude's total_cost_usd is the running total of its process. A resumed CLI starts from the session's earlier total only when it restored its cost
  // state, which it keeps per project folder for the last session there: never for a fork (Rewind, Branch) or a resume in another folder (the chat moved
  // into or out of its worktree), and not when another session ran in that folder since. Such a process counts from 0, so its totals sit on the chat's
  // total so far (`procCost.base`, fixed by the process's first result). Without a sure sign, a first total below the chat's means it started from 0.
  let procCost = { base: null, fresh: true }, costMoved = false;
  function sessionCost(total) {
    const before = state.costUsd ?? 0;
    if (procCost.base === null) procCost.base = procCost.fresh || total < before ? before : 0;
    return procCost.base + total;
  }
  // The CLI says only in the result text that auto mode refused a call. The refusal is recorded next to the call it was for (its input, the reason and the exact allow rule
  // that would let it through), so the screen and a later "allow and retry" work from what the CLI really ran, never from what the page sends.
  function noteAutoDenied(result) {
    const reason = autoDenialReason(result.content);
    if (reason === null) return;
    let call = null;
    for (let at = events.length - 1; at >= 0 && !call; at--) if (events[at].kind === 'message') call = events[at].blocks?.find(block => block.type === 'tool_use' && block.id === result.toolUseId) ?? null;
    if (!call) return;
    const slim = Object.fromEntries(Object.entries(call.input ?? {}).slice(0, 12).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 1200) : typeof value === 'number' || typeof value === 'boolean' ? value : undefined]));
    emit({ kind: 'auto_denied', toolUseId: result.toolUseId, tool: call.name, input: slim, reason, rule: sessionRule(call.name, call.input) });
  }
  // bypassPermissions never asks: every tool request is allowed on the spot. Only a question to the user (AskUserQuestion) or a plan to approve
  // (ExitPlanMode) still reaches the user, since an answer is the point there. Codex does the same inside its protocol (chat-rpc.js).
  const bypassAllows = event => agent === 'claude' && state.permissionMode === 'bypassPermissions' && event.phase === 'request' && !event.questions && event.tool !== 'AskUserQuestion' && event.tool !== 'ExitPlanMode';
  // Cursor Bypass (Run Everything): tool prompts are answered in chat-rpc; if one still reaches here, auto-allow instead of showing a card.
  const cursorRunEverything = event => agent === 'cursor' && state.runEverything === true && event.phase === 'request' && !event.questions && event.tool !== '계획 승인';
  // "Always allow" on a tool whose suggestion is one rule for the whole tool (an MCP tool) is the same grant as the "this tool" button: either way the chat answers it.
  const toolAllowedForChat = tool => toolAllowable(tool) && (meta.allowTools?.includes(tool) || meta.sessionAllow?.includes(tool));
  const bypassAllow = event => write(approvalLine(event.requestId, { allow: true, input: event.input })).catch(() => {});
  // Requests that were already waiting when the chat switched into bypass.
  function bypassPending() {
    for (const event of [...approvals.values()]) if (bypassAllows(event)) { approvals.delete(event.requestId); emit({ kind: 'approval', phase: 'cancel', requestId: event.requestId }); void bypassAllow(event); }
    setStatus();
  }
  function handleEvent(event) {
      if (event.kind === 'peer_message') { recordPeerMessage(event); return; }
      if (event.kind === 'codex_user_echo') {
        if (event.clientId) { applySteer(event.clientId); return; }
        // Older app-servers omit clientId. Skip the initial prompt's echo and match the remaining echoes in send order.
        if (inflight && !inflight.acked && inflight.text === event.text && inflight.images.length === event.images) { inflight.acked = true; return; }
        for (const [uuid, steer] of steers) {
          if (steer.sentText === event.text && steer.images === event.images) { applySteer(uuid); break; }
        }
        return;
      }
      eventCount += 1;
      if (event.kind === 'usage') noteCursorAcpUsage(event);
      if (agent === 'claude' && event.kind === 'tool_result' && event.isError) noteAutoDenied(event);
      if (event.kind === 'approval' && bypassAllows(event)) { void bypassAllow(event); return; }
      if (event.kind === 'approval' && cursorRunEverything(event)) {
        if (protocol) void protocol.approve(event.requestId, { allow: true, always: false }).catch(() => {});
        return;
      }
      if (event.kind === 'approval') {
        // A tool the user allowed for this chat is answered here, without a card. The CLI's own allow rule cannot do this alone: an `ask` rule in the user's settings
        // (or a hook) beats every allow rule, and the CLI then offers no suggestion at all, so the request would come back each time.
        // An MCP tool says which server it belongs to: the card offers to trust it, and a tool the user trusted in the settings is answered here the same way.
        if (event.phase === 'request' && agent === 'claude' && !event.questions && claudeMcp(event.tool)) event.mcp = claudeMcp(event.tool);
        if (event.phase === 'request' && agent === 'claude' && !protocol && !event.questions && (toolAllowedForChat(event.tool) || isTrusted(trusted(), event.mcp))) {
          void write(approvalLine(event.requestId, { allow: true, input: event.input })).catch(() => {});
          return;
        }
        // A Write request says whether it creates the file or replaces one, so its card can read "새 파일" or "덮어쓰기".
        if (event.phase === 'request' && event.tool === 'Write' && typeof event.input?.file_path === 'string') event.exists = existsSync(path.resolve(cwd, event.input.file_path));
        if (event.phase === 'request') approvals.set(event.requestId, event); else approvals.delete(event.requestId);
        emit(event); setStatus(); return;
      }
      if (event.kind === 'delta') {
        if (!protocol) {
          const stream = event.parentToolUseId ?? '';
          if (event.phase === 'start') { if (event.messageId) streamIds.set(stream, event.messageId); if (!stream) { nextMessage(event.messageId); thinkingTokens = 0; void refreshCache(); } }
          else if (event.phase === 'tool' && stream && event.id) subTools.add(event.id);
          else if (event.phase === 'thinkingTokens') { thinkingTokens = Number(event.tokens) || 0; publishSoon(); }
          else if (event.phase === 'usage') {
            // A subagent's usage is not this conversation's context. It still counts toward the session cost once a turn has a price.
            if (event.usage && stream) { const id = event.messageId || streamIds.get(stream) || stream; subLive.set(id, mergeTurnUsage(subLive.get(id), event.usage)); publishSoon(); }
            else if (event.usage) { turnUsage = mergeTurnUsage(turnUsage, event.usage); if (event.final) outputFinal = true; publishSoon(); }
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
      if (event.kind === 'task') canonTask(event);
      if (event.kind === 'task' && event.phase !== 'progress') { trackTask(event); publishSoon(); }
      if (event.kind === 'raw' || (event.kind === 'task' && event.phase === 'progress')) { emit(event, { store: false }); return; } // progress ticks often: live only
      // The CLI may print the same command output both in its echo and as a message of its own: it is shown once.
      if (event.kind === 'command_output') { const same = `${turnSeq}\0${event.isError}\0${event.text}`; if (lastCommandOutput === same) return; lastCommandOutput = same; }
      let moved;
      if (agent === 'claude') {
        if (event.kind === 'session') lastMainModel = undefined;
        if (event.kind === 'limit') { const sig = `${event.limit}:${event.status}:${event.threshold}:${event.resetsAt}:${event.overage}:${event.utilization === null ? '' : Math.round(event.utilization * 100)}`; if (sig === lastLimit) return; lastLimit = sig; }
        if (event.kind === 'message') {
          for (const block of event.blocks ?? []) if (block.type === 'tool_use' && (block.name === 'EnterWorktree' || block.name === 'ExitWorktree')) worktreeCalls.set(block.id, block);
          // A reply from another model than the one before (and than the one picked): the CLI switched on its own (plan mode, a limit). Said before that reply.
          if (event.role === 'assistant' && !event.parentToolUseId && typeof event.model === 'string' && !event.model.startsWith('<')) {
            const was = lastMainModel; lastMainModel = event.model;
            if (was && was !== event.model && !isPickedModel(meta.model, event.model)) emit({ kind: 'settings', model: event.model, from: was, by: 'agent' });
          }
        }
        if (event.kind === 'tool_result' && worktreeCalls.has(event.toolUseId)) {
          const call = worktreeCalls.get(event.toolUseId); worktreeCalls.delete(event.toolUseId);
          const move = event.isError ? null : worktreeMove(call, event.content);
          if (move) moved = { kind: 'worktree', ...move, ...(move.phase === 'exit' && { from: state.cwd }) };
        }
      }
      // Claude changed its own mode (EnterPlanMode, ExitPlanMode, "allow all edits"...): follow it, and keep it in meta so a restart or reopen does not undo it.
      // Our own set_permission_mode is echoed the same way; the mode is already ours then, so nothing changes twice.
      const cliMode = agent === 'claude' && event.kind === 'settings' && event.permissionMode !== undefined ? event.permissionMode : undefined;
      if (cliMode !== undefined) {
        const own = cliMode === ownMode; if (own) ownMode = undefined;
        if (cliMode === state.permissionMode) return;
        if (own) event = { ...event, by: undefined };
        if (cliMode === 'plan' && state.permissionMode !== 'plan') meta.prePlanMode = prePlanMode = state.permissionMode;
        meta.permissionMode = cliMode;
      }
      if (event.kind === 'compact' && inflight?.idle) event = { ...event, trigger: 'idle' }; // the CLI calls the /compact ADE sent "manual"; the thread says it was ADE's idle compact
      emit(event);
      if (surfaceSuppressed) return;
      if (moved) { emit(moved); publish(); }
      // Where the agent works after a worktree move, or a resumed Claude that reports another folder than it was started in (it re-entered one).
      if (moved) void refreshWorktree();
      else if (event.kind === 'session' && agent === 'claude' && typeof event.cwd === 'string' && event.cwd && !samePath(event.cwd, state.cwd)) { state.cwd = event.cwd; void refreshWorktree({ announce: true }); }
      if (event.kind === 'result') void refreshWorktree();
      if (cliMode !== undefined) { void saveMeta().catch(reportStorage); publish(); }
      noteBackgroundActivity(event);
      if (event.kind === 'message' && event.usage && !event.parentToolUseId && agent === 'claude') { nextMessage(event.id); turnUsage = { ...event.usage, output: Math.max(event.usage.output, turnUsage?.output ?? 0) }; refreshCacheSoon(); publishSoon(); }
      if (event.kind === 'message' && event.parentToolUseId && event.id) subLive.delete(event.id);
      if (event.kind === 'session') {
        meta.sessionId = state.sessionId ?? undefined; meta.resumeAt = undefined; meta.fork = false;
        if (agent === 'claude') void refreshAutoCompact(event.model ?? state.model);
        void saveMeta().catch(reportStorage); publish();
      }
      if (event.kind === 'capabilities' || event.kind === 'usage' || event.kind === 'settings' || event.kind === 'compact') publish();
      if (event.kind === 'compact' && agent === 'claude') {
        if (inflight && (event.trigger === 'manual' || event.trigger === 'idle')) inflight.compacted = true;
        refreshCacheSoon();
      }
      // A steer the turn never took in (it finished first) becomes the next turn on its own: stay working until it has run.
      if (event.kind === 'result') {
        if (agent === 'codex') dropSteers();
        if (agent === 'claude' && inflight && isClaudeCompact(inflight.text)) inflight = null;
        if (agent === 'cursor' && state.sessionId) {
          const sessionId = state.sessionId, last = retainedEvents().findLast(item => item.kind === 'message');
          if (last?.uuid && last.blocks?.some(block => block.type === 'text') && event.status === 'success') {
            const file = `cursor-checkpoints/${randomUUID()}.json`;
            cursorSnapshot = cursorSnapshot.then(async () => {
              if (await snapshotCursorSession({ sessionId, configDir: cursorDirOf(), destination: path.join(root, file), seen: copiedBlobs })) {
                emit({ kind: 'cursor_checkpoint', uuid: last.uuid, file }); publish();
              }
            }).catch(error => { emit({ kind: 'error', message: `분기용 대화 저장 실패: ${error.message}` }); });
          }
          const launch = { ...process.env, ...envNow() };
          void readCursorBilledUsage(sessionId, launch.CURSOR_API_KEY).then(value => {
            if (!value || closed || state.sessionId !== sessionId) return;
            emit({ kind: 'usage', ...value }); void saveMeta().catch(reportStorage); publish();
          }).catch(() => {});
        }
        clearTimeout(activityTimer); reopened = false;
        // The turn's cost is known now (Claude reports it only here): a cost limit reached by it stops the chat before the turn counts as over.
        if (meta.limit && !meta.limit.stop && !limitBypass) { const hit = limitStep(shown().costUsd, null); if (hit) stopByLimit(hit, { interrupt: false }); }
        streamIds.clear(); toolInputSize.clear(); resetLive(); turnOpen = steers.size > 0; setStatus(); limitAfterResult();
        if (followText && !turnOpen) {
          const saying = followText;
          followText = '';
          queueMicrotask(() => chatApi.send(saying, []).catch(error => { emit({ kind: 'error', message: error.message ?? '이어서 보내지 못했습니다.' }); publish(); }));
        }
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
  // A subagent's own steps are not this conversation's turn. The agent the user is talking to stays idle, so a message is sent at once
  // (not steered, and a form is not held as a follow-up) while that subagent runs. Its tool ids are remembered so a tool result that
  // omits parent_tool_use_id is still recognized as its own.
  const fromSubagent = event => Boolean(event.parentToolUseId) || (event.kind === 'tool_result' && subTools.has(event.toolUseId));
  function noteSubagentTools(event) {
    if (event.kind !== 'message' || !event.parentToolUseId) return;
    for (const block of event.blocks ?? []) if (block.type === 'tool_use' && block.id) subTools.add(block.id);
  }
  // The hand-back starts a new turn on the main thread (no user line, no parent). That output is the agent the user is talking to:
  // without this the chat showed "idle" (no stop button) while it kept answering. The next `result` closes it; if none comes, the quiet timer drops back to idle.
  function noteBackgroundActivity(event) {
    if (protocol || closed || !child || !['message', 'tool_result', 'session'].includes(event.kind)) return;
    noteSubagentTools(event);
    if (fromSubagent(event)) return;
    if (!turnOpen) { turnOpen = true; reopened = true; setStatus(); }
    if (reopened) { clearTimeout(activityTimer); activityTimer = setTimeout(() => { if (reopened && turnOpen && !approvals.size) { reopened = false; turnOpen = steers.size > 0; setStatus(); } }, quietMs); activityTimer.unref(); }
  }
  // SendMessage to a finished subagent resumes it: the CLI starts a task keyed by that SendMessage call but with the same task_id. Everything the pane
  // knows (card, tracker row, stop) hangs on the original Agent call, so the resumed run's events are renamed to it.
  const taskOwner = new Map(), taskAlias = new Map(); // task_id -> first call id; resume call id -> original call id
  const canonTask = event => {
    if (event.phase === 'start' && event.taskId) { const first = taskOwner.get(event.taskId); if (first && first !== event.toolUseId) taskAlias.set(event.toolUseId, first); else taskOwner.set(event.taskId, event.toolUseId); }
    event.toolUseId = taskAlias.get(event.toolUseId) ?? event.toolUseId;
  };
  // A subagent counts as running only while the child that started it lives: after a crash or an ADE restart nothing reports its end.
  const trackTask = event => { const live = new Set(state.liveTasks); if (event.phase === 'start') { live.add(event.toolUseId); if (event.taskId) taskIds.set(event.toolUseId, event.taskId); } else { live.delete(event.toolUseId); taskIds.delete(event.toolUseId); } state.liveTasks = [...live];
    // The last background task ended without a turn of its own: the pending restart or the idle countdown can go on now.
    if (event.phase !== 'start' && !live.size) { if (restartAfterTurn && quiet()) restart(); else setStatus(); }
  };
  const reportStorage = error => { state.error = `채팅 저장 실패: ${error.message}`; publish(); };

  // A mode this app asked the CLI for (the picker, "always allow" on an edit): the CLI's report of it is not the agent changing mode, so it gets no line in the thread.
  const worktreeCalls = new Map(); // EnterWorktree/ExitWorktree tool calls waiting for their result, which says where the CLI went
  // ---- the chat's git worktree (chat-worktree.js) ----
  // state.worktreeInfo: the worktree the agent works in now (`inside`), or else the one this chat made and keeps (worktree.json in its folder).
  // `managed`: ADE made it for this chat, so ADE can move the chat in and out; one the agent made itself (Claude's EnterWorktree) is left to the agent.
  let worktreeNote = '', worktreeChain = Promise.resolve();
  const takeWorktreeNote = () => { const note = worktreeNote; worktreeNote = ''; return note; };
  function refreshWorktree({ announce = false } = {}) {
    worktreeChain = worktreeChain.catch(() => {}).then(async () => {
      if (closed) return state.worktreeInfo;
      const own = await readOwnWorktree(root);
      let here = await detectWorktree(state.cwd).catch(() => null);
      // A project opened from a linked worktree (or a plugin's work folder) is simply where the chat lives, not a worktree it went into.
      if (here?.kind === 'other' && samePath(here.path, (await detectWorktree(cwd).catch(() => null))?.path ?? '')) here = null;
      const kept = here ?? (own ? await detectWorktree(own.path).catch(() => null) : null);
      const managed = Boolean(own && kept && samePath(own.path, kept.path)), before = state.worktreeInfo;
      const status = kept ? await worktreeStatus({ ...kept, base: kept.base || own?.base }).catch(() => null) : null;
      state.worktreeInfo = kept ? { ...kept, inside: Boolean(here), managed, originCwd: managed ? own.originCwd : kept.origin, status } : null;
      // The agent went in or out on its own and no tool result said so (a resumed Claude that re-entered its worktree): one line in the thread.
      if (announce && !samePath(before?.inside ? before.path : '', here?.path ?? '')) emit({ kind: 'worktree', phase: here ? 'enter' : 'exit', path: state.cwd, ...(here?.branch && { branch: here.branch }), ...(before?.inside && { from: before.path }), by: 'agent' });
      publish();
      return state.worktreeInfo;
    });
    return worktreeChain;
  }
  // Moves a chat that is not doing anything to another folder (into its worktree or back to where it came from). The child is ended, and the
  // session follows: Claude's transcript is copied to the new folder's project (its `--resume` looks there), Cursor's is copied to a new ACP
  // session for that folder, Codex resumes its thread with the new cwd. Nothing the agent wrote is deleted.
  async function relocate(nextCwd, { phase, worktreePath, branch, starting = false }) {
    live();
    // `starting`: the first message is starting the chat in its worktree (startNow), so there is no child and no session yet; its own turn is open.
    if (!starting && (turnOpen || approvals.size || steers.size || configuring)) throw fault('CHAT_BUSY', '응답이 끝난 뒤 옮길 수 있습니다.', 409);
    if (state.liveTasks.length) throw fault('CHAT_BACKGROUND', '백그라운드 작업이 끝난 뒤 옮길 수 있습니다.', 409);
    if (child) {
      const proc = dropChild();
      await new Promise(resolve => { if (proc.exitCode !== null || proc.signalCode) return resolve(); const timer = setTimeout(resolve, 3000); proc.once('close', () => { clearTimeout(timer); resolve(); }); });
      if (proc.exitCode === null && !proc.signalCode) throw fault('CHAT_SWITCH_FAILED', '에이전트를 종료하지 못해 옮기지 않았습니다.', 500);
    }
    const sessionId = state.sessionId ?? meta.sessionId, previous = cwd;
    if (sessionId && agent === 'claude') { await moveClaudeSession({ configDir: configDirOf(), sessionId, from: previous, to: nextCwd }); costMoved = true; }
    if (sessionId && agent === 'cursor') {
      await cursorSnapshot;
      const store = await cursorStorePath(sessionId, { env: { CURSOR_CONFIG_DIR: cursorDirOf() } });
      if (store) { const next = await forkCursorSession({ checkpoint: store, cwd: nextCwd, configDir: cursorDirOf() }); meta.sessionId = state.sessionId = next; }
    }
    cwd = state.cwd = nextCwd; meta.worktreePath = worktreePath;
    if (sessionId) worktreeNote = moveNote(phase, { cwd: nextCwd, path: worktreePath, branch, originCwd: nextCwd }, previous);
    emit({ kind: 'worktree', phase, path: nextCwd, ...(branch && { branch }), from: previous, by: 'user' });
    await saveMeta(); setStatus();
    return refreshWorktree();
  }
  // Into this chat's worktree: the one it already keeps, else a new one made from the folder the chat is in.
  async function enterWorktreeNow({ starting = false } = {}) {
    let own = await readOwnWorktree(root);
    if (own && !(await detectWorktree(own.path).catch(() => null))) { await writeOwnWorktree(root, null); own = null; }
    if (!own) {
      const made = await createChatWorktree({ directory, id, cwd });
      own = { path: made.path, cwd: made.cwd, originCwd: made.originCwd, branch: made.branch, base: made.base };
      await writeOwnWorktree(root, own);
      emit({ kind: 'worktree', phase: 'create', path: made.path, branch: made.branch, base: made.base, by: 'user' });
    }
    if (samePath(cwd, own.cwd)) return refreshWorktree();
    // A chat with nothing said yet just changes folder: there is no session to carry over and no child worth keeping.
    return relocate(own.cwd, { phase: 'enter', worktreePath: own.path, branch: own.branch, starting });
  }
  let lastMainModel, lastLimit; // the model the last main-thread reply came from; the last plan-limit report shown
  let ownMode; // ponytail: cleared when the report arrives or the request ends; a report that never comes could hide one later change to the same mode
  let prePlanMode = meta.prePlanMode ?? 'default'; // kept in meta so a plan approved after reopening goes back to the mode before it
  // Nothing in the child would be cut off: no turn, no approval, no background subagent.
  const quiet = () => !turnOpen && !approvals.size && state.liveTasks.length === 0;
  // A launch flag changed: replace the child now when quiet, else once the turn and its background tasks are over.
  function restartWhenQuiet() { if (quiet()) restart(); else { restartAfterTurn = true; state.restartPending = true; } }
  // Ends the child on purpose (restart, handoff, close). child is nulled first, so its close handler returns early: the subagents/tasks it took with it are
  // dropped here, or `quiet()` stays false (no idle kill, stale task UI).
  function dropChild() { const proc = child; child = null; protocol?.dispose(); protocol = null; state.liveTasks = []; taskIds.clear(); subTools.clear(); proc.kill('SIGTERM'); return proc; }
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
    if (agent !== 'cursor' && !state.sessionId && !meta.sessionId) { meta.mediaBlocks = true; meta.colorChips = true; }
    // A new Claude chat runs on the account the project's allowed .envrc names (what its terminals use) and keeps it; an old chat keeps the folder its history is in.
    if (agent === 'claude' && account && !meta.configDir && !meta.sessionId) { const dir = await account().catch(() => ''); if (dir) { meta.configDir = dir; await saveMeta(); } }
    // "Start in a worktree" picked before the first message: ADE makes it for every agent (Claude too, instead of its own --worktree, whose folder
    // ADE would not know), so the folder, branch and origin are known. The request is used up: the next start must not ask the CLI for another.
    if (meta.worktree && !meta.worktreePath && !meta.sessionId) { meta.worktree = state.worktree = false; await enterWorktreeNow({ starting: true }); }
    // Without a pick the CLI would follow ~/.claude/settings.json at every (re)start, so a change made in another project (or a terminal `/model`) would silently
    // switch this conversation on its next resume. The model and Effort it is running with are pinned to the chat instead.
    if (agent === 'claude') { let pinned = false; if (!meta.model && state.model) { meta.model = state.model; pinned = true; } if (meta.effort === undefined && state.effort && state.capabilities.efforts.includes(state.effort)) { meta.effort = state.effort; pinned = true; } if (pinned) await saveMeta(); }
    const extra = agent === 'claude' && prepare ? await prepare(root, { chatId: id, projectId, agent, interactiveUi: meta.interactiveUi === true, fileLinks: meta.fileLinks === true, mediaBlocks: meta.mediaBlocks === true, colorChips: meta.colorChips === true }) : {};
    const args = [...argsOf(executableArgs, meta.auth), ...(agent === 'claude' ? buildClaudeArgs({ sessionId: meta.sessionId, model: meta.model, effort: meta.effort, worktree: meta.worktree, addDirs: meta.addDirs, permissionMode: meta.permissionMode, resumeAt: meta.resumeAt, fork: meta.fork, ...extra }) : agent === 'codex' ? ['app-server'] : [...(meta.sandbox ? ['--sandbox', meta.sandbox] : []), 'acp'])];
    if (agent !== 'claude') protocol = createChatProtocol(agent, { write, emit: handleEvent, trusted });
    if (agent === 'claude') {
      // Resolved right now (the catalog and the model may have arrived after the chat was opened), so the gauge matches what the CLI starts with.
      const model = meta.model ?? state.model, compactNow = await readAutoCompact(configDirOf(), cwd, concreteModel(model), maxContextForModel(model));
      if (JSON.stringify(state.autoCompact) !== JSON.stringify(compactNow)) { state.autoCompact = compactNow; publish(); }
    }
    // shell:false and argv only: the message text never reaches a shell.
    const run = () => {
      const launchEnv = withUtf8Ctype({ ...process.env, ...envNow(), NO_COLOR: '1' });
      state.apiKey = usesApiKey(launchEnv);
      if (agent === 'codex') { meta.configDir ??= launchEnv.CODEX_HOME || path.join(os.homedir(), '.codex'); launchEnv.CODEX_HOME = meta.configDir; }
      if (agent === 'claude' && meta.configDir) launchEnv.CLAUDE_CONFIG_DIR = meta.configDir;
      if (agent === 'cursor' && meta.configDir) launchEnv.CURSOR_CONFIG_DIR = meta.configDir;
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
    if (agent === 'claude' && meta.sessionAllow?.length) await applySessionAllow(meta.sessionAllow);
    if (protocol) {
      try {
        const ready = await protocol.initialize({ ...meta, tokens: state.tokens }, cwd, chatMcpServers({ chatId: id, projectId, agent }), chatPrompt(meta.interactiveUi === true, meta.fileLinks === true, agent, meta.mediaBlocks === true, meta.colorChips === true));
        if (agent === 'cursor') cursorAppliedModel = ready?.modelApplied ?? null;
        if (ready?.modelRejected) { meta.model = undefined; meta.effort = undefined; await forgetRememberedModel(directory, agent); }
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
    const compact = agent === 'claude' && isClaudeCompact(last.text) ? { text: last.text, uuid: randomUUID(), acked: false } : null;
    if (compact) inflight = compact;
    try {
      await start();
      if (protocol) await protocol.send(last.text, []);
      else await write(userLine(last.text, [], compact?.uuid));
    } catch (error) { turnOpen = false; if (protocol) restart(); setStatus(); throw error; }
    setStatus();
  }
  function attach(proc) {
    if (agent === 'claude') { procCost = { base: null, fresh: !meta.sessionId || meta.fork === true || costMoved }; costMoved = false; }
    child = proc; state.liveTasks = []; taskIds.clear(); subTools.clear(); // a replaced child took its subagents with it
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
      child = null; protocol?.dispose(); protocol = null; turnOpen = false; reopened = false; clearTimeout(activityTimer); clearApprovals(); controls.clear(); dropSteers(); streamIds.clear(); toolInputSize.clear(); state.liveTasks = []; subTools.clear(); // A turn cut off before its result still spent these tokens.
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
  // Allow rules the user granted to actions the auto-mode classifier had blocked. They live in the CLI's flag settings (this process only, never written to a settings file),
  // so every new child gets them again; an update replaces the list, hence the whole list is always sent.
  async function applySessionAllow(rules) {
    const response = await control({ subtype: 'apply_flag_settings', settings: { permissions: { allow: rules } } });
    return response?.subtype === 'success';
  }
  // Turns the Artifact tools on for this chat. A running CLI takes it as a flag-settings update (no restart); one that is not started yet gets it as env at launch.
  // If the update is refused nothing is remembered, so the next message tries again.
  async function enableArtifact() {
    if (child) { const response = await control({ subtype: 'apply_flag_settings', settings: ARTIFACT_FLAG_SETTINGS }); if (response?.subtype !== 'success') return; }
    meta.artifact = true;
  }

  // ── limits (chat-limit.js) ──
  const readLimitWindows = async force => { if (!readUsage) return null; try { return (await readUsage(agent, { force }))?.windows ?? null; } catch { return null; } };
  // One look at the numbers; returns the rule reached. A new share baseline is stored (and kept across restarts).
  function limitStep(cost, windows) {
    const limit = meta.limit;
    if (!limit || limitBypass) return null;
    const result = evaluateLimit(limit, { cost, windows });
    limitNow = { ...limitNow, ...result.now };
    if (JSON.stringify(result.base) !== JSON.stringify(limit.base)) { limit.base = result.base; void saveMeta().catch(reportStorage); }
    return result.hit;
  }
  // Marks the chat stopped (the thread line, the refusal of new sends) and, when a turn is running, interrupts it like the stop button.
  // `live`: it happened while the chat was working (an event, a poll), not when a limit was set or a send was tried: only then does the automatic compact follow.
  // `interrupt` is off when the turn's own result just brought the number (nothing is left to interrupt).
  function stopByLimit(hit, { live = true, interrupt = true } = {}) {
    const limit = meta.limit;
    if (!limit || limit.stop) return;
    limit.stop = { rule: hit.label, live };
    emit({ kind: 'limit_stop', rule: hit.label });
    void saveMeta().catch(reportStorage);
    if (live && interrupt && turnOpen && child) void chatApi.interrupt().catch(() => {});
    syncLimitPoll(); publish();
  }
  // Plan windows are read every POLL_MS (the pace usage.js allows: a forced read is served from its cache inside FORCE_GAP, and its 429 backoff applies), and only while a turn is running. A send reads once before the turn starts.
  function syncLimitPoll() {
    const want = !closed && turnOpen && !approvals.size && !limitBypass && hasWindowRule() && !meta.limit.stop;
    if (want === Boolean(limitTimer)) return;
    if (!want) { clearInterval(limitTimer); limitTimer = null; return; }
    const poll = async () => {
      const windows = await readLimitWindows(true);
      if (closed || !hasWindowRule()) return;
      const hit = limitStep(shown().costUsd, windows);
      if (hit) stopByLimit(hit); else publishSoon();
    };
    limitTimer = setInterval(() => void poll(), limitPollMs); limitTimer.unref?.();
  }
  // A send is refused while a rule is reached (windows are read now, so a reset or a raised limit lets it through at once).
  async function assertLimit() {
    if (!meta.limit || limitBypass) return;
    const windows = hasWindowRule() ? await readLimitWindows(true) : null;
    live();
    const hit = limitStep(shown().costUsd, windows);
    if (!meta.limit) return;
    if (!hit) { if (meta.limit.stop) { delete meta.limit.stop; await saveMeta(); publish(); } return; }
    stopByLimit(hit, { live: false });
    throw fault('CHAT_LIMIT', `제한 규칙(${hit.label})에 도달해 보낼 수 없습니다. 채팅 상태 표시줄의 제한 버튼에서 바꾸거나 해제하세요.${hit.resetsAt ? ' 한도 창이 초기화되면 다시 보낼 수 있습니다.' : ''}`, 409);
  }
  // The turn a limit interrupted has ended: compact once if asked to. The compact's own result ends the bypass. Never again for the same stop.
  function limitAfterResult() {
    if (limitBypass) { limitBypass = false; syncLimitPoll(); return; }
    const limit = meta.limit;
    if (!limit?.stop?.live || limit.stop.compacted || !limit.compact || !state.sessionId || closed) return;
    limit.stop.compacted = true; limitBypass = true; void saveMeta().catch(reportStorage);
    chatApi.send('/compact').catch(() => { limitBypass = false; });
  }

  // A command that was running when the last server stopped never reported its end: it did not survive, and its card must not spin.
  for (const orphan of retainedEvents().filter(event => event.kind === 'shell' && event.phase === 'start' && !events.some(item => item.kind === 'shell' && item.phase === 'end' && item.id === event.id))) emit({ kind: 'shell', phase: 'end', id: orphan.id, status: 'interrupted', exitCode: null, signal: null, ms: null, stdout: '', stderr: '' });
  await saveMeta(); setStatus();
  if (handed) await takeOver(handed);
  await refreshCache();
  // The agent a stopped server left running in the pty-host: attached again with the turn, approvals and background tasks it had.
  async function takeOver(saved) {
    let proc = null;
    try { if (saved.v === 1 && procHost && typeof saved.procKey === 'string') proc = await procHost.attachProc(saved.procKey, saved.ack); } catch { /* gone meanwhile */ }
    if (proc?.missing) { proc.kill('SIGTERM'); proc = null; }
    if (!proc) {
      if (saved.turnOpen || saved.approvals?.length) { state.error = '이전 서버에서 응답을 이어받지 못했습니다. 세션 복구를 시도하거나 다시 보내세요.'; emit({ kind: 'error', message: state.error, recoverable: canRetryTurn() }); publish(); }
      return;
    }
    if (agent !== 'claude') { protocol = createChatProtocol(agent, { write, emit: handleEvent, trusted }); protocol.restore(saved.protocol ?? {}); }
    attach(proc);
    turnOpen = saved.turnOpen === true; reopened = saved.reopened === true; turnSeq = saved.turnSeq ?? 0; inflight = saved.inflight ?? null;
    restartAfterTurn = state.restartPending = saved.restartAfterTurn === true; lastCommandOutput = saved.lastCommandOutput ?? null;
    for (const event of saved.approvals ?? []) approvals.set(event.requestId, event);
    for (const [uuid, item] of saved.steers ?? []) steers.set(uuid, item);
    for (const [toolUseId, taskId] of saved.taskIds ?? []) taskIds.set(toolUseId, taskId);
    state.liveTasks = saved.liveTasks ?? [];
    if (reopened) noteBackgroundActivity({ kind: 'message' });
    if (agent === 'cursor') startCursorStorePoll();
    setStatus();
  }
  // Codex can fold the note into the live turn. Cursor has no steer, so the note waits until that turn ends and goes out as the next message.
  async function deliverNote(note) {
    if (agent === 'codex' && turnOpen) {
      try { await chatApi.send(note, [], { steer: true }); return; }
      catch { /* the turn ended before the steer landed */ }
    }
    if (!turnOpen) { await chatApi.send(note, []); return; }
    followText = note;
  }
  const chatApi = {
    id, agent, get cwd() { return cwd; },
    // Server shutdown: an agent running in the pty-host stays, and live.json tells the next server how far this one read and what was open.
    // Everything is taken in the same tick as the last line handled, so nothing is read twice or lost. Without the host it is a plain close.
    async detach() {
      if (closed) return;
      await endShells();
      const proc = child;
      if (!proc?.detach || !proc.pid) return this.close();
      const saved = { v: 1, procKey: proc.key, ack: proc.lastLine, turnOpen, reopened, turnSeq, inflight, restartAfterTurn, lastCommandOutput,
        approvals: [...approvals.values()], steers: [...steers], taskIds: [...taskIds], liveTasks: state.liveTasks, protocol: protocol?.snapshot() };
      proc.detach();
      closed = true; child = null; protocol = null;
      clearTimeout(idleTimer); clearTimeout(activityTimer); clearTimeout(publishTimer); clearTimeout(cacheLater); clearInterval(limitTimer); stopIdleCompact(); stopCursorStorePoll();
      await worktreeChain.catch(() => {});
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
    // /autocompact: saved like the CLI's own command, so it works while a turn runs.
    async setAutoCompact(value) {
      if (agent !== 'claude') throw fault('CHAT_UNSUPPORTED', 'Auto Compact 창은 Claude 채팅에서만 바꿀 수 있습니다.', 409);
      const model = meta.model ?? state.model;
      try { await writeAutoCompact(configDirOf(), concreteModel(model), value, maxContextForModel(model)); } catch (cause) { throw fault('INVALID_INPUT', cause.message); }
      await refreshAutoCompact(model);
      return { autoCompact: state.autoCompact };
    },
    // /idlecompact: this chat's own choice for the idle auto-compact (true, false, or null = follow the setting). No argument only reads it.
    async setIdleCompact(value) {
      if (agent !== 'claude') throw fault('CHAT_UNSUPPORTED', '캐시 만료 전 압축은 Claude 채팅에서만 쓸 수 있습니다.', 409);
      live();
      if (value !== undefined) {
        if (value !== null && typeof value !== 'boolean') throw fault('INVALID_INPUT', 'on, off 또는 auto로 입력하세요.');
        meta.idleCompact = value ?? undefined; await syncIdleCompact(); publish(); await saveMeta();
      }
      return shown().idleCompact;
    },
    // The global setting changed: arm or cancel the timer.
    resyncIdleCompact() { if (!closed) { void syncIdleCompact(); publish(); } },
    // 제한 (status line button): this chat's limit (see chat-limit.js). No argument reads it; null clears it. Setting one takes the share's baseline and looks at the numbers at once.
    async setLimit(input) {
      live();
      if (input !== undefined) {
        try { meta.limit = normalizeLimit(input, limitOptions({ agent, cost: state.capabilities.cost, apiKey: state.apiKey }), meta.limit) ?? undefined; } catch (cause) { throw fault('INVALID_INPUT', cause.message); }
        limitNow = {};
        const hit = limitStep(shown().costUsd, hasWindowRule() ? await readLimitWindows(true) : null);
        if (hit) stopByLimit(hit, { live: false });
        syncLimitPoll(); publish(); await saveMeta();
      }
      const { limit, limitOptions: options } = shown();
      return { limit, options };
    },
    // /mcp: the CLI's own MCP controls over its control channel (status, reconnect, enable/disable, OAuth), so nothing restarts. env/headers never leave this process.
    async mcp({ action, server, enabled, url }) {
      live();
      if (agent !== 'claude') throw fault('CHAT_UNSUPPORTED', 'MCP 관리는 Claude 채팅에서만 쓸 수 있습니다.', 409);
      const requests = { status: { subtype: 'mcp_status' }, reconnect: { subtype: 'mcp_reconnect', serverName: server }, toggle: { subtype: 'mcp_toggle', serverName: server, enabled: enabled === true },
        auth: { subtype: 'mcp_authenticate', serverName: server }, clearAuth: { subtype: 'mcp_clear_auth', serverName: server }, callback: { subtype: 'mcp_oauth_callback_url', serverName: server, callbackUrl: url } };
      if (!requests[action] || (action !== 'status' && !server) || (action === 'callback' && !url)) throw fault('INVALID_INPUT', '잘못된 MCP 요청입니다.');
      await start();
      const response = await control(requests[action], action === 'status' ? 10000 : 60000);
      if (!response) throw fault('CHAT_MCP', 'MCP 응답이 없습니다. 잠시 뒤 다시 시도하세요.', 504);
      if (response.subtype === 'error') throw fault('CHAT_MCP', String(response.error ?? 'MCP 요청이 실패했습니다.'), 409);
      if (action !== 'status') return { result: response.response ?? null };
      return { servers: (response.response?.mcpServers ?? []).map(s => ({ name: s.name, status: s.status, error: s.error, info: s.serverInfo, transport: s.transport, scope: s.scope,
        config: s.config && { type: s.config.type, command: s.config.command, args: s.config.args, url: s.config.url },
        tools: (s.tools ?? []).map(t => ({ name: t.name, description: t.description, annotations: t.annotations })) })) };
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
    // What the CLI's /permissions "Recently blocked" does: allow actions auto mode refused, for this chat only (and, with retry, tell the agent to run them again).
    async allowBlocked(toolUseIds, { retry = true } = {}) {
      live();
      if (agent !== 'claude') throw fault('CHAT_UNSUPPORTED', 'Claude 채팅에서만 쓸 수 있습니다.', 409);
      if (!Array.isArray(toolUseIds) || !toolUseIds.length || toolUseIds.length > 16 || toolUseIds.some(value => typeof value !== 'string')) throw fault('INVALID_INPUT', '승인할 작업을 확인하세요.');
      const open = new Map(pendingBlocked(retainedEvents()).map(event => [event.toolUseId, event]));
      const picked = [...new Set(toolUseIds)].map(id => open.get(id));
      if (picked.some(item => !item)) throw fault('NOT_FOUND', '이미 처리됐거나 찾을 수 없는 차단 기록입니다.', 404);
      const rules = [...new Set(picked.map(item => item.rule).filter(Boolean))];
      if (!retry && rules.length !== picked.length) throw fault('INVALID_INPUT', '허용 규칙으로 만들 수 없는 작업은 "승인하고 다시 시도"로만 허용할 수 있습니다.');
      if (rules.length) {
        const next = [...new Set([...(meta.sessionAllow ?? []), ...rules])].slice(-100);
        await start();
        if (!await applySessionAllow(next)) throw fault('AGENT_UNAVAILABLE', '허용 규칙을 적용하지 못했습니다. 잠시 뒤 다시 시도하세요.', 504);
        meta.sessionAllow = next; await saveMeta();
      }
      emit({ kind: 'denial_allow', toolUseIds: picked.map(item => item.toolUseId), retry, rules });
      if (retry) await this.send(retryText(picked), [], { steer: turnOpen });
    },
    state: shown,
    // What the user typed in this chat (not messages from other agents), newest first. The agent bus quotes it, in full, to the chat it messages: ADE reads it from the
    // chat's own record, so the receiver sees what the user actually asked for and no agent can reword, shorten or invent it. A queued steer counts (the user typed it
    // already); its later 'applied' event repeats the same text and is skipped.
    recentUserInstructions(limit = 3, max = 4000) {
      const out = [];
      for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
        const event = events[i], said = event.kind === 'user' || (event.kind === 'steer' && event.phase === 'queued') ? event.text : null;
        if (typeof said !== 'string' || !said.trim() || said.startsWith('[ADE agent bus]')) continue;
        const text = said.trim();
        out.push({ text: text.slice(0, max), at: event.at, ...(text.length > max && { cut: text.length }) });
      }
      return out;
    },
    lastUserInstruction() { return this.recentUserInstructions(1)[0] ?? null; },
    // The API key (or the choice to use one) changed: a running child still has the old one in its environment, so it is replaced (same session)
    // right away when idle, or once the running turn ends. The next message starts a child with the new key.
    relaunch() { if (child) { restartWhenQuiet(); } },
    replay: (since, { slim = false } = {}) => ({ events: ((list) => slim ? slimEvents(list) : list)(events.filter(event => event.seq > (Number.isSafeInteger(since) ? since : 0))), seq, state: shown(),
      approvals: [...approvals.values()] }),
    // `steer` sends into the running turn: the CLI folds the line into that turn (one `result` for both; checked with claude 2.1.322),
    // so turn state is left alone. ponytail: a steer racing the turn's last event may open a second turn, status then flickers idle once.
    async send(input, images = [], { steer = false, artifact = false, previews = [], clientMessageId, idle = false } = {}) {
      live();
      const text = await chatText.prepare(input);
      live();
      if (turnOpen && steer && child) {
        if (!state.capabilities.steer) throw fault('CHAT_UNSUPPORTED', state.capabilities.limitations.steer, 409);
        const uuid = randomUUID(), sendText = takeShellContext(text) + text, shells = shellTaken;
        steers.set(uuid, { text, images: images.length, previews, data: images, ...(agent === 'codex' && { sentText: sendText, shells }) });
        emit({ kind: 'steer', phase: 'queued', uuid, text, images: images.length, previews, shells, ...(validMessageUuid(clientMessageId) && { clientMessageId }) });
        try {
          if (protocol) await protocol.send(sendText, images, { steer: true, clientUserMessageId: uuid });
          else await write(userLine(sendText, images, uuid));
        } catch (error) {
          if (steers.delete(uuid)) emit({ kind: 'steer', phase: 'cancelled', uuid, text });
          throw error;
        }
        return { steered: true };
      }
      await assertLimit();
      if (turnOpen) throw fault('CHAT_BUSY', '이전 응답이 끝난 뒤 보내세요.', 409);
      state.error = null; turnOpen = true; reopened = false; turnSeq += 1; stopIdleCompact();
      // What the user ran with `!` since their last message goes ahead of this one (the thread still shows only what they typed).
      const sendText = takeShellContext(text) + takeWorktreeNote() + text, shells = shellTaken;
      const codexCompact = agent === 'codex' && /^\/compact\s*$/.test(text);
      if (codexCompact) { emit({ kind: 'delta', phase: 'compacting', active: true }); setStatus(); }
      // The message is shown right away; starting the process, a model change still in flight, or the previous turn's checkpoint must not delay it.
      emit({ kind: 'user', text, images: images.length, previews, shells }); inflight = { text: sendText, images, uuid: randomUUID(), acked: false, produced: false, retried: false, idle };
      setStatus();
      try {
        if (agent === 'cursor') { await new Promise(resolve => setImmediate(resolve)); await cursorSnapshot; }
        if (configuring) await configChain;
        if (agent === 'claude' && !meta.artifact && (artifact || wantsArtifact(input))) await enableArtifact();
        await start(); await saveMeta();
        if (meta.limit?.stop && !limitBypass) throw fault('CHAT_LIMIT', `제한 규칙(${meta.limit.stop.rule})에 도달해 보내지 못했습니다.`, 409); // a limit was reached while the agent was starting
        if (agent === 'cursor') startCursorStorePoll(Date.now() + 600_000);
        if (agent === 'cursor' && isCursorSummarizeCommand(text) && protocol) {
          if (images.length) throw fault('CHAT_UNSUPPORTED', '컨텍스트 압축 명령에는 이미지를 붙일 수 없습니다.', 409);
          const sessionId = state.sessionId ?? meta.sessionId;
          const preTokens = state.contextTokens, startedAt = Date.now();
          cursorManualCompact = true;
          emit({ kind: 'delta', phase: 'compacting', active: true });
          restart();
          try {
            const output = await runCursorSummarize({ executable, executableArgs: argsOf(executableArgs, meta.auth), sessionId, cwd, env, spawnProcess });
            const after = await readCursorStoreUsage(sessionId, { storePath: id => cursorStorePath(id, { env: { CURSOR_CONFIG_DIR: cursorDirOf() } }) }).catch(() => null);
            if (Number.isInteger(after?.selfSummaryCount)) cursorSummaryCount = after.selfSummaryCount;
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
          } finally { cursorManualCompact = false; }
          turnOpen = false;
          setStatus();
          if (agent === 'cursor') startCursorStorePoll(Date.now() + 45_000);
          return;
        }
        if (protocol) await protocol.send(sendText, images);
        else await write(userLine(sendText, images, inflight.uuid));
      }
      catch (error) { turnOpen = false; if (codexCompact) emit({ kind: 'delta', phase: 'compacting', active: false }); if (protocol) restart(); setStatus(); throw error; }
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
      if (agent === 'claude' && answer.allow === true) ownMode = planMode ?? (answer.always === true ? uiPermissionMode(alwaysSuggestions(pending.tool, pending.suggestions).find(item => item.type === 'setMode')?.mode) : undefined);
      if (planMode !== undefined && (!PERMISSION_MODES.includes(planMode) || planMode === 'plan' || planMode === 'bypassPermissions')) throw fault('INVALID_INPUT', '계획 승인 후 사용할 수 없는 권한 모드입니다.');
      if (answer.allowTool === true && (agent !== 'claude' || !toolAllowable(pending.tool))) throw fault('INVALID_INPUT', '이 요청은 도구 전체 허용을 지원하지 않습니다.');
      if (protocol) await protocol.approve(requestId, answer);
      else {
        // A Claude question is answered inside the tool input; skipping it tells the model so, instead of the generic "rejected, STOP" refusal.
        const asking = pending.tool === 'AskUserQuestion' && pending.questions;
        const grant = answer.allow !== true ? [] : answer.allowTool === true ? toolSuggestions(pending.tool) : answer.always === true ? alwaysSuggestions(pending.tool, pending.suggestions) : [];
        await write(approvalLine(requestId, { allow: answer.allow === true, input: asking && answer.allow ? askUserInput(pending.input, pending.questions, answer.answers) : pending.input,
          message: pending.tool === 'ExitPlanMode' && answer.message ? planRevision(answer.message) : answer.message ? (asking ? answer.message : refusalWith(answer.message)) : asking ? ASK_SKIPPED : undefined, suggestions: grant, mode: planMode }));
        // The CLI keeps a session rule only in its own memory; the chat keeps it too, so a child started later (idle kill, setting change) still has it.
        const rules = agent === 'claude' ? sessionRuleStrings(grant) : [];
        if (answer.allow === true && answer.allowTool === true) { meta.allowTools = [...new Set([...(meta.allowTools ?? []), pending.tool])].slice(-50); void saveMeta().catch(reportStorage); }
        if (rules.length) { meta.sessionAllow = [...new Set([...(meta.sessionAllow ?? []), ...rules])].slice(-100); void saveMeta().catch(reportStorage); void applySessionAllow(meta.sessionAllow); }
      }
      // Approving a plan makes the CLI leave plan mode (back to what it was before); it says nothing about it, so the mode chip is moved here.
      if (agent === 'claude' && pending.tool === 'ExitPlanMode' && answer.allow === true && state.permissionMode === 'plan') { meta.permissionMode = state.permissionMode = planMode ?? prePlanMode; void saveMeta().catch(() => {}); publish(); }
      approvals.delete(requestId);
      emit({ kind: 'approval', phase: 'answer', requestId, tool: pending.tool, allow: answer.allow === true });
      setStatus();
      // Only Claude reads a reason with a refusal; for Codex and Cursor the note leaves as the next user message.
      const note = agent !== 'claude' && answer.allow !== true && typeof answer.message === 'string' ? answer.message.trim() : '';
      if (note) await deliverNote(note);
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
      // Esc ends this turn only: spare_background_tasks keeps background subagents/shells running (the CLI's own Esc does the same; each task has its own stop,
      // see stopTask). A CLI that does not know the field treats it as a plain interrupt.
      const proc = child, turn = turnSeq, response = await control({ subtype: 'interrupt', spare_background_tasks: true }, 3000);
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
    // Whether the agent is told about UI blocks (and how to write file paths, see chat-prompt.js) is decided once, by the setting at the chat's first message, and kept: a later change would rewrite the system prompt
    // and make the whole conversation miss the prompt cache. Chats that already had a session (older ones) never get it. Cursor has no system-prompt channel.
    setInteractiveUi(value) {
      if (meta.interactiveUi === undefined && !state.sessionId && !child && typeof value === 'boolean') { meta.interactiveUi = value; meta.fileLinks = true; }
    },
    async warm() { live(); if (agent === 'cursor' && !closed && !child && !turnOpen) await start(); },
    async set({ model, effort, worktree, addDirs, permissionMode, configOption, sandbox, network, runEverything, auth }) {
      live();
      // The login (CLI plan or API key) is read when the child starts, so changing it replaces the child; the next message resumes the same session on the new
      // login. Nothing is asked here: the composer asks before a message that would change the account a chat has already used.
      if (auth !== undefined) {
        if (auth !== 'login' && auth !== 'key') throw fault('INVALID_INPUT', '잘못된 로그인 방식입니다.');
        if ([model, effort, worktree, addDirs, permissionMode, configOption, sandbox, network, runEverything].some(value => value !== undefined)) throw fault('INVALID_INPUT', '로그인 방식은 다른 설정과 함께 바꿀 수 없습니다.');
        if (configuring || !quiet()) throw fault('CHAT_BUSY', '응답과 백그라운드 작업이 끝난 뒤 로그인 방식을 바꿀 수 있습니다.', 409);
        if (auth === 'key' && !keyAvailable()) throw fault('API_KEY_MISSING', 'API 키가 등록되어 있지 않습니다. 설정 → AI 툴에서 등록하세요.', 409);
        meta.auth = state.auth = auth;
        if (child) restart();
        state.apiKey = usesApiKey({ ...process.env, ...envNow() });
        await saveMeta(); publish(); return;
      }
      if (runEverything !== undefined && (agent !== 'cursor' || typeof runEverything !== 'boolean')) throw fault(agent === 'cursor' ? 'INVALID_INPUT' : 'CHAT_UNSUPPORTED', agent === 'cursor' ? 'Run Everything 설정을 확인하세요.' : 'Run Everything은 Cursor에서만 설정할 수 있습니다.', agent === 'cursor' ? 400 : 409);
      if (configOption !== undefined && (agent !== 'cursor' || !configOption || typeof configOption !== 'object' || typeof configOption.configId !== 'string' || typeof configOption.value !== 'string' || configOption.configId.length > 200 || configOption.value.length > 200)) throw fault('INVALID_INPUT', '모델 옵션을 확인하세요.');
      if (agent !== 'claude') {
        const caps = state.capabilities;
        if (worktree !== undefined && typeof worktree !== 'boolean') throw fault('INVALID_INPUT', '워크트리 설정을 확인하세요.');
        if ((network !== undefined && agent !== 'codex') || (sandbox !== undefined && !caps.sandboxes?.length)) throw fault('CHAT_UNSUPPORTED', '이 설정은 Codex(샌드박스/네트워크)와 Cursor(샌드박스)에서만 바꿀 수 있습니다.', 409);
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
          if (runEverything !== undefined) { meta.runEverything = state.runEverything = runEverything; await protocol?.setRunEverything?.(runEverything); }
          if (sandbox !== undefined) {
            meta.sandbox = state.sandbox = sandbox ?? null;
            if (child) { restartWhenQuiet(); }
          }
          await saveMeta(); publish(); return;
        }
        if (agent === 'cursor' && (model !== undefined || effort !== undefined || configOption !== undefined || permissionMode !== undefined)) {
          if ([model, effort, configOption, permissionMode].filter(value => value !== undefined).length > 1 || worktree !== undefined || addDirs !== undefined) throw fault('INVALID_INPUT', '모델 설정은 한 번에 하나씩 바꾸세요.');
          const previous = { model: meta.model, effort: meta.effort, permissionMode: meta.permissionMode, configValues: { ...(meta.configValues ?? {}) }, stateModel: state.model, stateEffort: state.effort, stateMode: state.permissionMode, options: state.capabilities.configOptions, efforts: state.capabilities.efforts, effortConfigId: state.capabilities.effortConfigId };
          const restore = () => {
            meta.model = previous.model; meta.effort = previous.effort; meta.permissionMode = previous.permissionMode; meta.configValues = previous.configValues;
            state.model = previous.stateModel; state.effort = previous.stateEffort; state.permissionMode = previous.stateMode;
            if (state.capabilities.configOptions !== previous.options) state.capabilities = { ...state.capabilities, configOptions: previous.options, efforts: previous.efforts, ...(previous.effortConfigId && { effortConfigId: previous.effortConfigId }) };
          };
          configCount += 1; configuring = state.configuring = true;
          if (model !== undefined) {
            meta.model = model ?? undefined; meta.configValues = {}; meta.effort = undefined;
            state.model = model ?? state.model; cursorModelHold = state.model; cursorSurfaceLive = false;
            // Options already seen for this model go up at once. The ACP echo still replaces them; an unseen model waits for that echo.
            const surface = typeof model === 'string' ? cursorSurface(cursorModelCache?.get(), model) : null;
            if (surface?.configOptions.length) {
              state.capabilities = { ...state.capabilities, configOptions: surface.configOptions, efforts: surface.efforts, ...(surface.effortConfigId && { effortConfigId: surface.effortConfigId }), ...(surface.catalog.length && { catalog: surface.catalog }) };
              state.effort = surface.effort;
            }
          }
          if (permissionMode !== undefined) { meta.permissionMode = state.permissionMode = permissionMode; cursorModeHold = permissionMode; }
          if (model !== undefined || permissionMode !== undefined) publish();
          const apply = async () => {
            await start();
            if (model !== undefined) {
              // A cold start applies meta.model inside initialize. Configuring it again reloads the model twice.
              if ((cursorAppliedModel ?? null) !== (meta.model ?? null)) { await protocol.configure({ model: meta.model ?? null }); cursorAppliedModel = meta.model ?? null; }
              cursorSurfaceLive = true;
            } else {
              if (effort !== undefined) { meta.effort = effort ?? undefined; state.effort = effort; }
              if (configOption) {
                const option = state.capabilities.configOptions?.find(item => item.id === configOption.configId);
                if (!option || ['model', 'mode'].includes(option.category) || !option.options?.some(item => item.value === configOption.value)) throw fault('INVALID_INPUT', '지원하지 않는 모델 옵션입니다.');
                meta.configValues = { ...(meta.configValues ?? {}), [configOption.configId]: configOption.value };
                state.capabilities = { ...state.capabilities, configOptions: state.capabilities.configOptions.map(item => item.id === configOption.configId ? { ...item, currentValue: configOption.value } : item) };
              }
              publish();
              await protocol.configure({ permissionMode, configOption: effort !== undefined ? { configId: state.capabilities.effortConfigId, value: effort } : configOption });
              if (configOption || effort !== undefined) meta.model = state.model ?? meta.model;
            }
            await saveMeta();
          };
          const run = configChain.then(apply);
          configChain = run.catch(() => {});
          try { await run; } catch (error) { restore(); throw error; }
          finally { cursorModelHold = null; cursorSurfaceLive = true; cursorModeHold = null; if (--configCount === 0) { configuring = false; state.configuring = false; } publish(); }
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
          ownMode = permissionMode;
          const response = await control({ subtype: 'set_permission_mode', mode: cliPermissionMode(permissionMode) }).finally(() => { ownMode = undefined; });
          if (!response || response.subtype !== 'success') throw fault('AGENT_PROTOCOL', '권한 모드를 적용하지 못했습니다. Claude Code 버전과 설정을 확인하세요.', 502);
        }
        if (permissionMode === 'plan' && state.permissionMode !== 'plan') meta.prePlanMode = prePlanMode = state.permissionMode;
        meta.permissionMode = state.permissionMode = permissionMode;
        if (child && !protocol) bypassPending();
      }
      if (model !== undefined) {
        if (model !== null && !(typeof model === 'string' && /^[\w.\[\]-]{1,100}$/.test(model))) throw fault('INVALID_INPUT', '잘못된 모델입니다.');
        meta.model = model ?? undefined; lastMainModel = undefined;
        // The window reported for the previous model must not size the new one; the catalog stands in until the next result reports it.
        if (agent === 'claude' && model !== state.model) state.contextWindow = null;
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
      if (agent === 'cursor') {
        const checkpoint = cursorCheckpoints.get(uuid);
        if (!checkpoint || !/^cursor-checkpoints\/[a-f0-9-]{36}\.json$/.test(checkpoint)) throw fault('CHAT_UNSUPPORTED', '완료된 응답의 분기 기록이 없습니다. 새 응답이 끝난 뒤 다시 시도하세요.', 409);
        const end = kept.findIndex(item => item.kind === 'cursor_checkpoint' && item.uuid === uuid);
        return { events: kept.slice(0, end + 1), meta: { agent, cwd, configDir: cursorDirOf(), cursorCheckpoint: path.join(root, checkpoint), model: meta.model, effort: meta.effort, configValues: meta.configValues, sandbox: meta.sandbox, permissionMode: meta.permissionMode, runEverything: meta.runEverything, addDirs: [] } };
      }
      return { events: through(kept, selected), meta: { agent, cwd, worktree: meta.worktree, worktreePath: meta.worktreePath, configDir: meta.configDir, sessionId: meta.sessionId, resumeAt: agent === 'codex' ? events[at].turnId : uuid, fork: true, model: meta.model, effort: meta.effort, addDirs: meta.addDirs, permissionMode: meta.permissionMode, mediaBlocks: meta.mediaBlocks || undefined, colorChips: meta.colorChips || undefined } };
    },
    // Rewind: drop everything after one assistant message. The next message starts a fork of the session at that point. With `files`, the work folder's files
    // first go back to the end of that turn (chat-snapshots.js); without it, files the agent already changed stay.
    async rewind(uuid, { files = false } = {}) {
      live();
      if (agent === 'cursor') await cursorSnapshot;
      if (turnOpen || approvals.size) throw fault('CHAT_BUSY', '응답이 끝난 뒤 되돌릴 수 있습니다.', 409);
      const snapshot = this.branchSnapshot(uuid);
      // Files first: a restore that cannot start (no snapshot, the current state unreadable) throws before the conversation changes.
      if (files && !turnSnaps) throw fault('CHAT_UNSUPPORTED', '턴 스냅샷이 꺼져 있어 파일을 되돌릴 수 없습니다.', 409);
      const restored = files ? await turnSnaps.rewindFiles(answerOf(uuid)).catch(snapFault) : null;
      restart();
      if (agent === 'cursor') {
        const sessionId = await forkCursorSession({ checkpoint: snapshot.meta.cursorCheckpoint, cwd, configDir: cursorDirOf() });
        meta.sessionId = state.sessionId = sessionId;
        emit({ kind: 'rewind', uuid, ...(restored && { files: true }) }); if (restored) emit({ kind: 'file_rewind', uuid, ...restored }); await saveMeta(); setStatus(); return restored;
      }
      meta.resumeAt = snapshot.meta.resumeAt; meta.fork = true;
      emit({ kind: 'rewind', uuid, ...(restored && { files: true }) }); if (restored) emit({ kind: 'file_rewind', uuid, ...restored }); await saveMeta(); setStatus();
      return restored;
    },
    // Rewind's dialog: whether that point's files can come back, and which files that writes and removes (nothing is changed).
    rewindPreview(uuid) { live(); return turnSnaps ? turnSnaps.preview(answerOf(uuid)) : { available: false, reason: '턴 스냅샷이 꺼져 있습니다.' }; },
    // "파일 되돌리기 취소": the files go back to the snapshot kept just before that restore (`seq`: the restore's file_rewind event).
    async undoFileRewind(seq, { preview = false } = {}) {
      live();
      if (!turnSnaps) throw fault('CHAT_UNSUPPORTED', '턴 스냅샷이 꺼져 있습니다.', 409);
      if (!Number.isSafeInteger(seq)) throw fault('INVALID_INPUT', '취소할 되돌리기를 확인하세요.');
      if (preview) return turnSnaps.undoPreview(seq);
      if (turnOpen || approvals.size) throw fault('CHAT_BUSY', '응답이 끝난 뒤 되돌릴 수 있습니다.', 409);
      const done = await turnSnaps.undo(seq).catch(snapFault);
      emit({ kind: 'file_rewind', undo: seq, ...done }); setStatus();
      return done;
    },
    // One file of a turn's change card, both sides, for the editor's diff tab.
    turnFile(input) { live(); if (!turnSnaps) throw fault('CHAT_UNSUPPORTED', '턴 스냅샷이 꺼져 있습니다.', 409); return turnSnaps.file(input).catch(snapFault); },
    // Chat -> terminal: only while nothing runs. The child is ended (and waited for), so the session has a single writer again when the terminal resumes it.
    async handoff({ force = false } = {}) {
      live();
      if (agent === 'cursor') await cursorSnapshot;
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
      const sessionId = agent === 'cursor' ? await exportCursorSession({ sessionId: meta.sessionId, cwd, configDir: cursorDirOf() }) : meta.sessionId;
      return { agent, sessionId, configDir: agent === 'cursor' ? cursorDirOf() : meta.configDir };
    },
    // /btw: a side question answered from a fork of this conversation (see chat-btw.js). Needs no idle state: it runs beside a working turn and never touches the chat's events.
    // It runs on the agent's cheap default model (BTW_DEFAULTS), not the chat's own; `pick` ({ model, effort }) overrides that.
    async btw(question, btwId, pick = {}) {
      const text = typeof question === 'string' ? question.trim() : '';
      if (!text) throw fault('INVALID_INPUT', '질문을 입력하세요. 예: /btw 이 함수는 왜 비동기야?');
      const controller = new AbortController(), key = String(btwId ?? ''); if (key) btwRuns.set(key, controller);
      const launchEnv = withUtf8Ctype({ ...process.env, ...envNow() });
      if (agent === 'claude' && meta.configDir) launchEnv.CLAUDE_CONFIG_DIR = meta.configDir;
      if (agent === 'codex' && meta.configDir) launchEnv.CODEX_HOME = meta.configDir;
      try { return await runBtw({ agent, executable, executableArgs: argsOf(executableArgs, meta.auth), sessionId: state.sessionId ?? meta.sessionId ?? undefined, model: pick.model, effort: pick.effort, question: text, digest: agent === 'cursor' ? conversationDigest(events) : '', cwd: meta.worktreePath ?? cwd, env: launchEnv, spawnProcess, signal: controller.signal }); }
      finally { if (key) btwRuns.delete(key); }
    },
    // `!command`: starts the run and returns at once with its id; the card is filled by `shell` events. `done` (tests, callers that wait) settles when it ends.
    shell(command, options) { return startShell(command, options); },
    // Toggles whether one finished `!` run waits to ride along with the next message (on = left out); it can be turned back any time before that message.
    skipShell(runId, on) { const id = String(runId ?? ''); if (!pendingShellRuns(retainedEvents()).some(run => run.id === id) && on) return false; emit({ kind: 'shell', phase: 'skip', id, on: on === true }); return true; },
    stopShell(runId) { const run = shellRuns.get(String(runId ?? '')); run?.abort(); return run !== undefined; },
    cancelBtw(btwId) { const run = btwRuns.get(String(btwId ?? '')); run?.abort(); return run !== undefined; },
    // Where this conversation's transcript lives, for the statistics view.
    stats() { return { sessionId: state.sessionId ?? '', ...withSubagents(chatEventStats(retainedEvents()), events, costPerUnit) }; },
    storedEvents() { return events; },
    tokenPrice() { return costPerUnit; },
    // Codex and Cursor have no dollar transcript. The plan-share meter is the token weight their usage events accumulated since each window opened.
    spendSince(since) { return eventWeightSince(logFile, events, since); },
    // The chat's worktree (chat-worktree.js): read, move in and out, and forget it once it is removed. Git work on it is in the routes (chat-worktree-routes.js).
    worktreeInfo() { return state.worktreeInfo; },
    refreshWorktree() { return refreshWorktree(); },
    async enterWorktree() { live(); return enterWorktreeNow(); },
    async leaveWorktree() {
      live();
      const own = await readOwnWorktree(root);
      if (!own || !samePath(cwd, own.cwd)) {
        if ((await refreshWorktree())?.inside) throw fault('AGENT_WORKTREE', '에이전트가 직접 들어간 worktree입니다. 에이전트에게 나오라고 요청하세요(Claude: ExitWorktree).', 409);
        return state.worktreeInfo;
      }
      return relocate(own.originCwd, { phase: 'exit', worktreePath: undefined });
    },
    async forgetWorktree(details = {}) { await writeOwnWorktree(root, null); emit({ kind: 'worktree', phase: 'remove', ...details }); return refreshWorktree(); },
    noteWorktree(event) { emit({ kind: 'worktree', ...event }); return refreshWorktree(); },
    sessionRef() { return { agent, sessionId: state.sessionId ?? meta.sessionId ?? null, configDir: meta.configDir, cwd, worktreePath: meta.worktreePath, costUsd: typeof state.costUsd === 'number' ? state.costUsd : null }; },
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
      if (state.sessionId) await seedChat({ directory, id: randomUUID(), events: retainedEvents(), meta: { ...snapshotMeta(), limit: undefined } });
      restart();
      meta.resumeAt = undefined; meta.fork = false;
      clearApprovals(); dropSteers(false); turnOpen = false; meta.sessionId = undefined; meta.sessionAllow = undefined; meta.allowTools = undefined; meta.costBase = 0; if (meta.limit?.stop) delete meta.limit.stop; state.sessionId = null; state.costUsd = agent === 'claude' ? 0 : null; state.contextTokens = 0; state.tokens = zero(); resetLive(); state.turns = 0; state.durationMs = 0;
      emit({ kind: 'divider', reason: 'clear' }); await saveMeta(); setStatus();
    },
    async close({ forget = false, archiveAs } = {}) {
      if (closed) return;
      await endShells();
      closed = true; unsubscribeSpend?.(); clearTimeout(idleTimer); clearTimeout(activityTimer); clearInterval(limitTimer); stopIdleCompact(); stopCursorStorePoll();
      if (agent === 'codex') dropSteers();
      if (child) {
        const proc = dropChild(); setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 3000).unref();
        // Closed means the child is gone: on Windows a still-exiting child keeps its folder locked, so the caller (or a test) could not delete it right after close.
        await new Promise(resolve => { if (proc.exitCode !== null || proc.signalCode) return resolve(); const timer = setTimeout(resolve, 2000); proc.once('close', () => { clearTimeout(timer); resolve(); }); });
      }
      await cursorSnapshot;
      await worktreeChain.catch(() => {}); // a git read still running would keep the folder busy (Windows) for whoever removes it next
      if (forget) await turnSnaps?.forget().catch(() => {}); else await turnSnaps?.close(); // a forgotten chat's snapshot refs go with it
      await writing.catch(() => {});
      if (forget) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      else { await saveMeta(); if (archiveAs) await fs.rename(root, chatFolder(directory, archiveAs)); } // archiveAs: the transcript moves to another id so this id can start over as another agent
    }
  };
  void refreshWorktree(); // what the thread shows from the start: the worktree the chat is in or keeps
  return chatApi;
}

async function forgetRememberedModel(directory, agent) {
  const file = path.join(directory, 'last-picks.json');
  let all;
  try { all = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return; }
  if (!all?.[agent] || typeof all[agent] !== 'object') return;
  delete all[agent].model;
  delete all[agent].effort;
  if (!Object.keys(all[agent]).length) delete all[agent];
  await fs.writeFile(file, JSON.stringify(all), { mode: 0o600 });
}

// Only this project's stored Chat sessions are listed; the provider's private CLI history stays with its CLI.
export async function listChatSessions({ directory, agent, exclude }) {
  if (!chatAgents.includes(agent)) throw fault('INVALID_INPUT', '잘못된 에이전트입니다.');
  const root = path.join(directory, 'chat');
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const sessions = [], listed = entries.filter(entry => entry.isDirectory() && ID.test(entry.name) && entry.name !== exclude);
  // 32 at a time: each folder was read and parsed one after another, which a long history made seconds of waiting.
  for (let at = 0; at < listed.length; at += 32) {
    const found = await Promise.all(listed.slice(at, at + 32).map(async entry => {
      try {
        const file = path.join(root, entry.name, 'meta.json'), meta = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!meta || (meta.agent ?? 'claude') !== agent || typeof meta.sessionId !== 'string' || !meta.sessionId) return null;
        return { id: entry.name, sessionId: meta.sessionId, title: typeof meta.title === 'string' && meta.title ? meta.title : `대화 ${String(meta.sessionId).slice(0, 8)}`, model: [meta.lastModel, meta.model].find(value => typeof value === 'string' && value) ?? null, updatedAt: (await fs.stat(file)).mtimeMs };
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; return null; }
    }));
    for (const session of found) if (session) sessions.push(session);
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Writes a new chat's folder from a Branch snapshot; `openChatSession` then loads it like any stored chat.
export async function seedChat({ directory, id, events, meta }) {
  const root = chatFolder(directory, id);
  if (await fs.stat(path.join(root, 'meta.json')).then(() => true, () => false)) throw fault('INVALID_INPUT', '이미 있는 채팅입니다.');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (meta.agent === 'cursor' && meta.cursorCheckpoint) {
    const { cursorCheckpoint, ...rest } = meta;
    const source = path.dirname(path.dirname(cursorCheckpoint));
    await backupCursorStore(path.join(source, 'cursor-checkpoints/store.db'), path.join(root, 'cursor-checkpoints/store.db'));
    for (const event of events) if (event.kind === 'cursor_checkpoint') {
      if (!/^cursor-checkpoints\/[a-f0-9-]{36}\.json$/.test(event.file)) throw fault('INVALID_INPUT', '분기 기록 경로가 올바르지 않습니다.');
      await fs.copyFile(path.join(source, event.file), path.join(root, event.file), fs.constants.COPYFILE_EXCL);
    }
    meta = { ...rest, sessionId: await forkCursorSession({ checkpoint: cursorCheckpoint, cwd: meta.cwd, configDir: meta.configDir }) };
  }
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
