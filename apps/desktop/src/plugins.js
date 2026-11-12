// Plugins in the main process: the sealed settings, native dialogs, one Node process per approved plugin, and what the
// plugins add to new terminals (sent to the server child as `plugins/terminal`). The page can only read the state and start
// steps; turning plugins on, approving one and installing a zip are confirmed in native dialogs (see plugin-core.js and
// docs/PLUGINS.md). A .zip dropped directly into the plugin folder starts the install dialog.
import { BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createPluginManager, createPluginStore, probeMcpTools } from './plugin-core.js';

// `terminalNode` runs what plugins add to terminals (their CLIs, agents' MCP servers). Terminals outlive the app across an update, so
// it is the pty-host's copy of Node in the data folder: one in the install folder would be locked while the update replaces it.
export function setupPlugins({ userData, nodeBinary, terminalNode = nodeBinary, version, getServer, getWindow, trusted }) {
  // The plugins that ship with the app (apps/desktop/builtin-plugins): no approval, only their own on/off.
  const builtinDir = process.env.ADE_BUILTIN_PLUGINS_DIR || path.join(import.meta.dirname, '..', 'builtin-plugins');
  const dir = process.env.ADE_PLUGINS_DIR || path.join(userData, 'plugins'), stagingRoot = path.join(userData, 'plugin-staging');
  fs.mkdirSync(dir, { recursive: true });
  // Left over from an install the app did not finish.
  try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch (failure) { console.warn(`플러그인 임시 폴더를 지우지 못했습니다: ${failure.message}`); }
  const store = createPluginStore({ file: path.join(userData, 'plugins.bin'), crypto: safeStorage });
  let terminal = { node: terminalNode, plugins: [] }, error = null;

  const publish = snapshot => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('ade:plugins-state', { ...snapshot, error });
  };
  // Whether feedback can be submitted (a running plugin that declared `feedback` and is signed in); the server shows it in the feedback inbox.
  let feedback = null;
  const pushFeedback = () => { const child = getServer(); if (child?.connected && feedback) child.send({ type: 'feedback/status', status: feedback }); };
  const push = () => { const child = getServer(); if (child?.connected) child.send({ type: 'plugins/terminal', config: terminal }); pushFeedback(); };
  const toServer = message => { const child = getServer(); if (!child?.connected) return false; child.send(message); return true; };
  // A click brings the window forward on the plugins page. Shown ones are kept referenced, or the click handler can be collected.
  const shown = new Set();
  function notify({ title, body }) {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    shown.add(notification);
    notification.on('close', () => shown.delete(notification));
    notification.on('click', () => {
      shown.delete(notification);
      const window = getWindow();
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
      window.webContents.send('ade:plugins-open');
    });
    notification.show();
  }
  async function ask(options) {
    const window = getWindow();
    window?.show(); window?.focus();
    const result = window ? await dialog.showMessageBox(window, { noLink: true, ...options }) : await dialog.showMessageBox({ noLink: true, ...options });
    return result.response;
  }
  // The plugin gets the user's environment, minus what only the app's own processes should see.
  const hostEnv = () => {
    const env = { ...process.env, ADE_PLUGIN: '1' };
    for (const name of Object.keys(env)) if (/^(ADE_PTY_|ADE_DEV$|ELECTRON_)/.test(name)) delete env[name];
    return env;
  };
  function spawnHost({ id, dir: cwd, main }) {
    const child = spawn(nodeBinary, [main], { cwd, env: hostEnv(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    const prefix = chunk => String(chunk).split(/\r?\n/).filter(Boolean).map(line => `[plugin ${id}] ${line.slice(0, 2000)}`).join('\n');
    child.stdout.on('data', chunk => console.log(prefix(chunk)));
    child.stderr.on('data', chunk => console.warn(prefix(chunk)));
    return child;
  }

  // The plugin's MCP server is listed with what an agent in an ADE terminal would run it with: the terminal's Node and the
  // plugin's terminal variables on top of the user's environment.
  const probeMcp = ({ command, args, cwd, env }) => probeMcpTools({ command, args, cwd, env: { ...hostEnv(), ...env, ADE_PLUGIN_NODE: terminalNode }, clientVersion: version });
  const manager = createPluginManager({
    dir, builtinDir, dataRoot: path.join(userData, 'plugin-data'), stagingRoot, store, spawnHost, ask, nodeBinary, terminalNode, appVersion: version,
    onChange: publish, onTerminal: config => { terminal = config; push(); }, onFeedback: status => { feedback = status; pushFeedback(); }, toServer, notify, probeMcp
  });

  const installPickedZip = file => manager.installZip(String(file), { picked: true });
  const handlers = {
    state: () => ({ ...manager.snapshot(), error }),
    setEnabled: value => manager.setEnabled(value === true),
    setBuiltin: (id, on) => manager.setBuiltin(String(id), on === true),
    rescan: () => manager.rescan(),
    approve: folder => manager.approve(String(folder)),
    revoke: (id, options) => manager.revoke(String(id), { forget: options?.forget === true }),
    restart: id => manager.restart(String(id)),
    action: (id, action, values) => manager.action(String(id), String(action), values),
    setMcp: (id, change) => manager.setMcp(String(id), { ...(typeof change?.tool === 'string' && { tool: change.tool }), enabled: change?.enabled === true }),
    refreshTools: id => manager.refreshTools(String(id)),
    openFolder: async () => { const failure = await shell.openPath(dir); if (failure) throw new Error(failure); return manager.snapshot(); },
    installZip: installPickedZip,
    pickZip: async () => {
      const window = getWindow(), options = { title: '플러그인 zip 선택', properties: ['openFile'], filters: [{ name: '플러그인 zip', extensions: ['zip'] }] };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) return manager.snapshot();
      return installPickedZip(result.filePaths[0]);
    }
  };
  // Zips found in the plugin folder go through the same dialog, one after another. A failure is shown once and not retried
  // for the same file.
  function installDropped() {
    for (const file of manager.droppedZips()) {
      manager.installZip(file).then(result => { if (result.message) { error = null; publish(result); } }, failure => {
        error = failure.message; publish(manager.snapshot());
        void ask({ type: 'error', title: '플러그인 설치', message: '플러그인을 설치하지 못했습니다.', detail: `${path.basename(file)}\n\n${failure.message}`, buttons: ['확인'], defaultId: 0, cancelId: 0 }).catch(() => {});
      });
    }
  }
  // Only the app's own page in the app's own window may call these.
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`ade:plugins:${name}`, async (event, ...args) => {
    if (BrowserWindow.fromWebContents(event.sender) !== getWindow() || !trusted(event)) throw new Error('허용되지 않은 요청입니다.');
    try { const result = await handler(...args); error = null; return { ...result, error }; }
    catch (failure) { error = failure.message; publish(manager.snapshot()); throw failure; }
  });

  store.load();
  if (store.problem === 'unreadable') error = '저장된 플러그인 설정을 열 수 없어 플러그인을 껐습니다. 다시 켜고 승인하세요.';
  try { manager.rescan(); } catch (failure) { error = failure.message; }
  installDropped();
  // Files dropped in, updated or edited show up (and an edited plugin stops) without a restart.
  let timer = null;
  try {
    const watcher = fs.watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { try { manager.rescan(); } catch (failure) { console.warn(`플러그인 폴더를 다시 읽지 못했습니다: ${failure.message}`); } installDropped(); }, 500);
    });
    watcher.on('error', failure => { watcher.close(); console.warn(`플러그인 폴더 감시 오류: ${failure.message}`); });
  } catch (failure) { console.warn(`플러그인 폴더를 감시할 수 없습니다: ${failure.message}`); }

  return {
    // Called for every server process the app starts, once it is listening: a new server has none of the old sessions.
    push: () => { push(); manager.serverReset(); },
    // Workspace session traffic from the server for a plugin host.
    fromServer: message => manager.fromServer(message),
    // A feedback submission from the server: { meta, images:[{path, mime}] } -> { ok, issueUrl?, issueNumber?, error? }.
    submitFeedback: ({ meta, images }) => manager.submitFeedback({ meta, images }),
    close: () => manager.close()
  };
}
