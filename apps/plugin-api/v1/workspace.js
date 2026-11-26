// The ADE 0.6.3 workspace surface. A new server route or socket message must not
// become part of a plugin contract just because the desktop UI starts using it.
import requests from './workspace-requests.json' with { type: 'json' };

const keys = value => value ? value.split(' ') : [];
const fields = (value, names) => Object.fromEntries(names.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const pick = (value, names) => value && typeof value === 'object' && !Array.isArray(value) ? fields(value, keys(names)) : value;
const map = (value, transform) => Array.isArray(value) ? value.map(transform) : value;
const record = (value, transform) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transform(item)])) : value;

export const limits = Object.freeze({ sessions: 16, terminals: 8 });
const gitOps = new Set(requests.gitOps);
const mcpOps = new Set(['status', 'reconnect', 'toggle', 'auth', 'clearAuth', 'callback']);
const actionFields = new Map(Object.entries(requests.actions).map(([action, names]) => [action, ['projectId', ...keys(names)]]));
const pane = value => {
  const out = pick(value, 'id kind cwd agent tabs active direction children sizes');
  if (out?.children) out.children = map(out.children, pane);
  return out;
};
const paneTabs = value => map(value, tab => {
  const out = pick(tab, 'id title focus pane');
  if (out?.pane) out.pane = pane(out.pane);
  return out;
});
function layout(value) {
  const out = pick(value, 'gitRepositoryId focus activeTab rightVisible projectTreeExpanded paneTabs');
  if (out?.paneTabs) out.paneTabs = paneTabs(out.paneTabs);
  return out;
}
const chatDefaults = 'model effort worktree addDirs permissionMode sandbox network runEverything auth idleCompact autoCompact limit configDir';
export function request(action, value) {
  const allowed = actionFields.get(action);
  if (!allowed) return null;
  const input = fields(value, allowed);
  if (action === 'git/op' && !gitOps.has(input.op)) return null;
  if (action === 'chat/mcp' && !mcpOps.has(input.action)) return null;
  if (action === 'ui') input.ui = layout(input.ui);
  if (action === 'ui/layout') input.paneTabs = paneTabs(input.paneTabs);
  if (action === 'app/state' && input.state) input.state = appState(input.state);
  if (action === 'files/move' && input.moves) input.moves = map(input.moves, item => pick(item, 'from to'));
  if (action === 'chat/open' && input.defaults) input.defaults = pick(input.defaults, chatDefaults);
  return input;
}

const inbound = new Map(Object.entries({
  subscribe: 'since',
  unsubscribe: '',
  'terminal/input': 'id data',
  'terminal/paste-image': 'id mime data',
  'terminal/resize': 'id cols rows claim'
}).map(([type, names]) => [type, ['type', 'projectId', ...keys(names)]]));
export function clientMessage(value) {
  const allowed = inbound.get(value?.type);
  if (!allowed) return null;
  const message = fields(value, allowed);
  if (message.since) message.since = record(message.since, item => pick(item, 'stream offset'));
  return message;
}

const stateFields = 'agent capabilities status model effort worktree addDirs permissionMode sandbox network runEverything' +
  ' configuring restartPending sessionId costUsd turns durationMs contextTokens contextWindow contextUsageSource autoCompact' +
  ' tokens slashCommands commandInfo tools pending error recoverable startedAt segmentTitles chatTitle liveTasks cwd' +
  ' limit limitOptions idleCompact apiKey auth mcpServers lastAuth apiCostUsd cache';
function chatState(value) {
  const out = pick(value, stateFields);
  if (!out) return out;
  if (out.capabilities) out.capabilities = pick(out.capabilities, 'configOptions images steer cancelSteer branch rewind worktree addDirs terminal terminalToChat cost tokens context permissionModes sandboxes runEverything efforts catalog limitations');
  if (out.tokens) out.tokens = pick(out.tokens, 'input output cacheRead cacheCreate');
  if (out.mcpServers) out.mcpServers = map(out.mcpServers, item => pick(item, 'name disabledTools autoApprove'));
  return out;
}

function snapshot(value) {
  const out = pick(value, 'id root multiRepo repositories ui chats terminals');
  if (!out) return out;
  if (out.repositories) out.repositories = map(out.repositories, item => pick(item, 'id name path worktreeEnabled worktreePath branch'));
  if (out.ui) out.ui = layout(out.ui);
  if (out.chats) out.chats = map(out.chats, item => ({ id: item.id, state: chatState(item.state) }));
  if (out.terminals) out.terminals = map(out.terminals, item => pick(item, 'id exited cwd cols rows startedAt activeAt inputAt'));
  return out;
}

