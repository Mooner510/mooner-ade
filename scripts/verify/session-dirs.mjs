// Where verify sessions live, and how to tell whether one is running. No side effects on import (the server loads plugins.mjs, which imports this).
// Every session is a folder directly under <main checkout>/tmp: the main checkout is git's common dir, so every worktree (wt/*) and every agent
// sees the same folders. tmp/main is the one shared session; tmp/ade-<purpose>-<id> are isolated ones (real accounts, API keys, usage);
// tmp/run-* belong to a single script run (the t-*.mjs suites' own servers) and are removed when it ends.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
// Written into every session folder. The plugin harness and `session.mjs down` act only on folders that carry it.
export const MARKER = '.ade-verify-session';

let main;
export function mainCheckout() {
  if (main) return main;
  try { main = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()); }
  catch { main = ROOT; }
  return main = resolve(main);
}
export const tmpRoot = () => join(mainCheckout(), 'tmp');
export const mainDir = () => join(tmpRoot(), 'main');
export const sessionDir = name => join(tmpRoot(), name);

export const real = p => { try { return realpathSync(p); } catch { return undefined; } };
export const inside = (parent, child) => { const r = relative(parent, child); return Boolean(r) && !r.startsWith('..') && !isAbsolute(r); };
// A session folder sits directly under tmp/ (or, for tests and older runs, under the OS temp dir) and carries the marker.
export function isSessionDir(dir) {
  const r = real(dir); if (!r || !existsSync(join(r, MARKER))) return false;
  return [tmpRoot(), tmpdir()].some(root => { const p = real(root); return p && dirname(r) === p; });
}
export function ensureSession(dir, meta = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, MARKER);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ createdAt: Date.now(), ...meta }, null, 2));
  return real(dir);
}
export const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };
export const readEnv = dir => readJson(join(dir, 'env.json'));
export const readMarker = dir => readJson(join(dir, MARKER));

// Command lines by PID, to check a recorded PID still is the process it was (PIDs are reused). Windows: one CIM query, because Git Bash's
// `ps` cannot print command lines (the old cleanup-ui skipped every process because of it). Elsewhere: ps.
const ps = (args) => execFileSync('ps', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const cim = filter => {
  const json = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`],
  { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).trim();
  return json ? [].concat(JSON.parse(json)).map(p => [p.ProcessId, p.CommandLine ?? '']) : [];
};
export function commandLines(pids) {
  const list = [...new Set(pids.filter(p => Number.isInteger(p) && p > 0))], out = new Map();
  if (!list.length) return out;
  try {
    if (process.platform === 'win32') for (const [pid, cmd] of cim(list.map(p => `ProcessId=${p}`).join(' OR '))) out.set(pid, cmd);
    else for (const p of list) { try { out.set(p, ps(['-p', String(p), '-o', 'command=']).trim()); } catch { /* gone */ } }
  } catch { /* no process table: everything counts as gone */ }
  return out;
}
// node and Chrome processes with their command lines (to see whether an old folder is still used by anything).
export function nodeAndChrome() {
  try {
    if (process.platform === 'win32') return cim("Name='node.exe' OR Name='chrome.exe'");
    return ps(['-axo', 'pid=,command=']).split('\n').map(l => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(m => m && /node|chrom/i.test(m[2])).map(m => [Number(m[1]), m[2]]);
  } catch { return []; }
}
export const norm = s => String(s ?? '').replaceAll('\\', '/').toLowerCase();
// What each recorded PID must still be running.
export const EXPECT = { startUi: 'scripts/verify/start-ui.mjs', server: 'local-server/src/index.js' };
export function sessionState(env, cmds) {
  const is = (pid, needle) => Boolean(pid && needle && norm(cmds.get(pid)).includes(norm(needle)));
  return {
    owner: is(env?.pid, EXPECT.startUi),
    servers: (env?.serverPids ?? []).filter(pid => is(pid, EXPECT.server)),
    chrome: is(env?.chromePid, env?.chromeProfile),
  };
}
export const sessionPids = env => [env?.pid, ...(env?.serverPids ?? []), env?.chromePid];

export function defaultChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') {
    const found = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(d => join(d, 'Google/Chrome/Application/chrome.exe')).find(existsSync);
    if (found) return found;
  }
  return 'google-chrome';
}
export const branchOf = dir => { try { return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch { return '?'; } };
