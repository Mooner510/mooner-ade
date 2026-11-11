import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Windows only runs .exe through spawn(shell:false). `cursor-agent` is installed as .cmd/.ps1 launchers (Node refuses to spawn .cmd without a shell),
// so run the bundled node.exe + index.js of the newest version folder directly, exactly as the launcher does.
const VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/;
const versionKey = name => { const m = VERSION.exec(name); return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : -1; };

export function resolveAgentCommand(file, args = [], { platform = process.platform, env = process.env, exists = existsSync, list = dir => readdirSync(dir) } = {}) {
  if (platform !== 'win32' || file !== 'cursor-agent') return { file, args };
  const dirs = [];
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'cursor-agent'));
  for (const dir of String(env.Path ?? env.PATH ?? '').split(';')) if (dir && exists(path.join(dir, 'cursor-agent.cmd'))) dirs.push(dir);
  for (const dir of dirs) {
    let versions;
    try { versions = list(path.join(dir, 'versions')).filter(name => versionKey(name) >= 0).sort((a, b) => versionKey(b) - versionKey(a) || (a < b ? 1 : -1)); } catch { continue; }
    for (const name of versions) {
      const root = path.join(dir, 'versions', name), node = path.join(root, 'node.exe'), entry = path.join(root, 'index.js');
      if (exists(node) && exists(entry)) return { file: node, args: [entry, ...args] };
    }
  }
  return { file, args };
}

export function spawnAgent(file, args, options) {
  const resolved = resolveAgentCommand(file, args, { env: options?.env ?? process.env });
  return spawn(resolved.file, resolved.args, options);
}