// Chat's own tagged payloads are versioned as well as the outer server messages.
const chatEvents = new Map(Object.entries({
  approval: 'phase requestId tool input toolUseId suggestions questions exists mcp allow',
  auto_denied: 'toolUseId tool input reason rule',
  capabilities: 'capabilities',
  command_output: 'text isError',
  compact: 'trigger preTokens postTokens',
  cursor_checkpoint: 'uuid file',
  delta: 'phase tokens active messageId parentToolUseId usage final index text id name input detail',
  denial_allow: 'toolUseIds retry rules',
  divider: 'reason',
  error: 'message recoverable',
  limit: 'status limit utilization threshold resetsAt overage',
  limit_stop: 'rule',
  message: 'role id uuid model parentToolUseId blocks usage',
  peer_message: 'uuid sender text receivedAt beforeSeq beforeMessageId',
  raw: 'original',
  result: 'status text sessionId costUsd usage contextWindow durationMs turns turnCostUsd auth',
  rewind: 'uuid',
  session: 'sessionId model permissionMode cwd tools slashCommands commands',
  settings: 'permissionMode by effort model from reason',
  shell: 'phase ids id command cwd shell stream text status exitCode signal ms stdout stderr on needsTerminal error skipped',
  steer: 'phase uuid text images previews shells resent',
  task: 'phase toolUseId description agentType background status report taskId summary usage lastToolName run pid',
  title: 'source text',
  tool_result: 'toolUseId isError content',
  usage: 'contextWindow tokens contextTokens contextSource',
  user: 'text images previews shells uuid clientMessageId',
  worktree: 'phase path from name branch'
}).map(([kind, names]) => [kind, ['kind', 'seq', 'at', ...keys(names)]]));
function chatEvent(value) {
  const allowed = chatEvents.get(value?.kind);
  return allowed ? fields(value, allowed) : null;
}

const events = new Map(Object.entries({
  'chat/event': 'id event',
  'chat/state': 'id state',
  error: 'error',
  'feedback/changed': 'id',
  fs: 'paths',
  'plugin/chat': 'id agent cwd',
  snapshot: 'snapshot',
  terminal: 'id data sequence status',
  'terminal/agent': 'id agent ssh',
  'terminal/cache': 'id cache',
  'terminal/exit': 'id exitCode signal lost',
  'terminal/replay': 'id data append stream offset sequence exited status',
  'terminal/size': 'id cols rows',
  'terminal/ssh': 'id ssh',
  'terminal/status': 'id status',
  'terminal/stream': 'id stream offset sequence',
  'ui/changed': 'paneTabs from'
}).map(([type, names]) => [type, ['type', 'projectId', ...keys(names)]]));
export function event(value) {
  const allowed = events.get(value.type);
  if (!allowed) return null;
  const out = fields(value, allowed);
  if (out.type === 'snapshot') out.snapshot = snapshot(out.snapshot);
  if (out.type === 'chat/state') out.state = chatState(out.state);
  if (out.type === 'chat/event') {
    out.event = chatEvent(out.event);
    if (!out.event) return null;
  }
  if (out.type === 'error') out.error = pick(out.error, 'code message files');
  if (out.type === 'ui/changed') out.paneTabs = paneTabs(out.paneTabs);
  return out;
}

