const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

// File.path was removed from Electron, so a dropped file's absolute path is only reachable through webUtils here.
// OSC 52 copies arrive while the window may be unfocused, where navigator.clipboard refuses to write.
// Plugins: the page can only read the state and start steps; turning them on, approving one and installing a zip are native dialogs.
const pluginCall = name => (...args) => ipcRenderer.invoke(`ade:plugins:${name}`, ...args);
const plugins = Object.fromEntries(['state', 'setEnabled', 'setBuiltin', 'rescan', 'approve', 'revoke', 'restart', 'action', 'setMcp', 'refreshTools', 'openFolder', 'pickZip', 'installZip', 'checkUpdates', 'installUpdate', 'setUpdateMode', 'connectGithub', 'disconnectGithub', 'signInGithub', 'cancelSignIn', 'probeGithub', 'selectGithubAccount', 'openTokenPage', 'signInHub', 'cancelHubSignIn', 'signOutHub', 'hubCatalog', 'hubInstall'].map(name => [name, pluginCall(name)]));
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
// "다른 PC에 접속": the dialog in the main window only reads state and starts steps; every answer is { ok, value } or { ok:false, error }.
const remoteCall = name => async (...args) => {
  const answer = await ipcRenderer.invoke(`ade:remote:${name}`, ...args);
  if (!answer?.ok) throw Object.assign(new Error(answer?.error?.message ?? '요청이 실패했습니다.'), { code: answer?.error?.code ?? 'REMOTE_FAILED' });
  return answer.value;
};
const remote = Object.fromEntries(['state', 'signInStart', 'signInWait', 'signInCancel', 'signOut', 'hosts', 'offer', 'pair', 'forget', 'open'].map(name => [name, remoteCall(name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`))]));
contextBridge.exposeInMainWorld('adeDesktop', { pickFolder: options => ipcRenderer.invoke('ade:pick-folder', options), appInfo: () => ipcRenderer.invoke('ade:app-info'), changelogStore: { getItem: key => ipcRenderer.sendSync('ade:changelog-get', String(key)), setItem: (key, value) => { ipcRenderer.sendSync('ade:changelog-set', String(key), String(value)); } }, checkUpdate: () => ipcRenderer.invoke('ade:check-update'), getBetaUpdates: () => ipcRenderer.invoke('ade:get-beta-updates'), setBetaUpdates: beta => ipcRenderer.invoke('ade:set-beta-updates', beta === true), getSystemCa: () => ipcRenderer.invoke('ade:system-ca:get'), setSystemCa: on => ipcRenderer.invoke('ade:system-ca:set', on === true), offerSystemCa: () => ipcRenderer.invoke('ade:system-ca:offer'), pathForFile: file => webUtils.getPathForFile(file), writeClipboard: text => ipcRenderer.send('ade:write-clipboard', String(text)), setZoom: percent => { if (Number.isFinite(percent)) webFrame.setZoomFactor(Math.min(1.5, Math.max(0.8, percent / 100))); }, zoomFactor: () => webFrame.getZoomFactor(), capture: rect => ipcRenderer.invoke('ade:capture', rect ?? null), plugins, remote });

// The modal top layer dims the whole app and blocks background mouse/keyboard input until the update ends.
ipcRenderer.on('ade:update-progress', (_event, progress) => {
  let box = document.getElementById('ade-update-progress');
  if (!progress) { box?.close(); box?.remove(); return; }
  if (!box) {
    box = document.createElement('dialog');
    box.id = 'ade-update-progress';
    box.setAttribute('aria-labelledby', 'ade-update-title');
    box.setAttribute('aria-describedby', 'ade-update-text');
    box.style.cssText = 'position:fixed;inset:0;margin:0;width:100%;height:100%;max-width:none;max-height:none;box-sizing:border-box;border:0;border-radius:0;box-shadow:none;animation:none;padding:24px;background:rgba(0,0,0,.68);color:#e6e6e6;display:grid;place-items:center;font:13px system-ui,sans-serif;-webkit-app-region:no-drag';
    box.addEventListener('cancel', event => event.preventDefault());
    box.addEventListener('keydown', event => { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); });
    const style = document.createElement('style');
    style.textContent = '#ade-update-progress::backdrop{background:transparent;animation:none}';
    const panel = document.createElement('div'), title = document.createElement('div');
    panel.style.cssText = 'box-sizing:border-box;width:min(400px,calc(100vw - 48px));padding:28px;border:1px solid #3a3c40;border-radius:16px;background:#1e1f22;box-shadow:0 24px 80px rgba(0,0,0,.5)';
    title.id = 'ade-update-title';
    title.textContent = '업데이트 중';
    title.style.cssText = 'font-size:18px;font-weight:600;margin-bottom:14px';
    const text = document.createElement('div'), bar = document.createElement('div'), fill = document.createElement('div'), percent = document.createElement('div');
    text.id = 'ade-update-text';
    text.setAttribute('role', 'status');
    text.style.cssText = 'margin-bottom:18px;color:#b6b8bd;line-height:1.6;overflow-wrap:anywhere';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', '업데이트 진행률');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.style.cssText = 'height:6px;border-radius:3px;background:#3a3c40;overflow:hidden';
    fill.style.cssText = 'height:100%;background:#4c8bf5;border-radius:inherit;transition:width .15s';
    percent.style.cssText = 'margin-top:10px;text-align:right;color:#b6b8bd;font-variant-numeric:tabular-nums';
    bar.append(fill); panel.append(title, text, bar, percent); box.append(panel, style); document.body.append(box);
    box.showModal();
  }
  const [, text, bar, percent] = box.firstChild.children, fill = bar.firstChild;
  text.textContent = String(progress.text ?? '');
  const fraction = Number.isFinite(progress.fraction) ? Math.min(1, Math.max(0, progress.fraction)) : null;
  const value = fraction === null ? null : Math.round(fraction * 100);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  fill.style.transition = value === null || reducedMotion ? 'none' : 'width .15s';
  fill.style.width = value === null ? '35%' : `${value}%`;
  if (value === null) {
    bar.removeAttribute('aria-valuenow');
    if (reducedMotion) { for (const animation of fill.getAnimations()) animation.cancel(); }
    else if (!fill.getAnimations().length) fill.animate([{ transform: 'translateX(-100%)' }, { transform: 'translateX(286%)' }], { duration: 1400, iterations: Infinity });
  } else {
    bar.setAttribute('aria-valuenow', String(value));
    for (const animation of fill.getAnimations()) animation.cancel();
  }
  percent.textContent = value === null ? '잠시만 기다려 주세요' : `${value}%`;
});

// macOS traffic lights overlay the page without supplying titlebar-area CSS env values.
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.style.setProperty('--desktop-titlebar-height', '40px');
    document.documentElement.style.setProperty('--desktop-controls-width', '80px');
  });
}
