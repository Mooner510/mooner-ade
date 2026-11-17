// "Open in IDE": finds the editors installed on this machine (VS Code family, Zed, JetBrains) and starts one on a project folder or file,
// and shows a path in the OS file manager. The server always runs on the user's own machine, so these open on their desktop.
// Only absolute launcher paths found on disk are ever started (never a shell, never a bare name), and the target path is already
// checked to be inside the project by the caller.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fault } from './files.js';

const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const list = dir => { try { return fs.readdirSync(dir); } catch { return []; } };

// VS Code and its forks share one command line (`<exe> <folder> -g <file>:<line>:<col>`); Zed takes `<folder> <file>:<line>:<col>`.
// Windows entries are the app's own .exe (Node cannot start a .cmd shim without a shell); macOS entries are the CLI script inside the app bundle.
const EDITORS = [
  { id: 'vscode', label: 'Visual Studio Code', kind: 'vscode', win: ['Microsoft VS Code/Code.exe'], mac: ['Visual Studio Code.app/Contents/Resources/app/bin/code'], linux: ['code'] },
  { id: 'vscode-insiders', label: 'VS Code Insiders', kind: 'vscode', win: ['Microsoft VS Code Insiders/Code - Insiders.exe'], mac: ['Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders'], linux: ['code-insiders'] },
  { id: 'cursor', label: 'Cursor', kind: 'vscode', win: ['cursor/Cursor.exe', 'Cursor/Cursor.exe'], mac: ['Cursor.app/Contents/Resources/app/bin/cursor'], linux: ['cursor'] },
  { id: 'windsurf', label: 'Windsurf', kind: 'vscode', win: ['Windsurf/Windsurf.exe'], mac: ['Windsurf.app/Contents/Resources/app/bin/windsurf'], linux: ['windsurf'] },
  { id: 'vscodium', label: 'VSCodium', kind: 'vscode', win: ['VSCodium/VSCodium.exe'], mac: ['VSCodium.app/Contents/Resources/app/bin/codium'], linux: ['codium'] },
  { id: 'zed', label: 'Zed', kind: 'zed', win: ['Zed/zed.exe', 'Zed/Zed.exe'], mac: ['Zed.app/Contents/MacOS/cli'], linux: ['zed', 'zeditor'] }
];

function pathDirs(env) { return (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean); }