const settingFields = [
  'accentColor agentsMuted agentsOff animateInBackground appKeys artifactAlways boldBright',
  'cacheSendWarn cacheSendWarnMinutes cacheTimer cacheWarn chatAutoScroll chatComposerMax chatDarker',
  'chatDefaultEffort chatDefaultPermission chatFontSize chatKeys chatModelPins chatPermissionAutoSet',
  'chatSendKey chatSmoothStream chatStatusItems chatStatusLeft chatStatusRight chatStatusSeparator',
  'chatThinkingOpen chatTipPending chatToolDisplay chatToolsOpen chatWidth claudeArgs claudeSession cli',
  'clock12h clockSeconds codexArgs confirmClose confirmCloseChat confirmCloseProject contextTipK',
  'copyOnSelect cursorArgs cursorBlink cursorStyle date defaultMode diffComputeMs diffContextLines',
  'diffFoldUnchanged diffFont diffIgnoreWhitespace diffLayout diffRefresh dimInactivePanes enter',
  'feedbackAgentTool feedbackAiContext feedbackAiEffort feedbackAiModel followUpQueue fontSize',
  'gitBranchClick gitBranchDirs gitBranchTags gitBranchesPane gitBranchesWidth gitBrightness gitColumns',
  'gitCommitTime gitCompactRefs gitCurrent gitDetails gitDetailsWidth gitDiffPreview gitFavorites',
  'gitFetchPrune gitFilesByDir gitFirstParent gitLinear gitLogDock gitLogHeight gitLogLimit',
  'gitLongEdges gitMerges gitMine gitNoMerges gitPrettyDate gitProtected gitRefsLeft gitSaturation',
  'gitSort gitTagNames gitTipPending gitUpdateMethod hintsSeen idleCompact idleCompactMinK',
  'interactiveUi letterSpacing lineHeight live mcpTrust merge minimumContrast narrow none',
  'notifyApproval notifyDone notifyLooking notifySound onboarded optionAsMeta reviewWidth',
  'rightClickPaste scrollSensitivity scrollback sidebarCompact sidebarWidth soundAttention soundDone',
  'soundVolume soundVolumeExtended statusItems statusLeft statusRight summary systemRefresh termKeys',
  'terminalBell terminalFont terminalFontSize terminalFontWeight terminalGpu terminalShell theme tips',
  'tourVersion uiZoom usageColors usageRefresh usageShown usageStyle wakatime wakatimeBackground',
  'wordSeparator wordWrap',
].join(' ');
function appState(value) {
  const out = pick(value, 'version openProjects activeProjectId settings');
  if (out?.openProjects) out.openProjects = map(out.openProjects, item => pick(item, 'id root'));
  if (out?.settings) out.settings = pick(out.settings, settingFields);
  return out;
}

function feedbackItem(value) {
  const out = pick(value, 'id title body source status reviewed types images createdAt updatedAt error issue issueNumber submittedAt queuedAt nextAttemptAt attempts via track progress');
  if (out?.images) out.images = map(out.images, item => pick(item, 'name w h annotated original'));
  return out;
}
function feedbackResult(action, value) {
  if (action === 'feedback/list') {
    const out = pick(value, 'items available queue progress');
    if (out?.items) out.items = map(out.items, feedbackItem);
    return out;
  }
  if (action === 'feedback/status') return pick(value, 'ok mode account reason');
  if (action === 'feedback/refresh') return pick(value, 'checkedAt unsupported skipped off');
  if (action === 'feedback/delete') return pick(value, 'ok id');
  return feedbackItem(value);
}

