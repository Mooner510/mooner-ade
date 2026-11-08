// Owns the node-pty processes, apart from the local server and the app, so that terminals keep running while the server restarts
// (dev hot reload, a crash) and while the app restarts for an update. The app starts it detached from a copy outside the install
// folder (apps/desktop/src/pty-host-files.js) and finds it again through a file in its data folder.
//
// Wire format: one JSON object per line over a named pipe / unix socket. The first line must be {op:'hello', token, role}; the host
// answers {ev:'hello', protocol, pid, terminals}. role 'owner' (the local server; the default) takes the terminals over from any
// previous owner. role 'control' (the app) only sends `linger` / `shutdown` and does not touch the owner.
//
// Lifetime: while an owner is connected the host runs. When the owner goes away, terminals keep running (their output is kept in
// each terminal's tail buffer) until a new owner connects or the linger time runs out; then every terminal is ended and the host
// exits. The app sets a longer linger before an update restart and asks for `shutdown` on a normal quit. With no terminals and no
// owner there is nothing to keep, so the host exits.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { timingSafeEqual } from 'node:crypto';
import { createTerminalBuffer } from './terminal-buffer.js';
import { ignoreSocketErrors } from './pty-safety.js';
import { PTY_PROTOCOL } from './pty-protocol.js';

const endpoint = process.env.ADE_PTY_ENDPOINT, token = process.env.ADE_PTY_TOKEN;
// Without an owner: how long terminals are kept by default (a server that died), and how long a fresh host waits for its first owner.
const LINGER_MS = Number(process.env.ADE_PTY_LINGER_MS) || 2 * 60_000, FIRST_OWNER_MS = Number(process.env.ADE_PTY_FIRST_OWNER_MS) || 60_000;
const MAX_LINGER_MS = 30 * 60_000;
if (!endpoint || !token) { console.error('ADE_PTY_ENDPOINT / ADE_PTY_TOKEN are required'); process.exit(2); }
// Terminals get their environment from the server with each spawn; these must not leak into them either way.
for (const name of ['ADE_PTY_ENDPOINT', 'ADE_PTY_TOKEN', 'ADE_PTY_LINGER_MS', 'ADE_PTY_FIRST_OWNER_MS']) delete process.env[name];
if (process.platform !== 'win32') {
  try { fs.chmodSync(path.join(path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), 0o755); } catch { /* no prebuilt helper */ }
}
const pty = await import('node-pty');
const terminals = new Map(); // key -> { process, meta, buffer, socket }
let owner = null; // the one connected server; a new owner replaces it and the terminals keep running
let lingerMs = LINGER_MS, lingerTimer = null, stopping = false;

const log = message => console.error(`[pty-host ${new Date().toISOString()}] ${message}`);
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const reply = (socket, value) => { if (socket && !socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };

function spawnTerminal(socket, message) {
  const { key, file, args = [], options = {}, meta = {} } = message;
  if (typeof key !== 'string' || typeof file !== 'string' || terminals.has(key)) throw new Error('invalid spawn');
  const child = pty.spawn(file, args, { name: 'xterm-256color', useConptyDll: process.platform === 'win32', cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env });
  ignoreSocketErrors(child);
  const entry = { process: child, meta, buffer: createTerminalBuffer(), socket };
  terminals.set(key, entry);
  child.onData(data => { entry.buffer.append(data); if (entry.socket) reply(entry.socket, { ev: 'data', key, data }); });
  child.onExit(event => { terminals.delete(key); if (entry.socket) reply(entry.socket, { ev: 'exit', key, exitCode: event.exitCode, signal: event.signal }); settle(); });
  return entry;
}

// Ends every terminal and exits. `why` goes to the log, so a lost session can be explained afterwards.
function shutdown(why) {
  if (stopping) return; stopping = true;
  log(`종료: ${why} (터미널 ${terminals.size}개)`);
  clearTimeout(lingerTimer);
  for (const entry of terminals.values()) try { entry.process.kill(); } catch { /* already gone */ }
  server.close();
  if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true });
  // A moment for the kills to reach the shells (ConPTY closes its console asynchronously).
  setTimeout(() => process.exit(0), 300);
}
// Called whenever the owner or the terminal count changes: without an owner, wait for one (with terminals) or exit (without).
function settle() {
  if (stopping || owner) return;
  if (!terminals.size) { shutdown('소유자와 터미널이 모두 없음'); return; }
  if (!lingerTimer) {
    const ms = lingerMs;
    lingerTimer = setTimeout(() => shutdown(`${Math.round(ms / 1000)}초 동안 다시 연결되지 않음`), ms);
  }
}
function adopt(socket) {
  clearTimeout(lingerTimer); lingerTimer = null;
  if (owner && owner !== socket) owner.destroy();
  owner = socket; lingerMs = LINGER_MS;
}

