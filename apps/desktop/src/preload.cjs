const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

// File.path was removed from Electron, so a dropped file's absolute path is only reachable through webUtils here.
// OSC 52 copies arrive while the window may be unfocused, where navigator.clipboard refuses to write.
// Plugins: the page can only read the state and start steps; turning them on, approving one and installing a zip are native dialogs.
const pluginCall = name => (...args) => ipcRenderer.invoke(`ade:plugins:${name}`, ...args);
const plugins = Object.fromEntries(['state', 'setEnabled', 'setBuiltin', 'rescan', 'approve', 'revoke', 'restart', 'action', 'setMcp', 'refreshTools', 'openFolder', 'pickZip', 'installZip'].map(name => [name, pluginCall(name)]));
plugins.onOpen = listener => {
  const handler = () => listener();
  ipcRenderer.on('ade:plugins-open', handler);
  return () => ipcRenderer.off('ade:plugins-open', handler);
};
plugins.onState = listener => {
  const handler = (_event, state) => listener(state);
  ipcRenderer.on('ade:plugins-state', handler);
  return () => ipcRenderer.off('ade:plugins-state', handler);
};
contextBridge.exposeInMainWorld('adeDesktop', { pickFolder: options => ipcRenderer.invoke('ade:pick-folder', options), appInfo: () => ipcRenderer.invoke('ade:app-info'), checkUpdate: () => ipcRenderer.invoke('ade:check-update'), getBetaUpdates: () => ipcRenderer.invoke('ade:get-beta-updates'), setBetaUpdates: beta => ipcRenderer.invoke('ade:set-beta-updates', beta === true), pathForFile: file => webUtils.getPathForFile(file), writeClipboard: text => ipcRenderer.send('ade:write-clipboard', String(text)), setZoom: percent => { if (Number.isFinite(percent)) webFrame.setZoomFactor(Math.min(1.5, Math.max(0.8, percent / 100))); }, plugins });

// macOS traffic lights overlay the page without supplying titlebar-area CSS env values.
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.style.setProperty('--desktop-titlebar-height', '40px');
    document.documentElement.style.setProperty('--desktop-controls-width', '80px');
  });
}
