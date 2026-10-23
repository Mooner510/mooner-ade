// Owns the node-pty processes so the local server can restart (dev hot reload) without killing running terminals.
// Started by the desktop shell with an IPC channel; it exits, taking every terminal with it, when that channel closes.
// Wire format: one JSON object per line over a named pipe / unix socket. The first line must be {op:'hello', token}.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { timingSafeEqual } from 'node:crypto';
import { createTerminalBuffer } from './terminal-buffer.js';

const endpoint = process.env.ADE_PTY_ENDPOINT, token = process.env.ADE_PTY_TOKEN;
if (!endpoint || !token) { console.error('ADE_PTY_ENDPOINT / ADE_PTY_TOKEN are required'); process.exit(2); }
if (process.platform !== 'win32') {
  try { fs.chmodSync(path.join(path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), 0o755); } catch { /* no prebuilt helper */ }
}
const pty = await import('node-pty');
const terminals = new Map(); // key -> { process, meta, buffer, owner }
let owner = null; // the one connected server; a new connection replaces it and the terminals keep running

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const reply = (socket, value) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };

function spawnTerminal(socket, message) {
  const { key, file, args = [], options = {}, meta = {} } = message;
  if (typeof key !== 'string' || typeof file !== 'string' || terminals.has(key)) throw new Error('invalid spawn');
  const child = pty.spawn(file, args, { name: 'xterm-256color', useConptyDll: process.platform === 'win32', cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env });
  const entry = { process: child, meta, buffer: createTerminalBuffer(), socket };
  terminals.set(key, entry);
  child.onData(data => { entry.buffer.append(data); if (entry.socket) reply(entry.socket, { ev: 'data', key, data }); });
  child.onExit(event => { terminals.delete(key); if (entry.socket) reply(entry.socket, { ev: 'exit', key, exitCode: event.exitCode, signal: event.signal }); });
  return entry;
}

function handle(socket, message) {
  const { op, req, key } = message, entry = terminals.get(key);
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
  let pending = '', authed = false;
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    pending += chunk;
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (!authed) {
          if (message.op !== 'hello' || !same(message.token, token)) return socket.destroy();
          authed = true; owner?.destroy(); owner = socket; continue;
        }
        handle(socket, message);
      } catch (error) { if (authed) reply(socket, { re: (() => { try { return JSON.parse(line).req; } catch { return undefined; } })(), ok: false, error: error.message }); else socket.destroy(); }
    }
  });
  socket.on('close', () => { if (owner === socket) owner = null; for (const entry of terminals.values()) if (entry.socket === socket) entry.socket = null; });
  socket.on('error', () => {});
});

function shutdown() { for (const entry of terminals.values()) try { entry.process.kill(); } catch { /* already gone */ } server.close(); if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true }); process.exit(0); }
if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true });
server.listen(endpoint, () => { process.send?.({ type: 'ready' }); });
// Terminals must not outlive the app: the IPC channel closes when the desktop shell exits or crashes.
process.on('disconnect', shutdown);
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('message', message => { if (message?.type === 'shutdown') shutdown(); });
