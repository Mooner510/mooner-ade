import fs from 'node:fs';
import path from 'node:path';

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
