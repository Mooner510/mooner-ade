// Talks to pty-host.js. `factory.spawn` mirrors node-pty's API (but resolves asynchronously), so LocalTerminal can use it unchanged.
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { ptyProtocolSupported } from './pty-protocol.js';

const HELLO_TIMEOUT_MS = 5000;

// Connects and says hello. Resolves the socket and the host's hello ({protocol, pid, terminals}) once the host has answered with a
// protocol this code can use; a host that does not answer (protocol 1 never did), answers with another version or refuses the
// token rejects with `code: 'PTY_INCOMPATIBLE'` or the connection error.
export function helloPtyHost({ endpoint, token, role = 'owner', timeoutMs = HELLO_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    let pending = '', done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); socket.off('data', onData);
      if (error) { socket.destroy(); reject(error); } else resolve(value);
    };
    const incompatible = message => Object.assign(new Error(message), { code: 'PTY_INCOMPATIBLE' });
    const timer = setTimeout(() => finish(incompatible('pty-host가 응답하지 않습니다')), timeoutMs);
    const onData = chunk => {
      pending += chunk;
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      let hello;
      try { hello = JSON.parse(pending.slice(0, newline)); } catch { return finish(incompatible('pty-host 응답을 읽지 못했습니다')); }
      if (hello?.ev !== 'hello' || !ptyProtocolSupported(hello.protocol)) return finish(incompatible(`pty-host 프로토콜 ${hello?.protocol ?? '알 수 없음'}은 지원하지 않습니다`));
      // Paused until the caller listens; whatever came after the hello line is handed over as `rest`.
      socket.pause();
      finish(null, { socket, hello, rest: pending.slice(newline + 1) });
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ op: 'hello', token, role })}\n`));
    socket.on('data', onData);
    socket.once('error', error => finish(error));
    socket.once('close', () => finish(incompatible('pty-host가 연결을 닫았습니다')));
  });
}

// One control request from the app (`linger`, `shutdown`) that does not take the terminals from the server.
export async function ptyHostControl({ endpoint, token }, request, { timeoutMs = HELLO_TIMEOUT_MS } = {}) {
  const { socket, hello, rest } = await helloPtyHost({ endpoint, token, role: 'control', timeoutMs });
  return new Promise(resolve => {
    const req = randomUUID();
    let pending = rest;
    const done = value => { clearTimeout(timer); socket.end(); resolve(value); };
    const timer = setTimeout(() => done({ ok: false, hello, error: 'timeout' }), timeoutMs);
    socket.on('data', chunk => {
      pending += chunk;
      for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
        let message; try { message = JSON.parse(pending.slice(0, newline)); } catch { message = null; }
        pending = pending.slice(newline + 1);
        if (message?.re === req) return done({ ...message, hello });
      }
    });
    // `shutdown` may end the host before the answer gets out.
    socket.on('close', () => done({ ok: request.op === 'shutdown', hello }));
    socket.on('error', () => {});
    socket.write(`${JSON.stringify({ ...request, req })}\n`);
    socket.resume();
  });
}

export async function connectPtyHost({ endpoint, token }) {
  const { socket, hello, rest } = await helloPtyHost({ endpoint, token, role: 'owner' });
  const replies = new Map(), sessions = new Map(), procs = new Map();
  const write = value => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
  // `sync` sees the answer in the same tick it arrives, before any event the host sent after it.
  const request = (value, sync) => new Promise((resolve, reject) => {
    if (socket.destroyed) return reject(new Error('pty-host disconnected'));
    const req = randomUUID(); replies.set(req, { resolve, reject, sync }); write({ ...value, req });
  });

  // A piped process in the host, shaped like the ChildProcess chat.js drives: stdin.write, stdout/stderr 'data', 'spawn'/'error'/'close', kill().
  // stdout comes as whole lines; they are held until something listens (as a real pipe would) and `lastLine` is the number of the last one handed on.
  const procSession = key => {
    const proc = Object.assign(new EventEmitter(), { key, pid: undefined, exitCode: null, signalCode: null, lastLine: 0, acked: 0, stdout: new EventEmitter(), stderr: new EventEmitter() });
    let held = [], ended = null, closed = false;
    const finish = () => { if (closed || held.length || !ended) return; closed = true; procs.delete(key); proc.exitCode = ended.code; proc.signalCode = ended.signal; proc.emit('exit', ended.code, ended.signal); proc.emit('close', ended.code, ended.signal); };
    const flush = () => { while (held.length && proc.stdout.listenerCount('data')) { const [n, line] = held.shift(); proc.lastLine = n; proc.stdout.emit('data', `${line}\n`); } finish(); };
    proc.stdout.on('newListener', name => { if (name === 'data') queueMicrotask(flush); });
    proc.line = (n, line) => { held.push([n, line]); flush(); };
    proc.end = (code, signal) => { ended ??= { code, signal }; flush(); };
    proc.stdin = Object.assign(new EventEmitter(), {
      write(data, callback) {
        if (socket.destroyed || closed) { const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }); queueMicrotask(() => { callback?.(error); proc.stdin.emit('error', error); }); return false; }
        write({ op: 'stdin', key, data: String(data) }); if (callback) queueMicrotask(() => callback()); return true;
      },
      end() {}
    });
    proc.kill = (signal = 'SIGTERM') => { if (!closed) write({ op: 'killProc', key, signal }); return true; };
    // Leaves it running in the host for the next server, which goes on after `lastLine`.
    proc.detach = () => { procs.delete(key); write({ op: 'detachProc', key, ack: proc.lastLine }); };
    procs.set(key, proc);
    return proc;
  };
  // The host keeps lines until they are acknowledged; once a second is enough to keep its memory down.
  const ackTimer = setInterval(() => { for (const proc of procs.values()) if (proc.lastLine > proc.acked) { proc.acked = proc.lastLine; write({ op: 'ack', key: proc.key, n: proc.lastLine }); } }, 1000);
  ackTimer.unref();

  // A session is the node-pty look-alike for one remote terminal. Output that arrives before anyone listens is held back.
  const session = (key, pid) => {
    const dataListeners = new Set(), exitListeners = new Set(); let queued = [], exited = null;
    const value = {
      key, pid,
      onData(callback) {
        dataListeners.add(callback);
        if (queued.length) { const held = queued; queued = []; for (const data of held) callback(data); }
        return { dispose: () => dataListeners.delete(callback) };
      },
      onExit(callback) { exitListeners.add(callback); if (exited) callback(exited); return { dispose: () => exitListeners.delete(callback) }; },
      write: data => write({ op: 'write', key, data }),
      resize: (cols, rows) => write({ op: 'resize', key, cols, rows }),
      kill: () => write({ op: 'kill', key }),
      close: () => write({ op: 'kill', key }), // the PtySession name for kill, for sessions adopted without LocalTerminal
      // Stops listening but leaves the terminal running in the host, to be attached again by the next server.
      detach: () => { sessions.delete(key); write({ op: 'detach', key }); },
      emit: data => { if (dataListeners.size) for (const callback of dataListeners) callback(data); else queued.push(data); },
      finish: event => { exited = event; for (const callback of exitListeners) callback(event); }
    };
    sessions.set(key, value); return value;
  };

  let pending = rest;
  socket.on('data', chunk => {
    pending += chunk;
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      const message = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
      if (message.re) { const waiting = replies.get(message.re); replies.delete(message.re); waiting?.sync?.(message); if (message.ok === false) waiting?.reject(Object.assign(new Error(message.error || 'pty-host request failed'), message.code && { code: message.code })); else waiting?.resolve(message); }
      else if (message.ev === 'line') procs.get(message.key)?.line(message.n, message.line);
      else if (message.ev === 'stderr') procs.get(message.key)?.stderr.emit('data', Buffer.from(String(message.data)));
      else if (message.ev === 'procExit') procs.get(message.key)?.end(message.code, message.signal);
      else if (message.ev === 'data') sessions.get(message.key)?.emit(message.data);
      else if (message.ev === 'exit') { const item = sessions.get(message.key); sessions.delete(message.key); item?.finish({ exitCode: message.exitCode, signal: message.signal }); }
    }
  });
  const closeListeners = new Set();
  // Without the host nothing can be written or read any more: surface it as every terminal exiting.
  socket.on('close', () => {
    for (const listener of closeListeners) listener();
    for (const waiting of replies.values()) waiting.reject(new Error('pty-host disconnected'));
    replies.clear();
    for (const item of [...sessions.values()]) item.finish({ exitCode: -1, lost: true });
    sessions.clear();
    clearInterval(ackTimer);
    for (const proc of [...procs.values()]) proc.end(null, 'SIGHUP');
  });
  socket.on('error', () => {});
  socket.resume();

  return {
    hello,
    close: () => socket.end(),
    onClose: listener => { closeListeners.add(listener); },
    factory: {
      async spawn(file, args, { meta, ...options }) {
        const key = randomUUID(), created = session(key, undefined);
        try { created.pid = (await request({ op: 'spawn', key, file, args, options, meta })).pid; } catch (error) { sessions.delete(key); throw error; }
        return created;
      }
    },
    // Whether this host keeps piped processes (an older one, handed over by an update, does not).
    procs: Array.isArray(hello.features) && hello.features.includes('proc'),
    // Returns at once, like child_process.spawn; 'spawn' or 'error' follows.
    spawnProc(file, args, { cwd, env, meta } = {}) {
      const key = randomUUID(), proc = procSession(key);
      request({ op: 'spawnProc', key, file, args, options: { cwd, env }, meta }, answer => { if (answer.ok !== false) { proc.pid = answer.pid; queueMicrotask(() => proc.emit('spawn')); } })
        .catch(error => { procs.delete(key); proc.emit('error', error); }); // refused (ENOENT keeps its code) or the host is gone
      return proc;
    },
    // Takes over a process a previous server left running, from the line after `after`. `missing`: lines before those are gone (it cannot be followed on).
    async attachProc(key, after = 0) {
      const proc = procSession(key);
      try {
        await request({ op: 'attachProc', key, after }, answer => {
          if (answer.ok === false) return;
          proc.pid = answer.pid; proc.missing = answer.missing === true; proc.lastLine = proc.acked = after;
          for (const [n, line] of answer.lines ?? []) proc.line(n, line);
          if (answer.stderr) proc.stderrTail = answer.stderr;
          if (answer.exit) proc.end(answer.exit.code, answer.exit.signal);
        });
        return proc;
      } catch (error) { procs.delete(key); throw error; }
    },
    async listProcs() { return (await request({ op: 'list' })).procs ?? []; },
    async list() { return (await request({ op: 'list' })).items; },
    async attach(key) {
      const created = session(key, undefined);
      try { const result = await request({ op: 'attach', key }); created.pid = result.pid; created.initial = result.data; created.size = { cols: result.cols, rows: result.rows }; return created; }
      catch (error) { sessions.delete(key); throw error; }
    }
  };
}
