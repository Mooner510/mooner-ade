import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkForUpdate } from './updater.js';

// Keep the existing profile when changing the displayed product name.
app.setPath('userData', path.join(app.getPath('appData'), '@mooner/ade-desktop'));
// Chromium ends the whole app ("GPU process isn't usable. Goodbye.") once the GPU process has crashed a few times, which many busy
// terminal panes can cause. Without the limit it just starts the GPU process again and the window recovers.
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');

// The local server runs under the system Node (not Electron's), so node-pty keeps its normal Node ABI build.
const serverEntry = path.resolve(import.meta.dirname, '../../local-server/src/index.js');
const background = '#0c0d0f';
const iconPath = path.resolve(import.meta.dirname, '../assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
// `pnpm dev`: the server hosts a Vite dev server (HMR) instead of web/dist.
const dev = process.argv.includes('--dev');
// Cleared otherwise: started from a terminal of a `pnpm dev` app, the packaged app would inherit it and look for Vite.
if (dev) process.env.ADE_DEV = '1'; else delete process.env.ADE_DEV;
let server = null, origin = '', quitting = false, restarting = false, ptyHost = null, mainWindow = null;
// The dev launcher's renamed exe also reports app.isPackaged; started directly (e.g. from a pinned shortcut) it has no
// bundled runtime/, so fall back to the system Node instead of failing with ENOENT.
const bundledNode = path.resolve(import.meta.dirname, '../../../runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const nodeBinary = process.env.ADE_NODE || (app.isPackaged && fs.existsSync(bundledNode) ? bundledNode : 'node');

// Dev only: terminals live in their own process so the server can be replaced on every code change without killing them.
// The host dies with this app (its IPC channel closes), so quitting `pnpm dev` always cleans it up.
function startPtyHost() {
  const token = randomBytes(32).toString('hex'), id = randomBytes(6).toString('hex');
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\mooner-ade-pty-${id}` : path.join(os.tmpdir(), `mooner-ade-pty-${id}.sock`);
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBinary, [path.resolve(import.meta.dirname, '../../local-server/src/pty-host.js')], { env: { ...process.env, ADE_PTY_ENDPOINT: endpoint, ADE_PTY_TOKEN: token }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    ptyHost = child;
    child.once('error', reject);
    child.once('exit', code => { if (ptyHost === child) ptyHost = null; reject(new Error(`pty-host 종료 (exit ${code})`)); });
    child.on('message', message => { if (message?.type === 'ready') { process.env.ADE_PTY_ENDPOINT = endpoint; process.env.ADE_PTY_TOKEN = token; resolve(); } });
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = server = spawn(nodeBinary, [serverEntry], { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      output += chunk;
      const match = /(http:\/\/127\.0\.0\.1:\d+)\/#token=([a-f0-9]+)/.exec(output);
      if (match && !origin) { origin = match[1]; resolve(`${match[1]}/#token=${match[2]}`); }
    });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.once('error', reject);
    child.once('exit', code => {
      // A replaced server exiting late must not be mistaken for the current one dying.
      if (server !== child) return;
      server = null;
      if (!origin) reject(new Error(`로컬 서버가 시작되지 않았습니다 (exit ${code}).\n${output}`));
      else if (!quitting && !restarting) recoverServer(code);
    });
  });
}

// Graceful stop lets the server save state and release the project lock; SIGKILL after 5 s.
function stopServer() {
  if (!server) return Promise.resolve();
  const child = server;
  return new Promise(resolve => {
    // Resolve only once the old process is gone: it still holds the Vite HMR port and project locks until then,
    // and a new server started earlier fails to open those projects. SIGTERM would only re-enter its running shutdown.
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
  });
}

// Dev hot reload: replace only the server process (terminals stay in the pty-host) and reload the window against the new one.
let restartQueue = Promise.resolve();
function watchServerSources() {
  const root = path.resolve(import.meta.dirname, '../../..');
  const dirs = [path.join(root, 'apps/local-server/src')];
  let timer;
  const changed = (_event, name) => {
    // The host is not reloaded (that would kill the terminals it protects); changing it needs a full restart of the app.
    if (!name || /pty-host\.js$|\.(md|d\.ts)$|\.stackdump$/.test(name)) return;
    clearTimeout(timer);
    timer = setTimeout(() => { console.log('[dev] 서버 코드가 변경되어 서버만 다시 시작합니다 (터미널 유지)'); restartQueue = restartQueue.then(restartServer).catch(error => dialog.showErrorBox('무너에이드', `서버 재시작 실패: ${error.message}`)); }, 400);
  };
  const watchError = error => console.warn(`개발 모드 파일 감시 오류 (${error.code || 'WATCH_FAILED'}). 변경 반영은 앱을 직접 재시작하세요.`);
  for (const dir of dirs) try {
    const watcher = fs.watch(dir, { recursive: true }, changed);
    watcher.on('error', error => { watcher.close(); watchError(error); });
  } catch (error) { watchError(error); }
  let preloadTimer;
  try {
    const watcher = fs.watch(import.meta.dirname, (_event, name) => {
      if (name !== 'preload.cjs') return;
      clearTimeout(preloadTimer);
      preloadTimer = setTimeout(() => {
        restartQueue = restartQueue.then(() => {
          if (quitting || !mainWindow) return;
          console.log('[dev] preload 코드가 변경되어 창을 새로고침합니다 (터미널 유지)');
          mainWindow.webContents.reloadIgnoringCache();
        }).catch(error => dialog.showErrorBox('무너에이드', `창 새로고침 실패: ${error.message}`));
      }, 400);
    });
    watcher.on('error', error => { watcher.close(); clearTimeout(preloadTimer); watchError(error); });
  } catch (error) { watchError(error); }
}
async function restartServer() {
  if (quitting || !mainWindow) return;
  restarting = true;
  try {
    // Leave the old page first: once the new dev server is up, its Vite HMR client reloads the page against the dead origin,
    // which aborts the load below (ERR_ABORTED) and leaves an error page.
    await mainWindow.loadURL('about:blank').catch(() => {});
    await stopServer(); origin = ''; const url = await startServer();
    if (mainWindow) await load(mainWindow, url);
  } finally { restarting = false; }
}
// A navigation the page starts on its own aborts loadURL with ERR_ABORTED although nothing is wrong; load again.
async function load(window, url) {
  for (let attempt = 1; ; attempt++) {
    try { return await window.loadURL(url); }
    catch (error) { if (error.code !== 'ERR_ABORTED' || attempt >= 3 || window.isDestroyed()) throw error; }
  }
}
// A server that dies on its own is started again instead of closing the app (outside `pnpm dev` its terminals die with it).
// Only a server that keeps dying ends the app.
let serverCrashes = [];
function recoverServer(code) {
  const now = Date.now();
  serverCrashes = [...serverCrashes.filter(time => now - time < 60_000), now];
  if (serverCrashes.length > 3 || !mainWindow) { dialog.showErrorBox('무너에이드', `로컬 서버가 계속 종료됩니다 (exit ${code}).`); app.quit(); return; }
  console.warn(`로컬 서버가 종료되어 다시 시작합니다 (exit ${code})`);
  restartQueue = restartQueue.then(restartServer).catch(error => { dialog.showErrorBox('무너에이드', `서버 재시작 실패: ${error.message}`); app.quit(); });
}

