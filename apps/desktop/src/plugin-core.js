// Plugins: folders dropped into <userData>/plugins that add a feature MoonerADE does not ship (docs/PLUGINS.md). Off by
// default. Turning plugins on and approving each one happens in native dialogs; an approval pins the folder's content hash,
// so a plugin that changes on disk (an update, or something in a terminal editing it) stops until it is approved again.
// Each approved plugin runs as its own Node process and talks to the main process over IPC only.
// A plugin .zip is installed only after one native dialog that shows what approving it shows (installZip).
// Kept free of Electron so it can be tested: `crypto` is safeStorage or a stand-in, `spawnHost`, `ask` and `extractZip` are injected.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CHECK_EVERY_MS, DEFAULT_UPDATE_MODE, FIRST_CHECK_MS, UPDATE_MODES, credentialLabel, isNewer, validSource, versionText } from './plugin-updates.js';

export const PLUGIN_API = 1;
// What this MoonerADE understands beyond the apiVersion 1 basics; sent in `init` so a plugin can tell.
export const PLUGIN_FEATURES = ['view.setup', 'view.lists', 'updates'];
const STEP_ID = /^[a-z][a-z0-9-]{0,31}$/;
const ITEM_ID = /^[\w.-]{1,64}$/;
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MCP_NAME = /^[a-z][a-z0-9_]{1,39}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const FIELD_KEY = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const ACTION_ID = /^[a-z][a-z0-9-]{0,31}$/;
// An MCP tool name as the agents see it (Claude: mcp__<server>__<tool>, Codex: disabled_tools). Also safe inside TOML literal strings.
export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
// A prefix may not reach into what the app, Node or the agents read themselves, nor into variables that run code or move
// trust in every shell and tool started there (shell startup, proxies, TLS trust, language runtimes).
const RESERVED_PREFIX = /^(ADE_|NODE_|ELECTRON_|NPM_|CLAUDE|CODEX|OPENAI|ANTHROPIC|GIT_|SSH_|PATH|HOME|USER|SHELL|TERM|LD_|DYLD_|BASH_|PROMPT_|HTTP_|HTTPS_|ALL_|FTP_|SSL_|CURL_|REQUESTS_|JAVA_|JDK_|DOTNET_|COR_|CORECLR_|PYTHON|PIP_|SUDO_|XDG_|OTEL_|MCP_|DISABLE_|MAX_|API_)/;
export const MAX_FILES = 2000, MAX_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST = 64 * 1024;
export const MAX_STORAGE = 64 * 1024;
const RESTARTS = 3, RESTART_WINDOW_MS = 60_000, ACTION_TIMEOUT_MS = 5 * 60_000;
// OS notifications a plugin may raise: this many per minute, more are dropped.
const NOTIFY_PER_MINUTE = 10;
// Workspace relay: what a host may ask for, and how much output may wait for a host that stops reading before its session is closed.
const SESSION_ID = /^[\w-]{1,64}$/, WORKSPACE_BACKLOG = 8 * 1024 * 1024;
// Feedback submission (plugins that declared `feedback`): how long an upload may take before MoonerADE gives up on the answer.
export const FEEDBACK_TIMEOUT_MS = 120_000;
const NO_FEEDBACK_PLUGIN = '원격 접속 플러그인을 설치하고 로그인하면 피드백을 제출할 수 있습니다.';

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
    // Only for chats (never terminals), and told which chat it serves. A plugin that talks between chats needs this.
    if (mcp.chatOnly !== undefined) {
      if (typeof mcp.chatOnly !== 'boolean') throw fail('mcp.chatOnly가 올바르지 않습니다.');
      if (mcp.chatOnly) manifest.mcp.chatOnly = true;
    }
  }
  if (value.workspace !== undefined) {
    if (typeof value.workspace !== 'boolean') throw fail('workspace 항목이 올바르지 않습니다.');
    if (value.workspace) manifest.workspace = true;
  }
  if (value.feedback !== undefined) {
    if (typeof value.feedback !== 'boolean') throw fail('feedback 항목이 올바르지 않습니다.');
    if (value.feedback) manifest.feedback = true;
  }
  // Where updates come from: a GitHub repository's releases (plugin-updates.js).
  if (value.source !== undefined) manifest.source = validSource(value.source, manifest.id);
  // The steps that make the plugin work, shown as a guide before it even runs; the running plugin reports how far it got
  // (view.setup). Shown by MoonerADE as plain text.
  if (value.setup !== undefined) {
    if (!Array.isArray(value.setup) || value.setup.length > 8) throw fail('setup 항목이 올바르지 않습니다.');
    const seen = new Set();
    manifest.setup = value.setup.map(step => {
      if (!step || typeof step !== 'object' || !STEP_ID.test(step.id ?? '') || seen.has(step.id)) throw fail('setup 단계의 id가 올바르지 않습니다.');
      if (!str(step.label, 60) || UNSAFE_TEXT.test(step.label)) throw fail('setup 단계의 label이 올바르지 않습니다.');
      seen.add(step.id);
      return { id: step.id, label: step.label, detail: typeof step.detail === 'string' ? plainText(step.detail.slice(0, 300)) : '', ...(step.optional === true && { optional: true }) };
    });
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

// The checked plugin.json of one plugin folder.
export function readManifest(folder) {
  const file = path.join(folder, 'plugin.json');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) throw fail('plugin.json이 없습니다.');
  if (!stat.isFile() || stat.size > MAX_MANIFEST) throw fail('plugin.json이 올바르지 않습니다.');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error instanceof SyntaxError) throw fail('plugin.json을 읽을 수 없습니다.'); throw error; }
  return validManifest(value);
}
// The files and folder the manifest names must be there (and be a file / a folder, not a link).
export function checkPluginFiles(folder, manifest) {
  for (const target of [manifest.main, manifest.mcp?.script].filter(Boolean)) if (!fs.lstatSync(path.join(folder, target), { throwIfNoEntry: false })?.isFile()) throw fail(`${target} 파일이 없습니다.`);
  if (manifest.terminal?.bin && !fs.lstatSync(path.join(folder, manifest.terminal.bin), { throwIfNoEntry: false })?.isDirectory()) throw fail(`${manifest.terminal.bin} 폴더가 없습니다.`);
}

// Every folder directly in `dir` that has a plugin.json. A folder that fails is listed with its error instead of dropped,
// so the settings page can say why. A second folder with an id already taken is refused.
// `builtin` marks the plugins that ship inside the app (their folder key is `builtin:<name>`); `seen` carries ids already taken,
// so a plugin in the user's folder can never shadow a built-in one.
export function scanPlugins(dir, { builtin = false, seen = new Set() } = {}) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const list = [];
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const folder = path.join(dir, entry.name), item = { folder: builtin ? `builtin:${entry.name}` : entry.name, dir: folder, manifest: null, hash: null, error: null, ...(builtin && { builtin: true }) };
    if (!fs.lstatSync(path.join(folder, 'plugin.json'), { throwIfNoEntry: false })) continue;
    try {
      item.manifest = readManifest(folder);
      if (seen.has(item.manifest.id)) throw fail(`같은 id(${item.manifest.id})의 플러그인이 이미 있습니다.`);
      seen.add(item.manifest.id);
      checkPluginFiles(folder, item.manifest);
      item.hash = treeHash(folder);
      item.commands = binCommands(folder, item.manifest);
    } catch (error) { item.error = error.message; }
    list.push(item);
  }
  return list;
}

// The commands a plugin's terminal.bin folder puts on PATH, by name: `x`, `x.cmd` and `x.ps1` are one command. Script files
// (.js and the like) are what those launchers run, not commands of their own. Shown on the settings page only.
const LAUNCHER = /^[^.]+(\.(cmd|bat|ps1|exe|com|sh))?$/i;
export function binCommands(folder, manifest) {
  if (!manifest.terminal?.bin) return [];
  let entries;
  try { entries = fs.readdirSync(path.join(folder, ...manifest.terminal.bin.split('/')), { withFileTypes: true }); } catch { return []; }
  const names = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || !LAUNCHER.test(entry.name)) continue;
    const name = plainText(entry.name.replace(/\.[^.]+$/, '')).slice(0, 60);
    if (name) names.add(name);
  }
  return [...names].sort().slice(0, 20);
}

