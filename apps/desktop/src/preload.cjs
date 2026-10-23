const { contextBridge, ipcRenderer, webUtils } = require('electron');

// File.path was removed from Electron, so a dropped file's absolute path is only reachable through webUtils here.
contextBridge.exposeInMainWorld('adeDesktop', { pickFolder: () => ipcRenderer.invoke('ade:pick-folder'), pathForFile: file => webUtils.getPathForFile(file) });

// macOS traffic lights overlay the page without supplying titlebar-area CSS env values.
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.style.setProperty('--desktop-titlebar-height', '40px');
    document.documentElement.style.setProperty('--desktop-controls-width', '80px');
  });
}
