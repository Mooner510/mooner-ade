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
// exits. The app sets a longer linger before an update restart (or none at all, `ms: 0`, when the user leaves the sessions running
// in the background) and asks for `shutdown` on a normal quit. With no terminals and no owner there is nothing to keep, so the host exits.
//
// Besides terminals the host keeps plain piped processes (`proc`: the agent CLIs of the Chat panes). Their stdout is cut into lines
// here; each line gets a number and stays until the owner acknowledges it, so a server that stops (update, dev reload, background)
// says how far it read and the next one goes on from exactly there. Newer ops are announced in the hello's `features`.
import net from 'node:net';
import { spawn as spawnChild } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
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
// key -> { child, meta, lines: [{ n, line }] not yet acknowledged, next (last n), bytes, partial, stderr tail, exit, socket }
const procs = new Map();
const FEATURES = ['proc', 'linger-forever'];
// ponytail: unread output past this ends the process (the next server could not follow it anyway); raise it if long unattended runs hit it.
const MAX_PROC_BYTES = 32 * 1024 * 1024, STDERR_TAIL = 8192, EXITED_KEEP_MS = 10 * 60_000;
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

function spawnProc(socket, message, done) {
  const { key, file, args = [], options = {}, meta = {} } = message;
  if (typeof key !== 'string' || typeof file !== 'string' || procs.has(key) || terminals.has(key)) throw new Error('invalid spawn');
  const child = spawnChild(file, args, { cwd: options.cwd, env: options.env, stdio: 'pipe', windowsHide: true });
  const entry = { child, meta, lines: [], next: 0, bytes: 0, partial: '', stderr: '', exit: null, socket };
  procs.set(key, entry);
  const decoder = new StringDecoder('utf8');
  child.stdout.on('data', chunk => {
    entry.partial += decoder.write(chunk);
    let index;
    while ((index = entry.partial.indexOf('\n')) >= 0) {
      const line = entry.partial.slice(0, index); entry.partial = entry.partial.slice(index + 1);
      if (!line.trim()) continue;
      const n = ++entry.next; entry.lines.push({ n, line }); entry.bytes += line.length;
      if (entry.socket) reply(entry.socket, { ev: 'line', key, n, line });
    }
    if (entry.bytes + entry.partial.length > MAX_PROC_BYTES) { log(`proc ${key}: 읽지 않은 출력이 너무 많아 종료합니다`); child.kill(); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { entry.stderr = (entry.stderr + text).slice(-STDERR_TAIL); if (entry.socket) reply(entry.socket, { ev: 'stderr', key, data: text }); });
  child.stdin.on('error', () => {}); // EPIPE once it is gone; its exit says so
  child.once('spawn', () => done({ ok: true, pid: child.pid }));
  child.once('error', error => { if (!child.pid) { procs.delete(key); done({ ok: false, error: error.message, code: error.code }); settle(); } });
  child.once('close', (code, signal) => {
    if (!child.pid) return;
    const rest = entry.partial + decoder.end(); entry.partial = '';
    if (rest.trim()) { const n = ++entry.next; entry.lines.push({ n, line: rest }); entry.bytes += rest.length; if (entry.socket) reply(entry.socket, { ev: 'line', key, n, line: rest }); }
    entry.exit = { code, signal };
    if (entry.socket) { reply(entry.socket, { ev: 'procExit', key, code, signal }); procs.delete(key); }
    // Nobody reading: kept a while for a server that takes it over and wants its last lines.
    else setTimeout(() => { if (procs.get(key) === entry) { procs.delete(key); settle(); } }, EXITED_KEEP_MS).unref();
    settle();
  });
}
const trim = (entry, n) => { while (entry.lines.length && entry.lines[0].n <= n) entry.bytes -= entry.lines.shift().line.length; };
// What a server takes over: the lines after `after`, and whether any before them are gone already (then it cannot follow on).
function attachProc(socket, key, after) {
  const entry = procs.get(key);
  if (!entry) return { ok: false };
  const first = entry.lines[0]?.n ?? entry.next + 1, missing = first > after + 1;
  trim(entry, after);
  entry.socket = socket;
  const result = { ok: true, pid: entry.child.pid, lines: entry.lines.map(item => [item.n, item.line]), next: entry.next, stderr: entry.stderr, exit: entry.exit, missing };
  if (entry.exit) procs.delete(key);
  return result;
}
// Live sessions of either kind; an exited process nobody has read yet counts too.
const sessionCount = () => terminals.size + procs.size;

// Ends every terminal and exits. `why` goes to the log, so a lost session can be explained afterwards.
function shutdown(why) {
  if (stopping) return; stopping = true;
  log(`종료: ${why} (터미널 ${terminals.size}개, 프로세스 ${procs.size}개)`);
  clearTimeout(lingerTimer);
  for (const entry of terminals.values()) try { entry.process.kill(); } catch { /* already gone */ }
  for (const entry of procs.values()) try { entry.child.kill(); } catch { /* already gone */ }
  server.close();
  if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true });
  // A moment for the kills to reach the shells (ConPTY closes its console asynchronously).
  setTimeout(() => process.exit(0), 300);
}
// Called whenever the owner or the terminal count changes: without an owner, wait for one (with terminals) or exit (without).
function settle() {
  if (stopping || owner) return;
  if (!sessionCount()) { shutdown('소유자와 터미널이 모두 없음'); return; }
  // 0: kept until an owner comes back (the user left the sessions running in the background).
  if (!lingerTimer && lingerMs > 0) {
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
    lingerMs = message.ms === 0 ? 0 : Math.min(MAX_LINGER_MS, Math.max(1000, Number(message.ms) || LINGER_MS));
    if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; settle(); }
    return reply(socket, { re: req, ok: true });
  }
  if (op === 'shutdown') { reply(socket, { re: req, ok: true }); return shutdown(String(message.reason || '앱이 종료를 요청함').slice(0, 200)); }
  if (role !== 'owner') throw new Error('not the owner');
  switch (op) {
    case 'spawn': { const created = spawnTerminal(socket, message); return reply(socket, { re: req, ok: true, pid: created.process.pid }); }
    case 'list': return reply(socket, { re: req, items: [...terminals].map(([id, item]) => ({ key: id, pid: item.process.pid, meta: item.meta })),
      procs: [...procs].map(([id, item]) => ({ key: id, pid: item.child.pid, meta: item.meta, exited: Boolean(item.exit) })) });
    // Replay and subscription happen in one step, so no output is lost or duplicated between them. The size lets the next
    // server tell its windows what the terminal is drawn at (an older host leaves it out; the server then treats it as unknown).
    case 'attach':
      if (!entry) return reply(socket, { re: req, ok: false });
      entry.socket = socket; return reply(socket, { re: req, ok: true, pid: entry.process.pid, data: entry.buffer.text, cols: entry.process.cols, rows: entry.process.rows });
    case 'detach': if (entry?.socket === socket) entry.socket = null; return;
    case 'write': return entry?.process.write(String(message.data));
    case 'resize': return entry?.process.resize(message.cols, message.rows);
    case 'kill': return entry?.process.kill();
    case 'spawnProc': return spawnProc(socket, message, result => reply(socket, { re: req, ...result }));
    case 'attachProc': return reply(socket, { re: req, ...attachProc(socket, key, Number(message.after) || 0) });
    case 'detachProc': { const item = procs.get(key); if (item) { trim(item, Number(message.ack) || 0); if (item.socket === socket) item.socket = null; } return; }
    case 'ack': { const item = procs.get(key); if (item) trim(item, Number(message.n) || 0); return; }
    case 'stdin': return procs.get(key)?.child.stdin.write(String(message.data));
    case 'killProc': { const item = procs.get(key); try { item?.child.kill(['SIGTERM', 'SIGKILL', 'SIGINT'].includes(message.signal) ? message.signal : 'SIGTERM'); } catch { /* gone */ } return; }
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
        reply(socket, { ev: 'hello', protocol: PTY_PROTOCOL, pid: process.pid, terminals: terminals.size, procs: procs.size, features: FEATURES });
        continue;
      }
      try { handle(socket, message, role); } catch (error) { reply(socket, { re: message?.req, ok: false, error: error.message }); }
    }
  });
  socket.on('close', () => {
    for (const entry of terminals.values()) if (entry.socket === socket) entry.socket = null;
    for (const entry of procs.values()) if (entry.socket === socket) entry.socket = null;
    if (owner === socket) { owner = null; settle(); }
  });
  socket.on('error', () => {});
});

if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true });
server.on('error', error => { log(`대기 실패: ${error.message}`); process.exit(1); });
server.listen(endpoint, () => {
  log(`시작 (pid ${process.pid}, protocol ${PTY_PROTOCOL})`);
  // Nobody connected at all (the app died while starting it): do not stay around.
  setTimeout(() => { if (!owner && !sessionCount()) shutdown('처음 연결을 기다리다 시간 초과'); }, FIRST_OWNER_MS).unref();
});
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
// One terminal's stray error must not take every other terminal with it.
process.on('uncaughtException', error => log(`오류: ${error?.stack || error}`));
