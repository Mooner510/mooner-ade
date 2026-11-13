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
contextBridge.exposeInMainWorld('adeDesktop', { pickFolder: options => ipcRenderer.invoke('ade:pick-folder', options), appInfo: () => ipcRenderer.invoke('ade:app-info'), checkUpdate: () => ipcRenderer.invoke('ade:check-update'), getBetaUpdates: () => ipcRenderer.invoke('ade:get-beta-updates'), setBetaUpdates: beta => ipcRenderer.invoke('ade:set-beta-updates', beta === true), pathForFile: file => webUtils.getPathForFile(file), writeClipboard: text => ipcRenderer.send('ade:write-clipboard', String(text)), setZoom: percent => { if (Number.isFinite(percent)) webFrame.setZoomFactor(Math.min(1.5, Math.max(0.8, percent / 100))); }, zoomFactor: () => webFrame.getZoomFactor(), capture: rect => ipcRenderer.invoke('ade:capture', rect ?? null), plugins });

// Update progress on macOS ({ text, fraction|null }, null to remove), drawn over the page instead of in a window of its own (see updater.js).
ipcRenderer.on('ade:update-progress', (_event, progress) => {
  let box = document.getElementById('ade-update-progress');
  if (!progress) { box?.remove(); return; }
  if (!box) {
    box = document.createElement('div');
    box.id = 'ade-update-progress';
    box.setAttribute('role', 'status');
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;padding:14px 16px;border-radius:10px;background:#1e1f22;color:#e6e6e6;font:13px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);pointer-events:none';
    const text = document.createElement('div'), bar = document.createElement('div'), fill = document.createElement('div');
    text.style.marginBottom = '10px';
    bar.style.cssText = 'height:6px;border-radius:3px;background:#3a3c40;overflow:hidden';
    fill.style.cssText = 'height:100%;background:#4c8bf5;transition:width .15s';
    bar.append(fill); box.append(text, bar); document.body.append(box);
  }
  const [text, bar] = box.children, fill = bar.firstChild;
  text.textContent = String(progress.text ?? '');
  const fraction = typeof progress.fraction === 'number' ? progress.fraction : null;
  fill.style.width = fraction === null ? '100%' : `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  fill.style.opacity = fraction === null ? '.45' : '1';
});

// macOS traffic lights overlay the page without supplying titlebar-area CSS env values.
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.style.setProperty('--desktop-titlebar-height', '40px');
    document.documentElement.style.setProperty('--desktop-controls-width', '80px');
  });
}
