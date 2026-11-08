const { contextBridge, ipcRenderer, webUtils } = require('electron');

// File.path was removed from Electron, so a dropped file's absolute path is only reachable through webUtils here.
// OSC 52 copies arrive while the window may be unfocused, where navigator.clipboard refuses to write.
// Plugins: the page can only read the state and start steps; turning them on, approving one and installing a zip are native dialogs.
const pluginCall = name => (...args) => ipcRenderer.invoke(`ade:plugins:${name}`, ...args);
const plugins = Object.fromEntries(['state', 'setEnabled', 'rescan', 'approve', 'revoke', 'restart', 'action', 'openFolder', 'pickZip'].map(name => [name, pluginCall(name)]));
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
contextBridge.exposeInMainWorld('adeDesktop', { pickFolder: options => ipcRenderer.invoke('ade:pick-folder', options), appInfo: () => ipcRenderer.invoke('ade:app-info'), checkUpdate: () => ipcRenderer.invoke('ade:check-update'), pathForFile: file => webUtils.getPathForFile(file), writeClipboard: text => ipcRenderer.send('ade:write-clipboard', String(text)), plugins });

// macOS traffic lights overlay the page without supplying titlebar-area CSS env values.
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.style.setProperty('--desktop-titlebar-height', '40px');
    document.documentElement.style.setProperty('--desktop-controls-width', '80px');
  });
}