// ---- plugin zips ----------------------------------------------------------------------------------------------------
// The OS's own bsdtar reads zips; no unzip code of our own. (GNU tar cannot, so elsewhere a `bsdtar` on PATH is used.)
export function systemTar(platform = process.platform, env = process.env) {
  if (platform === 'win32') return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe');
  if (platform === 'darwin') return '/usr/bin/tar';
  return 'bsdtar';
}
const runFile = (file, args) => new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
  if (error) reject(fail(`zip을 풀 수 없습니다: ${String(stderr || error.message).trim().split(/\r?\n/)[0].slice(0, 300)}`, 'PLUGIN_ZIP'));
  else resolve(stdout);
}));
// What a zip may hold, from `tar -tf` (names) and `tar -tvf` (types and sizes), checked before anything is written:
// only files and folders, relative paths that stay inside, and no more than a plugin folder may hold.
export function checkZipListing(names, verbose) {
  const lines = text => text.split(/\r?\n/).filter(line => line.length > 0);
  const list = lines(names), detail = lines(verbose);
  if (list.length === 0) throw fail('zip이 비어 있습니다.', 'PLUGIN_ZIP');
  if (list.length !== detail.length) throw fail('zip 안의 이름을 읽을 수 없습니다.', 'PLUGIN_ZIP');
  let files = 0, bytes = 0;
  for (const [index, name] of list.entries()) {
    const parts = name.replace(/\/+$/, '').split(/[\\/]/);
    if (/^[\\/]/.test(name) || name.includes(':') || name.includes('\0') || parts.some(part => part === '..' || part === '')) throw fail(`zip 안에 플러그인 폴더 밖을 가리키는 경로가 있습니다: ${name.slice(0, 200)}`, 'PLUGIN_ZIP');
    const match = /^([-d])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s/.exec(detail[index]);
    if (!match || / link to | -> /.test(detail[index])) throw fail(`링크나 파일이 아닌 것은 플러그인에 넣을 수 없습니다: ${name.slice(0, 200)}`, 'PLUGIN_ZIP');
    if (match[1] === '-') { files += 1; bytes += Number(match[2]); }
    if (files > MAX_FILES || bytes > MAX_BYTES) throw fail('플러그인 파일이 너무 많거나 큽니다.', 'PLUGIN_ZIP');
  }
}
// extractZip({ zip, dest }) fills the existing, empty folder `dest`.
export function createZipExtractor({ tar = systemTar(), run = runFile } = {}) {
  return async ({ zip, dest }) => {
    checkZipListing(await run(tar, ['-tf', zip]), await run(tar, ['-tvf', zip]));
    await run(tar, ['-xf', zip, '-C', dest]);
  };
}
// Finder adds these next to the folder it compressed.
const ZIP_EXTRAS = new Set(['__MACOSX', '.DS_Store']);
// plugin.json at the top of the zip, or inside its one top-level folder.
function zipPluginRoot(staging) {
  if (fs.lstatSync(path.join(staging, 'plugin.json'), { throwIfNoEntry: false })) return staging;
  const entries = fs.readdirSync(staging, { withFileTypes: true }).filter(entry => !ZIP_EXTRAS.has(entry.name));
  if (entries.length === 1 && entries[0].isDirectory() && fs.lstatSync(path.join(staging, entries[0].name, 'plugin.json'), { throwIfNoEntry: false })) return path.join(staging, entries[0].name);
  throw fail('zip 맨 위나 그 안의 폴더 하나에 plugin.json이 있어야 합니다.', 'PLUGIN_ZIP');
}
// Rename, or copy and remove when the plugin folder is on another volume.
function moveFolder(from, to) {
  try { fs.renameSync(from, to); return; } catch (error) { if (!['EXDEV', 'EPERM'].includes(error.code)) throw error; }
  try { fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true }); }
  catch (error) { fs.rmSync(to, { recursive: true, force: true }); throw error; }
  fs.rmSync(from, { recursive: true, force: true });
}

// ---- what a plugin is allowed, as the approval and install dialogs list it ------------------------------------------
export function grantsFor(manifest) {
  return [
    '별도 프로세스로 실행되며 이 컴퓨터에서 MoonerADE와 같은 권한을 갖습니다.',
    manifest.terminal && `새로 여는 MoonerADE 터미널에 명령${manifest.terminal.bin ? `(${manifest.terminal.bin} 폴더)` : ''}과 환경 변수${manifest.terminal.envPrefix ? `(${manifest.terminal.envPrefix}*)` : ''}를 추가합니다.`,
    manifest.mcp && `MoonerADE 터미널에서 실행한 Claude Code와 Codex에 MCP 도구(${manifest.mcp.name})를 줍니다. 에이전트가 그 도구를 직접 쓸 수 있습니다.`,
    manifest.workspace && '이 PC의 프로젝트와 터미널을 열고 조작할 수 있습니다.',
    manifest.feedback && '피드백 요청에서 제출한 피드백(본문과 스크린샷)을 받아 개발자에게 전송합니다.'
  ].filter(Boolean);
}
// `place` is the folder or zip line.
const sourceLine = manifest => manifest.source ? `\n업데이트 출처: github.com/${manifest.source.github} (릴리스)` : '';
const pluginDetail = (manifest, hash, place) => `${manifest.description ? `${manifest.description}\n\n` : ''}이 플러그인은:\n${grantsFor(manifest).map(line => `• ${line}`).join('\n')}\n\nid: ${manifest.id}${sourceLine(manifest)}\n${place}\nSHA-256: ${hash}`;
// What an update asks for that the installed version did not: new grants, or updates from another repository. An update
// that asks for more is never installed without the user seeing it, even in automatic mode.
export function updateReview(before, after) {
  const had = new Set(grantsFor(before)), review = grantsFor(after).filter(line => !had.has(line)).map(line => `새 권한: ${line}`);
  if ((before.source?.github ?? null) !== (after.source?.github ?? null)) review.push(`업데이트 출처가 바뀝니다: ${before.source ? `github.com/${before.source.github}` : '없음'} → ${after.source ? `github.com/${after.source.github}` : '없음'}`);
  return review;
}

// ---- sealed settings ------------------------------------------------------------------------------------------------
// `mcp[id]` is what the user turned off of a plugin's MCP server: all of it (`off`) or single tools (`disabled`).
// `builtin[id]` is the on/off choice for a plugin that ships with the app (on until the user turns it off).
// `updates[id]` is how a plugin is updated (`mode`: auto, notify or manual) and the newest version already announced.
// `github` is the GitHub account connected in MoonerADE for private plugin repositories: { token, login, via: 'pat'|'oauth' }.
export const emptyPluginState = () => ({ version: 1, enabled: false, approved: {}, data: {}, mcp: {}, builtin: {}, updates: {}, github: null });
export function validPluginState(value) {
  const state = emptyPluginState();
  if (!value || typeof value !== 'object' || value.version !== 1) return state;
  state.enabled = value.enabled === true;
  for (const [id, entry] of Object.entries(value.approved ?? {})) {
    if (ID.test(id) && entry && /^[a-f0-9]{64}$/.test(entry.hash) && str(entry.folder, 200) && Number.isFinite(entry.approvedAt)) state.approved[id] = { hash: entry.hash, folder: entry.folder, version: String(entry.version ?? '').slice(0, 32), approvedAt: entry.approvedAt };
  }
  for (const [id, data] of Object.entries(value.data ?? {})) if (ID.test(id) && typeof data === 'string' && data.length <= MAX_STORAGE) state.data[id] = data;
  for (const [id, entry] of Object.entries(value.builtin && typeof value.builtin === 'object' && !Array.isArray(value.builtin) ? value.builtin : {})) if (ID.test(id) && entry && typeof entry.enabled === 'boolean') state.builtin[id] = { enabled: entry.enabled };
  const mcp = value.mcp && typeof value.mcp === 'object' && !Array.isArray(value.mcp) ? value.mcp : {};
  for (const [id, entry] of Object.entries(mcp)) {
    if (!ID.test(id) || !entry || typeof entry !== 'object') continue;
    const disabled = [...new Set(Array.isArray(entry.disabled) ? entry.disabled.filter(name => typeof name === 'string' && TOOL_NAME.test(name)) : [])].slice(0, 200);
    if (entry.off === true || disabled.length) state.mcp[id] = { off: entry.off === true, disabled };
  }
  const updates = value.updates && typeof value.updates === 'object' && !Array.isArray(value.updates) ? value.updates : {};
  for (const [id, entry] of Object.entries(updates)) {
    if (!ID.test(id) || !entry || typeof entry !== 'object') continue;
    const next = {};
    if (UPDATE_MODES.includes(entry.mode)) next.mode = entry.mode;
    if (typeof entry.notified === 'string' && versionText(entry.notified)) next.notified = versionText(entry.notified);
    if (Object.keys(next).length) state.updates[id] = next;
  }
  const github = value.github;
  if (github && typeof github === 'object' && typeof github.token === 'string' && /^[\x21-\x7e]{20,255}$/.test(github.token) && typeof github.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(github.login)) {
    state.github = { token: github.token, login: github.login, via: github.via === 'oauth' ? 'oauth' : 'pat', at: Number.isFinite(github.at) ? github.at : 0 };
  }
  return state;
}
// A built-in plugin's storage is a plain file (0600) in its data folder, not sealed: it ships with the app and needs no approval,
// and on macOS sealing it asked for the Keychain password on every start (agent-bus saves its bus address each time).
const storageFile = dir => path.join(dir, 'storage.json');
const readStorageFile = dir => { try { return fs.readFileSync(storageFile(dir), 'utf8'); } catch { return null; } };
function writeStorageFile(dir, text) {
  if (readStorageFile(dir) === text) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${storageFile(dir)}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, storageFile(dir)); } finally { fs.rmSync(tmp, { force: true }); }
}