// JetBrains products describe themselves: <install dir>/product-info.json (macOS: Contents/Resources/product-info.json) names the product and its launcher.
function jetbrains({ platform, env, home }) {
  const found = [];
  const roots = [];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    roots.push(path.join(local, 'Programs'));
    for (const base of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean)) roots.push(path.join(base, 'JetBrains'));
    // Toolbox keeps each product under apps/<Product>/<channel>/<build>/.
    const toolbox = path.join(local, 'JetBrains', 'Toolbox', 'apps');
    for (const product of list(toolbox)) for (const channel of list(path.join(toolbox, product))) roots.push(path.join(toolbox, product, channel));
  } else if (platform === 'darwin') {
    roots.push('/Applications', path.join(home, 'Applications'));
    const toolbox = path.join(home, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'apps');
    for (const product of list(toolbox)) for (const channel of list(path.join(toolbox, product))) roots.push(path.join(toolbox, product, channel));
  } else {
    roots.push('/opt', path.join(home, '.local', 'share', 'JetBrains'));
    const toolbox = path.join(home, '.local', 'share', 'JetBrains', 'Toolbox', 'apps');
    for (const product of list(toolbox)) for (const channel of list(path.join(toolbox, product))) roots.push(path.join(toolbox, product, channel));
  }
  for (const root of roots) for (const name of list(root)) {
    const dir = path.join(root, name);
    // Toolbox's channel folder holds the build folder one level lower.
    for (const install of [dir, ...list(dir).map(child => path.join(dir, child))]) {
      const infoFile = [path.join(install, 'product-info.json'), path.join(install, 'Contents', 'Resources', 'product-info.json')].find(isFile);
      if (!infoFile) continue;
      let info; try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { continue; }
      const launcherPath = info.launch?.[0]?.launcherPath;
      if (typeof info.name !== 'string' || typeof launcherPath !== 'string' || /\.\./.test(launcherPath)) continue;
      const base = infoFile.endsWith(path.join('Resources', 'product-info.json')) ? path.join(install, 'Contents') : install;
      const exe = path.join(base, ...launcherPath.replace(/^\.?\//, '').split('/'));
      if (isFile(exe)) { found.push({ id: `jetbrains:${info.productCode || info.name}`, label: info.name, kind: 'jetbrains', file: exe, version: String(info.version || '') }); break; }
    }
  }
  // The same product can be installed twice (Toolbox and a standalone copy): keep the newest.
  const best = new Map();
  for (const item of found) { const old = best.get(item.id); if (!old || old.version.localeCompare(item.version, undefined, { numeric: true }) < 0) best.set(item.id, item); }
  return [...best.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// Editors found on this machine, in a stable order: VS Code family and Zed first, then JetBrains products by name.
export function detectIdes({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const out = [];
  const dirs = pathDirs(env);
  const programRoots = platform === 'win32'
    ? [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean)
    : platform === 'darwin' ? ['/Applications', path.join(home, 'Applications')] : [];
  for (const editor of EDITORS) {
    let file = null;
    if (platform === 'linux') for (const name of editor.linux) for (const dir of dirs) { const candidate = path.join(dir, name); if (!file && isFile(candidate)) file = candidate; }
    else for (const root of programRoots) for (const relative of platform === 'win32' ? editor.win : editor.mac) { const candidate = path.join(root, ...relative.split('/')); if (!file && isFile(candidate)) file = candidate; }
    // Installed somewhere unusual but on PATH (a `code.cmd` shim): the app's .exe sits a few folders above it.
    if (!file && platform === 'win32') for (const dir of dirs) for (const relative of editor.win) {
      const exe = path.basename(relative), shim = editor.linux[0] + '.cmd';
      if (!isFile(path.join(dir, shim))) continue;
      for (let up = dir, depth = 0; depth < 5 && !file; depth++, up = path.dirname(up)) { const candidate = path.join(up, exe); if (isFile(candidate)) file = candidate; }
    }
    if (file) out.push({ id: editor.id, label: editor.label, kind: editor.kind, file });
  }
  out.push(...jetbrains({ platform, env, home }));
  return out;
}

// The command line for opening `target` (an absolute path inside `root`) in an editor. A folder opens as the project; a file opens inside
// `root` as the project, at `line`/`column` when given. Pure, so it is tested without starting anything.
export function ideCommand(ide, { root, target, directory, line, column }) {
  const at = Number.isInteger(line) && line > 0 ? line : 0, col = at && Number.isInteger(column) && column > 0 ? column : 0;
  if (directory || target === root) return { file: ide.file, args: [target] };
  if (ide.kind === 'vscode') return { file: ide.file, args: [root, '-g', `${target}${at ? `:${at}${col ? `:${col}` : ''}` : ''}`] };
  if (ide.kind === 'zed') return { file: ide.file, args: [root, `${target}${at ? `:${at}${col ? `:${col}` : ''}` : ''}`] };
  return { file: ide.file, args: [root, ...(at ? ['--line', String(at), ...(col ? ['--column', String(col)] : [])] : []), target] };
}

// The file manager for "show in folder": Explorer selects the file, Finder reveals it, other desktops open the containing folder.
export function revealCommand({ target, directory, platform = process.platform }) {
  if (platform === 'win32') return { file: path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), args: directory ? [target] : ['/select,', target] };
  if (platform === 'darwin') return { file: '/usr/bin/open', args: directory ? [target] : ['-R', target] };
  return { file: 'xdg-open', args: [directory ? target : path.dirname(target)] };
}
export function fileManagerName(platform = process.platform) { return platform === 'win32' ? '탐색기' : platform === 'darwin' ? 'Finder' : '파일 관리자'; }

// What a started editor must not inherit: Electron's "run as plain Node" switch would turn a VS Code fork into a Node REPL, and
// ADE's own tokens have no business in the editor's terminals.
function cleanEnv(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) if (key === 'ELECTRON_RUN_AS_NODE' || key === 'NODE_OPTIONS' || key.startsWith('ADE_')) delete next[key];
  return next;
}

// Starts a detached GUI process and resolves once it has started (or rejects when it cannot). Explorer exits with 1 on success, so the exit code is ignored.
export function launch({ file, args }, { spawnProcess = spawn, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcess(file, args, { detached: true, stdio: 'ignore', env: cleanEnv(env) }); } catch (error) { reject(fault('LAUNCH_FAILED', `실행하지 못했습니다: ${error.message}`, 500)); return; }
    child.once('error', error => reject(fault('LAUNCH_FAILED', `실행하지 못했습니다: ${error.code === 'ENOENT' ? '프로그램을 찾을 수 없습니다.' : error.message}`, 500)));
    child.once('spawn', () => { child.unref(); resolve({}); });
  });
}

// Detection touches the disk a few dozen times, so a menu opened again soon reuses the last answer.
let cached = null;
export function listIdes(options = {}, now = Date.now()) {
  if (!options.force && cached && now - cached.at < 30_000) return cached.value;
  const ides = detectIdes(options);
  cached = { at: now, value: { ides: ides.map(({ id, label, kind }) => ({ id, label, kind })), fileManager: fileManagerName(options.platform) }, raw: ides };
  return cached.value;
}
export function findIde(id) {
  if (!cached || Date.now() - cached.at >= 30_000) listIdes({ force: true });
  return cached.raw.find(item => item.id === id);
}

// Opens `target` (absolute, already confirmed inside `root`) in editor `ideId`, or in the file manager when `ideId` is 'files'.
export async function openPath({ ide: ideId, root, target, line, column }) {
  const stat = await fs.promises.stat(target).catch(() => null);
  if (!stat) throw fault('NOT_FOUND', `파일을 찾을 수 없습니다: ${path.relative(root, target) || '.'}`, 404);
  const directory = stat.isDirectory();
  if (ideId === 'files') return launch(revealCommand({ target, directory }));
  const ide = findIde(ideId);
  if (!ide) throw fault('NOT_FOUND', '이 컴퓨터에서 해당 편집기를 찾을 수 없습니다. 설치를 확인하세요.', 404);
  if (!directory && !stat.isFile()) throw fault('INVALID_INPUT', '파일이나 폴더만 열 수 있습니다.');
  return launch(ideCommand(ide, { root, target, directory, line, column }));
}
