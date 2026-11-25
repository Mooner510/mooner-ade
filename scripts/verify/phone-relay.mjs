// Small, side-effect-free pieces of the phone <-> PC end-to-end rig (phone-rig.mjs re-exports them): free ports and the Hub relay that can be cut.
import net from 'node:net';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
// The relay's port is baked into the debug APK (BuildConfig.HUB_URL), so it is the same every run (the APK is only rebuilt when it changes); a busy one falls back to a free port.
export const pickPort = preferred => new Promise(res => { const s = net.createServer(); s.once('error', () => freePort().then(res)); s.listen(preferred, '127.0.0.1', () => s.close(() => res(preferred))); });

// A transparent TCP relay in front of the Hub: what the phone (through `adb reverse`) and the plugin both reach. `cut(ms)` drops every connection
// and refuses new ones for a while, the way a real network break does, while the Hub keeps its accounts (it is in memory: restarting it would sign everything out).
export function relayProxy({ port, targetPort }) {
  const sockets = new Set(), events = [];
  let server = null, accepted = 0;
  const note = what => events.push({ at: Date.now(), what });
  const listen = () => new Promise((res, rej) => {
    const s = net.createServer(client => {
      accepted++;
      const upstream = net.connect(targetPort, '127.0.0.1');
      for (const sock of [client, upstream]) { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); sock.on('error', () => sock.destroy()); }
      client.pipe(upstream); upstream.pipe(client);
    });
    s.once('error', rej); s.listen(port, '127.0.0.1', () => { server = s; res(); });
  });
  const stop = () => new Promise(res => { const s = server; server = null; for (const sock of [...sockets]) sock.destroy(); if (!s) return res(); s.close(() => res()); });
  return {
    start: async () => { await listen(); note('listening'); },
    stop,
    // Down for `ms`, then listening again on the same port (the clients' retries find it there).
    async cut(ms) { note(`cut ${ms}ms`); await stop(); await sleep(ms); await listen(); note('listening again'); },
    get open() { return sockets.size; }, get accepted() { return accepted; }, events
  };
}

