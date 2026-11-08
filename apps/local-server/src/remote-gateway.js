// Remote access from the phone app (docs/REMOTE_ACCESS.md). The Electron main process owns the settings (enabled, host key,
// paired devices, Hub token) and pushes them here over IPC; this side keeps the Hub control connection, answers relayed
// connections as the Noise responder, and turns each authenticated session into a client of the same message handlers the
// window uses, behind the remote dispatcher's allow list.
//
// Order of checks for a session: the Hub names the device (it authenticated the phone's token) → the device must be paired
// here → the phone must prove the static key paired for that device (Noise IK) → its first transport message must arrive
// within the handshake timeout. Nothing the phone sends is acted on before that first transport message.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createChannel, createHandshake, fingerprint, keyPair, MAX_NOISE_MESSAGE, prologue, sameKey } from './noise.js';
import { REMOTE_TERMINAL_LIMIT, remoteApi, remoteMessage, scopeSummary, SCOPES } from './remote-dispatch.js';
import { fault } from './files.js';

export const LIMITS = {
  handshakeMs: 10_000,
  idleMs: 90_000,
  sessionMs: 12 * 60 * 60_000,
  pairDecisionMs: 120_000,
  sessions: 8,
  sessionsPerDevice: 3,
  pairFailures: 5,
  pastePerMinute: 10,
  bufferedBytes: 8 * 1024 * 1024,
  hubPingMs: 25_000
};
const SUBPROTOCOL = 'mooner-ade.v1';
const b64 = value => Buffer.from(value, 'base64');
const errorValue = error => ({ code: error.code || 'OPERATION_FAILED', message: error.message || '작업에 실패했습니다.' });

// Turns the IPC config into checked values; anything malformed disables remote access rather than half-enabling it.
export function normalizeConfig(value) {
  const off = { enabled: false, devices: [], pairing: null };
  if (!value || value.enabled !== true) return off;
  try {
    const url = new URL(value.hubUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) return off;
    if (typeof value.hostId !== 'string' || !/^[\w-]{1,64}$/.test(value.hostId) || typeof value.accessToken !== 'string' || !value.accessToken) return off;
    const hostKey = keyPair(b64(value.hostKey.privateKey));
    const devices = (Array.isArray(value.devices) ? value.devices : []).filter(device =>
      typeof device?.id === 'string' && /^[\w-]{1,64}$/.test(device.id) && SCOPES.includes(device.scope) && b64(device.key ?? '').length === 32
    ).map(device => ({ id: device.id, name: String(device.name ?? '').slice(0, 80), scope: device.scope, key: b64(device.key) }));
    const pairing = value.pairing && b64(value.pairing.psk ?? '').length === 32 && Number.isFinite(value.pairing.expiresAt)
      ? { id: String(value.pairing.id ?? ''), psk: b64(value.pairing.psk), expiresAt: value.pairing.expiresAt } : null;
    return { enabled: true, hubUrl: url.href.replace(/\/$/, ''), accessToken: value.accessToken, hostId: value.hostId, hostKey, devices, pairing, host: value.host ?? {} };
  } catch { return off; }
}

const wsUrl = (hubUrl, path) => hubUrl.replace(/^http/, 'ws') + path;

