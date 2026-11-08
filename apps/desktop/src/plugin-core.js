// Plugins: folders dropped into <userData>/plugins that add a feature MoonerADE does not ship (docs/PLUGINS.md). Off by
// default. Turning plugins on and approving each one happens in native dialogs; an approval pins the folder's content hash,
// so a plugin that changes on disk (an update, or something in a terminal editing it) stops until it is approved again.
// Each approved plugin runs as its own Node process and talks to the main process over IPC only.
// Kept free of Electron so it can be tested: `crypto` is safeStorage or a stand-in, `spawnHost` and `ask` are injected.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const PLUGIN_API = 1;
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MCP_NAME = /^[a-z][a-z0-9_]{1,39}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const FIELD_KEY = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const ACTION_ID = /^[a-z][a-z0-9-]{0,31}$/;
// A prefix may not reach into what the app, Node or the agents read themselves, nor into variables that run code or move
// trust in every shell and tool started there (shell startup, proxies, TLS trust, language runtimes).
const RESERVED_PREFIX = /^(ADE_|NODE_|ELECTRON_|NPM_|CLAUDE|CODEX|OPENAI|ANTHROPIC|GIT_|SSH_|PATH|HOME|USER|SHELL|TERM|LD_|DYLD_|BASH_|PROMPT_|HTTP_|HTTPS_|ALL_|FTP_|SSL_|CURL_|REQUESTS_|JAVA_|JDK_|DOTNET_|COR_|CORECLR_|PYTHON|PIP_|SUDO_|XDG_|OTEL_|MCP_|DISABLE_|MAX_|API_)/;
const MAX_FILES = 2000, MAX_BYTES = 32 * 1024 * 1024, MAX_MANIFEST = 64 * 1024;
export const MAX_STORAGE = 64 * 1024;
const RESTARTS = 3, RESTART_WINDOW_MS = 60_000, ACTION_TIMEOUT_MS = 5 * 60_000;

const fail = (message, code = 'PLUGIN_INVALID') => Object.assign(new Error(message), { code });
// The name and description appear in MoonerADE's own approval dialog: no control or bidirectional formatting characters
// that could fake its layout or reorder what it says (the description keeps single line breaks).
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const plainText = text => text.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(new RegExp(UNSAFE_TEXT.source, 'g'), '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
const str = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
// A path inside the plugin folder, written with forward slashes, never absolute and never climbing out. No `:` anywhere:
// besides drive letters, on NTFS `host.js:x.js` names an alternate data stream, which the tree hash never reads.
function relative(value, what) {
  if (!str(value, 200) || /^[\\/]|[\\:]/.test(value)) throw fail(`${what} 경로가 올바르지 않습니다.`);
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw fail(`${what} 경로가 올바르지 않습니다.`);
  return parts.join('/');
}

export function validManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('plugin.json이 객체가 아닙니다.');
  if (value.apiVersion !== PLUGIN_API) throw fail(`이 MoonerADE가 모르는 플러그인 API 버전입니다 (${value.apiVersion}).`);
  if (!str(value.id, 40) || !ID.test(value.id)) throw fail('플러그인 id가 올바르지 않습니다.');
  if (!str(value.name, 60) || UNSAFE_TEXT.test(value.name) || !value.name.trim()) throw fail('플러그인 이름이 없거나 쓸 수 없는 문자가 있습니다.');
  if (!str(value.version, 32) || !/^[0-9A-Za-z.+-]+$/.test(value.version)) throw fail('플러그인 버전이 올바르지 않습니다.');
  const manifest = { id: value.id, name: value.name, version: value.version, apiVersion: PLUGIN_API, description: typeof value.description === 'string' ? plainText(value.description.slice(0, 300)) : '', main: relative(value.main, 'main') };
  if (!/\.(m?js)$/.test(manifest.main)) throw fail('main은 .js 또는 .mjs 파일이어야 합니다.');
  if (value.terminal !== undefined) {
    const terminal = value.terminal;
    if (!terminal || typeof terminal !== 'object') throw fail('terminal 항목이 올바르지 않습니다.');
    manifest.terminal = {};
    if (terminal.bin !== undefined) manifest.terminal.bin = relative(terminal.bin, 'terminal.bin');
    if (terminal.envPrefix !== undefined) {
      if (!str(terminal.envPrefix, 32) || !/^[A-Z][A-Z0-9]*_([A-Z0-9]+_)*$/.test(terminal.envPrefix) || terminal.envPrefix.length < 4 || RESERVED_PREFIX.test(terminal.envPrefix)) throw fail('terminal.envPrefix가 올바르지 않습니다.');
      manifest.terminal.envPrefix = terminal.envPrefix;
    }
  }
  if (value.mcp !== undefined) {
    const mcp = value.mcp;
    if (!mcp || typeof mcp !== 'object' || !str(mcp.name, 40) || !MCP_NAME.test(mcp.name)) throw fail('mcp.name이 올바르지 않습니다.');
    const args = mcp.args ?? [];
    if (!Array.isArray(args) || args.length > 8 || !args.every(arg => str(arg, 200) && !arg.includes("'"))) throw fail('mcp.args가 올바르지 않습니다.');
    manifest.mcp = { name: mcp.name, script: relative(mcp.script, 'mcp.script'), args: [...args] };
  }
  return manifest;
}