// Sealed with safeStorage: without working encryption nothing is stored and plugins stay off.
// On macOS every safeStorage call, even isEncryptionAvailable(), reads the key from the Keychain, which asks for the login password
// whenever the app's ad-hoc signature is not on the item's list. So nothing touches it until there is something sealed to read or
// something to seal; until then `available` assumes yes and save() still checks for real.
export function createPluginStore({ file, crypto }) {
  let state = emptyPluginState(), problem = null, available = null;
  const probe = () => (available = crypto.isEncryptionAvailable());
  return {
    get state() { return state; },
    get problem() { return problem; },
    get available() { return available ?? true; },
    load() {
      problem = null; state = emptyPluginState();
      let sealed;
      try { sealed = fs.readFileSync(file); } catch (error) { if (error.code !== 'ENOENT') problem = 'unreadable'; return state; }
      if (!probe()) { problem = 'unavailable'; return state; }
      try { state = validPluginState(JSON.parse(crypto.decryptString(sealed))); } catch { problem = 'unreadable'; }
      return state;
    },
    save(next) {
      if (!probe()) throw fail('이 컴퓨터에서는 설정을 안전하게 암호화할 수 없어 플러그인을 쓸 수 없습니다.', 'ENCRYPTION_UNAVAILABLE');
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
const FIELD_TYPES = ['text', 'select', 'switch', 'number'];
// How far a setup step got: done, todo (not started), active (in progress, e.g. waiting for a browser sign-in), error.
export const STEP_STATUS = ['done', 'todo', 'active', 'error'];
// The settings page draws this as plain text; nothing a plugin sends becomes markup.
export function validView(view) {
  if (!view || typeof view !== 'object') return null;
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  const list = (value, max) => Array.isArray(value) ? value.slice(0, max) : [];
  const keys = (value, test, max = 12) => [...new Set(list(value, max).filter(key => typeof key === 'string' && test.test(key)))];
  const button = item => ({ id: item.id, label: item.label, primary: item.primary === true, ...(item.danger === true && { danger: true }) });
  const validButton = item => item && ACTION_ID.test(item.id ?? '') && str(item.label, 40);
  return {
    status: view.status && TONES.includes(view.status.tone) ? { tone: view.status.tone, text: text(view.status.text, 300) } : null,
    // `key` lets a setup step show the row inside the step.
    info: list(view.info, 30).filter(item => item && str(item.label, 60)).map(item => ({ label: item.label, value: text(item.value, 2000), mono: item.mono === true, copy: item.copy === true, ...(FIELD_KEY.test(item.key ?? '') && { key: item.key }) })),
    // `type` is how the page draws the input: text (default), select (needs `options`), switch ('true' / 'false') or number. The value stays a string.
    fields: list(view.fields, 24).filter(item => item && FIELD_KEY.test(item.key ?? '') && str(item.label, 60)).map(item => {
      const type = FIELD_TYPES.includes(item.type) ? item.type : 'text';
      const options = type === 'select' ? list(item.options, 12).filter(option => option && str(option.value, 60) && str(option.label, 60)).map(option => ({ value: option.value, label: option.label })) : [];
      return { key: item.key, label: item.label, type: type === 'select' && !options.length ? 'text' : type, value: text(item.value, 4096), placeholder: text(item.placeholder, 200), hint: text(item.hint, 300), ...(item.required === true && { required: true }), ...(options.length && type === 'select' && { options }) };
    }),
    actions: list(view.actions, 12).filter(validButton).map(button),
    // Only the text to encode; the settings page draws the code itself.
    qr: view.qr && str(view.qr.value, 1000) ? { label: text(view.qr.label, 60), value: view.qr.value } : null,
    // How far each setup step got (merged with plugin.json `setup` by id), and which fields, info rows, buttons and the QR
    // code belong to it: those are drawn inside the step instead of in the settings below.
    setup: list(view.setup?.steps ?? view.setup, 8).filter(step => step && STEP_ID.test(step.id ?? '') && STEP_STATUS.includes(step.status)).map(step => ({
      id: step.id, status: step.status,
      ...(str(step.label, 60) && !UNSAFE_TEXT.test(step.label) && { label: step.label }),
      ...(typeof step.detail === 'string' && step.detail && { detail: plainText(step.detail.slice(0, 300)) }),
      ...(typeof step.optional === 'boolean' && { optional: step.optional }),
      fields: keys(step.fields, FIELD_KEY), info: keys(step.info, FIELD_KEY), actions: keys(step.actions, ACTION_ID, 4), ...(step.qr === true && { qr: true })
    })),
    // Things the user manages one by one (paired devices, keys, ...), each with its own buttons. A button sends `action`
    // with `item` set to the item's id.
    lists: list(view.lists, 4).filter(group => group && STEP_ID.test(group.id ?? '') && str(group.title, 60)).map(group => ({
      id: group.id, title: group.title, empty: text(group.empty, 200),
      items: list(group.items, 50).filter(item => item && ITEM_ID.test(item.id ?? '') && str(item.label, 100)).map(item => ({
        id: item.id, label: item.label, detail: text(item.detail, 300),
        ...(item.tag && TONES.includes(item.tag.tone) && str(item.tag.text, 20) && { tag: { text: item.tag.text, tone: item.tag.tone } }),
        actions: list(item.actions, 4).filter(validButton).map(button)
      }))
    }))
  };
}
// A short status-bar item. Single line: it sits between MoonerADE's own items.
export function validBadge(badge) {
  if (!badge || typeof badge !== 'object' || !TONES.includes(badge.tone) || typeof badge.text !== 'string') return null;
  const text = plainText(badge.text).replace(/\s+/g, ' ').slice(0, 24).trim();
  return text ? { text, tone: badge.tone } : null;
}
// Terminal additions are limited to what the manifest declared: its own env prefix, its own bin folder, its own MCP script.
// `builtin` plugins (shipped with the app, so trusted like the app) may also ask for their MCP tools to run without a permission prompt.
export function pluginTerminal(manifest, dir, report, nodeBinary, { builtin = false } = {}) {
  const env = {};
  if (manifest.terminal?.envPrefix && report?.env && typeof report.env === 'object') {
    for (const [name, value] of Object.entries(report.env).slice(0, 32)) if (ENV_NAME.test(name) && name.startsWith(manifest.terminal.envPrefix) && typeof value === 'string' && value.length <= 4096 && !value.includes('\0')) env[name] = value;
  }
  const extra = Array.isArray(report?.mcpArgs) ? report.mcpArgs.slice(0, 16).filter(arg => str(arg, 1024) && !arg.includes("'")) : [];
  return {
    id: manifest.id, env,
    path: manifest.terminal?.bin ? [path.join(dir, ...manifest.terminal.bin.split('/'))] : [],
    mcp: manifest.mcp ? { name: manifest.mcp.name, command: nodeBinary, args: [path.join(dir, ...manifest.mcp.script.split('/')), ...manifest.mcp.args, ...extra],
      ...(manifest.mcp.chatOnly && { chatOnly: true }), ...(builtin && report?.autoApprove === true && { autoApprove: true }) } : null
  };
}

// What an MCP server's tools/list said, as the settings page shows it: plain text, limited in size.
export function validTools(tools) {
  const seen = new Set(), list = [];
  const text = (value, max) => typeof value === 'string' ? plainText(value).slice(0, max) : '';
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== 'object' || !TOOL_NAME.test(tool.name ?? '') || seen.has(tool.name)) continue;
    seen.add(tool.name);
    const annotations = tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
    const properties = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
    const required = Array.isArray(schema.required) ? schema.required : [];
    list.push({
      name: tool.name, title: text(tool.title ?? annotations.title, 80), description: text(tool.description, 1000),
      readOnly: annotations.readOnlyHint === true, destructive: annotations.readOnlyHint !== true && annotations.destructiveHint === true,
      params: properties.filter(name => /^[\w.-]{1,64}$/.test(name)).slice(0, 20).map(name => ({ name, required: required.includes(name) }))
    });
    if (list.length >= 200) break;
  }
  return list;
}
// Asks a plugin's MCP server (stdio, one JSON-RPC message per line) which tools it has, the way an agent would, then ends it.
export function probeMcpTools({ command, args, cwd, env = process.env, timeoutMs = 15_000, spawnProcess = spawn, clientVersion = '0.0.0' }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcess(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); }
    catch (error) { reject(fail(`MCP 서버를 시작하지 못했습니다: ${error.message}`, 'MCP_PROBE')); return; }
    let buffer = '', done = false;
    const tools = [];
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      // A server that answered gets to end on its own when its input closes; one that failed is ended now.
      try { child.stdin.end(); } catch {}
      const kill = () => { if (child.exitCode === null && child.signalCode == null) child.kill(); };
      if (error) kill(); else setTimeout(kill, 1000).unref?.();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(fail('MCP 서버가 응답하지 않습니다.', 'MCP_TIMEOUT')), timeoutMs);
    const send = message => { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); } catch {} };
    const rpcError = error => fail(`MCP 서버가 오류로 답했습니다: ${String(error?.message ?? '').slice(0, 200)}`, 'MCP_PROBE');
    child.on('error', error => finish(fail(`MCP 서버를 시작하지 못했습니다: ${error.message}`, 'MCP_PROBE')));
    child.on('exit', code => finish(fail(`MCP 서버가 도구 목록을 주기 전에 종료되었습니다 (exit ${code}).`, 'MCP_PROBE')));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return finish(fail('MCP 서버의 응답이 너무 큽니다.', 'MCP_PROBE'));
      let end;
      while (!done && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (!message || typeof message !== 'object') continue;
        // A request from the server (roots/list, sampling, ...): this client offers none of them.
        if (typeof message.method === 'string') { if (message.id !== undefined && message.id !== null) send({ id: message.id, error: { code: -32601, message: 'Method not found' } }); continue; }
        if (message.id === 1) {
          if (message.error) return finish(rpcError(message.error));
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (Number.isInteger(message.id) && message.id >= 2) {
          if (message.error) return finish(rpcError(message.error));
          if (Array.isArray(message.result?.tools)) tools.push(...message.result.tools);
          const cursor = message.result?.nextCursor;
          if (typeof cursor === 'string' && cursor && message.id < 10 && tools.length < 200) send({ id: message.id + 1, method: 'tools/list', params: { cursor } });
          else finish(null, tools);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mooner-ade', version: clientVersion } } });
  });
}

