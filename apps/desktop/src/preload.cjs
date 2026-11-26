const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

// File.path was removed from Electron, so a dropped file's absolute path is only reachable through webUtils here.
// OSC 52 copies arrive while the window may be unfocused, where navigator.clipboard refuses to write.
// Plugins: the page can only read the state and start steps; turning them on, approving one and installing a zip are native dialogs.
const pluginCall = name => (...args) => ipcRenderer.invoke(`ade:plugins:${name}`, ...args);
const plugins = Object.fromEntries(['state', 'setEnabled', 'setBuiltin', 'rescan', 'approve', 'revoke', 'restart', 'action', 'setMcp', 'refreshTools', 'openFolder', 'pickZip', 'installZip', 'checkUpdates', 'installUpdate', 'setUpdateMode', 'connectGithub', 'disconnectGithub', 'signInGithub', 'cancelSignIn', 'probeGithub', 'selectGithubAccount', 'openTokenPage', 'signInHub', 'cancelHubSignIn', 'signOutHub', 'hubCatalog', 'hubInstall', 'usageSync', 'console'].map(name => [name, pluginCall(name)]));
plugins.onOpen = listener => {
  const handler = () => listener();
  ipcRenderer.on('ade:plugins-open', handler);
  return () => ipcRenderer.off('ade:plugins-open', handler);
};
// The console tab of a plugin that declared `console` (API v2): requests out, events back. Desktop window only.
plugins.consoleEvents = listener => {
  const handler = (_event, value) => listener(value);
  ipcRenderer.on('ade:plugins-console', handler);
  return () => ipcRenderer.off('ade:plugins-console', handler);
};
plugins.onState = listener => {
  const handler = (_event, state) => listener(state);
  ipcRenderer.on('ade:plugins-state', handler);
  return () => ipcRenderer.off('ade:plugins-state', handler);
};
// "다른 PC에 접속": the dialog in the main window only reads state and starts steps; every answer is { ok, value } or { ok:false, error }.
const remoteCall = name => async (...args) => {
  const answer = await ipcRenderer.invoke(`ade:remote:${name}`, ...args);
  if (!answer?.ok) throw Object.assign(new Error(answer?.error?.message ?? '요청이 실패했습니다.'), { code: answer?.error?.code ?? 'REMOTE_FAILED' });
  return answer.value;
};
const remote = Object.fromEntries(['state', 'signInStart', 'signInWait', 'signInCancel', 'signOut', 'hosts', 'offer', 'pair', 'forget', 'open'].map(name => [name, remoteCall(name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`))]));
const updates = {
  getAutoDownload: () => ipcRenderer.invoke('ade:get-auto-download-updates'),
  setAutoDownload: enabled => ipcRenderer.invoke('ade:set-auto-download-updates', enabled === true),
  getCountdownPosition: () => ipcRenderer.invoke('ade:get-update-countdown-position'),
  setCountdownPosition: position => ipcRenderer.invoke('ade:set-update-countdown-position', position),
  status: () => ipcRenderer.invoke('ade:update-status'),
  apply: () => ipcRenderer.invoke('ade:apply-downloaded-update'),
  onStatus(listener) {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on('ade:update-progress', handler);
    return () => ipcRenderer.off('ade:update-progress', handler);
  },
};
const moveDroppedFiles = async (files, projectId, dir, dirty) => {
  if (!Array.isArray(files) || !files.length || files.length > 500) throw new Error('한 번에 파일을 1개에서 500개까지 옮길 수 있습니다.');
  const paths = files.map(file => webUtils.getPathForFile(file));
  if (paths.some(path => !path)) throw new Error('파일 관리자에 있는 로컬 파일을 놓아 주세요.');
  const result = await ipcRenderer.invoke('ade:move-dropped-files', { paths, projectId, dir, dirty });
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('adeDesktop', { pickFolder: options => ipcRenderer.invoke('ade:pick-folder', options), appInfo: () => ipcRenderer.invoke('ade:app-info'), changelogStore: { getItem: key => ipcRenderer.sendSync('ade:changelog-get', String(key)), setItem: (key, value) => { ipcRenderer.sendSync('ade:changelog-set', String(key), String(value)); } }, checkUpdate: () => ipcRenderer.invoke('ade:check-update'), getBetaUpdates: () => ipcRenderer.invoke('ade:get-beta-updates'), setBetaUpdates: beta => ipcRenderer.invoke('ade:set-beta-updates', beta === true), getSystemCa: () => ipcRenderer.invoke('ade:system-ca:get'), setSystemCa: on => ipcRenderer.invoke('ade:system-ca:set', on === true), offerSystemCa: () => ipcRenderer.invoke('ade:system-ca:offer'), pathForFile: file => webUtils.getPathForFile(file), moveDroppedFiles, writeClipboard: text => ipcRenderer.send('ade:write-clipboard', String(text)), setZoom: percent => { if (Number.isFinite(percent)) webFrame.setZoomFactor(Math.min(1.5, Math.max(0.8, percent / 100))); }, zoomFactor: () => webFrame.getZoomFactor(), capture: rect => ipcRenderer.invoke('ade:capture', rect ?? null), plugins, remote, updates });

// macOS traffic lights overlay the page without supplying titlebar-area CSS env values.
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.style.setProperty('--desktop-titlebar-height', '40px');
    document.documentElement.style.setProperty('--desktop-controls-width', '80px');
  });
}