// SHA-256 over every file's relative path, size and bytes, in path order. Links are refused: what is hashed must be what runs.
// So is anything that is neither a file nor a folder: Node would read a FIFO or a device found at a module path, and the
// hash would not cover what it reads.
export function treeHash(dir) {
  const files = [];
  let total = 0;
  const walk = (folder, prefix) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const full = path.join(folder, entry.name), rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw fail(`링크는 플러그인에 넣을 수 없습니다: ${rel}`);
      if (stat.isDirectory()) walk(full, rel);
      else if (stat.isFile()) {
        total += stat.size;
        if (files.push({ rel, full, size: stat.size }) > MAX_FILES || total > MAX_BYTES) throw fail('플러그인 파일이 너무 많거나 큽니다.');
      } else throw fail(`파일이나 폴더가 아닌 것은 플러그인에 넣을 수 없습니다: ${rel}`);
    }
  };
  walk(dir, '');
  const hash = createHash('sha256');
  for (const file of files) { hash.update(`${file.rel}\0${file.size}\0`); hash.update(fs.readFileSync(file.full)); }
  return hash.digest('hex');
}

// Every folder directly in `dir` that has a plugin.json. A folder that fails is listed with its error instead of dropped,
// so the settings page can say why. A second folder with an id already taken is refused.
export function scanPlugins(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const seen = new Set(), list = [];
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const folder = path.join(dir, entry.name), item = { folder: entry.name, dir: folder, manifest: null, hash: null, error: null };
    try {
      const file = path.join(folder, 'plugin.json');
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isFile() || stat.size > MAX_MANIFEST) throw fail('plugin.json이 올바르지 않습니다.');
      item.manifest = validManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (seen.has(item.manifest.id)) throw fail(`같은 id(${item.manifest.id})의 플러그인이 이미 있습니다.`);
      seen.add(item.manifest.id);
      for (const target of [item.manifest.main, item.manifest.mcp?.script].filter(Boolean)) if (!fs.lstatSync(path.join(folder, target), { throwIfNoEntry: false })?.isFile()) throw fail(`${target} 파일이 없습니다.`);
      if (item.manifest.terminal?.bin && !fs.lstatSync(path.join(folder, item.manifest.terminal.bin), { throwIfNoEntry: false })?.isDirectory()) throw fail(`${item.manifest.terminal.bin} 폴더가 없습니다.`);
      item.hash = treeHash(folder);
    } catch (error) { item.error = error instanceof SyntaxError ? 'plugin.json을 읽을 수 없습니다.' : error.message; }
    list.push(item);
  }
  return list;
}

