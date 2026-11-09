import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const exists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };

function onPath(names, env = process.env) {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const name of names) for (const dir of dirs) { const file = path.join(dir, name); if (exists(file)) return file; }
  return null;
}

// Shells a terminal can start on this machine. `id` is what the setting stores: a stable name on Windows, the path elsewhere.
const readEtcShells = () => {
  try { return fs.readFileSync('/etc/shells', 'utf8').split('\n').map(line => line.trim()).filter(line => line.startsWith('/')); } catch { return []; }
};

export function detectShells({ platform = process.platform, env = process.env, isFile = exists, etcShells = readEtcShells } = {}) {
  const found = [];
  const add = (id, label, file) => { if (file && !found.some(item => item.id === id)) found.push({ id, label, path: file }); };
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean);
    const systemRoot = env.SystemRoot || 'C:\\Windows';
    // PowerShell 7 is not in System32; the MSI/winget install and the Store package each put it somewhere else.
    const pwsh = onPath(['pwsh.exe'], env) || roots.map(root => path.join(root, 'PowerShell', '7', 'pwsh.exe')).find(isFile);
    add('pwsh', 'PowerShell 7', pwsh);
    const legacy = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    add('powershell', 'Windows PowerShell 5.1', isFile(legacy) ? legacy : onPath(['powershell.exe'], env));
    add('cmd', '명령 프롬프트 (cmd)', path.join(systemRoot, 'System32', 'cmd.exe'));
    add('gitbash', 'Git Bash', roots.map(root => path.join(root, 'Git', 'bin', 'bash.exe')).find(isFile));
    return found;
  }
  for (const file of [env.SHELL, ...etcShells()]) if (file && isFile(file)) add(file, path.basename(file), file);
  if (!found.length) add('/bin/sh', 'sh', '/bin/sh');
  return found;
}

// '' (or a shell that is no longer installed) means automatic: PowerShell 7 when present on Windows, otherwise the login shell.
export function resolveShell(preferred, shells = detectShells(), { platform = process.platform, env = process.env } = {}) {
  const chosen = typeof preferred === 'string' && preferred ? shells.find(item => item.id === preferred) : undefined;
  if (chosen) return chosen;
  if (platform === 'win32') return shells.find(item => item.id === 'pwsh') || shells.find(item => item.id === 'powershell') || { id: 'powershell', label: 'Windows PowerShell 5.1', path: 'powershell.exe' };
  return shells.find(item => item.path === env.SHELL) || shells[0];
}

// Launcher agents and the command each one runs (apps/web/src/Panes.tsx).
const agentCommands = { claude: 'claude', codex: 'codex', cursor: 'cursor-agent' };

// Agent ids whose command is in none of `dirs`. Windows runs only these extensions from a terminal.
export function missingAgents(dirs, { platform = process.platform, isFile = exists } = {}) {
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1'] : [''];
  return Object.entries(agentCommands).filter(([, command]) => !dirs.some(dir => extensions.some(ext => isFile(path.join(dir, command + ext))))).map(([id]) => id);
}

// The PATH a newly opened terminal would get right now, not the one this process started with: a CLI install edits the
// shell profile (macOS/Linux) or the registry (Windows), which the running app never sees. null when it cannot be read.
function freshPath(platform = process.platform) {
  const [file, args] = platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"]]
    : [process.env.SHELL || '/bin/sh', ['-ilc', 'printf "\\n__ADE_PATH__%s\\n" "$PATH"']];
  return new Promise(resolve => execFile(file, args, { timeout: 8000, windowsHide: true, encoding: 'utf8' }, (_error, stdout) => {
    const value = platform === 'win32' ? stdout?.trim() : /__ADE_PATH__(.*)/.exec(stdout || '')?.[1];
    resolve(value || null);
  }));
}

let agentCheck = null, lastCheck = { at: 0, value: null };
// Each check starts an interactive login shell (profile, plugins). The UI asks on every window focus and once a minute,
// so a reading under CHECK_REUSE_MS old is reused; concurrent calls share one shell. Directories new to
// the fresh PATH also join this process's PATH, so terminals opened from now on can run what was just installed.
const CHECK_REUSE_MS = 10_000;
export function checkAgents() {
  if (lastCheck.value && Date.now() - lastCheck.at < CHECK_REUSE_MS) return Promise.resolve(lastCheck.value);
  agentCheck ??= freshPath().then(fresh => {
    const key = Object.keys(process.env).find(name => name.toLowerCase() === 'path') || 'PATH';
    const current = (process.env[key] || '').split(path.delimiter).filter(Boolean);
    const freshDirs = (fresh || '').split(path.delimiter).filter(dir => dir && path.isAbsolute(dir));
    const added = freshDirs.filter(dir => !current.includes(dir));
    if (added.length) process.env[key] = [...current, ...added].join(path.delimiter);
    // macOS/Linux terminals are shells that rebuild PATH from the profile, so that PATH decides; Windows terminals inherit ours.
    const value = { missing: missingAgents(process.platform !== 'win32' && freshDirs.length ? freshDirs : [...current, ...added]) };
    lastCheck = { at: Date.now(), value };
    return value;
  }).finally(() => { agentCheck = null; });
  return agentCheck;
}