// hooks: api(action, input, client) → value; message(client, message); attach(client); detach(client);
//        check(name, input, client) → throws when refused; event(object) to the main process.
export function createRemoteGateway(hooks, { limits = LIMITS, now = Date.now, WebSocketImpl = WebSocket } = {}) {
  let config = normalizeConfig(null), hub = null, hubTimer = null, retry = 0, pairFailures = 0;
  const sessions = new Set(), usedPairings = new Set();
  // A QR stops working once used, or after too many attempts that did not prove its secret.
  const spendPairing = (id, reason) => {
    usedPairings.add(id);
    if (config.pairing?.id === id) config.pairing = null;
    hooks.event({ type: 'remote/pairing-used', id, reason });
  };
  const audit = (kind, detail = {}) => hooks.event({ type: 'remote/audit', at: now(), kind, ...detail });
  const status = () => hooks.event({ type: 'remote/status', hub: hub?.readyState === 1 ? 'online' : config.enabled ? 'connecting' : 'off', sessions: [...sessions].filter(item => item.client).map(item => item.client.remote) });

  // ---- Hub control connection -------------------------------------------------------------------------------------
  function connectHub() {
    clearTimeout(hubTimer); hubTimer = null;
    if (!config.enabled || hub) return;
    const socket = new WebSocketImpl(wsUrl(config.hubUrl, '/v1/host'), [SUBPROTOCOL], { headers: { Authorization: `Bearer ${config.accessToken}` }, maxPayload: 64 * 1024, handshakeTimeout: 15_000 });
    hub = socket;
    let ping = null, alive = true;
    socket.on('open', () => {
      retry = 0; status();
      socket.send(JSON.stringify({ type: 'presence', host: { name: config.host.name, platform: config.host.platform, version: config.host.version } }));
      ping = setInterval(() => { if (!alive) return socket.terminate(); alive = false; socket.ping(); }, limits.hubPingMs);
    });
    socket.on('pong', () => { alive = true; });
    socket.on('unexpected-response', (_request, response) => {
      // 401: the access token expired or was revoked; the main process refreshes it and pushes a new config.
      if (response.statusCode === 401) hooks.event({ type: 'remote/token-expired' });
      else if (response.statusCode === 403) hooks.event({ type: 'remote/hub-denied' });
      socket.terminate();
    });
    socket.on('message', (raw, binary) => { if (!binary) hubMessage(raw.toString()); });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearInterval(ping);
      if (hub === socket) hub = null;
      status();
      if (!config.enabled) return;
      // 1 s, 2 s, 4 s … up to a minute, each with up to 50% jitter so hosts do not reconnect in step after a Hub restart.
      const delay = Math.min(60_000, 1000 * 2 ** retry++) * (1 + Math.random() / 2);
      hubTimer = setTimeout(connectHub, delay); hubTimer.unref?.();
    });
  }
  function hubSend(value) { if (hub?.readyState === 1) hub.send(JSON.stringify(value)); }
  function hubMessage(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message?.type === 'relay/open') openRelay(message);
    else if (message?.type === 'revoke' && typeof message.deviceId === 'string') {
      // The Hub can only take access away. The main process removes the device and pushes a new config.
      for (const session of sessions) if (session.device?.id === message.deviceId) session.close(4003, 'revoked');
      audit('revoked', { deviceId: message.deviceId });
      hooks.event({ type: 'remote/revoked', deviceId: message.deviceId });
    } else if (message?.type === 'ping') hubSend({ type: 'pong' });
  }
  function openRelay(message) {
    const { relayId, mode } = message, device = message.device;
    const reject = reason => { hubSend({ type: 'relay/reject', relayId, reason }); audit('rejected', { reason, deviceId: device?.id, deviceName: device?.name }); };
    if (typeof relayId !== 'string' || !/^[\w-]{1,64}$/.test(relayId) || typeof device?.id !== 'string') return;
    if (mode === 'pair') {
      if (!config.pairing || config.pairing.expiresAt <= now()) return reject('no-pairing');
    } else if (mode === 'session') {
      if (!config.devices.some(item => item.id === device.id)) return reject('unknown-device');
    } else return reject('bad-mode');
    if (sessions.size >= limits.sessions || [...sessions].filter(item => item.device?.id === device.id).length >= limits.sessionsPerDevice) return reject('busy');
    const socket = new WebSocketImpl(wsUrl(config.hubUrl, `/v1/relay/${relayId}`), [SUBPROTOCOL], { headers: { Authorization: `Bearer ${config.accessToken}` }, maxPayload: MAX_NOISE_MESSAGE, handshakeTimeout: 15_000 });
    accept(transportOf(socket), { mode, transport: 'relay', hubDevice: { id: device.id, name: String(device.name ?? '').slice(0, 80) } });
  }

  // ---- Transport-independent session ------------------------------------------------------------------------------
  // A binary WebSocket carrying one Noise message per frame; the relay and (later) the direct listener both provide one.
  function transportOf(socket) {
    return {
      socket,
      send: data => { if (socket.readyState === 1) socket.send(data, { binary: true }); },
      close: (code, reason) => { if (socket.readyState === 0) socket.terminate(); else socket.close(code, reason); },
      get bufferedAmount() { return socket.bufferedAmount; },
      get open() { return socket.readyState === 1; }
    };
  }

  function accept(transport, { mode, transport: kind, hubDevice }) {
    const sessionId = randomUUID();
    const pairing = mode === 'pair' ? config.pairing : null;
    const handshake = createHandshake({ initiator: false, prologue: prologue({ pattern: mode, transport: kind, hostId: config.hostId }), s: config.hostKey, psk: pairing?.psk ?? null });
    let channel = null, device = null, client = null, closed = false, lastSeen = now(), pasteTimes = [], stage = 'handshake';
    const session = {
      get device() { return device; }, get client() { return client; },
      close(code = 1000, reason = '') {
        if (closed) return; closed = true;
        clearTimeout(handshakeTimer); clearInterval(idleTimer); clearTimeout(lifeTimer);
        // A wrong QR secret shows as a phone that hangs up after the second handshake message (IKpsk2 mixes the psk in there)
        // or as a first transport message that does not decrypt.
        if (mode === 'pair' && stage !== 'pairing') {
          audit('pair-failed', { deviceId: hubDevice.id });
          if (++pairFailures >= limits.pairFailures && pairing) spendPairing(pairing.id, 'failures');
        }
        sessions.delete(session);
        if (client) { hooks.detach(client); audit('disconnected', { deviceId: device.id, deviceName: device.name, sessionId, code }); }
        transport.close(code, reason);
        status();
      }
    };
    sessions.add(session);
    const handshakeTimer = setTimeout(() => { audit('timeout', { deviceId: hubDevice.id, mode }); session.close(4008, 'handshake timeout'); }, limits.handshakeMs);
    const idleTimer = setInterval(() => { if (now() - lastSeen > limits.idleMs) session.close(4008, 'idle'); }, Math.min(limits.idleMs, 15_000));
    const lifeTimer = setTimeout(() => session.close(4000, 'session expired'), limits.sessionMs);
    idleTimer.unref?.(); lifeTimer.unref?.();

    const write = value => {
      if (closed || !channel) return;
      const data = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
      for (const part of channel.seal(data)) transport.send(part);
    };
    transport.socket.on('message', (raw, binary) => {
      if (closed) return;
      if (!binary) return session.close(4002, 'binary only');
      lastSeen = now();
      try { onFrame(Buffer.from(raw)); }
      catch (error) {
        if (mode !== 'pair') audit('protocol-error', { deviceId: hubDevice.id, code: error.code });
        session.close(4002, 'protocol error');
      }
    });
    transport.socket.on('close', () => session.close());
    transport.socket.on('error', () => session.close());

    function onFrame(frame) {
      if (stage === 'handshake') {
        handshake.readMessage(frame); // msg1 carries no application data
        if (mode === 'session') {
          // The key must be the one paired for the device the Hub vouched for; an unknown key gets no reply at all.
          const known = config.devices.find(item => item.id === hubDevice.id);
          if (!known || !sameKey(known.key, handshake.remoteStatic)) { audit('unknown-key', { deviceId: hubDevice.id, fingerprint: fingerprint(handshake.remoteStatic) }); return session.close(4003, 'unknown key'); }
          device = { id: known.id, name: known.name || hubDevice.name, scope: known.scope };
        }
        transport.send(handshake.writeMessage());
        channel = createChannel(handshake.split());
        stage = 'transport-first';
        return;
      }
      const data = channel.open(frame);
      if (data === null) return;
      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { throw fault('INVALID_INPUT', '잘못된 메시지입니다.'); }
      if (stage === 'transport-first') {
        clearTimeout(handshakeTimer);
        if (mode === 'pair') return void startPairing(message);
        if (message?.t !== 'start') throw fault('INVALID_INPUT', '세션 시작 메시지가 필요합니다.');
        return start();
      }
      if (stage === 'pairing') return; // waiting for the PC's answer; nothing else is accepted meanwhile
      if (stage === 'open') void handle(message);
    }

    async function startPairing(message) {
      // The psk proved the phone scanned the current QR: the QR is spent now, whatever the PC answers.
      if (message?.t !== 'pair' || !config.pairing || config.pairing.id !== pairing.id || config.pairing.expiresAt <= now()) throw fault('INVALID_INPUT', '페어링 요청이 올바르지 않습니다.');
      stage = 'pairing';
      spendPairing(pairing.id, 'used'); pairFailures = 0;
      const name = typeof message.name === 'string' ? message.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : '';
      const requestId = randomUUID(), key = handshake.remoteStatic;
      audit('pair-request', { deviceId: hubDevice.id, deviceName: name || hubDevice.name, fingerprint: fingerprint(key) });
      const scope = await decide(requestId, { deviceId: hubDevice.id, name: name || hubDevice.name, hubName: hubDevice.name, fingerprint: fingerprint(key), key: key.toString('base64') });
      if (closed) return;
      if (!SCOPES.includes(scope)) { write({ t: 'pair-denied' }); audit('pair-denied', { deviceId: hubDevice.id }); return session.close(4003, 'denied'); }
      audit('paired', { deviceId: hubDevice.id, deviceName: name || hubDevice.name, scope });
      // Pairing ends the connection; the phone reconnects as a paired device, through the same checks as every later session.
      write({ t: 'paired', scope, host: hostInfo() });
      setTimeout(() => session.close(1000, 'paired'), 200).unref?.();
    }

    function start() {
      stage = 'open';
      // The session counts as a client of the window's message handlers from here on.
      client = {
        remote: { sessionId, deviceId: device.id, name: device.name, scope: device.scope, transport: kind, since: now() },
        projects: new Set(),
        get readyState() { return closed || !transport.open ? 3 : 1; },
        get bufferedAmount() { return transport.bufferedAmount; },
        // Messages for the window are already JSON; wrapping the text avoids parsing every terminal output batch again.
        send: text => { if (transport.bufferedAmount > limits.bufferedBytes) return session.close(1013, 'Reconnect to replay'); write(`{"t":"ws","message":${text}}`); },
        close: (code, reason) => session.close(code, reason)
      };
      hooks.attach(client);
      audit('connected', { deviceId: device.id, deviceName: device.name, sessionId, scope: device.scope, transport: kind });
      hooks.event({ type: 'remote/seen', deviceId: device.id, at: now() });
      write({ t: 'hello', host: hostInfo(), session: sessionId, ...scopeSummary(device.scope) });
      status();
    }

    async function handle(message) {
      if (message?.t === 'ping') return write({ t: 'pong' });
      if (message?.t === 'api') {
        const id = message.id;
        if (!Number.isSafeInteger(id)) return session.close(4002, 'protocol error');
        try {
          const request = remoteApi(message.action, message.input, device.scope);
          if (request.check) await hooks.check(request.check, request.input, client);
          const value = await hooks.api(request.action, request.input, client);
          write({ t: 'api', id, ok: true, value: value ?? null });
        } catch (error) {
          if (error.code === 'REMOTE_FORBIDDEN') audit('forbidden', { deviceId: device.id, action: String(message.action).slice(0, 64) });
          write({ t: 'api', id, ok: false, error: errorValue(error) });
        }
        return;
      }
      if (message?.t === 'ws') {
        let clean;
        try {
          clean = remoteMessage(message.message, device.scope);
          if (clean.type === 'terminal/paste-image') {
            pasteTimes = pasteTimes.filter(at => now() - at < 60_000);
            if (pasteTimes.length >= limits.pastePerMinute) throw fault('RATE_LIMITED', '이미지를 너무 자주 보냈습니다. 잠시 뒤 다시 시도하세요.', 429);
            pasteTimes.push(now());
          }
        } catch (error) {
          if (error.code === 'REMOTE_FORBIDDEN') audit('forbidden', { deviceId: device.id, action: String(message.message?.type).slice(0, 64) });
          return write({ t: 'ws', message: { type: 'error', error: errorValue(error), ...(typeof message.message?.projectId === 'string' && { projectId: message.message.projectId }) } });
        }
        return hooks.message(client, clean);
      }
      session.close(4002, 'protocol error');
    }
    return session;
  }

  const pending = new Map();
  // The PC decides through the main process's native dialog; no answer within the limit counts as "deny".
  function decide(requestId, request) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(requestId); resolve(null); }, limits.pairDecisionMs);
      pending.set(requestId, scope => { clearTimeout(timer); pending.delete(requestId); resolve(scope); });
      hooks.event({ type: 'remote/pair-request', requestId, ...request });
    });
  }
  const hostInfo = () => ({ id: config.hostId, name: config.host.name ?? '', platform: config.host.platform ?? '', version: config.host.version ?? '' });

  return {
    configure(value) {
      const next = normalizeConfig(value), previous = config;
      const reconnect = !next.enabled || !previous.enabled || next.hubUrl !== previous.hubUrl || next.hostId !== previous.hostId || !sameKey(next.hostKey?.publicKey, previous.hostKey?.publicKey);
      // A config the main process wrote before it heard that a QR was used up must not bring that QR back.
      if (next.pairing && usedPairings.has(next.pairing.id)) next.pairing = null;
      if (next.pairing?.id !== previous.pairing?.id) pairFailures = 0;
      config = next;
      // A device that is gone or whose scope changed loses its sessions; it reconnects under the new scope.
      for (const session of sessions) {
        const device = session.device, current = device && next.devices.find(item => item.id === device.id);
        if (reconnect || (device && (!current || current.scope !== device.scope))) session.close(4003, 'access changed');
      }
      // A refreshed token only matters for the next connection; the live one stays.
      if (!reconnect && next.accessToken !== previous.accessToken && hub?.readyState !== 1) { hub?.terminate(); hub = null; }
      if (reconnect && hub) { const old = hub; hub = null; old.terminate(); }
      clearTimeout(hubTimer); hubTimer = null; retry = 0;
      if (next.enabled) connectHub();
      status();
    },
    decide(requestId, scope) { pending.get(requestId)?.(scope); },
    disconnect(sessionId) { for (const session of sessions) if (session.client?.remote.sessionId === sessionId) session.close(4003, 'disconnected by host'); },
    // For tests and the direct listener: run a session over an already-open binary WebSocket.
    accept: (socket, options) => accept(transportOf(socket), options),
    get sessions() { return [...sessions].filter(item => item.client).map(item => item.client.remote); },
    close() {
      config = normalizeConfig(null);
      for (const session of sessions) session.close(1001, 'shutting down');
      clearTimeout(hubTimer); hub?.terminate(); hub = null;
      for (const resolve of pending.values()) resolve(null);
    },
    REMOTE_TERMINAL_LIMIT
  };
}