// ---- sealed settings ------------------------------------------------------------------------------------------------
export const emptyPluginState = () => ({ version: 1, enabled: false, approved: {}, data: {} });
export function validPluginState(value) {
  const state = emptyPluginState();
  if (!value || typeof value !== 'object' || value.version !== 1) return state;
  state.enabled = value.enabled === true;
  for (const [id, entry] of Object.entries(value.approved ?? {})) {
    if (ID.test(id) && entry && /^[a-f0-9]{64}$/.test(entry.hash) && str(entry.folder, 200) && Number.isFinite(entry.approvedAt)) state.approved[id] = { hash: entry.hash, folder: entry.folder, version: String(entry.version ?? '').slice(0, 32), approvedAt: entry.approvedAt };
  }
  for (const [id, data] of Object.entries(value.data ?? {})) if (ID.test(id) && typeof data === 'string' && data.length <= MAX_STORAGE) state.data[id] = data;
  return state;
}
// Sealed like remote.bin: without working encryption nothing is stored and plugins stay off.
export function createPluginStore({ file, crypto }) {
  let state = emptyPluginState(), problem = null;
  return {
    get state() { return state; },
    get problem() { return problem; },
    get available() { return crypto.isEncryptionAvailable(); },
    load() {
      problem = null; state = emptyPluginState();
      if (!crypto.isEncryptionAvailable()) { problem = 'unavailable'; return state; }
      let sealed;
      try { sealed = fs.readFileSync(file); } catch (error) { if (error.code !== 'ENOENT') problem = 'unreadable'; return state; }
      try { state = validPluginState(JSON.parse(crypto.decryptString(sealed))); } catch { problem = 'unreadable'; }
      return state;
    },
    save(next) {
      if (!crypto.isEncryptionAvailable()) throw fail('이 컴퓨터에서는 설정을 안전하게 암호화할 수 없어 플러그인을 쓸 수 없습니다.', 'ENCRYPTION_UNAVAILABLE');
      const value = validPluginState(next), sealed = crypto.encryptString(JSON.stringify(value));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      try { fs.writeFileSync(tmp, sealed, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
      state = value; problem = null;
      return state;
    },
    update(change) { return this.save(change(state)); }
  };
}

// ---- what a plugin may show and add ------------------------------------------------------------------------------
const TONES = ['ok', 'warn', 'error', 'info'];
// The settings page draws this as plain text; nothing a plugin sends becomes markup.
export function validView(view) {
  if (!view || typeof view !== 'object') return null;
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  const list = (value, max) => Array.isArray(value) ? value.slice(0, max) : [];
  return {
    status: view.status && TONES.includes(view.status.tone) ? { tone: view.status.tone, text: text(view.status.text, 300) } : null,
    info: list(view.info, 20).filter(item => item && str(item.label, 60)).map(item => ({ label: item.label, value: text(item.value, 2000), mono: item.mono === true, copy: item.copy === true })),
    fields: list(view.fields, 10).filter(item => item && FIELD_KEY.test(item.key ?? '') && str(item.label, 60)).map(item => ({ key: item.key, label: item.label, value: text(item.value, 4096), placeholder: text(item.placeholder, 200), hint: text(item.hint, 300) })),
    actions: list(view.actions, 8).filter(item => item && ACTION_ID.test(item.id ?? '') && str(item.label, 40)).map(item => ({ id: item.id, label: item.label, primary: item.primary === true }))
  };
}
// Terminal additions are limited to what the manifest declared: its own env prefix, its own bin folder, its own MCP script.
export function pluginTerminal(manifest, dir, report, nodeBinary) {
  const env = {};
  if (manifest.terminal?.envPrefix && report?.env && typeof report.env === 'object') {
    for (const [name, value] of Object.entries(report.env).slice(0, 32)) if (ENV_NAME.test(name) && name.startsWith(manifest.terminal.envPrefix) && typeof value === 'string' && value.length <= 4096 && !value.includes('\0')) env[name] = value;
  }
  const extra = Array.isArray(report?.mcpArgs) ? report.mcpArgs.slice(0, 16).filter(arg => str(arg, 1024) && !arg.includes("'")) : [];
  return {
    id: manifest.id, env,
    path: manifest.terminal?.bin ? [path.join(dir, ...manifest.terminal.bin.split('/'))] : [],
    mcp: manifest.mcp ? { name: manifest.mcp.name, command: nodeBinary, args: [path.join(dir, ...manifest.mcp.script.split('/')), ...manifest.mcp.args, ...extra] } : null
  };
}

// ---- the manager --------------------------------------------------------------------------------------------------
// spawnHost({ id, dir, main }) returns a ChildProcess-like object (send, kill, connected, on('message'|'exit')).
// ask({ title, message, detail, buttons, defaultId, cancelId }) resolves the chosen button index.
export function createPluginManager({ dir, dataRoot, store, spawnHost, ask, nodeBinary, appVersion = '0.0.0', onChange = () => {}, onTerminal = () => {}, log = console }) {
  let list = [], closing = false;
  const hosts = new Map(); // id -> running host
  const crashes = new Map(); // id -> recent crash times, kept across restarts

  const approvedFor = item => item.manifest && store.state.approved[item.manifest.id];
  const eligible = item => !item.error && store.state.enabled && approvedFor(item)?.hash === item.hash && approvedFor(item)?.folder === item.folder;
  function stateOf(item) {
    if (item.error) return 'invalid';
    const approval = approvedFor(item);
    if (!approval) return 'new';
    if (approval.hash !== item.hash || approval.folder !== item.folder) return 'changed';
    if (!store.state.enabled) return 'off';
    return hosts.get(item.manifest.id)?.status ?? 'stopped';
  }
  function snapshot() {
    return {
      available: store.available, problem: store.problem, enabled: store.state.enabled, dir,
      plugins: list.map(item => {
        const host = item.manifest && hosts.get(item.manifest.id);
        return {
          folder: item.folder, id: item.manifest?.id ?? null, name: item.manifest?.name ?? item.folder, version: item.manifest?.version ?? null,
          description: item.manifest?.description ?? '', hash: item.hash, state: stateOf(item), error: item.error ?? host?.error ?? null,
          terminal: Boolean(item.manifest?.terminal), mcp: item.manifest?.mcp?.name ?? null, view: host?.status === 'running' ? host.view : null
        };
      })
    };
  }
  const changed = () => onChange(snapshot());
  function emitTerminal() {
    onTerminal({ node: nodeBinary, plugins: [...hosts.values()].filter(host => host.status === 'running' && host.terminal).map(host => host.terminal) });
  }

  // ---- hosts ------------------------------------------------------------------------------------------------------
  function start(item) {
    const { manifest } = item;
    // Hashed again right before it runs: what starts is what was approved.
    let hash;
    try { hash = treeHash(item.dir); } catch (error) { item.error = error.message; return; }
    if (hash !== item.hash) { item.hash = hash; return; }
    const dataDir = path.join(dataRoot, manifest.id);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const host = { id: manifest.id, item, child: null, status: 'starting', error: null, view: null, terminal: null, pending: new Map(), confirms: Promise.resolve(), stopping: false };
    hosts.set(manifest.id, host);
    let child;
    try { child = spawnHost({ id: manifest.id, dir: item.dir, main: path.join(item.dir, ...manifest.main.split('/')) }); }
    catch (error) { host.status = 'error'; host.error = error.message; return; }
    host.child = child;
    child.on('message', message => { try { onHostMessage(host, message); } catch (error) { log.warn(`[plugin ${host.id}] 메시지 처리 실패: ${error.message}`); } });
    child.on('exit', code => onHostExit(host, code));
    child.on('error', error => { host.error = error.message; });
    let storage = null;
    try { storage = store.state.data[manifest.id] ? JSON.parse(store.state.data[manifest.id]) : null; } catch { storage = null; }
    child.send({ type: 'init', apiVersion: PLUGIN_API, id: manifest.id, appVersion, dataDir, storage });
  }
  function stop(host) {
    host.stopping = true;
    for (const { reject } of host.pending.values()) reject(fail('플러그인이 멈췄습니다.', 'PLUGIN_STOPPED'));
    host.pending.clear();
    const child = host.child;
    if (child && child.exitCode === null) {
      if (child.connected) child.send({ type: 'shutdown' });
      setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2000).unref?.();
    }
    if (hosts.get(host.id) === host) hosts.delete(host.id);
  }
  function onHostExit(host, code) {
    for (const { reject } of host.pending.values()) reject(fail('플러그인이 종료되었습니다.', 'PLUGIN_STOPPED'));
    host.pending.clear();
    const wasRunning = host.terminal !== null;
    if (hosts.get(host.id) !== host) { if (wasRunning) emitTerminal(); return; }
    host.terminal = null;
    if (host.stopping || closing) { hosts.delete(host.id); emitTerminal(); changed(); return; }
    host.status = 'error'; host.error = `플러그인 프로세스가 종료되었습니다 (exit ${code}).`;
    emitTerminal();
    const now = Date.now();
    const recent = [...(crashes.get(host.id) ?? []).filter(at => now - at < RESTART_WINDOW_MS), now];
    crashes.set(host.id, recent);
    if (recent.length <= RESTARTS) setTimeout(() => { if (hosts.get(host.id) === host && !closing) { hosts.delete(host.id); reconcile(); } }, 1000 * recent.length).unref?.();
    else host.error = `${host.error} 계속 종료되어 다시 시작하지 않습니다.`;
    changed();
  }
  function onHostMessage(host, message) {
    if (hosts.get(host.id) !== host || !message || typeof message.type !== 'string') return;
    const { manifest } = host.item;
    switch (message.type) {
      case 'ready': host.status = 'running'; host.error = null; changed(); emitTerminal(); break;
      case 'view': host.view = validView(message.view); changed(); break;
      case 'storage': {
        const text = JSON.stringify(message.value ?? null);
        if (text.length > MAX_STORAGE) { log.warn(`[plugin ${host.id}] 저장할 데이터가 너무 큽니다.`); break; }
        store.update(state => ({ ...state, data: { ...state.data, [manifest.id]: text } }));
        break;
      }
      case 'confirm': {
        const id = message.id;
        // One dialog at a time, always titled with the plugin's name so it cannot pass for MoonerADE's own.
        host.confirms = host.confirms.then(async () => {
          const answer = await ask({
            type: 'warning', title: `플러그인: ${manifest.name}`, message: String(message.message ?? '').slice(0, 300) || '계속할까요?',
            detail: `${String(message.detail ?? '').slice(0, 2000)}\n\n이 확인 창은 플러그인 “${manifest.name}”(${manifest.id})이 요청했습니다.`.trim(),
            buttons: [String(message.confirmLabel ?? '').slice(0, 30) || '확인', '취소'], defaultId: 1, cancelId: 1
          }).catch(() => 1);
          if (host.child?.connected) host.child.send({ type: 'confirm-result', id, ok: answer === 0 });
        });
        break;
      }
      // `enabled: false` withdraws the additions (e.g. a plugin that is not set up yet).
      case 'terminal': host.terminal = message.enabled === false ? null : pluginTerminal(manifest, host.item.dir, message, nodeBinary); if (host.status === 'running') emitTerminal(); break;
      case 'action-result': {
        const pending = host.pending.get(message.id);
        if (!pending) break;
        host.pending.delete(message.id);
        message.ok ? pending.resolve(message.message ?? null) : pending.reject(fail(String(message.error ?? '플러그인 작업이 실패했습니다.').slice(0, 500), 'PLUGIN_ACTION'));
        break;
      }
      case 'log': log[message.level === 'error' ? 'error' : message.level === 'warn' ? 'warn' : 'log'](`[plugin ${host.id}] ${String(message.message ?? '').slice(0, 2000)}`); break;
    }
  }
  // Starts what should run and stops what should not.
  function reconcile() {
    // A running plugin whose files changed no longer matches its approval and stops; one approved again with new files
    // restarts on them.
    for (const host of [...hosts.values()]) {
      const item = list.find(entry => entry.manifest?.id === host.id);
      if (!item || !eligible(item) || item.hash !== host.item.hash || item.folder !== host.item.folder) stop(host);
      else host.item = item;
    }
    for (const item of list) if (eligible(item) && !hosts.has(item.manifest.id)) start(item);
    emitTerminal();
    changed();
  }
  function rescan() {
    list = scanPlugins(dir);
    reconcile();
    return snapshot();
  }
  // Starts a plugin that kept crashing once more.
  function restart(id) {
    const host = hosts.get(id);
    crashes.delete(id);
    if (host) stop(host);
    rescan();
    return snapshot();
  }

  // ---- steps the settings page can start (each grant goes through `ask`) ------------------------------------------
  async function setEnabled(on) {
    if (!on) { store.update(state => ({ ...state, enabled: false })); reconcile(); return snapshot(); }
    if (store.state.enabled) return snapshot();
    const answer = await ask({
      type: 'warning', title: '플러그인 켜기', message: '플러그인 기능을 켤까요?',
      detail: `플러그인은 MoonerADE와 같은 권한으로 이 컴퓨터에서 실행되는 프로그램입니다. 켜도 플러그인 폴더의 플러그인은 하나씩 직접 승인해야 실행됩니다. 믿을 수 있는 곳(MoonerADE 릴리스)에서 받은 플러그인만 승인하세요.\n\n플러그인 폴더: ${dir}`,
      buttons: ['켜기', '취소'], defaultId: 1, cancelId: 1
    });
    if (answer !== 0) return snapshot();
    store.update(state => ({ ...state, enabled: true }));
    rescan();
    return snapshot();
  }
  async function approve(folder) {
    if (!store.state.enabled) throw fail('먼저 플러그인 기능을 켜세요.', 'PLUGINS_OFF');
    rescan();
    const item = list.find(entry => entry.folder === folder);
    if (!item) throw fail('플러그인을 찾을 수 없습니다.', 'NOT_FOUND');
    if (item.error) throw fail(item.error);
    const { manifest } = item, grants = [
      '별도 프로세스로 실행되며 이 컴퓨터에서 MoonerADE와 같은 권한을 갖습니다.',
      manifest.terminal && `새로 여는 MoonerADE 터미널에 명령${manifest.terminal.bin ? `(${manifest.terminal.bin} 폴더)` : ''}과 환경 변수${manifest.terminal.envPrefix ? `(${manifest.terminal.envPrefix}*)` : ''}를 추가합니다.`,
      manifest.mcp && `MoonerADE 터미널에서 실행한 Claude Code와 Codex에 MCP 도구(${manifest.mcp.name})를 줍니다. 에이전트가 그 도구를 직접 쓸 수 있습니다.`
    ].filter(Boolean);
    const answer = await ask({
      type: 'warning', title: '플러그인 승인', message: `“${manifest.name}” ${manifest.version} 플러그인을 실행할까요?`,
      detail: `${manifest.description ? `${manifest.description}\n\n` : ''}이 플러그인은:\n${grants.map(line => `• ${line}`).join('\n')}\n\nid: ${manifest.id}\n폴더: ${item.dir}\nSHA-256: ${item.hash}\n\n파일이 바뀌면 다시 승인할 때까지 실행되지 않습니다.`,
      buttons: ['승인하고 실행', '취소'], defaultId: 1, cancelId: 1
    });
    if (answer !== 0) return snapshot();
    // What the user saw is what gets pinned: a change during the dialog voids it.
    if (treeHash(item.dir) !== item.hash) throw fail('확인하는 동안 플러그인 파일이 바뀌었습니다. 다시 시도하세요.');
    store.update(state => ({ ...state, approved: { ...state.approved, [manifest.id]: { hash: item.hash, folder: item.folder, version: manifest.version, approvedAt: Date.now() } } }));
    reconcile();
    return snapshot();
  }
  // Keeps the plugin's saved data (its keys and settings) unless `forget` is set.
  function revoke(id, { forget = false } = {}) {
    store.update(state => {
      const approved = { ...state.approved }, data = { ...state.data };
      delete approved[id]; if (forget) delete data[id];
      return { ...state, approved, data };
    });
    reconcile();
    return snapshot();
  }
  async function action(id, actionId, values) {
    const host = hosts.get(id);
    if (!host || host.status !== 'running' || !host.child?.connected) throw fail('플러그인이 실행 중이 아닙니다.', 'PLUGIN_STOPPED');
    if (!ACTION_ID.test(String(actionId))) throw fail('잘못된 작업입니다.');
    const clean = {};
    if (values && typeof values === 'object') for (const [key, value] of Object.entries(values).slice(0, 10)) if (FIELD_KEY.test(key) && typeof value === 'string') clean[key] = value.slice(0, 4096);
    const requestId = randomUUID();
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { host.pending.delete(requestId); reject(fail('플러그인이 응답하지 않습니다.', 'PLUGIN_TIMEOUT')); }, ACTION_TIMEOUT_MS);
      timer.unref?.();
      host.pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      host.child.send({ type: 'action', id: requestId, action: String(actionId), values: clean });
    });
    return { ...snapshot(), message: typeof message === 'string' ? message.slice(0, 500) : null };
  }
  function close() { closing = true; for (const host of [...hosts.values()]) stop(host); }

  return { snapshot, rescan, restart, setEnabled, approve, revoke, action, close, emitTerminal };
}
