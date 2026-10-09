import { fault } from './files.js';

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
      if (value.kind !== undefined && !['terminal', 'editor'].includes(value.kind)) invalid();
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
  if (!Array.isArray(ui.tabs) || ui.tabs.length > 30) invalid();
  for (const tab of ui.tabs) {
    if (!tab || typeof tab.path !== 'string' || !tab.path || tab.path.length > 8192 || typeof tab.revision !== 'string') invalid();
    if (tab.draft !== undefined && (typeof tab.draft !== 'string' || Buffer.byteLength(tab.draft) > 2 * 1024 * 1024)) invalid();
  }
  if (ui.settings !== undefined) {
    const { settings } = ui;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || JSON.stringify(settings).length > 4096) invalid();
    if (settings.theme !== undefined && !['dark', 'light'].includes(settings.theme)) invalid();
    if (settings.autoSave !== undefined && !['off', 'afterDelay'].includes(settings.autoSave)) invalid();
    for (const name of ['fontSize', 'tabSize']) if (settings[name] !== undefined && !(Number.isInteger(settings[name]) && settings[name] >= 1 && settings[name] <= 72)) invalid();
    for (const name of ['wordWrap', 'minimap']) if (settings[name] !== undefined && typeof settings[name] !== 'boolean') invalid();
  }
  if (ui.side !== undefined && !['files', 'search', 'git', 'ai', 'settings'].includes(ui.side)) invalid();
  for (const name of ['sideVisible', 'panelVisible']) if (ui[name] !== undefined && typeof ui[name] !== 'boolean') invalid();
  if (ui.panelTab !== undefined && !['terminal', 'problems'].includes(ui.panelTab)) invalid();
  return ui;
}