const snapshotActions = new Set(['project/open', 'project/create', 'project/clone', 'snapshot']);
const resultFields = new Map(Object.entries({
  'app/tip': 'claimed',
  'agent/installed': 'missing',
  'agent/update-check': 'installed current latest outdated checkedAt error',
  'agent/update': 'ok before after changed message status',
  'chat/autocompact': 'autoCompact',
  'chat/idlecompact': 'chat on',
  'chat/limit': 'limit options',
  'chat/models': 'models catalog configOptions',
  'chat/mcp': 'result servers',
  'chat/import-cli': 'id agent sessionId cwd',
  'chat/import-cursor': 'id agent sessionId cwd',
  'ide/list': 'ides fileManager',
  'ide/open': '',
  'git/op': 'state stopped conflicts output restore stashed stashConflict restored stash skipped error',
  'terminal/to-chat': 'cwd agent',
  'usage/status': 'provider windows credit codexCredits plan source at identity note error checked account',
  'usage/review': 'timeZone from to device deviceLabel devices providersFilter projectFilter projectLabel accountFilter accountLabel authFilter turns sessions tokens weight costUsd costTurns unknownCostTurns success failed interrupted activeMs compactions unknownTurns aliasedTurns cacheHitRate inputFamily tools models providers accounts projects days weeks sessionSpread sessionPage snapshots report deviceId deviceName catalog',
  'usage/review/session': 'title turns report summary',
  'usage/ledger/pending': 'deviceId deviceName platform remoteSince remoteAfter records upto more',
  'usage/ledger/ack': 'hubSent',
  'usage/ledger/import': 'imported',
  'wakatime/status': 'enabled cli lastSent lastError apiKey apiUrl today',
  'chat/allow-blocked': '',
  'chat/approve': '',
  'chat/branch': '',
  'chat/close': '',
  'chat/interrupt': '',
  'chat/reset': '',
  'chat/retry': '',
  'chat/rewind': '',
  'chat/set': '',
  'chat/stop-task': '',
  'chat/warm': '',
  'files/create': '',
  'files/delete': '',
  'files/move': '',
  'git/checkout': '',
  'git/worktree-setting': '',
  'git/worktree/integrate': '',
  'project/close': '',
  'terminal/close': '',
  'ui': '',
  'ui/layout': '',
  'wakatime/config': '',
  'chat/btw-cancel': 'cancelled',
  'chat/cancel-steer': 'cancelled',
  'chat/model-catalog': 'models catalog configOptions',
  'chat/btw': 'ok text costUsd tokens model durationMs cancelled error',
  'chat/send': 'steered queued',
  readiness: 'claude codex pty',
  'chat/rename': 'title',
  'chat/shell': 'id',
  'chat/shell-skip': 'ok',
  'chat/shell-stop': 'stopped',
  'chat/spend': 'spent',
  'chat/stats': 'sessionId source tokensAvailable contextAvailable requests subRequests turns outcomes compactions compactionAt startedAt endedAt activeMs tokens cacheHitRate peakContext cost models tools toolCalls timeline turnSeries subagents blocks spentSince report',
  'chat/to-terminal': 'agent restoreId cwd configDir',
  'dialog/folder': 'path',
  'files/copy': 'created',
  'files/directory': 'entries',
  'files/list': 'files',
  'files/read': 'file',
  'files/upload': 'path',
  'files/write': 'file conflict',
  'fs/folders': 'path parent folders sep',
  'git/branches': 'branches',
  'git/commit-details': 'sha parents parent author email authorTime committer committerEmail commitTime message files',
  'git/commit-file': 'original modified note',
  'git/compare': 'files',
  'git/log': 'signature unchanged state head refs commits truncated limit me remotes urls',
  'git/patch': 'patch',
  'git/paths': 'hashes',
  'git/status': 'branch changes clean additions deletions',
  home: 'path',
  'ide/resolve': 'path editor',
  'picker/parent': 'path',
  'shell/list': 'shells default',
  'system/info': 'cpu cores memory uptime platform hostname',
  'terminal/follow-up': 'accepted',
  'terminal/open': 'id command',
  'terminal/session': 'sessionId',
  'ui/file': 'path type csp cache hash encoding data',
  'ui/manifest': 'version entry csp files preload encoding data'
}));
export function result(action, value) {
  if (snapshotActions.has(action)) return snapshot(value);
  if (action === 'chat/peers') return map(value, item => pick(item, 'id projectId project agent sessionId title status cwd permissionMode'));
  if (action === 'chat/open') {
    const out = pick(value, 'id agent user events state seq replace approvals');
    if (out?.state) out.state = chatState(out.state);
    if (Array.isArray(out?.events)) out.events = out.events.map(chatEvent).filter(Boolean);
    if (out?.approvals) out.approvals = map(out.approvals, item => pick(item, 'kind phase requestId tool input toolUseId suggestions questions exists mcp allow'));
    return out;
  }
  if (action === 'app/state') return appState(value);
  if (action === 'recent' || action === 'recent/remove' || action === 'recent/pin') return map(value, item => pick(item, 'id root name openedAt pinned multiRepo lastOpenedAt at'));
  if (action === 'chat/cursor-sessions' || action === 'terminal/chat-sessions' || action === 'chat/cli-sessions' || action === 'chat/sessions') {
    return map(value, item => pick(item, 'id sessionId title updatedAt running chatId cwd model agent startedAt imported exact file'));
  }
  if (action === 'agent-keys/status' || action === 'agent-keys/config') {
    const out = pick(value, 'claude codex cursor cacheTtl');
    for (const agent of ['claude', 'codex', 'cursor']) if (out?.[agent]) out[agent] = pick(out[agent], 'use key');
    return out;
  }
  if (action.startsWith('feedback/')) return feedbackResult(action, value);
  if (action === 'chat/commands') return map(value, item => pick(item, 'name description hint'));
  const names = resultFields.get(action);
  return names === undefined ? value : pick(value, names);
}
