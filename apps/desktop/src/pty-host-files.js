// Where the pty-host (apps/local-server/src/pty-host.js) runs from, and how the app finds a running one again. Electron-free, so it
// can be tested.
//
// The host outlives the app across an update restart, so it must not run from the install folder: on Windows the update mirrors the
// new files over that folder (robocopy /MIR) and a running node.exe, conpty.dll or OpenConsole.exe there would be locked; on macOS
// the bundle is moved aside. So the host's files (its few sources, node-pty and the Node binary) are copied once into the app's
// data folder, under a name made from their contents, and run from there. An update that does not change them reuses the copy.
//
// The running host is described in `pty-host.json` next to the copies: endpoint, token, pid, protocol and the copy it runs from.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Everything pty-host.js imports from the server sources, and nothing more (tests/pty-host.test.mjs checks the import list).
export const HOST_SOURCES = ['pty-host.js', 'terminal-buffer.js', 'pty-safety.js', 'pty-protocol.js'];
const RENDEZVOUS = 'pty-host.json', HOST_PID = '.host-pid';

// node-pty files the host never loads: sources, debug symbols, other platforms' prebuilds.
function ptyFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name), rel = path.relative(base, full).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      if (['src', 'deps', 'scripts', 'typings', 'test', 'node_modules'].includes(rel) || rel === 'build/Debug') continue;
      if (/^prebuilds\/[^/]+$/.test(rel) && rel !== `prebuilds/${process.platform}-${process.arch}`) continue;
      if (/^third_party\/conpty\/[^/]+\/[^/]+$/.test(rel) && !rel.endsWith(`win10-${process.arch}`)) continue;
      ptyFiles(full, base, out);
    } else if (!/\.(pdb|md|ts|map|gyp)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// The files a host copy consists of: [{ from, to }] with `to` relative to the copy.
export function hostFiles({ serverSrc, nodePtyDir, nodeBinary }) {
  return [
    ...HOST_SOURCES.map(name => ({ from: path.join(serverSrc, name), to: `src/${name}` })),
    ...ptyFiles(nodePtyDir).map(rel => ({ from: path.join(nodePtyDir, rel), to: `node_modules/node-pty/${rel}` })),
    { from: nodeBinary, to: process.platform === 'win32' ? 'node.exe' : 'node' }
  ];
}

// Sources by content; the large binaries by size and modification time, which change with every new build of them.
export function hostKey(files) {
  const hash = createHash('sha256');
  for (const { from, to } of [...files].sort((a, b) => a.to.localeCompare(b.to))) {
    hash.update(`${to}\0`);
    if (to.startsWith('src/') || to.endsWith('.js') || to.endsWith('.json')) hash.update(fs.readFileSync(from));
    else { const stat = fs.statSync(from); hash.update(`${stat.size}:${Math.trunc(stat.mtimeMs)}`); }
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

// Returns the copy to run ({ dir, entry, node }), making it when missing. Copied to a temporary folder and renamed into place,
// so a half-written copy (the app killed mid-way) is never used.
export function prepareHostCopy({ root, serverSrc, nodePtyDir, nodeBinary }) {
  const files = hostFiles({ serverSrc, nodePtyDir, nodeBinary }), key = hostKey(files), dir = path.join(root, key);
  const result = { dir, entry: path.join(dir, 'src', 'pty-host.js'), node: path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node'), key };
  if (fs.existsSync(path.join(dir, '.complete'))) return result;
  fs.mkdirSync(root, { recursive: true });
  const temp = path.join(root, `.tmp-${key}-${randomBytes(4).toString('hex')}`);
  try {
    for (const { from, to } of files) {
      const target = path.join(temp, to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(from, target);
    }
    if (process.platform !== 'win32') fs.chmodSync(path.join(temp, 'node'), 0o755);
    // ESM: the sources are modules (as in the server's package.json).
    fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ name: 'mooner-ade-pty-host', private: true, type: 'module' }));
    fs.writeFileSync(path.join(temp, '.complete'), key);
    try { fs.renameSync(temp, dir); }
    catch (error) {
      // Another start made the same copy first; use that one.
      if (!fs.existsSync(path.join(dir, '.complete'))) throw error;
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  return result;
}

// Removes copies that no running host uses. One still in use is locked on Windows and simply stays.
// Records which host runs from a copy, for sweepHostCopies.
export function markHostCopy(dir, pid) {
  try { fs.writeFileSync(path.join(dir, HOST_PID), String(pid)); } catch { /* only keeps the sweep from waiting for it */ }
}
export function sweepHostCopies(root, keep) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || keep.includes(entry.name)) continue;
    // A host may still run from it: an earlier version's host that this app could not take over, ending its terminals in its own
    // time. Windows lets a delete get halfway through such a folder, so it is left alone until that host is gone.
    const dir = path.join(root, entry.name);
    let pid = 0;
    try { pid = Number(fs.readFileSync(path.join(dir, HOST_PID), 'utf8')); } catch { /* never started */ }
    if (pid > 0 && processAlive(pid)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swept next time */ }
  }
}

export const newEndpoint = () => {
  const id = randomBytes(8).toString('hex');
  return process.platform === 'win32' ? `\\\\.\\pipe\\mooner-ade-pty-${id}` : path.join(os.tmpdir(), `mooner-ade-pty-${id}.sock`);
};

export function readRendezvous(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, RENDEZVOUS), 'utf8'));
    if (typeof value?.endpoint !== 'string' || typeof value.token !== 'string' || !Number.isInteger(value.pid)) return null;
    return value;
  } catch { return null; }
}
// Only this user can read it (the data folder is already private on Windows): the token lets a process drive every terminal.
export function writeRendezvous(root, value) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, RENDEZVOUS), temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    // It holds the token that runs commands in the user's terminals. On Windows the mode does nothing: the file would take the
    // folder's ACL, which other local accounts may read, so it gets an ACL of its own before the token goes in.
    fs.writeFileSync(temp, '', { mode: 0o600 });
    if (process.platform === 'win32') restrictToUser(temp);
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, file);
  }
  finally { fs.rmSync(temp, { force: true }); }
}
export function restrictToUser(file) {
  execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], { stdio: 'ignore', windowsHide: true });
}
export function clearRendezvous(root, pid) {
  const current = readRendezvous(root);
  if (current && (pid === undefined || current.pid === pid)) fs.rmSync(path.join(root, RENDEZVOUS), { force: true });
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