// ---- the manager --------------------------------------------------------------------------------------------------
// spawnHost({ id, dir, main }) returns a ChildProcess-like object (send, kill, connected, on('message'|'exit')).
// ask({ title, message, detail, buttons, defaultId, cancelId }) resolves the chosen button index.
// builtinDir holds the plugins that ship with the app: they need no approval and no "plugins on" switch, only their own on/off (setBuiltin).
// toServer(message) hands a `plugin/workspace` message to the local server and returns false when there is none to take it.
// extractZip({ zip, dest }) unpacks a plugin zip into `dest` (default: the OS's bsdtar); zips are unpacked under `stagingRoot`.
// probeMcp({ command, args, cwd, env }) resolves the raw tools/list of a plugin's MCP server (default: probeMcpTools).
// github: the release client (plugin-updates.js createGithub) for plugins that declared `source`; null turns updates off.
// probeCredential() resolves which login this PC has for GitHub ({ via } or null), for the settings page only.
// clientId: the GitHub App / OAuth App MoonerADE signs in with (device flow); null offers token connection only.
// openExternal(url) opens GitHub's sign-in page in the browser.
export function createPluginManager({ dir, builtinDir = null, dataRoot, stagingRoot = path.join(dataRoot, '..', 'plugin-staging'), store, spawnHost, ask, extractZip = createZipExtractor(), nodeBinary, terminalNode = nodeBinary, appVersion = '0.0.0', onChange = () => {}, onTerminal = () => {}, onFeedback = () => {}, toServer = () => false, notify = () => {}, probeMcp = options => probeMcpTools({ ...options, clientVersion: appVersion }), github = null, probeCredential = async () => null, clientId = null, openExternal = () => {}, firstCheckMs = FIRST_CHECK_MS, checkEveryMs = CHECK_EVERY_MS, log = console }) {
  let list = [], closing = false;
  const hosts = new Map(); // id -> running host
  const crashes = new Map(); // id -> recent crash times, kept across restarts
  // id -> what its MCP server said it has: { key, status: 'loading'|'ok'|'error', list, error, at }. Kept while the plugin is
  // stopped, so its tools can still be looked at and turned off.
  const tools = new Map();
  const mcpPrefs = id => store.state.mcp?.[id] ?? { off: false, disabled: [] };

  const approvedFor = item => item.manifest && store.state.approved[item.manifest.id];
  const builtinOn = item => store.state.builtin?.[item.manifest?.id]?.enabled !== false;
  const eligible = item => !item.error && (item.builtin ? builtinOn(item) : store.state.enabled && approvedFor(item)?.hash === item.hash && approvedFor(item)?.folder === item.folder);
  function stateOf(item) {
    if (item.error) return 'invalid';
    if (item.builtin) return builtinOn(item) ? hosts.get(item.manifest.id)?.status ?? 'stopped' : 'off';
    const approval = approvedFor(item);
    if (!approval) return 'new';
    if (approval.hash !== item.hash || approval.folder !== item.folder) return 'changed';
    if (!store.state.enabled) return 'off';
    return hosts.get(item.manifest.id)?.status ?? 'stopped';
  }
  function snapshot() {
    return {
      available: store.available, problem: store.problem, enabled: store.state.enabled, dir,
      // The GitHub account for private plugin repositories. Never the token itself.
      github: {
        available: Boolean(github), login: store.state.github?.login ?? null, via: store.state.github?.via ?? null, machine: machineVia, machineChecked, signIn: Boolean(clientId), error: githubError,
        device: device ? { userCode: device.userCode, verifyUrl: device.verifyUrl, expiresAt: device.expiresAt } : null
      },
      plugins: list.map(item => {
        const host = item.manifest && hosts.get(item.manifest.id);
        return {
          folder: item.folder, id: item.manifest?.id ?? null, name: item.manifest?.name ?? item.folder, version: item.manifest?.version ?? null,
          builtin: item.builtin === true, ...(item.builtin && { builtinEnabled: builtinOn(item) }),
          description: item.manifest?.description ?? '', hash: item.hash, state: stateOf(item), error: item.error ?? host?.error ?? null,
          terminal: Boolean(item.manifest?.terminal), mcp: item.manifest?.mcp?.name ?? null, mcpChatOnly: item.manifest?.mcp?.chatOnly === true, workspace: Boolean(item.manifest?.workspace), feedback: Boolean(item.manifest?.feedback), view: host?.status === 'running' ? host.view : null,
          badge: host?.status === 'running' ? host.badge : null,
          // What the plugin adds, for the settings page: command names, env names (never values) and its MCP tools.
          commands: item.commands ?? [], envPrefix: item.manifest?.terminal?.envPrefix ?? null,
          env: host?.status === 'running' && host.terminal ? Object.keys(host.terminal.env) : [],
          tools: item.manifest?.mcp ? toolsView(item.manifest.id, host) : null,
          // The setup guide from plugin.json (the running plugin's view.setup says how far it got).
          setup: item.manifest?.setup ?? [],
          update: item.manifest && !item.builtin ? updateView(item) : null
        };
      })
    };
  }
  function toolsView(id, host) {
    const prefs = mcpPrefs(id), found = tools.get(id);
    return {
      enabled: !prefs.off,
      // The plugin hands its server to new terminals and chats now (one that is not set up yet may hold it back).
      offered: host?.status === 'running' && Boolean(host.terminal?.mcp),
      status: found?.status ?? 'idle', error: found?.error ?? null, checkedAt: found?.at ?? null,
      list: found?.list ? found.list.map(tool => ({ ...tool, enabled: !prefs.disabled.includes(tool.name) })) : null,
      disabled: [...prefs.disabled]
    };
  }
  const changed = () => { onChange(snapshot()); emitFeedback(); };
  // Whether feedback can be submitted now, and through which plugin's account. Pushed to the server only when it changes.
  let lastFeedback = '', feedbackSequence = 0;
  function feedbackStatus() {
    const declared = [...hosts.values()].filter(host => host.item.manifest.feedback && host.status === 'running');
    const ready = declared.find(host => host.feedback?.available);
    if (ready) return { ok: true, ...(ready.feedback.account && { account: ready.feedback.account }), plugin: ready.id };
    const reason = declared.find(host => host.feedback?.reason)?.feedback.reason;
    return { ok: false, reason: reason || NO_FEEDBACK_PLUGIN };
  }
  function emitFeedback() {
    const status = feedbackStatus(), text = JSON.stringify(status);
    if (text === lastFeedback) return;
    lastFeedback = text;
    onFeedback(status);
  }
  // Hands one submission to the plugin that can send it now and resolves its answer. Never rejects and never leaves a request hanging.
  function submitFeedback({ meta, images }) {
    const status = feedbackStatus(), host = status.ok ? hosts.get(status.plugin) : null;
    if (!host?.child?.connected) return Promise.resolve({ ok: false, error: { code: 'FEEDBACK_UNAVAILABLE', message: status.reason || NO_FEEDBACK_PLUGIN } });
    const id = ++feedbackSequence;
    return new Promise(resolve => {
      const timer = setTimeout(() => { host.feedbackPending.delete(id); resolve({ ok: false, error: { code: 'PLUGIN_TIMEOUT', message: '플러그인이 제때 응답하지 않았습니다. 잠시 뒤 다시 제출하세요.' } }); }, FEEDBACK_TIMEOUT_MS);
      timer.unref?.();
      host.feedbackPending.set(id, value => { clearTimeout(timer); resolve(value); });
      host.child.send({ type: 'feedback/submit', id, meta, images });
    });
  }
  // What the user turned off stays out: a server turned off is not given at all, single tools are named for the agents to leave out.
  function withPrefs(terminal) {
    if (!terminal.mcp) return terminal;
    const prefs = mcpPrefs(terminal.id);
    if (prefs.off) return { ...terminal, mcp: null };
    return prefs.disabled.length ? { ...terminal, mcp: { ...terminal.mcp, disabledTools: [...prefs.disabled] } } : terminal;
  }
  function emitTerminal() {
    onTerminal({ node: terminalNode, plugins: [...hosts.values()].filter(host => host.status === 'running' && host.terminal).map(host => withPrefs(host.terminal)) });
  }
  // Runs the plugin's MCP server once, as the agents would get it, to list its tools. Again only when what would run changes.
  function discoverTools(host, force = false) {
    const mcp = host.terminal?.mcp;
    if (!mcp) return;
    const key = JSON.stringify([host.item.hash, mcp.command, mcp.args]), before = tools.get(host.id);
    if (before?.key === key && (!force || before.status === 'loading')) return;
    const run = { key, status: 'loading', list: before?.list ?? null, error: null, at: before?.at ?? null };
    tools.set(host.id, run);
    Promise.resolve().then(() => probeMcp({ command: mcp.command, args: [...mcp.args], cwd: host.item.dir, env: { ...host.terminal.env } })).then(raw => {
      if (tools.get(host.id) !== run) return;
      Object.assign(run, { status: 'ok', list: validTools(raw), error: null, at: Date.now() });
      changed();
    }, error => {
      if (tools.get(host.id) !== run) return;
      Object.assign(run, { status: 'error', error: String(error?.message ?? error).slice(0, 300) });
      changed();
    });
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
    const host = { id: manifest.id, item, child: null, status: 'starting', error: null, view: null, badge: null, notices: [], terminal: null, pending: new Map(), feedback: null, feedbackPending: new Map(), confirms: Promise.resolve(), stopping: false, backlog: 0 };
    hosts.set(manifest.id, host);
    let child;
    try { child = spawnHost({ id: manifest.id, dir: item.dir, main: path.join(item.dir, ...manifest.main.split('/')) }); }
    catch (error) { host.status = 'error'; host.error = error.message; return; }
    host.child = child;
    child.on('message', message => { try { onHostMessage(host, message); } catch (error) { log.warn(`[plugin ${host.id}] 메시지 처리 실패: ${error.message}`); } });
    child.on('exit', code => onHostExit(host, code));
    child.on('error', error => { host.error = error.message; });
    let storage = null;
    try { const text = (item.builtin && readStorageFile(dataDir)) || store.state.data[manifest.id]; storage = text ? JSON.parse(text) : null; } catch { storage = null; }
    child.send({ type: 'init', apiVersion: PLUGIN_API, id: manifest.id, appVersion, dataDir, storage, features: [...PLUGIN_FEATURES] });
  }
  function stop(host) {
    host.stopping = true;
    for (const { reject } of host.pending.values()) reject(fail('플러그인이 멈췄습니다.', 'PLUGIN_STOPPED'));
    host.pending.clear();
    endFeedback(host, '플러그인이 멈췄습니다.');
    closeWorkspace(host);
    const child = host.child;
    if (child && child.exitCode === null) {
      if (child.connected) child.send({ type: 'shutdown' });
      setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2000).unref?.();
    }
    if (hosts.get(host.id) === host) hosts.delete(host.id);
  }
  function endFeedback(host, message) {
    for (const answer of host.feedbackPending.values()) answer({ ok: false, error: { code: 'PLUGIN_STOPPED', message } });
    host.feedbackPending.clear();
    host.feedback = null;
  }
  function onHostExit(host, code) {
    for (const { reject } of host.pending.values()) reject(fail('플러그인이 종료되었습니다.', 'PLUGIN_STOPPED'));
    host.pending.clear();
    endFeedback(host, '플러그인이 종료되었습니다.');
    // A host replaced by a newer one for the same plugin already closed its sessions when it was stopped; the newer one's stay.
    if (!hosts.has(host.id) || hosts.get(host.id) === host) closeWorkspace(host);
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
      case 'badge': host.badge = validBadge(message.badge); changed(); break;
      case 'notify': {
        const now = Date.now();
        host.notices = host.notices.filter(at => now - at < 60_000);
        if (host.notices.length >= NOTIFY_PER_MINUTE) break;
        const title = plainText(String(message.title ?? '')).slice(0, 100), body = plainText(String(message.body ?? '')).slice(0, 300);
        if (!title && !body) break;
        host.notices.push(now);
        // Titled by MoonerADE with the plugin's name, like its dialogs, so it cannot pass for MoonerADE's own.
        notify({ id: manifest.id, title: `플러그인: ${manifest.name}`, body: [title, body].filter(Boolean).join('\n') });
        break;
      }
      case 'storage': {
        const text = JSON.stringify(message.value ?? null);
        if (text.length > MAX_STORAGE) { log.warn(`[plugin ${host.id}] 저장할 데이터가 너무 큽니다.`); break; }
        if (host.item.builtin) { writeStorageFile(path.join(dataRoot, manifest.id), text); break; }
        // Plugins send it on every start; sealing the same value again would read the Keychain for nothing.
        if (store.state.data[manifest.id] !== text) store.update(state => ({ ...state, data: { ...state.data, [manifest.id]: text } }));
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
      case 'terminal':
        host.terminal = message.enabled === false ? null : pluginTerminal(manifest, host.item.dir, message, terminalNode, { builtin: host.item.builtin === true });
        if (host.status === 'running') emitTerminal();
        discoverTools(host);
        changed();
        break;
      case 'action-result': {
        const pending = host.pending.get(message.id);
        if (!pending) break;
        host.pending.delete(message.id);
        message.ok ? pending.resolve(message.message ?? null) : pending.reject(fail(String(message.error ?? '플러그인 작업이 실패했습니다.').slice(0, 500), 'PLUGIN_ACTION'));
        break;
      }
      case 'workspace': relayWorkspace(host, message); break;
      // Only for a plugin whose approved manifest declared `feedback` (docs/PLUGINS.md).
      case 'feedback': {
        if (!manifest.feedback) break;
        const account = typeof message.account === 'string' ? plainText(message.account).slice(0, 100) : '';
        const reason = typeof message.reason === 'string' ? plainText(message.reason).slice(0, 200) : '';
        host.feedback = { available: message.available === true, ...(account && { account }), ...(reason && { reason }) };
        emitFeedback();
        break;
      }
      case 'feedback/result': {
        const answer = host.feedbackPending.get(message.id);
        if (!answer) break;
        host.feedbackPending.delete(message.id);
        const issueUrl = typeof message.issueUrl === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(message.issueUrl) ? message.issueUrl : undefined;
        answer(message.ok === true
          ? { ok: true, ...(issueUrl && { issueUrl }), ...(Number.isSafeInteger(message.issueNumber) && { issueNumber: message.issueNumber }) }
          : { ok: false, error: { code: typeof message.error?.code === 'string' ? message.error.code.slice(0, 40) : 'PLUGIN_FEEDBACK', message: plainText(String(message.error?.message ?? '피드백을 보내지 못했습니다.')).slice(0, 500) || '피드백을 보내지 못했습니다.',
            ...(Number.isInteger(message.error?.retryAfter) && message.error.retryAfter > 0 && { retryAfter: Math.min(message.error.retryAfter, 86_400) }) } });
        break;
      }
      case 'log': log[message.level === 'error' ? 'error' : message.level === 'warn' ? 'warn' : 'log'](`[plugin ${host.id}] ${String(message.message ?? '').slice(0, 2000)}`); break;
    }
  }
  // ---- workspace sessions (plugins that declared `workspace`) --------------------------------------------------------
  // The server owns the sessions; this only relays, and only for a plugin whose approved manifest asked for it.
  function relayWorkspace(host, message) {
    const { manifest } = host.item;
    if (!manifest.workspace || !SESSION_ID.test(message.session ?? '')) return;
    const { op, session } = message, base = { type: 'plugin/workspace', plugin: manifest.id, op, session };
    const reply = value => { if (host.child?.connected) host.child.send({ type: 'workspace', session, ...value }); };
    if (op === 'open' || op === 'close') { if (!toServer(base) && op === 'open') reply({ op: 'closed' }); }
    else if (op === 'send') { if (message.message && typeof message.message === 'object') toServer({ ...base, message: message.message }); }
    else if (op === 'api') {
      if (!Number.isSafeInteger(message.id)) return;
      if (typeof message.action !== 'string' || message.action.length > 100) return reply({ op: 'api-result', id: message.id, ok: false, error: { code: 'INVALID_INPUT', message: '잘못된 요청입니다.' } });
      if (!toServer({ ...base, id: message.id, action: message.action, input: message.input ?? {} })) reply({ op: 'api-result', id: message.id, ok: false, error: { code: 'SERVER_UNAVAILABLE', message: '로컬 서버가 실행 중이 아닙니다.' } });
    }
  }
  function closeWorkspace(host) {
    if (host.item.manifest.workspace) toServer({ type: 'plugin/workspace', plugin: host.id, op: 'close-all' });
  }
  // A message from the server for a plugin's session.
  function fromServer(message) {
    const host = hosts.get(message?.plugin);
    if (!host?.item.manifest.workspace || !host.child?.connected || !SESSION_ID.test(message.session ?? '')) return;
    const { op, session } = message;
    if (op === 'message' && typeof message.text === 'string') {
      // A host that stops reading would otherwise pile its output up in this process.
      if (host.backlog > WORKSPACE_BACKLOG) { toServer({ type: 'plugin/workspace', plugin: host.id, op: 'close', session }); return; }
      const size = message.text.length;
      host.backlog += size;
      host.child.send({ type: 'workspace', op, session, text: message.text }, () => { host.backlog -= size; });
    } else if (op === 'closed') host.child.send({ type: 'workspace', op, session });
    else if (op === 'api-result' && Number.isSafeInteger(message.id)) host.child.send({ type: 'workspace', op, session, id: message.id, ok: message.ok === true, ...(message.ok === true ? { value: message.value ?? null } : { error: message.error ?? null }) });
  }
  // The server started again: every session is gone, so the hosts open what they need again.
  function serverReset() {
    for (const host of hosts.values()) if (host.item.manifest.workspace && host.child?.connected) host.child.send({ type: 'workspace', op: 'reset' });
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
    // Built-in ones first: their ids are taken, so a plugin of the same id in the user's folder shows up as a duplicate.
    const seen = new Set();
    list = [...(builtinDir ? scanPlugins(builtinDir, { builtin: true, seen }) : []), ...scanPlugins(dir, { seen })];
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
    if (item.builtin) throw fail('내장 플러그인은 승인하지 않아도 됩니다.', 'PLUGIN_INVALID');
    if (item.error) throw fail(item.error);
    const { manifest } = item;
    const answer = await ask({
      type: 'warning', title: '플러그인 승인', message: `“${manifest.name}” ${manifest.version} 플러그인을 실행할까요?`,
      detail: `${pluginDetail(manifest, item.hash, `폴더: ${item.dir}`)}\n\n파일이 바뀌면 다시 승인할 때까지 실행되지 않습니다.`,
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
      const approved = { ...state.approved }, data = { ...state.data }, mcp = { ...state.mcp };
      delete approved[id]; if (forget) { delete data[id]; delete mcp[id]; }
      return { ...state, approved, data, mcp };
    });
    reconcile();
    return snapshot();
  }
  // Turns a plugin's whole MCP server (no `tool`) or one of its tools on or off for agents started from now on. Turning off
  // needs no dialog, and turning back on gives no more than the plugin's approval already did.
  function setMcp(id, { tool, enabled } = {}) {
    const item = list.find(entry => entry.manifest?.id === id);
    if (!item?.manifest?.mcp) throw fail('MCP 도구를 주는 플러그인이 아닙니다.', 'NOT_FOUND');
    if (tool !== undefined && !TOOL_NAME.test(String(tool))) throw fail('잘못된 도구 이름입니다.');
    const on = enabled === true;
    store.update(state => {
      const current = state.mcp?.[id] ?? { off: false, disabled: [] };
      const next = tool === undefined ? { ...current, off: !on }
        : { ...current, disabled: on ? current.disabled.filter(name => name !== tool) : [...new Set([...current.disabled, String(tool)])] };
      const mcp = { ...state.mcp };
      if (next.off || next.disabled.length) mcp[id] = next; else delete mcp[id];
      return { ...state, mcp };
    });
    emitTerminal();
    changed();
    return snapshot();
  }
  // Turns a plugin that ships with the app on or off. No dialog: it is part of the app, and turning it off only removes things.
  function setBuiltin(id, on) {
    const item = list.find(entry => entry.builtin && entry.manifest?.id === id);
    if (!item) throw fail('내장 플러그인이 아닙니다.', 'NOT_FOUND');
    store.update(state => ({ ...state, builtin: { ...state.builtin, [id]: { enabled: on === true } } }));
    reconcile();
    return snapshot();
  }
  // Lists a running plugin's tools again (e.g. after the plugin was set up or its server changed what it offers).
  function refreshTools(id) {
    const host = hosts.get(id);
    if (!host || host.status !== 'running') throw fail('플러그인이 실행 중일 때 도구 목록을 불러올 수 있습니다.', 'PLUGIN_STOPPED');
    if (!host.terminal?.mcp) throw fail('플러그인이 아직 에이전트 도구를 주고 있지 않습니다. 플러그인 설정을 먼저 마치세요.', 'MCP_NOT_OFFERED');
    discoverTools(host, true);
    return snapshot();
  }
  // `item` is the id of a view.lists item whose button was pressed.
  async function action(id, actionId, values, item) {
    const host = hosts.get(id);
    if (!host || host.status !== 'running' || !host.child?.connected) throw fail('플러그인이 실행 중이 아닙니다.', 'PLUGIN_STOPPED');
    if (!ACTION_ID.test(String(actionId))) throw fail('잘못된 작업입니다.');
    if (item !== undefined && item !== null && !ITEM_ID.test(String(item))) throw fail('잘못된 항목입니다.');
    const clean = {};
    if (values && typeof values === 'object') for (const [key, value] of Object.entries(values).slice(0, 24)) if (FIELD_KEY.test(key) && typeof value === 'string') clean[key] = value.slice(0, 4096);
    const requestId = randomUUID();
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { host.pending.delete(requestId); reject(fail('플러그인이 응답하지 않습니다.', 'PLUGIN_TIMEOUT')); }, ACTION_TIMEOUT_MS);
      timer.unref?.();
      host.pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      host.child.send({ type: 'action', id: requestId, action: String(actionId), values: clean, ...(item != null && { item: String(item) }) });
    });
    return { ...snapshot(), message: typeof message === 'string' ? message.slice(0, 500) : null };
  }
  // ---- installing a zip: one dialog unpacks, turns plugins on, approves and runs it --------------------------------
  const zipKey = (file, stat) => `${file}\0${stat.mtimeMs}\0${stat.size}`;
  const handled = new Set(); // zips cancelled or failed during this run: not asked again
  const queued = new Set(); // zip paths waiting for their turn
  let installs = Promise.resolve();
  // Zips directly in the plugin folder that have not been asked about yet.
  function droppedZips() {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries.filter(entry => entry.isFile() && /\.zip$/i.test(entry.name)).map(entry => path.join(dir, entry.name)).filter(file => {
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      return stat && !queued.has(path.resolve(file)) && !handled.has(zipKey(path.resolve(file), stat));
    });
  }
  // One at a time. `picked` (chosen in the settings page) asks again even about a zip cancelled before.
  function installZip(file, { picked = false, update = null } = {}) {
    const zip = path.resolve(String(file));
    queued.add(zip);
    const run = installs.then(() => install(zip, { picked, update })).finally(() => queued.delete(zip));
    installs = run.catch(() => {});
    return run;
  }
  // Folders the install replaces: every folder holding this id, and the folder named after it if its plugin.json is broken.
  // A folder of that name holding another plugin, or something that is not a plugin, is left alone and the install refused.
  function replaced(id) {
    const own = list.filter(item => item.manifest?.id === id), named = list.find(item => item.folder === id);
    if (named?.manifest && named.manifest.id !== id) throw fail(`플러그인 폴더의 ${id} 폴더에 다른 플러그인(${named.manifest.id})이 있습니다.`);
    if (!named && fs.lstatSync(path.join(dir, id), { throwIfNoEntry: false })) throw fail(`플러그인 폴더에 플러그인이 아닌 ${id}이(가) 이미 있습니다. 옮기거나 지운 뒤 다시 시도하세요.`);
    const folders = own.map(item => item.dir);
    if (named && !folders.includes(named.dir)) folders.push(named.dir);
    const current = own.find(item => !item.error) ?? own[0];
    return { folders, current: folders.length ? current?.manifest?.version ?? '알 수 없음' : null };
  }
  // `update` ({ id, version, auto }) is a release downloaded by the updater: the zip must be that plugin at that version.
  // With `auto`, an update that asks for nothing new is installed without the dialog; one that does throws NEEDS_REVIEW.
  async function install(zip, { picked = false, update = null } = {}) {
    const before = fs.lstatSync(zip, { throwIfNoEntry: false });
    if (!before) { if (picked) throw fail('zip 파일을 찾을 수 없습니다.', 'NOT_FOUND'); return snapshot(); }
    const key = zipKey(zip, before);
    if (!picked && handled.has(key)) return snapshot();
    const staging = path.join(stagingRoot, randomUUID()), copy = `${staging}.zip`;
    try {
      if (!before.isFile()) throw fail('zip 파일이 아닙니다.', 'PLUGIN_ZIP');
      if (before.size > MAX_BYTES) throw fail('플러그인 zip이 너무 큽니다.', 'PLUGIN_ZIP');
      if (!store.available) throw fail('이 컴퓨터에서는 설정을 안전하게 암호화할 수 없어 플러그인을 쓸 수 없습니다.', 'ENCRYPTION_UNAVAILABLE');
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      // The checked listing and the extraction read the same bytes: a private copy, not a file that can be swapped between them.
      fs.copyFileSync(zip, copy, fs.constants.COPYFILE_EXCL);
      if (fs.statSync(copy).size > MAX_BYTES) throw fail('플러그인 zip이 너무 큽니다.', 'PLUGIN_ZIP');
      await extractZip({ zip: copy, dest: staging });
      // Everything that came out, not only the plugin folder: no links, nothing but files and folders, within the limits.
      treeHash(staging);
      const root = zipPluginRoot(staging), manifest = readManifest(root);
      checkPluginFiles(root, manifest);
      if (update && (manifest.id !== update.id || versionText(manifest.version) !== update.version)) throw fail(`받은 플러그인(${manifest.id} ${manifest.version})이 업데이트 정보(${update.id} ${update.version})와 다릅니다. 설치하지 않았습니다.`, 'PLUGIN_ZIP');
      const hash = treeHash(root), wasOn = store.state.enabled;
      rescan();
      if (list.some(entry => entry.builtin && entry.manifest?.id === manifest.id)) throw fail(`이 id(${manifest.id})는 MoonerADE에 들어 있는 플러그인이 쓰고 있습니다.`, 'PLUGIN_ZIP');
      const { current } = replaced(manifest.id);
      const installed = list.find(entry => !entry.builtin && !entry.error && entry.manifest?.id === manifest.id);
      const review = installed ? updateReview(installed.manifest, manifest) : [];
      // Automatic: only an approved, running-eligible plugin whose update asks for nothing new goes in without a dialog.
      const silent = update?.auto === true && installed && eligible(installed) && review.length === 0;
      if (update?.auto && !silent) throw Object.assign(fail(review.length ? '새 권한을 요청하는 업데이트라 자동으로 설치하지 않았습니다.' : '승인된 플러그인만 자동으로 업데이트합니다.', 'NEEDS_REVIEW'), { review });
      if (!silent) {
        const from = update ? `github.com/${installed?.manifest.source?.github ?? manifest.source?.github ?? ''} 릴리스` : `파일: ${zip}`;
        const answer = await ask({
          type: 'warning', title: current ? '플러그인 업데이트' : '플러그인 설치',
          message: current ? `“${manifest.name}” 플러그인을 업데이트하고 실행할까요?` : `“${manifest.name}” ${manifest.version} 플러그인을 설치하고 실행할까요?`,
          detail: `${current ? `업데이트 (${current} → ${manifest.version})\n\n` : ''}${review.length ? `이 업데이트는 전에 없던 것을 요청합니다:\n${review.map(line => `• ${line}`).join('\n')}\n\n` : ''}${pluginDetail(manifest, hash, from)}${wasOn ? '' : '\n\n플러그인 기능도 켭니다. 믿을 수 있는 곳(MoonerADE 릴리스)에서 받은 플러그인만 설치하세요.'}\n\n설치한 뒤 파일이 바뀌면 다시 승인할 때까지 실행되지 않습니다.`,
          buttons: ['설치', '취소'], defaultId: 1, cancelId: 1
        });
        if (answer !== 0) { handled.add(key); return snapshot(); }
      }
      // What the user saw is what gets installed: a change to the zip or the unpacked files during the dialog voids it.
      const after = fs.lstatSync(zip, { throwIfNoEntry: false });
      if (!after || zipKey(zip, after) !== key || treeHash(root) !== hash) throw fail('확인하는 동안 플러그인 파일이 바뀌었습니다. 다시 시도하세요.');
      rescan();
      const { folders } = replaced(manifest.id), host = hosts.get(manifest.id);
      if (host) stop(host);
      crashes.delete(manifest.id);
      for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      moveFolder(root, path.join(dir, manifest.id));
      // The plugin's saved data stays.
      store.update(state => ({ ...state, enabled: true, approved: { ...state.approved, [manifest.id]: { hash, folder: manifest.id, version: manifest.version, approvedAt: Date.now() } } }));
      // A zip picked from elsewhere (e.g. Downloads) is the user's; only one dropped into the plugin folder is removed.
      if (path.relative(path.resolve(dir), path.dirname(zip)) === '') {
        try { fs.rmSync(zip, { force: true }); } catch (error) { handled.add(key); log.warn(`플러그인 zip을 지우지 못했습니다: ${error.message}`); }
      }
      rescan();
      return { ...snapshot(), message: current ? `“${manifest.name}” 플러그인을 ${manifest.version}(으)로 업데이트했습니다.` : `“${manifest.name}” ${manifest.version} 플러그인을 설치했습니다.` };
    } catch (error) {
      handled.add(key);
      throw error;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      fs.rmSync(copy, { force: true });
    }
  }

  // ---- updates from the plugin's GitHub releases (plugin.json `source`) --------------------------------------------
  // id -> { status: 'checking'|'latest'|'available'|'downloading'|'installing'|'error', found, checkedAt, error, review }
  const updates = new Map(), checking = new Map();
  let updateTimers = [], round = null, machineVia = null, machineChecked = false, device = null, githubError = null;
  const modeOf = id => store.state.updates?.[id]?.mode ?? DEFAULT_UPDATE_MODE;
  function updateView(item) {
    const id = item.manifest.id, source = item.manifest.source ?? null;
    if (!source) return { source: null, mode: modeOf(id) };
    const entry = updates.get(id), latest = entry?.found?.version ?? null, available = Boolean(latest && isNewer(latest, item.manifest.version));
    const status = !entry ? 'idle' : ['latest', 'available'].includes(entry.status) ? (available ? 'available' : 'latest') : entry.status;
    return {
      source: { github: source.github, asset: source.asset }, mode: modeOf(id), status, current: item.manifest.version, latest, available,
      checkedAt: entry?.checkedAt ?? null, error: entry?.error ?? null, via: entry?.found?.via ?? null, viaLabel: credentialLabel(entry?.found?.via ?? null),
      review: available ? entry?.review ?? [] : []
    };
  }
  function sourceItem(id) {
    if (!github) throw fail('이 MoonerADE에서는 플러그인 업데이트를 쓸 수 없습니다.', 'UPDATES_UNAVAILABLE');
    const item = list.find(entry => !entry.builtin && entry.manifest?.id === id);
    if (!item?.manifest) throw fail('플러그인을 찾을 수 없습니다.', 'NOT_FOUND');
    if (!item.manifest.source) throw fail('이 플러그인은 업데이트 출처(source)를 알려 주지 않아 새 zip으로만 업데이트할 수 있습니다.', 'NO_SOURCE');
    return item;
  }
  // One check at a time per plugin; a check started while one runs gets the running one's answer.
  function checkUpdate(id) {
    const item = sourceItem(id);
    if (checking.has(id)) return checking.get(id);
    const entry = updates.get(id) ?? {};
    updates.set(id, entry);
    Object.assign(entry, { status: 'checking', error: null });
    changed();
    const run = github.latest(item.manifest.source, id).then(found => {
      if (entry.found?.version !== found.version) entry.review = [];
      Object.assign(entry, { status: 'latest', found, checkedAt: Date.now(), error: null });
      if (found.via === 'gh' || found.via === 'git') { machineVia = found.via; machineChecked = true; }
      return found;
    }, error => {
      Object.assign(entry, { status: 'error', error: String(error?.message ?? error).slice(0, 300), checkedAt: Date.now() });
      throw error;
    }).finally(() => { checking.delete(id); changed(); });
    checking.set(id, run);
    return run;
  }
  // Downloads the newest release, checks it against the release's checksum and installs it the way a zip is installed
  // (the dialog, unless `auto` and the update asks for nothing new). A check within the last minute is reused.
  async function installUpdate(id, { auto = false } = {}) {
    const item = sourceItem(id), entry = updates.get(id);
    const found = entry?.found && entry.checkedAt > Date.now() - 60_000 && entry.status !== 'error' ? entry.found : await checkUpdate(id);
    const now = updates.get(id);
    if (!isNewer(found.version, item.manifest.version)) return { ...snapshot(), message: `“${item.manifest.name}” 플러그인은 이미 최신(${item.manifest.version})입니다.` };
    let zip = null;
    try {
      now.status = 'downloading'; changed();
      const { data } = await github.download(found);
      fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
      zip = path.join(stagingRoot, `${randomUUID()}.update.zip`);
      fs.writeFileSync(zip, data, { flag: 'wx', mode: 0o600 });
      now.status = 'installing'; changed();
      const result = await installZip(zip, { picked: true, update: { id, version: found.version, auto } });
      now.status = 'latest';
      return result;
    } catch (error) {
      if (error.code === 'NEEDS_REVIEW') { now.status = 'available'; now.review = error.review ?? []; }
      else { now.status = 'error'; now.error = String(error?.message ?? error).slice(0, 300); }
      throw error;
    } finally {
      if (zip) fs.rmSync(zip, { force: true });
      if (['downloading', 'installing'].includes(now.status)) now.status = 'available';
      changed();
    }
  }
  // Once per version and plugin, kept across restarts.
  function announce(id, version, body) {
    if (store.state.updates?.[id]?.notified === version) return;
    try { store.update(state => ({ ...state, updates: { ...state.updates, [id]: { ...state.updates?.[id], notified: version } } })); } catch { return; }
    notify({ id, title: '플러그인 업데이트', body });
  }
  // The background round: every plugin with a source and not on manual. Automatic ones are installed, the rest announced.
  async function checkAll() {
    for (const item of [...list]) {
      const id = item.manifest?.id;
      if (closing) return;
      if (!id || item.builtin || item.error || !item.manifest.source || modeOf(id) === 'manual') continue;
      let found;
      try { found = await checkUpdate(id); } catch (error) { log.warn(`[plugin ${id}] 업데이트를 확인하지 못했습니다: ${error.message}`); continue; }
      const { name, version } = item.manifest;
      if (!isNewer(found.version, version)) continue;
      if (modeOf(id) === 'auto' && eligible(item)) {
        try {
          await installUpdate(id, { auto: true });
          notify({ id, title: '플러그인 업데이트', body: `${name} 플러그인을 ${version}에서 ${found.version}(으)로 자동 업데이트했습니다.` });
          continue;
        } catch (error) {
          if (error.code !== 'NEEDS_REVIEW') { log.warn(`[plugin ${id}] 자동 업데이트하지 못했습니다: ${error.message}`); continue; }
          announce(id, found.version, `${name} ${found.version}은(는) 새 권한을 요청해 자동으로 설치하지 않았습니다. 설정 → 플러그인 → ${name}에서 확인하고 설치하세요.`);
          continue;
        }
      }
      announce(id, found.version, `${name} ${found.version} 업데이트가 있습니다(지금 ${version}). 설정 → 플러그인 → ${name}에서 설치하세요.`);
    }
  }
  const runRound = () => { round ??= checkAll().catch(error => log.warn(`플러그인 업데이트 확인 실패: ${error.message}`)).finally(() => { round = null; }); return round; };
  function startUpdates() {
    if (!github || updateTimers.length) return;
    const first = setTimeout(() => { void runRound(); const every = setInterval(() => void runRound(), checkEveryMs); every.unref?.(); updateTimers.push(every); }, firstCheckMs);
    first.unref?.();
    updateTimers.push(first);
  }
  // From the settings page: one plugin, or (no id) every plugin with a source, whatever its mode. Only checks.
  async function checkUpdates(id) {
    if (id) {
      const item = sourceItem(id), found = await checkUpdate(id);
      return { ...snapshot(), message: isNewer(found.version, item.manifest.version) ? `${item.manifest.name} ${found.version} 업데이트가 있습니다.` : `${item.manifest.name} 플러그인은 최신(${item.manifest.version})입니다.` };
    }
    const targets = list.filter(item => !item.builtin && !item.error && item.manifest?.source);
    if (!github || !targets.length) return { ...snapshot(), message: '업데이트 출처를 알려 주는 플러그인이 없습니다.' };
    const results = await Promise.allSettled(targets.map(item => checkUpdate(item.manifest.id)));
    const newer = targets.filter((item, index) => results[index].status === 'fulfilled' && isNewer(results[index].value.version, item.manifest.version));
    const failed = results.filter(result => result.status === 'rejected').length;
    return { ...snapshot(), message: `${newer.length ? `업데이트 ${newer.length}개: ${newer.map(item => item.manifest.name).join(', ')}` : '모두 최신입니다'}${failed ? ` · ${failed}개는 확인하지 못했습니다` : ''}.` };
  }
  // Automatic updates run new code without a dialog, so turning them on is confirmed natively; manual and notify only take away.
  async function setUpdateMode(id, mode) {
    if (!UPDATE_MODES.includes(mode)) throw fail('알 수 없는 업데이트 방식입니다.');
    const item = sourceItem(id), { name, source } = item.manifest;
    if (mode === 'auto' && modeOf(id) !== 'auto') {
      const answer = await ask({
        type: 'warning', title: '플러그인 자동 업데이트', message: `“${name}” 플러그인을 자동으로 업데이트할까요?`,
        detail: `github.com/${source.github}에 새 릴리스가 나오면 확인 창 없이 받아 설치하고 다시 시작합니다. 받은 파일은 릴리스의 체크섬과 맞춰 봅니다.\n\n새 권한을 요청하거나 업데이트 출처가 바뀌는 업데이트는 자동으로 설치하지 않고 알려 드립니다.\n\n이 저장소에 릴리스를 올릴 수 있는 사람은 이 PC에서 MoonerADE와 같은 권한으로 코드를 실행할 수 있게 됩니다. 믿을 수 있는 저장소에만 켜세요.`,
        buttons: ['자동 업데이트 켜기', '취소'], defaultId: 1, cancelId: 1
      });
      if (answer !== 0) return snapshot();
    }
    store.update(state => ({ ...state, updates: { ...state.updates, [id]: { ...state.updates?.[id], mode } } }));
    changed();
    return snapshot();
  }

  // ---- the GitHub account for private plugin repositories -------------------------------------------------------------
  // A token pasted on the settings page: checked with GitHub, then confirmed natively with the account it belongs to.
  async function connectGithub(token) {
    if (!github) throw fail('이 MoonerADE에서는 플러그인 업데이트를 쓸 수 없습니다.', 'UPDATES_UNAVAILABLE');
    const value = String(token ?? '').trim();
    const { login } = await github.whoami(value);
    const answer = await ask({
      type: 'question', title: 'GitHub 연결', message: `GitHub 계정 ${login}을(를) 연결할까요?`,
      detail: '플러그인 업데이트를 확인하고 받을 때 이 계정으로 GitHub에 접속합니다(비공개 저장소의 플러그인용).\n\n토큰은 이 PC에 암호화해 저장하고 GitHub API에만 보냅니다. 플러그인에는 주지 않습니다. 저장소 읽기 권한(Contents: Read-only)만 있는 토큰을 쓰세요.',
      buttons: ['연결', '취소'], defaultId: 0, cancelId: 1
    });
    if (answer !== 0) return snapshot();
    store.update(state => ({ ...state, github: { token: value, login, via: 'pat', at: Date.now() } }));
    githubError = null;
    changed();
    return { ...snapshot(), message: `GitHub 계정 ${login}을(를) 연결했습니다.` };
  }
  function disconnectGithub() {
    const login = store.state.github?.login;
    store.update(state => ({ ...state, github: null }));
    changed();
    return { ...snapshot(), message: login ? `GitHub 계정 ${login}의 연결을 해제했습니다.` : null };
  }
  // Sign in with GitHub (device flow): the browser opens GitHub's page, the user enters the code shown here and approves.
  async function signInGithub() {
    if (!github || !clientId) throw fail('GitHub 로그인을 쓸 수 없습니다. 토큰으로 연결하세요.', 'SIGN_IN_UNAVAILABLE');
    if (device && device.expiresAt > Date.now()) { openExternal(device.verifyUrl); return snapshot(); }
    const started = await github.deviceStart(clientId), current = { ...started };
    device = current; githubError = null;
    openExternal(current.verifyUrl);
    void pollDevice(current);
    changed();
    return { ...snapshot(), message: `브라우저에서 코드 ${current.userCode}를 입력하고 승인하세요.` };
  }
  async function pollDevice(current) {
    let wait = current.interval;
    while (device === current && !closing && Date.now() < current.expiresAt) {
      await new Promise(resolve => { const timer = setTimeout(resolve, wait * 1000); timer.unref?.(); });
      if (device !== current || closing) return;
      try {
        const answer = await github.devicePoll(clientId, current.deviceCode);
        if (device !== current) return;
        if (answer.token) {
          const { login } = await github.whoami(answer.token);
          store.update(state => ({ ...state, github: { token: answer.token, login, via: 'oauth', at: Date.now() } }));
          device = null; changed();
          return;
        }
        wait += answer.wait ?? 0;
      } catch (error) { if (device === current) { device = null; githubError = error.message; changed(); } return; }
    }
    if (device === current) { device = null; githubError = 'GitHub 로그인 시간이 지났습니다. 다시 시도하세요.'; changed(); }
  }
  function cancelSignIn() { device = null; changed(); return snapshot(); }
  // Which login this PC itself has for GitHub (gh / git), for the settings page. The token is not kept.
  async function probeGithub() {
    try { machineVia = (await probeCredential())?.via ?? null; } catch { machineVia = null; }
    machineChecked = true;
    changed();
    return snapshot();
  }

  function close() {
    closing = true; device = null;
    for (const timer of updateTimers) { clearTimeout(timer); clearInterval(timer); }
    updateTimers = [];
    for (const host of [...hosts.values()]) stop(host);
  }

  return { snapshot, rescan, restart, setEnabled, setBuiltin, approve, revoke, action, setMcp, refreshTools, installZip, droppedZips, close, emitTerminal, fromServer, serverReset, feedbackStatus, submitFeedback,
    startUpdates, checkUpdates, installUpdate: id => installUpdate(id), setUpdateMode, connectGithub, disconnectGithub, signInGithub, cancelSignIn, probeGithub, runUpdateRound: runRound };
}
