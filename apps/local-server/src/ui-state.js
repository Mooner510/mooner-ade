import { fault } from './files.js';
import { validMcpTrust } from './mcp-trust.js';
import { validMinK } from './chat-idle-compact.js';

// Typed into the agent's launch line, so a newline or other control character would run a second command.
export const validAgentArgs = value => typeof value === 'string' && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);

function validateSettings(settings, invalid) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || JSON.stringify(settings).length > 32768) invalid();
  if (settings.theme !== undefined && (typeof settings.theme !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(settings.theme))) invalid();
  for (const name of ['fontSize', 'terminalFontSize']) if (settings[name] !== undefined && !(Number.isInteger(settings[name]) && settings[name] >= 1 && settings[name] <= 72)) invalid();
  for (const name of ['wordWrap', 'dimInactivePanes', 'cursorBlink', 'copyOnSelect', 'notifyDone', 'notifyApproval', 'notifySound', 'soundVolumeExtended', 'wakatime', 'wakatimeBackground', 'usageColors', 'claudeSession', 'notifyLooking', 'cacheTimer', 'cacheSendWarn', 'tips', 'followUpQueue', 'interactiveUi', 'artifactAlways', 'rightClickPaste', 'optionAsMeta', 'confirmClose', 'boldBright', 'terminalGpu', 'diffIgnoreWhitespace', 'diffFoldUnchanged', 'clock12h', 'clockSeconds', 'onboarded', 'chatTipPending', 'chatToolsOpen', 'chatAutoScroll', 'chatSmoothStream', 'sidebarCompact', 'animateInBackground', 'confirmCloseChat', 'confirmCloseProject', 'chatPermissionAutoSet', 'feedbackAgentTool', 'feedbackAiContext', 'chatDarker', 'idleCompact']) if (settings[name] !== undefined && typeof settings[name] !== 'boolean') invalid();
  if (settings.feedbackAiModel !== undefined && !['', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'sonnet', 'opus'].includes(settings.feedbackAiModel)) invalid();
  if (settings.feedbackAiEffort !== undefined && !['', 'low', 'medium', 'high'].includes(settings.feedbackAiEffort)) invalid();
  if (settings.usageStyle !== undefined && !['bar', 'text'].includes(settings.usageStyle)) invalid();
  if (settings.usageShown !== undefined) {
    // Older clients can still submit saved Opus and Sonnet meter IDs.
    const meters = { claude: ['session', 'weekly', 'fable', 'weekly-opus', 'weekly-sonnet', 'credit'], codex: ['session', 'weekly', 'credit'], cursor: ['auto', 'api', 'total', 'grok', 'on-demand'] };
    const shown = settings.usageShown;
    if (!shown || typeof shown !== 'object' || Array.isArray(shown)) invalid();
    for (const [provider, list] of Object.entries(shown)) {
      const allowed = meters[provider];
      if (!allowed || !Array.isArray(list) || list.length > allowed.length || list.some(id => typeof id !== 'string' || !allowed.includes(id) || list.indexOf(id) !== list.lastIndexOf(id))) invalid();
    }
  }
  if (settings.mcpTrust !== undefined && !validMcpTrust(settings.mcpTrust)) invalid();
  if (settings.defaultMode !== undefined && !['chat', 'cli'].includes(settings.defaultMode)) invalid();
  if (settings.cursorStyle !== undefined && !['bar', 'block', 'underline'].includes(settings.cursorStyle)) invalid();
  if (settings.sidebarWidth !== undefined && !(Number.isInteger(settings.sidebarWidth) && settings.sidebarWidth >= 160 && settings.sidebarWidth <= 480)) invalid();
  if (settings.scrollback !== undefined && !(Number.isInteger(settings.scrollback) && settings.scrollback >= 500 && settings.scrollback <= 100000)) invalid();
  if (settings.lineHeight !== undefined && !(typeof settings.lineHeight === 'number' && settings.lineHeight >= 1 && settings.lineHeight <= 2)) invalid();
  if (settings.diffRefresh !== undefined && !(Number.isInteger(settings.diffRefresh) && settings.diffRefresh >= 1 && settings.diffRefresh <= 60)) invalid();
  if (settings.soundVolume !== undefined && !(Number.isInteger(settings.soundVolume) && settings.soundVolume >= 0 && settings.soundVolume <= (settings.soundVolumeExtended === true ? 200 : 100))) invalid();
  for (const name of ['soundDone', 'soundAttention']) if (settings[name] !== undefined && !(typeof settings[name] === 'string' && /^[a-z]{1,16}$/.test(settings[name]))) invalid();
  if (settings.terminalFont !== undefined && !(typeof settings.terminalFont === 'string' && settings.terminalFont.length <= 200)) invalid();
  if (settings.terminalShell !== undefined && !(typeof settings.terminalShell === 'string' && settings.terminalShell.length <= 512)) invalid();
  for (const name of ['claudeArgs', 'codexArgs', 'cursorArgs']) if (settings[name] !== undefined && !validAgentArgs(settings[name])) invalid();
  if (settings.idleCompactMinK !== undefined && !validMinK(settings.idleCompactMinK)) invalid();
  if (settings.cacheWarn !== undefined && !(Number.isInteger(settings.cacheWarn) && settings.cacheWarn >= 5 && settings.cacheWarn <= 50)) invalid();
  if (settings.cacheSendWarnMinutes !== undefined && !(Number.isInteger(settings.cacheSendWarnMinutes) && settings.cacheSendWarnMinutes >= 1 && settings.cacheSendWarnMinutes <= 60)) invalid();
  if (settings.usageRefresh !== undefined && !(Number.isInteger(settings.usageRefresh) && settings.usageRefresh >= 60 && settings.usageRefresh <= 600)) invalid();
  if (settings.accentColor !== undefined && !(typeof settings.accentColor === 'string' && /^(#[0-9a-fA-F]{6})?$/.test(settings.accentColor))) invalid();
  if (settings.terminalFontWeight !== undefined && !(Number.isInteger(settings.terminalFontWeight) && settings.terminalFontWeight >= 100 && settings.terminalFontWeight <= 900)) invalid();
  if (settings.wordSeparator !== undefined && !(typeof settings.wordSeparator === 'string' && settings.wordSeparator.length <= 64)) invalid();
  if (settings.diffLayout !== undefined && !['auto', 'inline', 'split'].includes(settings.diffLayout)) invalid();
  for (const [name, min, max, whole] of [['letterSpacing', 0, 5, true], ['scrollSensitivity', 0.5, 5, false], ['minimumContrast', 1, 21, false], ['diffContextLines', 1, 20, true], ['contextTipK', 50, 1000, true], ['systemRefresh', 2, 60, true], ['reviewWidth', 320, 1600, true], ['tourVersion', 0, 1000, true]])
    if (settings[name] !== undefined && !(typeof settings[name] === 'number' && settings[name] >= min && settings[name] <= max && (!whole || Number.isInteger(settings[name])))) invalid();
  for (const name of ['agentsOff', 'agentsMuted']) if (settings[name] !== undefined && !(Array.isArray(settings[name]) && settings[name].length <= 8 && settings[name].every(item => ['claude', 'codex', 'cursor'].includes(item)))) invalid();
  for (const name of ['chatKeys', 'appKeys']) if (settings[name] !== undefined && !(settings[name] && typeof settings[name] === 'object' && !Array.isArray(settings[name]) && Object.entries(settings[name]).length <= (name === 'appKeys' ? 64 : 16)
    && Object.entries(settings[name]).every(([id, combo]) => /^[a-zA-Z][a-zA-Z0-9]{0,23}$/.test(id) && typeof combo === 'string' && /^[a-z0-9+\[\]\\,.;'`=/-]{1,48}$/.test(combo)))) invalid();
  if (settings.termKeys !== undefined && !(settings.termKeys && typeof settings.termKeys === 'object' && !Array.isArray(settings.termKeys) && Object.entries(settings.termKeys).length <= 64
    && Object.entries(settings.termKeys).every(([id, on]) => /^[a-zA-Z][a-zA-Z0-9]{0,23}$/.test(id) && typeof on === 'boolean'))) invalid();
  for (const name of ['statusItems', 'statusLeft', 'statusRight', 'chatStatusItems', 'chatStatusLeft', 'chatStatusRight', 'hintsSeen']) if (settings[name] !== undefined && !(Array.isArray(settings[name]) && settings[name].length <= 32 && settings[name].every(item => typeof item === 'string' && /^[a-z]{1,16}$/.test(item)))) invalid();
  if (settings.chatStatusSeparator !== undefined && !(typeof settings.chatStatusSeparator === 'string' && settings.chatStatusSeparator.length <= 8)) invalid();
  // bypassPermissions is deliberately not a valid default: it must be chosen per chat, never inherited.
  for (const [name, values] of [['chatSendKey', ['enter', 'mod-enter']], ['chatThinkingOpen', ['live', 'always', 'never']], ['chatToolDisplay', ['summary', 'detail']], ['chatWidth', ['narrow', 'default', 'wide', 'full']], ['chatDefaultPermission', ['cli', 'default', 'acceptEdits', 'plan', 'auto']],
    ['chatDefaultEffort', ['auto', 'low', 'medium', 'high', 'xhigh', 'max']], ['terminalBell', ['off', 'visual', 'sound']]]) if (settings[name] !== undefined && !values.includes(settings[name])) invalid();
  for (const [name, min, max] of [['chatFontSize', 11, 20], ['chatComposerMax', 120, 600], ['uiZoom', 80, 150], ['diffComputeMs', 1000, 20000]])
    if (settings[name] !== undefined && !(Number.isInteger(settings[name]) && settings[name] >= min && settings[name] <= max)) invalid();
  if (settings.diffFont !== undefined && !(typeof settings.diffFont === 'string' && settings.diffFont.length <= 200)) invalid();
  // Git tool window
  for (const name of ['gitLogDock', 'gitLinear', 'gitFirstParent', 'gitNoMerges', 'gitCompactRefs', 'gitTagNames', 'gitLongEdges', 'gitCommitTime', 'gitRefsLeft', 'gitMine', 'gitMerges', 'gitCurrent', 'gitPrettyDate', 'gitDetails', 'gitDiffPreview', 'gitFilesByDir', 'gitBranchesPane', 'gitBranchDirs', 'gitBranchTags', 'gitFetchPrune', 'gitTipPending'])
    if (settings[name] !== undefined && typeof settings[name] !== 'boolean') invalid();
  for (const [name, min, max] of [['gitLogHeight', 120, 2000], ['gitLogLimit', 1000, 50000], ['gitBranchesWidth', 120, 800], ['gitDetailsWidth', 200, 1200], ['gitSaturation', 0, 100], ['gitBrightness', 20, 100]])
    if (settings[name] !== undefined && !(Number.isInteger(settings[name]) && settings[name] >= min && settings[name] <= max)) invalid();
  for (const [name, values] of [['gitSort', ['date', 'topo']], ['gitBranchClick', ['none', 'filter', 'navigate']], ['gitUpdateMethod', ['merge', 'rebase']]]) if (settings[name] !== undefined && !values.includes(settings[name])) invalid();
  if (settings.gitColumns !== undefined && !(Array.isArray(settings.gitColumns) && settings.gitColumns.length <= 3 && settings.gitColumns.every(item => ['author', 'date', 'hash'].includes(item)))) invalid();
  if (settings.gitFavorites !== undefined && !(Array.isArray(settings.gitFavorites) && settings.gitFavorites.length <= 64 && settings.gitFavorites.every(item => typeof item === 'string' && item.length <= 250))) invalid();
  if (settings.gitProtected !== undefined && !(typeof settings.gitProtected === 'string' && settings.gitProtected.length <= 500)) invalid();
  if (settings.chatModelPins !== undefined) {
    if (!settings.chatModelPins || typeof settings.chatModelPins !== 'object' || Array.isArray(settings.chatModelPins)) invalid();
    if (Object.keys(settings.chatModelPins).length > 3) invalid();
    for (const [agent, list] of Object.entries(settings.chatModelPins)) {
      if (!['claude', 'codex', 'cursor'].includes(agent)) invalid();
      if (!Array.isArray(list) || list.length > 32 || list.some(item => typeof item !== 'string' || item.length > 128)) invalid();
    }
  }
}

// App-wide state: which projects are open, which one is active, and settings shared by every project.
export function validateAppState(state) {
  const invalid = () => { throw fault('INVALID_INPUT', '잘못된 앱 상태입니다.'); };
  if (!state || typeof state !== 'object' || Array.isArray(state)) invalid();
  if (!Array.isArray(state.openProjects) || state.openProjects.length > 64) invalid();
  const ids = new Set();
  for (const item of state.openProjects) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 128 || ids.has(item.id)) invalid();
    if (typeof item.root !== 'string' || !item.root || item.root.length > 8192) invalid();
    ids.add(item.id);
  }
  if (typeof state.activeProjectId !== 'string' || state.activeProjectId.length > 128 || (state.activeProjectId && !ids.has(state.activeProjectId))) invalid();
  if (state.settings !== undefined && state.settings !== null) validateSettings(state.settings, invalid);
  return { version: 1, openProjects: state.openProjects.map(({ id, root }) => ({ id, root })), activeProjectId: state.activeProjectId, settings: state.settings ?? null };
}

// The tab/pane layout every device shares: a tab created on the phone shows on the PC and the other way round (docs/REMOTE_UI.md).
export function validateLayout(paneTabs, invalid = () => { throw fault('INVALID_INPUT', '잘못된 화면 상태입니다.'); }) {
  function sizes(values, count) {
    if (!Array.isArray(values) || values.length !== count || values.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)) invalid();
  }
  function pane(value, ids, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 16) invalid();
    if ('id' in value) {
      if (typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(value.id) || ids.has(value.id)) invalid();
      ids.add(value.id); if (ids.size > 32) invalid();
      if (value.kind !== undefined && !['terminal', 'editor', 'launcher', 'chat'].includes(value.kind)) invalid();
      if (value.cwd !== undefined && (typeof value.cwd !== 'string' || value.cwd.length > 8192)) invalid();
      if (value.agent !== undefined && !['claude', 'codex', 'cursor'].includes(value.agent)) invalid();
      if (value.kind === 'editor') {
        if (!Array.isArray(value.tabs) || value.tabs.length > 30 || value.tabs.some(tab => typeof tab !== 'string' || !/^(diff:|file:.+)/s.test(tab) || tab.length > 8192)) invalid();
        if (value.active !== undefined && (typeof value.active !== 'string' || value.active.length > 8192)) invalid();
      }
    } else {
      if (!['row', 'column'].includes(value.direction) || !Array.isArray(value.children) || value.children.length < 1 || value.children.length > 32) invalid();
      sizes(value.sizes, value.children.length); value.children.forEach(child => pane(child, ids, depth + 1));
    }
  }
  // Warp-style tabs: each tab owns a pane tree.
  if (!Array.isArray(paneTabs) || paneTabs.length > 16) invalid();
  const tabIds = new Set();
  for (const tab of paneTabs) {
    if (!tab || typeof tab !== 'object' || typeof tab.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(tab.id) || tabIds.has(tab.id)) invalid();
    tabIds.add(tab.id);
    if (tab.title !== undefined && (typeof tab.title !== 'string' || tab.title.length > 200)) invalid();
    if (tab.focus !== undefined && (typeof tab.focus !== 'string' || tab.focus.length > 128)) invalid();
    if (tab.pane !== null) pane(tab.pane, new Set());
  }
  return paneTabs.map(({ id, title, focus, pane }) => ({ id, ...(title !== undefined && { title }), ...(focus !== undefined && { focus }), pane }));
}

// The project layout the UI saves; only these fields are kept, so nothing unvalidated reaches state.json.
export function validateUi(ui) {
  const invalid = () => { throw fault('INVALID_INPUT', '잘못된 화면 상태입니다.'); };
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) invalid();
  if (typeof ui.gitRepositoryId !== 'string' || ui.gitRepositoryId.length > 128) invalid();
  if (typeof ui.focus !== 'string' || ui.focus.length > 8192) invalid();
  const paneTabs = validateLayout(ui.paneTabs, invalid);
  if (typeof ui.activeTab !== 'string' || ui.activeTab.length > 128) invalid();
  if (typeof ui.rightVisible !== 'boolean') invalid();
  const expanded = ui.projectTreeExpanded;
  if (expanded !== undefined && (!Array.isArray(expanded) || expanded.some(path => typeof path !== 'string' || !path || path.length > 8192 || path.includes('\0')))) invalid();
  return {
    gitRepositoryId: ui.gitRepositoryId, focus: ui.focus, activeTab: ui.activeTab, rightVisible: ui.rightVisible,
    ...(expanded !== undefined && { projectTreeExpanded: [...new Set(expanded)] }),
    paneTabs
  };
}
