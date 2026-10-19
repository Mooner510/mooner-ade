import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The local server runs under the system Node (not Electron's), so node-pty keeps its normal Node ABI build.
const serverEntry = path.resolve(import.meta.dirname, '../../local-server/src/index.js');
const background = '#0c0d0f';
// `pnpm desktop:dev`: the server hosts a Vite dev server (HMR) instead of web/dist.
const dev = process.argv.includes('--dev');
if (dev) process.env.ADE_DEV = '1';
let server = null, origin = '', quitting = false, restarting = false, ptyHost = null, mainWindow = null;
const nodeBinary = process.env.ADE_NODE || 'node';

// Dev only: terminals live in their own process so the server can be replaced on every code change without killing them.
// The host dies with this app (its IPC channel closes), so quitting `pnpm desktop:dev` always cleans it up.
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
    server = spawn(nodeBinary, [serverEntry], { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let output = '';
    server.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      output += chunk;
      const match = /(http:\/\/127\.0\.0\.1:\d+)\/#token=([a-f0-9]+)/.exec(output);
      if (match && !origin) { origin = match[1]; resolve(`${match[1]}/#token=${match[2]}`); }
    });
    server.stderr.on('data', chunk => process.stderr.write(chunk));
    server.once('error', reject);
    server.once('exit', code => {
      server = null;
      if (!origin) reject(new Error(`로컬 서버가 시작되지 않았습니다 (exit ${code}).\n${output}`));
      else if (!quitting && !restarting) { dialog.showErrorBox('무너에이드', `로컬 서버가 종료되었습니다 (exit ${code}).`); app.quit(); }
    });
  });
}

// Graceful stop lets the server save state and release the project lock; force-kill after 5 s.
function stopServer() {
  if (!server) return Promise.resolve();
  const child = server;
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
  });
}

// Dev hot reload: replace only the server process (terminals stay in the pty-host) and reload the window against the new one.
let restartQueue = Promise.resolve();
function watchServerSources() {
  const root = path.resolve(import.meta.dirname, '../../..');
  const dirs = [path.join(root, 'apps/local-server/src'), ...fs.readdirSync(path.join(root, 'packages')).map(name => path.join(root, 'packages', name, 'src'))].filter(dir => fs.existsSync(dir));
  let timer;
  const changed = (_event, name) => {
    // The host is not reloaded (that would kill the terminals it protects); changing it needs a full restart of the app.
    if (!name || /pty-host\.js$|\.(md|d\.ts)$|\.stackdump$/.test(name)) return;
    clearTimeout(timer);
    timer = setTimeout(() => { restartQueue = restartQueue.then(restartServer).catch(error => dialog.showErrorBox('무너에이드', `서버 재시작 실패: ${error.message}`)); }, 400);
  };
  for (const dir of dirs) try { fs.watch(dir, { recursive: true }, changed); } catch { /* no recursive watch here: restart the app manually */ }
  let preloadTimer;
  fs.watch(import.meta.dirname, (_event, name) => {
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
}
async function restartServer() {
  if (quitting || !mainWindow) return;
  console.log('[dev] 서버 코드가 변경되어 서버만 다시 시작합니다 (터미널 유지)');
  restarting = true;
  try { await stopServer(); origin = ''; const url = await startServer(); await mainWindow?.loadURL(url); }
  finally { restarting = false; }
}

function createWindow(url) {
  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 720, minHeight: 480, backgroundColor: background, title: '무너에이드', show: false,
    // The web UI's tab bar becomes the title bar; window controls overlay it on Windows/Linux.
    titleBarStyle: 'hidden', ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 13 } } : { titleBarOverlay: { color: background, symbolColor: '#8b9099', height: 40 } }),
    webPreferences: { preload: path.resolve(import.meta.dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target) && !target.startsWith(origin)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => { if (!target.startsWith(origin)) event.preventDefault(); });
  mainWindow = window; window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  void window.loadURL(url);
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

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const [window] = BrowserWindow.getAllWindows(); if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    installMenu();
    try { if (dev) await startPtyHost(); createWindow(await startServer()); if (dev) watchServerSources(); }
    catch (error) { dialog.showErrorBox('무너에이드', error instanceof Error ? error.message : String(error)); app.quit(); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('quit', () => { ptyHost?.kill(); });
  app.on('before-quit', event => {
    if (quitting || !server) return;
    event.preventDefault(); quitting = true;
    void stopServer().finally(() => app.quit());
  });
}