function sameOrigin(target) {
  try { return new URL(target).origin === origin; } catch { return false; }
}

function createWindow(url) {
  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 720, minHeight: 480, backgroundColor: background, title: '무너에이드', show: false, icon: iconPath,
    // The web UI's tab bar becomes the title bar; window controls overlay it on Windows.
    titleBarStyle: 'hidden', ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 13 } } : { titleBarOverlay: { color: background, symbolColor: '#8b9099', height: 40 } }),
    webPreferences: { preload: path.resolve(import.meta.dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target) && !sameOrigin(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  // Compare parsed origins: a prefix check would let http://127.0.0.1:PORT@evil.example/ through.
  const guard = (event, target) => { if (!sameOrigin(target)) event.preventDefault(); };
  window.webContents.on('will-navigate', guard);
  window.webContents.on('will-redirect', guard);
  // A renderer that crashed (e.g. out of memory with many busy panes) leaves a dead window; the server and its terminals keep
  // running, so load the app again (the session cookie still signs it in). Repeated crashes stop the reloads.
  let rendererCrashes = [];
  window.webContents.on('render-process-gone', (_event, details) => {
    if (quitting || restarting || details.reason === 'clean-exit') return;
    const now = Date.now();
    rendererCrashes = [...rendererCrashes.filter(time => now - time < 60_000), now];
    console.warn(`화면 프로세스 종료 (${details.reason}, exit ${details.exitCode})`);
    if (rendererCrashes.length > 3) { dialog.showErrorBox('무너에이드', `화면 프로세스가 계속 종료됩니다 (${details.reason}). 열린 패널 수를 줄인 뒤 다시 실행하세요.`); return; }
    if (origin && !window.isDestroyed()) load(window, `${origin}/`).catch(error => console.warn(`창 다시 불러오기 실패: ${error.message}`));
  });
  mainWindow = window; window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  load(window, url).catch(error => console.warn(`창 불러오기 실패: ${error.message}`));
}

ipcMain.handle('ade:pick-folder', async event => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(owner, { title: '프로젝트 폴더 선택', properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

function installMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(dev ? Menu.buildFromTemplate([{ label: 'Dev', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] }]) : null);
    return;
  }
  // macOS needs a menu for copy/paste and quit shortcuts.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' }]));
}

if (!app.requestSingleInstanceLock()) {
  console.error('무너에이드가 이미 실행 중입니다. 실행 중인 창을 앞으로 가져오고 종료합니다. (완전히 끄려면 앱을 종료한 뒤 다시 실행하세요)');
  app.quit();
} else {
  app.on('second-instance', () => { const [window] = BrowserWindow.getAllWindows(); if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    installMenu();
    if (process.platform === 'darwin') app.dock?.setIcon(iconPath);
    try { if (dev) await startPtyHost(); createWindow(await startServer()); if (dev) watchServerSources(); else setTimeout(() => checkForUpdate({ repo: 'Mooner510/mooner-ade', asset: `MoonerADE-win32-${process.arch}.zip`, window: mainWindow }).catch(error => console.warn(`업데이트 확인 실패: ${error.message}`)), 5000); }
    catch (error) { dialog.showErrorBox('무너에이드', error instanceof Error ? error.message : String(error)); app.quit(); }
  });
  app.on('child-process-gone', (_event, details) => { if (details.type === 'GPU') console.warn(`GPU 프로세스 종료 (${details.reason}, exit ${details.exitCode})`); });
  app.on('window-all-closed', () => app.quit());
  app.on('quit', () => { ptyHost?.kill(); });
  app.on('before-quit', event => {
    if (quitting || !server) return;
    event.preventDefault(); quitting = true;
    void stopServer().finally(() => app.quit());
  });
}
