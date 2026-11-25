// The preload of a remote window (the other PC's ADE shown here, remote.js). It gives the page exactly what the phone app's WebView
// gets: `AdeRemoteNative`, the message channel to this app, which relays everything over the encrypted link (docs/REMOTE_UI.md).
// There is no `adeDesktop` here: the page is the other PC's UI, and a folder dialog, updates or plugin settings would act on THIS PC.
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
ipcRenderer.on('ade:remote-bridge:message', (_event, data) => { for (const listener of listeners) { try { listener({ data }); } catch { /* the page's own error */ } } });
contextBridge.exposeInMainWorld('AdeRemoteNative', {
  // Tells the page it runs in a desktop window, not a phone's: it draws the green frame and keeps its fonts.
  client: 'desktop',
  postMessage: text => {
    if (typeof text !== 'string') return;
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message?.k === 'copy' && !navigator.userActivation?.isActive) return;
    ipcRenderer.send('ade:remote-bridge:post', text);
  },
  addEventListener: (type, listener) => { if (type === 'message' && typeof listener === 'function') listeners.add(listener); }
});

let notice;
ipcRenderer.on('ade:remote-bridge:copied', () => {
  notice?.remove();
  const item = document.createElement('div');
  item.textContent = '클립보드에 복사했습니다.';
  item.setAttribute('role', 'status');
  item.style.cssText = 'position:fixed;bottom:16px;right:16px;padding:8px 12px;border-radius:6px;background:#222;color:white;z-index:2147483647;pointer-events:none';
  document.body?.append(item);
  notice = item;
  setTimeout(() => item.remove(), 1800);
});
