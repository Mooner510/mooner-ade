// A fake Hub and a fake "other PC" for the remote client tests (apps/desktop/src/remote-link.js, remote-window.js).
// The Hub side: the device-code sign-in, token refresh, the PC list, and the relay socket. Instead of pairing that socket with a PC's own
// socket the fake answers it itself as the PC does (a Noise responder with the plugin's session protocol), which is all the client sees.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createChannel, createHandshake, fingerprint, keyPair, pairingPsk, prologue, safetyCode } from '../apps/desktop/src/vendor/noise.js';

const { WebSocketServer } = createRequire(new URL('../apps/local-server/package.json', import.meta.url))('ws');

export const ACCESS = 'aha_test-access';
const b64url = buffer => Buffer.from(buffer).toString('base64url');

// `api(action, input, session)` answers an api call (return a value, or throw { code, message }); `onWs(message, session)` gets the `ws` messages
// (answer with session.send({ t: 'ws', message })); `hello` is the lists the PC announces; `scope` is what it grants.
// One Hub can serve several PCs of the account: the first is the options of this call (its per-PC state is `hub.state`), more come from
// `hub.addHost({ hostId, hostName, api, … })`, which returns the same helpers (pairLink, hostFingerprint, state) for that PC.
export async function fakeHub(t, { approve = true, ...first } = {}) {
  const state = { enrolls: 0, polls: 0, refreshes: 0, signedOut: 0, enrollBody: null, refreshToken: 'ahr_1', denyUpgrade: 0, accessGood: ACCESS };
  const hosts = new Map();
  const defaults = { hostId: 'host-1', hostName: '작업 PC', api: () => ({}), onWs: null, hello: { api: ['snapshot', 'ui/manifest', 'ui/file'], messages: ['subscribe'], features: [] }, scope: 'control' };
  const makeHost = (spec, own) => {
    const host = { ...defaults, ...spec, hostKey: keyPair(), secret: Buffer.alloc(32, hosts.size + 7) };
    Object.assign(own, { online: true, closeNext: null, sessions: [], pairings: [], requests: [], answerRequest: 'approve', connects: 0, knownKeys: new Set() });
    host.state = own;
    host.pairLink = () => `moonerade://pair?v=1&k=${b64url(host.hostKey.publicKey)}&h=${host.hostId}&t=${b64url(host.secret)}&n=${encodeURIComponent(host.hostName)}`;
    host.hostFingerprint = () => fingerprint(host.hostKey.publicKey);
    hosts.set(host.hostId, host);
    return host;
  };
  const primary = makeHost(first, state);
  const json = (response, status, value) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const url = new URL(request.url, 'http://hub');
    const authed = request.headers.authorization === `Bearer ${state.accessGood}`;
    if (url.pathname === '/v1/enroll/start') {
      state.enrolls++; state.enrollBody = input;
      return json(response, 200, { enrollId: 'e1', pollToken: 'p1', userCode: 'ABCD-1234', verifyUrl: `${hub.url}/enroll?code=ABCD-1234`, interval: 0.01, expiresIn: 600 });
    }
    if (url.pathname === '/v1/enroll/poll') {
      state.polls++;
      if (!approve) return json(response, 410, { error: { code: 'gone', message: 'gone' } });
      if (state.polls < 2) return json(response, 200, { status: 'pending' });
      return json(response, 200, { status: 'approved', device: { id: 'desktop-1' }, account: { id: 'acc', name: '무너' }, accessToken: ACCESS, refreshToken: state.refreshToken, accessExpiresIn: 3600 });
    }
    if (url.pathname === '/v1/token/refresh') {
      state.refreshes++;
      if (input.refreshToken !== state.refreshToken) return json(response, 401, { error: { code: 'invalid-token', message: 'no' } });
      state.refreshToken = `ahr_${state.refreshes + 1}`; state.accessGood = `aha_${state.refreshes}`;
      return json(response, 200, { accessToken: state.accessGood, refreshToken: state.refreshToken, accessExpiresIn: 3600 });
    }
    if (url.pathname === '/v1/me' && request.method === 'DELETE') { state.signedOut++; return json(response, 204, {}); }
    if (url.pathname === '/v1/hosts') {
      if (!authed) return json(response, 401, { error: { code: 'token-expired', message: 'expired' } });
      return json(response, 200, { hosts: [...hosts.values()].map(host => ({ id: host.hostId, name: host.hostName, platform: 'darwin', version: '0.7.0', keyHash: keyHash(host.hostKey.publicKey), key: host.hostKey.publicKey.toString('base64'), online: host.state.online, lastSeenAt: 1 })) });
    }
    json(response, 404, { error: { code: 'not-found', message: 'not found' } });
  });
  const wss = new WebSocketServer({ noServer: true, handleProtocols: protocols => protocols.has('mooner-ade.v1') ? 'mooner-ade.v1' : false });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://hub');
    if (state.denyUpgrade > 0 || request.headers.authorization !== `Bearer ${state.accessGood}`) { if (state.denyUpgrade > 0) state.denyUpgrade--; socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
    const host = hosts.get(/^\/v1\/connect\/([\w-]+)$/.exec(url.pathname)?.[1] ?? '');
    if (!host || !host.state.online) { socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, ws => answer(ws, url.searchParams.get('mode'), host));
  });
  // The other PC, as the plugin's gateway answers: Noise IK (IKpsk2 for a pairing) as the responder, then the session's JSON frames.
  function answer(ws, mode, host) {
    const { hostId, hostName, hostKey, secret, scope, hello, api, onWs, state: mine } = host;
    mine.connects++;
    const sess = { ws, mode, messages: [], sent: [] };
    mine.sessions.push(sess);
    let noise = null, channel = null, stage = 'handshake';
    const send = value => { for (const part of channel.seal(Buffer.from(JSON.stringify(value)))) ws.send(part); };
    sess.send = value => send(value);
    ws.on('message', raw => {
      try {
        const frame = Buffer.from(raw);
        if (stage === 'handshake') {
          noise = createHandshake({ initiator: false, prologue: prologue({ pattern: mode, transport: 'relay', hostId }), s: hostKey, psk: mode === 'pair' ? pairingPsk(secret) : null });
          noise.readMessage(frame);
          // A PC answers only the keys it paired (an empty set: nobody is restricted yet, as before any pairing).
          if (mode === 'session' && mine.knownKeys.size && !mine.knownKeys.has(Buffer.from(noise.remoteStatic).toString('base64'))) return ws.close(4003, 'unknown key');
          ws.send(noise.writeMessage());
          channel = createChannel(noise.split()); stage = 'open';
          sess.clientKey = noise.remoteStatic;
          if (mine.closeNext) { const [code, reason] = mine.closeNext; mine.closeNext = null; ws.close(code, reason); }
          return;
        }
        const data = channel.open(frame);
        if (!data) return;
        const message = JSON.parse(data.toString('utf8'));
        sess.messages.push(message);
        if (message.t === 'start') send({ t: 'hello', host: { id: hostId, name: hostName, platform: 'darwin', version: '0.7.0' }, session: 's1', scope, ...hello });
        else if (message.t === 'pair') {
          mine.pairings.push(message);
          if (mine.denyPair) { send({ t: 'pair-denied' }); ws.close(4003, 'denied'); } else { mine.knownKey = sess.clientKey; mine.knownKeys.add(Buffer.from(sess.clientKey).toString('base64')); send({ t: 'paired', scope, host: { id: hostId, name: hostName } }); setTimeout(() => ws.close(1000), 50); }
        } else if (message.t === 'request') {
          // A connection request: the code from the keys this PC sees, then the owner's answer ('approve', 'deny', or null: never).
          mine.requests.push(message);
          send({ t: 'request-pending', code: mine.requestCode ?? safetyCode(hostKey.publicKey, sess.clientKey) });
          const answer = mine.answerRequest;
          if (answer) setTimeout(() => {
            if (answer === 'deny') { send({ t: 'pair-denied' }); ws.close(4003, 'denied'); return; }
            mine.knownKeys.add(Buffer.from(sess.clientKey).toString('base64'));
            send({ t: 'paired', scope: message.scope, host: { id: hostId, name: hostName } }); setTimeout(() => ws.close(1000), 50);
          }, 30);
        } else if (message.t === 'ws') onWs?.(message.message, sess);
        else if (message.t === 'ping') send({ t: 'pong' });
        else if (message.t === 'api') {
          Promise.resolve().then(() => api(message.action, message.input, sess)).then(value => send({ t: 'api', id: message.id, ok: true, value }), error => send({ t: 'api', id: message.id, ok: false, error: { code: error.code ?? 'ERR', message: error.message } }));
        }
      } catch { ws.close(4002, 'protocol'); }
    });
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const client of wss.clients) client.terminate(); server.closeAllConnections?.(); server.close(); });
  const hub = {
    url: `http://127.0.0.1:${server.address().port}`, state, hostId: primary.hostId, hostName: primary.hostName, hostKey: primary.hostKey, secret: primary.secret,
    // The link the other PC's settings show.
    pairLink: primary.pairLink, hostFingerprint: primary.hostFingerprint,
    addHost: spec => makeHost(spec, {}),
    // Waits for a condition (a session opened, a message seen).
    async until(check, what = 'condition', ms = 5000) { const end = Date.now() + ms; for (;;) { const value = check(); if (value) return value; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 10)); } }
  };
  return hub;
}

import { createHash } from 'node:crypto';
export const keyHash = key => createHash('sha256').update(key).digest('hex').slice(0, 32);

// The stored state in memory (the app seals it).
export function memoryStore(initial = null) {
  const store = { value: initial, writes: 0, read: () => store.value, write: value => { store.value = JSON.parse(JSON.stringify(value)); store.writes++; } };
  return store;
}
