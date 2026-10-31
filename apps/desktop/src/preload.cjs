const { contextBridge, ipcRenderer, webUtils } = require('electron');

// File.path was removed from Electron, so a dropped file's absolute path is only reachable through webUtils here.
// OSC 52 copies arrive while the window may be unfocused, where navigator.clipboard refuses to write.
contextBridge.exposeInMainWorld('adeDesktop', { pickFolder: () => ipcRenderer.invoke('ade:pick-folder'), appInfo: () => ipcRenderer.invoke('ade:app-info'), checkUpdate: () => ipcRenderer.invoke('ade:check-update'), pathForFile: file => webUtils.getPathForFile(file), writeClipboard: text => ipcRenderer.send('ade:write-clipboard', String(text)) });

// macOS traffic lights overlay the page without supplying titlebar-area CSS env values.
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.style.setProperty('--desktop-titlebar-height', '40px');
    document.documentElement.style.setProperty('--desktop-controls-width', '80px');
  });
}
