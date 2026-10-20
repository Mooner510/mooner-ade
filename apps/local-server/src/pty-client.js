// Talks to pty-host.js. `factory.spawn` mirrors node-pty's API (but resolves asynchronously), so LocalTerminal can use it unchanged.
import net from 'node:net';
import { randomUUID } from 'node:crypto';

export async function connectPtyHost({ endpoint, token }) {
  const socket = await new Promise((resolve, reject) => {
    const connection = net.connect(endpoint);
    connection.once('connect', () => resolve(connection)); connection.once('error', reject);
  });
  socket.setEncoding('utf8');
  const replies = new Map(), sessions = new Map();
  const write = value => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
  const request = value => new Promise((resolve, reject) => {
    const req = randomUUID(); replies.set(req, { resolve, reject }); write({ ...value, req });
  });

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

  let pending = '';
  socket.on('data', chunk => {
    pending += chunk;
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      const message = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
      if (message.re) { const waiting = replies.get(message.re); replies.delete(message.re); if (message.ok === false) waiting?.reject(new Error(message.error || 'pty-host request failed')); else waiting?.resolve(message); }
      else if (message.ev === 'data') sessions.get(message.key)?.emit(message.data);
      else if (message.ev === 'exit') { const item = sessions.get(message.key); sessions.delete(message.key); item?.finish({ exitCode: message.exitCode, signal: message.signal }); }
    }
  });
  // Without the host nothing can be written or read any more: surface it as every terminal exiting.
  socket.on('close', () => {
    for (const waiting of replies.values()) waiting.reject(new Error('pty-host disconnected'));
    replies.clear();
    for (const item of [...sessions.values()]) item.finish({ exitCode: -1, lost: true });
    sessions.clear();
  });
  socket.on('error', () => {});
  write({ op: 'hello', token });

  return {
    close: () => socket.end(),
    factory: {
      async spawn(file, args, { meta, ...options }) {
        const key = randomUUID(), created = session(key, undefined);
        try { created.pid = (await request({ op: 'spawn', key, file, args, options, meta })).pid; } catch (error) { sessions.delete(key); throw error; }
        return created;
      }
    },
    async list() { return (await request({ op: 'list' })).items; },
    async attach(key) {
      const created = session(key, undefined);
      try { const result = await request({ op: 'attach', key }); created.pid = result.pid; created.initial = result.data; return created; }
      catch (error) { sessions.delete(key); throw error; }
    }
  };
}
