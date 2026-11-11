import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { helloPtyHost, ptyHostControl } from '../../local-server/src/pty-client.js';
import { PTY_PROTOCOL } from '../../local-server/src/pty-protocol.js';
import { setupPlugins } from './plugins.js';
import { clearRendezvous, markHostCopy, newEndpoint, prepareHostCopy, processAlive, readRendezvous, sweepHostCopies, writeRendezvous } from './pty-host-files.js';
import { applyStagedUpdate, checkForUpdate, sweepStaleUpdates, UPDATE_CHECK_INTERVAL_MS } from './updater.js';

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
// A dev app started from a terminal of an older dev app inherits the NODE_ENV=development its Vite leaked; the server would pass it on.
if (dev) delete process.env.NODE_ENV;
let server = null, origin = '', quitting = false, restarting = false, mainWindow = null, plugins = null;
// `app.isPackaged` is false whenever the executable is named electron/Electron, which is what the macOS bundle's is, so it cannot tell
// an installed app from a dev one. The runtime/ folder (resources/runtime, beside resources/app) exists only in packaged builds; a dev
// launcher has none and uses the system Node. A GUI launch (Finder, Dock) has no node on PATH, so never rely on the fallback there.
const bundledNode = path.resolve(import.meta.dirname, '../../../../runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const packaged = fs.existsSync(bundledNode);
// The version comes from package.json two folders above src/: the repository root in dev, the packaged app's own package.json
// (written by package.mjs) once installed. Electron's app.getVersion() would report Electron's own version in dev.
const appVersion = (() => { try { return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8')).version || app.getVersion(); } catch { return app.getVersion(); } })();
const nodeBinary = process.env.ADE_NODE || (packaged ? bundledNode : 'node');

// Terminals live in their own process, the pty-host (apps/local-server/src/pty-host.js), so they keep running while the server is
// replaced (dev reload, a crash) and while the app restarts for an update; the next app finds the host through pty-host.json and its
// server takes the terminals over. A normal quit ends them as before. Without a host (it could not start) the server keeps its
// terminals in its own process, which is how every terminal used to live.
const ptyRoot = path.join(app.getPath('userData'), 'pty-host');
// How long the host keeps terminals for the app that an update is restarting.
const UPDATE_LINGER_MS = 5 * 60_000;
let ptyHostInfo = null, keepTerminalsOnQuit = false, ptyNotice = '';

async function ensurePtyHost() {
  const known = readRendezvous(ptyRoot);
  if (known && processAlive(known.pid)) {
    try {
      const { socket, hello } = await helloPtyHost({ endpoint: known.endpoint, token: known.token, role: 'control' });
      socket.destroy();
      if (hello.pid === known.pid) {
        console.log(`실행 중인 pty-host에 연결합니다 (pid ${hello.pid}, 터미널 ${hello.terminals}개)`);
        return usePtyHost(known);
      }
    } catch (error) {
      // Not ended here: it may be an older host whose terminals someone still wants. It ends them itself once nobody takes them over.
      console.warn(`실행 중인 pty-host를 이어받을 수 없어 새로 시작합니다: ${error.message}`);
      if (error.code === 'PTY_INCOMPATIBLE') ptyNotice = '이전 버전에서 열려 있던 터미널은 이 버전에서 이어받지 못했습니다. 그 터미널은 몇 분 뒤 종료됩니다.';
    }
  }
  const token = randomBytes(32).toString('hex'), endpoint = newEndpoint();
  // The packaged app runs the host from a copy in its data folder, so updating the install folder never hits its locked files.
  // `pnpm dev` runs it from the source tree with the system Node.
  const source = path.dirname(serverEntry);
  const files = packaged && !dev
    ? prepareHostCopy({ root: ptyRoot, serverSrc: source, nodePtyDir: path.dirname(createRequire(serverEntry).resolve('node-pty/package.json')), nodeBinary })
    : { dir: ptyRoot, entry: path.join(source, 'pty-host.js'), node: nodeBinary, key: null };
  fs.mkdirSync(ptyRoot, { recursive: true });
  const logFile = path.join(ptyRoot, 'pty-host.log');
  try { if (fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, `${logFile}.old`); } catch { /* no log yet */ }
  const log = fs.openSync(logFile, 'a');
  let child;
  try {
    // Detached with its own stdio, so it outlives this app; its cwd is its own folder, never the install folder.
    child = spawn(files.node, [files.entry], { cwd: files.dir, env: { ...process.env, ADE_PTY_ENDPOINT: endpoint, ADE_PTY_TOKEN: token }, detached: true, stdio: ['ignore', log, log], windowsHide: true });
  } finally { fs.closeSync(log); }
  if (files.key) markHostCopy(files.dir, child.pid);
  let exited = null;
  child.once('exit', code => { exited = code ?? 'signal'; });
  child.once('error', error => { exited = error.message; });
  child.unref();
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (exited !== null) throw new Error(`pty-host가 시작하지 못했습니다 (${exited}). ${logFile}을 확인하세요.`);
    try { const { socket } = await helloPtyHost({ endpoint, token, role: 'control', timeoutMs: 2000 }); socket.destroy(); break; }
    catch (error) { if (Date.now() > deadline) { try { child.kill(); } catch { /* gone */ } throw new Error(`pty-host가 응답하지 않습니다: ${error.message}`); } }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const info = { protocol: PTY_PROTOCOL, endpoint, token, pid: child.pid, key: files.key };
  writeRendezvous(ptyRoot, info);
  return usePtyHost(info);
}
function usePtyHost(info) {
  // The copy's Node also runs the plugin tools in terminals (see setupPlugins); `pnpm dev` has no copy.
  ptyHostInfo = { ...info, node: info.key ? path.join(ptyRoot, info.key, process.platform === 'win32' ? 'node.exe' : 'node') : null };
  // Read by the server it starts, which removes them from its own environment so terminals never see them.
  process.env.ADE_PTY_ENDPOINT = info.endpoint; process.env.ADE_PTY_TOKEN = info.token;
  // Copies of earlier versions no running host uses any more.
  if (packaged && !dev) sweepHostCopies(ptyRoot, info.key ? [info.key] : []);
}
// Before the server goes: an update restart asks the host to keep the terminals for the next app; a normal quit ends them.
async function releasePtyHost() {
  const info = ptyHostInfo;
  if (!info) return;
  const request = keepTerminalsOnQuit ? { op: 'linger', ms: UPDATE_LINGER_MS } : { op: 'shutdown', reason: '앱 종료' };
  const result = await ptyHostControl(info, request).catch(error => ({ ok: false, error: error.message }));
  if (!result.ok) console.warn(`pty-host에 ${request.op}를 알리지 못했습니다: ${result.error ?? '응답 없음'}`);
  if (!keepTerminalsOnQuit) clearRendezvous(ptyRoot, info.pid);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = server = spawn(nodeBinary, [serverEntry], { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      output += chunk;
      const match = /(http:\/\/127\.0\.0\.1:\d+)\/#token=([a-f0-9]+)/.exec(output);
      // Listening means its IPC handlers are in place: hand it what the plugins add to terminals.
      if (match && !origin) { origin = match[1]; plugins?.push(); resolve(`${match[1]}/#token=${match[2]}`); }
    });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('message', message => { if (message?.type === 'plugin/workspace' && server === child) plugins?.fromServer(message); });
    child.once('error', error => { if (server === child) server = null; reject(error); });
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
    if (child.connected) child.send({ type: 'shutdown' }, error => { if (error) child.kill(); }); else child.kill();
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
    timer = setTimeout(() => {
      // One waiting reload covers every change made while it waits; a change after it has started queues the next one.
      if (reloadPending) return;
      reloadPending = true;
      restartQueue = restartQueue.then(restartWhenIdle).catch(error => dialog.showErrorBox('무너에이드', `서버 재시작 실패: ${error.message}`));
    }, 400);
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
// Replacing the server ends every chat turn it runs (the turn is a child of the server). Editing server files from inside a chat therefore cut that very chat
// off after each edit, with no closing message. The reload waits until nothing is working; terminals kept by the pty-host do not count, they survive it.
let reloadPending = false;
async function restartWhenIdle() {
  try {
    for (let announced = false; !quitting; announced = true) {
      const report = await serverBusy().catch(() => null); // no answer means a stuck server: reloading is the cure, not a reason to wait
      if (!report?.reasons.some(reason => !reason.keeps)) break;
      if (!announced) console.log('[dev] 서버 코드가 변경되었습니다. 진행 중인 작업(채팅 턴 등)이 끝나면 서버만 다시 시작합니다');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } finally { reloadPending = false; }
  console.log('[dev] 서버 코드가 변경되어 서버만 다시 시작합니다 (터미널 유지)');
  await restartServer();
}
async function restartServer() {
  if (quitting || !mainWindow) return;
  restarting = true;
  try {
    // Leave the old page first: once the new dev server is up, its Vite HMR client reloads the page against the dead origin,
    // which aborts the load below (ERR_ABORTED) and leaves an error page.
    loadGeneration++;
    await mainWindow.loadURL('about:blank').catch(() => {});
    await stopServer(); origin = ''; const url = await startServer();
    // Not awaited: the server is up, so loading the page can no longer fail the restart, and retries must not hold up the queue.
    if (mainWindow) void load(mainWindow, url);
  } finally { restarting = false; }
}
// loadURL rejects whenever the page doesn't finish loading, e.g. ERR_ABORTED (-3) when the page navigates itself meanwhile (Vite's
// reload after a dev server start). For an aborted document load Electron leaves `code` (the description) empty, so no error is
// matched by name: while this server runs, every failure is retried. A newer load, a restart or a dead server ends the retries.
let loadGeneration = 0;
async function load(window, url) {
  const generation = ++loadGeneration;
  const current = () => generation === loadGeneration && !quitting && !window.isDestroyed() && sameOrigin(url);
  for (let attempt = 1; current(); attempt++) {
    try { return await window.loadURL(url); }
    catch (error) {
      if (!current()) return;
      console.warn(`창 불러오기 실패, 다시 시도합니다 (${attempt}): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, Math.min(250 * attempt, 5000)));
    }
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
    if (origin && !window.isDestroyed()) void load(window, `${origin}/`);
  });
  mainWindow = window; window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  void load(window, url);
}

ipcMain.handle('ade:pick-folder', async (event, options) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const title = typeof options?.title === 'string' && options.title ? options.title.slice(0, 200) : '프로젝트 폴더 선택';
  const defaultPath = typeof options?.defaultPath === 'string' && options.defaultPath ? options.defaultPath : undefined;
  const result = await dialog.showOpenDialog(owner, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.on('ade:write-clipboard', (_event, text) => { if (typeof text === 'string' && text.length <= 8 * 1024 * 1024) clipboard.writeText(text); });

// Asks the server what an app restart would cut off (running agent turns, background tasks, commands). The answer is
// { busy, reasons }; a missing or silent server rejects, which the updater counts as busy instead of guessing idle.
let busyRequests = 0;
function serverBusy() {
  const child = server;
  if (!child) return Promise.resolve({ busy: false, reasons: [] }); // no server, so no terminals either
  if (!child.connected) return Promise.reject(new Error('서버와 연결되어 있지 않습니다'));
  return new Promise((resolve, reject) => {
    const id = ++busyRequests;
    const finish = result => { clearTimeout(timer); child.off('message', onMessage); result instanceof Error ? reject(result) : resolve(result); };
    const onMessage = message => { if (message?.type === 'busy' && message.id === id) finish({ busy: message.busy, reasons: message.reasons }); };
    const timer = setTimeout(() => finish(new Error('서버가 작업 상태에 응답하지 않습니다')), 10_000);
    child.on('message', onMessage);
    child.send({ type: 'busy?', id }, error => { if (error) finish(error); });
  });
}
// Just before the update restarts the app: keep the terminals for the new version instead of ending them.
// Beta updates are the user's choice, kept beside the other app data (not in the server's settings: the updater lives in this process).
const channelFile = path.join(app.getPath('userData'), 'update-channel.json');
const readBeta = () => { try { return JSON.parse(fs.readFileSync(channelFile, 'utf8')).beta === true; } catch { return false; } };
const updateTarget = (manual = false) => ({ repo: 'Mooner510/mooner-ade', asset: `MoonerADE-${process.platform}-${process.arch}.zip`, window: mainWindow, manual, beta: readBeta(), getBusy: serverBusy, beforeRestart: () => { keepTerminalsOnQuit = true; } });
ipcMain.handle('ade:app-info', () => ({ version: appVersion, dev }));
ipcMain.handle('ade:get-beta-updates', () => readBeta());
ipcMain.handle('ade:set-beta-updates', (_event, beta) => { fs.writeFileSync(channelFile, JSON.stringify({ beta: beta === true })); return readBeta(); });
ipcMain.handle('ade:check-update', () => checkForUpdate(updateTarget(true)));

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
    try {
      // First, so plugins learn which Node terminals use. A host that cannot start leaves terminals in the server process, as they
      // used to be: nothing is kept through a restart then.
      await ensurePtyHost().catch(error => console.warn(`pty-host 없이 시작합니다: ${error.message}`));
      // Needs the app to be ready (safeStorage). Off unless turned on and each plugin approved; a plugin setup that fails leaves plugins off, never the app.
      try { plugins = setupPlugins({ userData: app.getPath('userData'), nodeBinary, terminalNode: ptyHostInfo?.node ?? nodeBinary, version: appVersion, getServer: () => server, getWindow: () => mainWindow, trusted: event => sameOrigin(event.senderFrame?.url ?? '') }); }
      catch (error) { console.warn(`플러그인을 불러오지 못했습니다: ${error.message}`); }
      createWindow(await startServer());
      if (ptyNotice) void dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['확인'], title: '무너에이드', message: ptyNotice });
      if (dev) watchServerSources();
      else {
        // Once shortly after start, then every 10 minutes for an app that stays open for days.
        sweepStaleUpdates();
        const background = () => checkForUpdate(updateTarget()).catch(error => console.warn(`업데이트 확인 실패: ${error.message}`));
        setTimeout(background, 5000); setInterval(background, UPDATE_CHECK_INTERVAL_MS).unref();
      }
    }
    catch (error) { dialog.showErrorBox('무너에이드', error instanceof Error ? error.message : String(error)); app.quit(); }
  });
  app.on('child-process-gone', (_event, details) => { if (details.type === 'GPU') console.warn(`GPU 프로세스 종료 (${details.reason}, exit ${details.exitCode})`); });
  app.on('window-all-closed', () => app.quit());
  app.on('quit', () => { plugins?.close(); });
  let asking = false;
  const quitNow = () => {
    quitting = true;
    // Linger is set before the server lets go of the terminals; shutdown after it has saved the sessions it reads from them.
    const steps = keepTerminalsOnQuit ? [releasePtyHost, stopServer] : [stopServer, releasePtyHost];
    void steps.reduce((chain, step) => chain.then(step).catch(error => console.warn(error.message)), Promise.resolve()).finally(() => app.quit());
  };
  // Terminals survive a quit in the pty-host; a chat turn is a child of the server and ends with it, so quitting in the middle of one asks first.
  // An immediate update restart already set keepTerminalsOnQuit, so it skips this. A server that does not answer is not a reason to hold the quit.
  async function confirmQuit() {
    if (keepTerminalsOnQuit) return true;
    const report = await serverBusy().catch(() => null), turns = report?.reasons.filter(reason => reason.kind === 'turn' && !reason.keeps && reason.agent) ?? [];
    if (!turns.length) return true;
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const { response } = await dialog.showMessageBox(...(window ? [window] : []), { type: 'question', buttons: ['종료', '취소'], defaultId: 1, cancelId: 1, message: `진행 중인 채팅 응답이 ${turns.length}개 있습니다.`, detail: '지금 종료하면 응답이 중단됩니다. 대화는 저장되며, 중단된 마지막 요청은 다시 열어 ‘세션 복구’로 이어서 보낼 수 있습니다.' });
    return response === 0;
  }
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (asking) return;
    asking = true;
    void confirmQuit().catch(() => true).then(async go => {
      asking = false;
      if (!go) return;
      try { if (await applyStagedUpdate()) keepTerminalsOnQuit = true; }
      catch (error) { dialog.showErrorBox('업데이트', `설치를 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`); return; }
      quitNow();
    });
  });
}
