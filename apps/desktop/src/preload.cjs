const { contextBridge, ipcRenderer, webUtils } = require('electron');

// File.path was removed from Electron, so a dropped file's absolute path is only reachable through webUtils here.
// OSC 52 copies arrive while the window may be unfocused, where navigator.clipboard refuses to write.
// Remote access: the page can only read the state and start steps; anything that grants access is confirmed in a native dialog.
const remoteCall = name => (...args) => ipcRenderer.invoke(`ade:remote:${name}`, ...args);
const remote = Object.fromEntries(['state', 'connect', 'cancelConnect', 'unlink', 'setEnabled', 'startPairing', 'cancelPairing', 'setScope', 'removeDevice', 'endSession', 'rotateKey'].map(name => [name, remoteCall(name)]));
remote.onState = listener => {
  const handler = (_event, state) => listener(state);
  ipcRenderer.on('ade:remote-state', handler);
  return () => ipcRenderer.off('ade:remote-state', handler);
};
contextBridge.exposeInMainWorld('adeDesktop', { pickFolder: options => ipcRenderer.invoke('ade:pick-folder', options), appInfo: () => ipcRenderer.invoke('ade:app-info'), checkUpdate: () => ipcRenderer.invoke('ade:check-update'), pathForFile: file => webUtils.getPathForFile(file), writeClipboard: text => ipcRenderer.send('ade:write-clipboard', String(text)), remote });

// macOS traffic lights overlay the page without supplying titlebar-area CSS env values.
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.style.setProperty('--desktop-titlebar-height', '40px');
    document.documentElement.style.setProperty('--desktop-controls-width', '80px');
  });
}
