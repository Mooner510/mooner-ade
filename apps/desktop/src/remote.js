// "다른 PC에 접속": this app as the client of another PC's ADE (docs/REMOTE_UI.md). The pieces are free of Electron (remote-link.js: Hub
// session, pairing, the encrypted link; remote-ui-proxy.js: the other PC's page; remote-bridge.js: the page's messages); this file is the
// Electron part: the sealed store, the `ade-remote:` page protocol, one window per PC, and the IPC the main window's dialog uses.
//
// A remote window is the other PC's own web UI in a window of its own, in its own session (partition), with a preload that gives it only
// `AdeRemoteNative`. Its page may not reach any network: every request goes through the link.
import { BrowserWindow, clipboard, dialog, ipcMain, protocol, safeStorage, session, shell } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createBridge } from './remote-bridge.js';
import { createRemoteClient } from './remote-link.js';
import { createRemoteStore } from './remote-store.js';
import { createUiProxy } from './remote-ui-proxy.js';

const SCHEME = 'ade-remote';
// Before the app is ready, or Electron refuses.
export function registerRemoteScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
}

const hostLabel = hostId => `h${createHash('sha256').update(hostId).digest('hex').slice(0, 24)}`;
const b64url = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

export function setupRemote({ userData, getWindow, trusted, iconPath, background, client = null }) {
  const store = createRemoteStore({ file: path.join(userData, 'remote.bin'), crypto: safeStorage });
  const remote = client ?? createRemoteClient({ store });
  const windows = new Map();   // hostId → { window, link }
  const byContents = new Map();   // webContents id → bridge

  // ---- the main window's dialog -------------------------------------------------------------------------------------------
  // The answers are { ok, value } or { ok:false, error }, so the dialog gets the error text as written here, not wrapped by IPC.
  const handle = (name, fn) => ipcMain.handle(`ade:remote:${name}`, async (event, ...args) => {
    if (!trusted(event) || BrowserWindow.fromWebContents(event.sender) !== getWindow()) return { ok: false, error: { code: 'FORBIDDEN', message: '허용되지 않은 요청입니다.' } };
    try { return { ok: true, value: await fn(...args) }; }
    catch (error) { return { ok: false, error: { code: error.code ?? 'REMOTE_FAILED', message: error.message ?? String(error) } }; }
  });
  const text = value => typeof value === 'string' && value.length <= 2000 ? value : '';
  handle('state', () => ({ available: remote.available, hubHost: remote.hubHost, signedIn: remote.signedIn, account: remote.account, fingerprint: remote.fingerprint, open: [...windows.keys()] }));
  handle('sign-in-start', async () => {
    const info = await remote.signInStart();
    if (!process.env.ADE_REMOTE_NO_BROWSER) void shell.openExternal(info.verifyUrl);   // the Hub's own page (checked in remote-link.js); tests never open a browser
    return { userCode: info.userCode, expiresAt: info.expiresAt };
  });
  handle('sign-in-wait', () => remote.signInWait());
  handle('sign-in-cancel', () => remote.signInCancel());
  handle('sign-out', async () => { for (const { window } of [...windows.values()]) window.close(); await remote.signOut(); });
  handle('hosts', () => remote.hosts());
  handle('offer', link => remote.offer(text(link)));
  handle('pair', link => remote.pair(text(link)));
  handle('forget', hostId => { const open = windows.get(text(hostId)); open?.window.close(); remote.forget(text(hostId)); });
  handle('open', hostId => openHost(text(hostId)));

  // ---- the page's messages ------------------------------------------------------------------------------------------------
  ipcMain.on('ade:remote-bridge:post', (event, raw) => {
    // Only the main frame of a remote window: a frame inside the page (a chat's sandboxed UI) never gets this app's help.
    if (event.senderFrame !== event.sender.mainFrame || typeof raw !== 'string') return;
    byContents.get(event.sender.id)?.receive(raw);
  });

  async function openHost(hostId) {
    const open = windows.get(hostId);
    if (open) { if (open.window.isMinimized()) open.window.restore(); open.window.focus(); return { reused: true }; }
    const host = remote.pairedHost(hostId);
    if (!host) throw Object.assign(new Error('페어링하지 않은 PC입니다.'), { code: 'NOT_PAIRED' });
    const label = hostLabel(hostId), origin = `${SCHEME}://${label}`;
    let window = null, bridge = null, ended = false;
    const post = value => { if (window && !window.isDestroyed()) window.webContents.send('ade:remote-bridge:message', JSON.stringify(value)); };
    const link = remote.link(hostId, {
      state: value => bridge?.onState(value),
      message: value => bridge?.onMessage(value),
      // The PC ended it for good (not allowed any more, a different key, too many failures): say why and close.
      closed: info => {
        if (ended) return;
        ended = true;
        const target = window && !window.isDestroyed() ? window : undefined;
        void dialog.showMessageBox(...(target ? [target] : []), { type: 'warning', buttons: ['확인'], title: '무너에이드', message: `${host.name}에서 연결이 끝났습니다`, detail: info.message })
          .then(() => { if (window && !window.isDestroyed()) window.close(); });
      }
    });
    try {
      await link.whenOpen();
      const proxy = createUiProxy({ link, cacheDir: path.join(userData, 'remote-ui'), origin });
      const { entry } = await proxy.prepare();
      const hello = link.hello;

      // A session of its own per PC: its page storage, its permissions, its protocol. Nothing but the page protocol may leave it.
      const partition = session.fromPartition(`persist:ade-remote-${label}`);
      if (partition.protocol.isProtocolHandled(SCHEME)) partition.protocol.unhandle(SCHEME);
      partition.protocol.handle(SCHEME, async request => {
        if (request.method !== 'GET') return new Response(null, { status: 405 });
        const answer = await proxy.respond(request.url);
        return new Response(answer.body, { status: answer.status, headers: answer.headers });
      });
      partition.setPermissionRequestHandler((_contents, _permission, done) => done(false));
      partition.webRequest.onBeforeRequest((details, done) => done({ cancel: /^(https?|wss?|ftp):/i.test(details.url) }));

      const title = `${host.name} — Remote`;
      window = new BrowserWindow({
        width: 1440, height: 900, minWidth: 720, minHeight: 480, backgroundColor: background, title, show: false, icon: iconPath,
        webPreferences: { preload: path.resolve(import.meta.dirname, 'remote-preload.cjs'), partition: `persist:ade-remote-${label}`, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
      });
      const contentsId = window.webContents.id;
      bridge = createBridge({ link, post, copy: value => clipboard.writeText(value), close: () => window.close() });
      byContents.set(contentsId, bridge);
      windows.set(hostId, { window, link });
      window.once('ready-to-show', () => window.show());
      // The page is the other PC's: its title would say "무너에이드"; this window says whose it is.
      window.on('page-title-updated', event => { event.preventDefault(); window.setTitle(title); });
      const inPage = target => { try { const url = new URL(target); return url.protocol === `${SCHEME}:` && url.host === label; } catch { return false; } };
      window.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
      const guard = (event, target) => { if (!inPage(target)) event.preventDefault(); };
      window.webContents.on('will-navigate', guard);
      window.webContents.on('will-redirect', guard);
      window.on('closed', () => { ended = true; byContents.delete(contentsId); if (windows.get(hostId)?.window === window) windows.delete(hostId); link.close(); });
      await window.loadURL(`${origin}${entry}#remote=${b64url({ scope: hello.scope, api: hello.api ?? [], messages: hello.messages ?? [], features: hello.features ?? [], host: hello.host })}`);
      return { reused: false };
    } catch (error) {
      ended = true;
      link.close();
      if (window && !window.isDestroyed()) window.destroy();
      windows.delete(hostId);
      throw error;
    }
  }

  return { close() { for (const { window } of [...windows.values()]) if (!window.isDestroyed()) window.destroy(); } };
}
