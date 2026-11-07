// A fake Hub and a phone client for the remote access tests. The fake Hub does what the real one does for a host: checks the
// bearer token, keeps the host's control socket, sends relay/open and pairs the host's relay socket with a phone. The phone
// side is driven in-process instead of over a second WebSocket.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createChannel, createHandshake, prologue } from '../apps/local-server/src/noise.js';

const { WebSocketServer } = createRequire(new URL('../apps/local-server/package.json', import.meta.url))('ws');

export const TOKEN = 'test-access-token';

// Messages arriving on a socket, taken in order with an optional predicate and a timeout.
function inbox() {
  const items = [], waiters = [];
  let closed = null;
  return {
    push(item) { const index = waiters.findIndex(waiter => waiter.match(item)); if (index >= 0) waiters.splice(index, 1)[0].resolve(item); else items.push(item); },
    close(info) { closed = info; for (const waiter of waiters.splice(0)) waiter.reject(Object.assign(new Error(`closed ${info.code}`), info)); },
    next(match = () => true, ms = 5000) {
      const index = items.findIndex(match);
      if (index >= 0) return Promise.resolve(items.splice(index, 1)[0]);
      if (closed) return Promise.reject(Object.assign(new Error(`closed ${closed.code}`), closed));
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('timeout')); }, ms);
        waiters.push(waiter);
      });
    },
    get closed() { return closed; }
  };
}

export async function fakeHub(t) {
  const server = http.createServer((_request, response) => { response.statusCode = 404; response.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const relays = new Map();
  const state = { host: null, hostMessages: inbox(), hostConnections: 0, rejectToken: false };
  server.on('upgrade', (request, socket, head) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}` || state.rejectToken) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    if (request.headers['sec-websocket-protocol'] !== 'mooner-ade.v1') { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const url = new URL(request.url, 'http://hub');
    wss.handleUpgrade(request, socket, head, ws => {
      if (url.pathname === '/v1/host') {
        state.host = ws; state.hostConnections++; state.hostMessages = inbox();
        const messages = state.hostMessages;
        ws.on('message', raw => messages.push(JSON.parse(String(raw))));
        ws.on('close', () => { if (state.host === ws) state.host = null; });
        return;
      }
      const match = /^\/v1\/relay\/([\w-]+)$/.exec(url.pathname), relay = match && relays.get(match[1]);
      if (!relay) return ws.close(4004);
      relays.delete(match[1]); relay.resolve(ws);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const client of wss.clients) client.terminate(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, state,
    async waitHost(ms = 5000) { const end = Date.now() + ms; while (!state.host || state.host.readyState !== 1) { if (Date.now() > end) throw new Error('host never connected'); await new Promise(resolve => setTimeout(resolve, 20)); } return state.host; },
    revoke(deviceId) { state.host.send(JSON.stringify({ type: 'revoke', deviceId })); },
    // Asks the host to take a relayed connection for `device`; resolves with the hub side of the host's relay socket.
    async open({ mode, device }) {
      const host = await this.waitHost(), relayId = randomUUID();
      const socket = new Promise((resolve, reject) => {
        relays.set(relayId, { resolve });
        state.hostMessages.next(message => message.type === 'relay/reject' && message.relayId === relayId, 3000)
          .then(message => reject(Object.assign(new Error(`rejected: ${message.reason}`), { reason: message.reason })), () => {});
      });
      host.send(JSON.stringify({ type: 'relay/open', relayId, mode, device }));
      const ws = await socket, frames = inbox();
      ws.on('message', raw => frames.push(Buffer.from(raw)));
      ws.on('close', (code, reason) => frames.close({ code, reason: String(reason) }));
      return { send: data => ws.send(data), next: ms => frames.next(undefined, ms), frames, close: () => ws.close(), ws };
    }
  };
}

// The phone: Noise initiator over a relayed link, then the session's JSON protocol.
export async function phone(hub, { mode = 'session', device, key, hostKey, hostId, psk = null, start = true, name = 'Test phone' }) {
  const link = await hub.open({ mode, device });
  const handshake = createHandshake({ initiator: true, prologue: prologue({ pattern: mode, transport: 'relay', hostId }), s: key, rs: hostKey, psk });
  link.send(handshake.writeMessage());
  handshake.readMessage(await link.next());
  const channel = createChannel(handshake.split()), messages = inbox();
  let ids = 0;
  (async () => {
    for (;;) {
      let frame;
      try { frame = await link.frames.next(undefined, 600_000); } catch (error) { messages.close(error); return; }
      const data = channel.open(frame);
      if (data) messages.push(JSON.parse(data.toString('utf8')));
    }
  })();
  const send = value => { for (const part of channel.seal(Buffer.from(JSON.stringify(value)))) link.send(part); };
  const client = {
    link, messages, send,
    next: (match, ms) => messages.next(match, ms),
    async api(action, input = {}) {
      const id = ++ids;
      send({ t: 'api', id, action, input });
      const reply = await messages.next(message => message.t === 'api' && message.id === id);
      if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
      return reply.value;
    },
    ws: message => send({ t: 'ws', message }),
    event: (match, ms) => messages.next(message => message.t === 'ws' && match(message.message), ms).then(message => message.message),
    close: () => link.close()
  };
  if (mode === 'pair') send({ t: 'pair', name });
  else if (start) { send({ t: 'start' }); client.hello = await messages.next(message => message.t === 'hello'); }
  return client;
}
