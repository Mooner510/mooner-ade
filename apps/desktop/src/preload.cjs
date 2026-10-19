const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adeDesktop', { pickFolder: () => ipcRenderer.invoke('ade:pick-folder') });

// macOS traffic lights overlay the page without supplying titlebar-area CSS env values.
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.style.setProperty('--desktop-titlebar-height', '40px');
    document.documentElement.style.setProperty('--desktop-controls-width', '80px');
  });
}
