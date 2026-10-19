const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adeDesktop', { pickFolder: () => ipcRenderer.invoke('ade:pick-folder') });
