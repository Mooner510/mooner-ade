import { fault } from './files.js';

function validateSettings(settings, invalid) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || JSON.stringify(settings).length > 4096) invalid();
  if (settings.theme !== undefined && !['dark', 'light'].includes(settings.theme)) invalid();
  if (settings.autoSave !== undefined && !['off', 'afterDelay'].includes(settings.autoSave)) invalid();
  for (const name of ['fontSize', 'tabSize', 'terminalFontSize']) if (settings[name] !== undefined && !(Number.isInteger(settings[name]) && settings[name] >= 1 && settings[name] <= 72)) invalid();
  for (const name of ['wordWrap', 'minimap', 'dimInactivePanes', 'cursorBlink', 'copyOnSelect', 'notifyDone', 'notifyApproval', 'notifySound', 'soundVolumeExtended', 'compactSidebar', 'ignoreWhitespace']) if (settings[name] !== undefined && typeof settings[name] !== 'boolean') invalid();
  if (settings.cursorStyle !== undefined && !['bar', 'block', 'underline'].includes(settings.cursorStyle)) invalid();
  if (settings.sidebarWidth !== undefined && !(Number.isInteger(settings.sidebarWidth) && settings.sidebarWidth >= 160 && settings.sidebarWidth <= 480)) invalid();
  if (settings.scrollback !== undefined && !(Number.isInteger(settings.scrollback) && settings.scrollback >= 500 && settings.scrollback <= 100000)) invalid();
  if (settings.lineHeight !== undefined && !(typeof settings.lineHeight === 'number' && settings.lineHeight >= 1 && settings.lineHeight <= 2)) invalid();
  if (settings.diffRefresh !== undefined && !(Number.isInteger(settings.diffRefresh) && settings.diffRefresh >= 1 && settings.diffRefresh <= 60)) invalid();
  if (settings.soundVolume !== undefined && !(Number.isInteger(settings.soundVolume) && settings.soundVolume >= 0 && settings.soundVolume <= (settings.soundVolumeExtended === true ? 200 : 100))) invalid();
  for (const name of ['soundDone', 'soundAttention']) if (settings[name] !== undefined && !(typeof settings[name] === 'string' && /^[a-z]{1,16}$/.test(settings[name]))) invalid();
  if (settings.terminalFont !== undefined && !(typeof settings.terminalFont === 'string' && settings.terminalFont.length <= 200)) invalid();
  if (settings.statusItems !== undefined && !(Array.isArray(settings.statusItems) && settings.statusItems.length <= 16 && settings.statusItems.every(item => typeof item === 'string' && /^[a-z]{1,16}$/.test(item)))) invalid();
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

export function validateUi(ui) {
  const invalid = () => { throw fault('INVALID_INPUT', '잘못된 화면 상태입니다.'); };
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) invalid();
  if (ui.viewMode !== undefined && !['ade', 'ide'].includes(ui.viewMode)) invalid();
  if (ui.gitRepositoryId !== undefined && (typeof ui.gitRepositoryId !== 'string' || ui.gitRepositoryId.length > 128)) invalid();
  for (const name of ['activeFile', 'conversationId', 'workspaceId', 'focus']) if (typeof ui[name] !== 'string' || ui[name].length > 8192) invalid();
  function sizes(values, count) {
    if (!Array.isArray(values) || values.length !== count || values.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)) invalid();
  }
  if (!Array.isArray(ui.widths) || ![2, 3].includes(ui.widths.length)) invalid();
  sizes(ui.widths, ui.widths.length); sizes(ui.heights, 2);
  function pane(value, ids, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 16) invalid();
    if ('id' in value) {
      if (typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(value.id) || ids.has(value.id)) invalid();
      ids.add(value.id); if (ids.size > 32) invalid();
      if (value.kind !== undefined && !['terminal', 'editor', 'launcher'].includes(value.kind)) invalid();
      if (value.cwd !== undefined && (typeof value.cwd !== 'string' || value.cwd.length > 8192)) invalid();
      if (value.agent !== undefined && !['claude', 'codex'].includes(value.agent)) invalid();
      if (value.kind === 'editor') {
        if (!Array.isArray(value.tabs) || value.tabs.length > 30 || value.tabs.some(tab => typeof tab !== 'string' || !tab || tab.length > 8192)) invalid();
        if (value.active !== undefined && (typeof value.active !== 'string' || value.active.length > 8192)) invalid();
      }
    } else {
      if (!['row', 'column'].includes(value.direction) || !Array.isArray(value.children) || value.children.length < 1 || value.children.length > 32) invalid();
      sizes(value.sizes, value.children.length); value.children.forEach(child => pane(child, ids, depth + 1));
    }
  }
  if (ui.pane !== null) pane(ui.pane, new Set());
  for (const name of ['editorPane', 'panelPane']) if (ui[name] !== undefined && ui[name] !== null) pane(ui[name], new Set());
  // Warp-style tabs: each tab owns a pane tree; `pane` mirrors the active tab for older clients.
  if (ui.paneTabs !== undefined) {
    if (!Array.isArray(ui.paneTabs) || ui.paneTabs.length > 16) invalid();
    const tabIds = new Set();
    for (const tab of ui.paneTabs) {
      if (!tab || typeof tab !== 'object' || typeof tab.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(tab.id) || tabIds.has(tab.id)) invalid();
      tabIds.add(tab.id);
      if (tab.title !== undefined && (typeof tab.title !== 'string' || tab.title.length > 200)) invalid();
      if (tab.pane !== null) pane(tab.pane, new Set());
    }
  }
  if (ui.activeTab !== undefined && (typeof ui.activeTab !== 'string' || ui.activeTab.length > 128)) invalid();
  if (ui.rightVisible !== undefined && typeof ui.rightVisible !== 'boolean') invalid();
  if (ui.rightTab !== undefined && !['review', 'agent'].includes(ui.rightTab)) invalid();
  if (!Array.isArray(ui.tabs) || ui.tabs.length > 30) invalid();
  for (const tab of ui.tabs) {
    if (!tab || typeof tab.path !== 'string' || !tab.path || tab.path.length > 8192 || typeof tab.revision !== 'string') invalid();
    if (tab.draft !== undefined && (typeof tab.draft !== 'string' || Buffer.byteLength(tab.draft) > 2 * 1024 * 1024)) invalid();
  }
  if (ui.settings !== undefined) validateSettings(ui.settings, invalid);
  if (ui.side !== undefined && !['files', 'search', 'git', 'ai', 'settings'].includes(ui.side)) invalid();
  for (const name of ['sideVisible', 'panelVisible']) if (ui[name] !== undefined && typeof ui[name] !== 'boolean') invalid();
  if (ui.panelTab !== undefined && !['terminal', 'problems'].includes(ui.panelTab)) invalid();
  return ui;
}