function handle(socket, message, role) {
  const { op, req, key } = message, entry = terminals.get(key);
  // The app's control link: how long to keep terminals once the owner is gone, or end everything now.
  if (op === 'linger') {
    lingerMs = Math.min(MAX_LINGER_MS, Math.max(1000, Number(message.ms) || LINGER_MS));
    if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; settle(); }
    return reply(socket, { re: req, ok: true });
  }
  if (op === 'shutdown') { reply(socket, { re: req, ok: true }); return shutdown(String(message.reason || '앱이 종료를 요청함').slice(0, 200)); }
  if (role !== 'owner') throw new Error('not the owner');
  switch (op) {
    case 'spawn': { const created = spawnTerminal(socket, message); return reply(socket, { re: req, ok: true, pid: created.process.pid }); }
    case 'list': return reply(socket, { re: req, items: [...terminals].map(([id, item]) => ({ key: id, pid: item.process.pid, meta: item.meta })) });
    // Replay and subscription happen in one step, so no output is lost or duplicated between them.
    case 'attach':
      if (!entry) return reply(socket, { re: req, ok: false });
      entry.socket = socket; return reply(socket, { re: req, ok: true, pid: entry.process.pid, data: entry.buffer.text });
    case 'detach': if (entry?.socket === socket) entry.socket = null; return;
    case 'write': return entry?.process.write(String(message.data));
    case 'resize': return entry?.process.resize(message.cols, message.rows);
    case 'kill': return entry?.process.kill();
    default: throw new Error('unknown op');
  }
}

const server = net.createServer(socket => {
  let pending = '', role = null;
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    pending += chunk;
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { if (!role) return socket.destroy(); continue; }
      if (!role) {
        if (message?.op !== 'hello' || !same(message.token, token)) return socket.destroy();
        role = message.role === 'control' ? 'control' : 'owner';
        if (role === 'owner') adopt(socket);
        reply(socket, { ev: 'hello', protocol: PTY_PROTOCOL, pid: process.pid, terminals: terminals.size });
        continue;
      }
      try { handle(socket, message, role); } catch (error) { reply(socket, { re: message?.req, ok: false, error: error.message }); }
    }
  });
  socket.on('close', () => {
    for (const entry of terminals.values()) if (entry.socket === socket) entry.socket = null;
    if (owner === socket) { owner = null; settle(); }
  });
  socket.on('error', () => {});
});

if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true });
server.on('error', error => { log(`대기 실패: ${error.message}`); process.exit(1); });
server.listen(endpoint, () => {
  log(`시작 (pid ${process.pid}, protocol ${PTY_PROTOCOL})`);
  // Nobody connected at all (the app died while starting it): do not stay around.
  setTimeout(() => { if (!owner && !terminals.size) shutdown('처음 연결을 기다리다 시간 초과'); }, FIRST_OWNER_MS).unref();
});
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
// One terminal's stray error must not take every other terminal with it.
process.on('uncaughtException', error => log(`오류: ${error?.stack || error}`));
