// This PC as the *client* of another PC's ADE (docs/REMOTE_UI.md, "PC에서 PC로"): what the MoonerADE phone app does, in Node.
// - the Hub session (kind `desktop`): sign in with a device code, keep the tokens fresh, list the account's PCs;
// - pairing with a link the other PC made (`moonerade://pair?...`): Noise IKpsk2, the other PC's owner approves there;
// - the link itself: Noise IK through the Hub's relay, `start → hello`, then `api` calls and the ADE's `ws` messages, kept alive and
//   reconnected by itself. Protocol: mooner-ade-plugins/docs/REMOTE_ACCESS.md; the phone app's RemoteLink.kt is the same thing.
// Free of Electron: the stored state, `fetchImpl`, the socket (`dial`) and the clock are injected, so tests run it against a fake Hub.
import { createHash } from 'node:crypto';
import os from 'node:os';
import { DEFAULT_HUB_URL } from './hub-client.js';
import { createChannel, createHandshake, fingerprint, keyPair, pairingPsk, prologue } from './vendor/noise.js';

const SUBPROTOCOL = 'mooner-ade.v1';
const HANDSHAKE_MS = 10_000, HELLO_MS = 10_000, PAIR_MS = 180_000, OPEN_MS = 30_000, CALL_MS = 60_000, PING_MS = 30_000, IDLE_MS = 90_000;
const MAX_FAILURES = 40;
const HOST_ID = /^[\w-]{1,64}$/;
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

export const fail = (message, code = 'REMOTE_FAILED') => Object.assign(new Error(message), { code });
const isLocal = origin => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const b64 = value => Buffer.from(value, 'base64');

// ---- the pairing link --------------------------------------------------------------------------------------------------------
// moonerade://pair?v=1&k=<host key>&h=<host id>&t=<secret>&n=<name>: the same rules as the phone app (PairLink.kt). The key is what
// the PC is pinned to; the secret proves this link was made on that PC and is used once.
export function parsePairLink(text) {
  const bad = () => fail('페어링 링크가 올바르지 않습니다. 접속할 PC의 원격 접속 설정에 나온 링크를 그대로 붙여넣으세요.', 'BAD_LINK');
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 1024) throw bad();
  let url;
  try { url = new URL(raw); } catch { throw bad(); }
  if (url.protocol !== 'moonerade:' || url.hostname !== 'pair') throw bad();
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) throw bad();
  const get = name => url.searchParams.get(name) ?? '';
  const hostId = get('h');
  if (get('v') !== '1' || !KEY_TEXT.test(get('k')) || !KEY_TEXT.test(get('t')) || !HOST_ID.test(hostId)) throw bad();
  const name = get('n').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return { hostKey: Buffer.from(get('k'), 'base64url'), secret: Buffer.from(get('t'), 'base64url'), hostId, name: name || 'PC' };
}

// ---- one socket --------------------------------------------------------------------------------------------------------------
// Frames and the close in order, for `await`: next(ms) is the next binary frame; once the socket closed it rejects with { code, reason }.
function attach(socket) {
  socket.binaryType = 'arraybuffer';
  const queue = [], waiters = [];
  let closed = null;
  socket.addEventListener('message', event => {
    if (typeof event.data === 'string') { socket.close(1003, 'binary only'); return; }
    const data = Buffer.from(event.data), waiter = waiters.shift();
    if (waiter) waiter.resolve(data); else queue.push(data);
  });
  socket.addEventListener('close', event => {
    closed = { code: event.code, reason: String(event.reason ?? '') };
    for (const waiter of waiters.splice(0)) waiter.reject(Object.assign(new Error(`closed ${closed.code}`), closed));
  });
  socket.addEventListener('error', () => {});
  return {
    get closed() { return closed; },
    opened: () => new Promise((resolve, reject) => {
      if (socket.readyState === 1) return resolve();
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('close', event => reject(Object.assign(new Error('Hub에 연결하지 못했습니다.'), { code: 'HUB_REFUSED', close: event.code })), { once: true });
    }),
    next(ms) {
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.reject(Object.assign(new Error(`closed ${closed.code}`), closed));
      return new Promise((resolve, reject) => {
        const waiter = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(Object.assign(new Error('응답이 없습니다.'), { code: 'TIMEOUT' })); }, ms);
        waiters.push(waiter);
      });
    }
  };
}

// Noise handshake as the initiator over an open socket → the channel. A wrong answer is the PC's key not being the one we pinned.
async function handshake({ socket, io, hostId, hostKey, key, mode, psk }) {
  const noise = createHandshake({ initiator: true, prologue: prologue({ pattern: mode, transport: 'relay', hostId }), s: key, rs: hostKey, psk });
  socket.send(noise.writeMessage());
  const reply = await io.next(HANDSHAKE_MS);
  try { noise.readMessage(reply); } catch { throw fail('이 PC의 키가 페어링할 때와 다릅니다. 접속할 PC를 다시 페어링하세요.', 'HOST_KEY'); }
  return createChannel(noise.split());
}
const sealer = (socket, channel) => value => { for (const part of channel.seal(Buffer.from(JSON.stringify(value)))) socket.send(part); };
const read = (channel, frame) => { const data = channel.open(frame); return data ? JSON.parse(data.toString('utf8')) : null; };

// The first message after the handshake, waited for (hello, or the PC's answer to a pairing request).
async function firstMessage(io, channel, match, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const message = read(channel, await io.next(Math.max(1, end - Date.now())));
    if (message && match(message)) return message;
  }
}

// ---- the link to one PC ------------------------------------------------------------------------------------------------------
// `connect(refresh)` opens a socket to the Hub's relay (refresh: the last try may have failed on an expired token). The link keeps one
// session at a time and starts the next after a drop: 1 s, 2 s, 4 s … up to 30 s with jitter, 40 tries in a row. A close the PC
// meant (not allowed any more, protocol error, a different key) ends it for good; `on.closed` says why.
export function createLink({ connect, hostId, hostKey, key, backoff = { baseMs: 1000, maxMs: 30_000 }, random = Math.random, on = {} }) {
  const pending = new Map();
  let ids = 0, send = null, hello = null, open = false, stopped = false, final = null, socket = null, waiting = [], sessionUp = false;
  const setOpen = value => { if (open === value) return; open = value; on.state?.(value); if (value) for (const waiter of waiting.splice(0)) waiter.resolve(); };
  const endPending = error => { for (const [id, item] of pending) { pending.delete(id); clearTimeout(item.timer); item.reject(error); } };
  const finish = error => {
    final = error; stopped = true; setOpen(false);
    endPending(error);
    for (const waiter of waiting.splice(0)) waiter.reject(error);
    on.closed?.({ code: error.code, message: error.message });
  };

  async function session(refresh) {
    socket = await connect(refresh);
    const io = attach(socket);
    await io.opened();
    const channel = await handshake({ socket, io, hostId, hostKey, key, mode: 'session' });
    send = sealer(socket, channel);
    send({ t: 'start' });
    hello = await firstMessage(io, channel, message => message.t === 'hello', HELLO_MS);
    setOpen(true); sessionUp = true;
    const ping = setInterval(() => { try { send({ t: 'ping' }); } catch { /* the read loop sees the close */ } }, PING_MS);
    try {
      for (;;) {
        const message = read(channel, await io.next(IDLE_MS));
        if (!message) continue;
        if (message.t === 'api' && pending.has(message.id)) {
          const item = pending.get(message.id);
          pending.delete(message.id); clearTimeout(item.timer);
          if (message.ok) item.resolve(message.value);
          else item.reject(Object.assign(new Error(message.error?.message ?? '원격 요청이 실패했습니다.'), { code: message.error?.code ?? 'REMOTE_ERROR', files: message.error?.files }));
        } else if (message.t === 'ws') on.message?.(JSON.stringify(message.message));
      }
    } finally { clearInterval(ping); send = null; setOpen(false); endPending(fail('PC와의 연결이 끊겼습니다.', 'REMOTE_DISCONNECTED')); }
  }
  // A socket that is not used any more is closed, whichever step ended the session.
  const run1 = async refresh => { try { await session(refresh); } finally { try { socket?.close(1000); } catch { /* closed */ } } };

  (async () => {
    let failures = 0, refresh = false;
    while (!stopped) {
      let immediate = false;
      sessionUp = false;
      try { await run1(refresh); }
      catch (error) {
        if (stopped) break;
        if (error.code === 'HOST_KEY') return finish(error);
        if (error.code === 4002 || error.code === 4003) {
          // 4003 "access changed" / "busy" come back when the PC settles; anything else means this device may not connect.
          if (error.code === 4002 || !/access changed|busy/.test(error.reason ?? '')) return finish(fail(error.code === 4003 ? '이 PC에서 이 기기의 접속을 허용하지 않습니다. 다시 페어링하세요.' : 'PC가 이 기기의 연결을 받아들이지 못했습니다. PC의 키가 바뀌었거나 통신 규칙이 맞지 않습니다. 다시 페어링하세요.', error.code === 4003 ? 'DENIED' : 'PROTOCOL'));
        }
        if (error.code === 'HUB_REFUSED' && !refresh) { refresh = true; immediate = true; }   // maybe the token ran out: refresh it once, try again at once
        else if (error.code === 4000 || error.code === 4001) { immediate = true; failures = 0; }
        else failures = sessionUp ? 1 : failures + 1;   // a session that had been up starts the backoff low again
        if (sessionUp) refresh = false;
        if (failures > MAX_FAILURES) return finish(fail('PC에 다시 연결하지 못했습니다.', 'GAVE_UP'));
      }
      if (stopped) break;
      if (!immediate) {
        const step = Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.max(0, failures - 1));
        await sleep(step / 2 + random() * (step / 2));
      }
    }
  })();

  const link = {
    get open() { return open; },
    get hello() { return hello; },
    get final() { return final; },
    // Resolves once a session is up (the first one, or the one after a drop); rejects when the link is over.
    whenOpen(ms = OPEN_MS) {
      if (open) return Promise.resolve();
      if (final) return Promise.reject(final);
      return new Promise((resolve, reject) => {
        const waiter = { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } };
        const timer = setTimeout(() => { waiting.splice(waiting.indexOf(waiter), 1); reject(fail('PC에 연결하지 못했습니다. PC가 켜져 있고 원격 접속이 켜져 있는지 확인하세요.', 'REMOTE_TIMEOUT')); }, ms);
        waiting.push(waiter);
      });
    },
    async call(action, input = {}, ms = CALL_MS) {
      await link.whenOpen();
      const id = ++ids;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(fail('PC가 제때 응답하지 않았습니다.', 'REMOTE_TIMEOUT')); }, ms);
        pending.set(id, { resolve, reject, timer });
        try { send({ t: 'api', id, action, input }); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
    // A message for the ADE's `/ws` (subscribe, terminal input, …). false when there is no session right now.
    send(message) { try { if (!send) return false; send({ t: 'ws', message }); return true; } catch { return false; } },
    close() {
      if (!stopped) { stopped = true; final = final ?? fail('연결을 닫았습니다.', 'CLOSED'); }
      setOpen(false); endPending(fail('연결을 닫았습니다.', 'CLOSED'));
      for (const waiter of waiting.splice(0)) waiter.reject(final);
      try { socket?.close(1000); } catch { /* already closed */ } }
  };
  return link;
}

// ---- the Hub session and this PC's pairings ---------------------------------------------------------------------------------
const deviceName = () => `ADE - ${String(os.hostname() || 'PC').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40).trim() || 'PC'}`;
const emptyState = () => ({ account: null, deviceId: null, tokens: null, key: null, hosts: [] });

// `store`: { read() → state | null, write(state) }. The state holds secrets (Hub tokens, this PC's Noise key): the caller seals it.
export function createRemoteClient({ store, baseUrl = process.env.ADE_HUB_URL || DEFAULT_HUB_URL, fetchImpl = globalThis.fetch, dial = (url, options) => new globalThis.WebSocket(url, options), now = Date.now, name = deviceName, platform = process.platform, hostname = os.hostname, backoff, minPollMs = 2000 } = {}) {
  let base = null;
  try { base = new URL(baseUrl); } catch { /* unusable below */ }
  if (base && base.protocol !== 'https:' && !isLocal(base.origin)) base = null;
  const origin = base?.origin ?? null;
  let loaded = null;
  const state = () => loaded ??= { ...emptyState(), ...(store.read() ?? {}) };
  const save = next => { loaded = next; store.write(next); };

  async function request(path, { method = 'GET', body, token = null, timeout = 15_000 } = {}) {
    if (!origin) throw fail('Hub 주소가 올바르지 않습니다(https 주소여야 합니다).', 'HUB_UNAVAILABLE');
    let response;
    try {
      response = await fetchImpl(new URL(path, origin), { method, redirect: 'manual', signal: AbortSignal.timeout(timeout),
        headers: { Accept: 'application/json', 'User-Agent': 'MoonerADE-remote', ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) { throw fail(error?.name === 'TimeoutError' ? 'Hub가 제때 응답하지 않았습니다.' : 'Hub에 연결할 수 없습니다. 인터넷 연결을 확인하세요.', error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK'); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw fail('Hub가 예상하지 못한 주소로 보내 요청을 중단했습니다.', 'HTTP'); }
    return response;
  }
  const json = async response => { try { return await response.json(); } catch { throw fail('Hub의 응답이 올바르지 않습니다.', 'HTTP'); } };
  const httpError = async (response, what) => {
    let detail = '';
    try { detail = (await response.json())?.error?.message ?? ''; } catch { /* no body */ }
    if (response.status === 403) return fail('이 계정은 MoonerADE 원격 접속을 쓸 수 없습니다. 계정 권한을 확인하세요.', 'FORBIDDEN');
    if (response.status === 429) return fail('요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.', 'RATE_LIMITED');
    return fail(`${what}하지 못했습니다${detail ? ` (${String(detail).slice(0, 120)})` : ` (HTTP ${response.status})`}.`, 'HTTP');
  };
  const signedOut = () => fail('Hub에 로그인하지 않았습니다. 먼저 로그인하세요.', 'NOT_SIGNED_IN');

  let refreshing = null;
  // One refresh at a time; the rotated refresh token is saved before anything uses the new access token.
  const refresh = () => refreshing ??= (async () => {
    const current = state();
    if (!current.tokens) throw signedOut();
    const response = await request('/v1/token/refresh', { method: 'POST', body: { refreshToken: current.tokens.refresh } });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      save({ ...emptyState(), hosts: [] });
      throw fail('Hub 로그인이 끝났습니다. 다시 로그인하세요.', 'UNAUTHORIZED');
    }
    if (!response.ok) throw await httpError(response, '로그인을 갱신');
    const body = await json(response);
    if (typeof body?.accessToken !== 'string' || typeof body.refreshToken !== 'string' || !(body.accessExpiresIn > 0)) throw fail('Hub의 로그인 응답이 올바르지 않습니다.', 'HTTP');
    const tokens = { access: body.accessToken, refresh: body.refreshToken, accessExpiresAt: now() + body.accessExpiresIn * 1000 };
    save({ ...state(), tokens });
    return tokens;
  })().finally(() => { refreshing = null; });
  async function accessToken(force = false) {
    const tokens = state().tokens;
    if (!tokens) throw signedOut();
    return !force && tokens.accessExpiresAt - now() > 60_000 ? tokens.access : (await refresh()).access;
  }
  async function authed(path, options) {
    let response = await request(path, { ...options, token: await accessToken() });
    if (response.status === 401) { await response.body?.cancel().catch(() => {}); response = await request(path, { ...options, token: await accessToken(true) }); }
    return response;
  }

  let enrolling = null;
  const keyOf = () => { const stored = state().key; if (!stored) throw signedOut(); return keyPair(b64(stored.privateKey)); };
  // The key's hash as the Hub shows it for a PC (hex of the first 16 bytes of SHA-256 over the raw key).
  const keyHash = key => createHash('sha256').update(key).digest('hex').slice(0, 32);

  return {
    get available() { return Boolean(origin); },
    get hubHost() { return base?.host ?? null; },
    get signedIn() { return Boolean(state().tokens); },
    get account() { return state().account; },
    get fingerprint() { return state().key ? fingerprint(keyPair(b64(state().key.privateKey)).publicKey) : null; },

    // ---- sign in (device code): the browser page to open and the code to compare ----------------------------------------------
    async signInStart() {
      const pair = keyPair();
      const response = await request('/v1/enroll/start', { method: 'POST', body: { kind: 'desktop', name: name(), platform: String(platform).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32) || 'unknown', key: pair.publicKey.toString('base64') } });
      if (!response.ok) throw await httpError(response, '로그인을 시작');
      const body = await json(response);
      let verify = null;
      try { verify = new URL(body?.verifyUrl); } catch { /* checked below */ }
      // Only the Hub's own page: the code is approved there.
      if (typeof body?.enrollId !== 'string' || typeof body.pollToken !== 'string' || typeof body.userCode !== 'string' || verify?.origin !== origin) throw fail('Hub의 로그인 응답이 올바르지 않습니다.', 'HTTP');
      enrolling = { enrollId: body.enrollId, pollToken: body.pollToken, pair, intervalMs: Math.max(minPollMs, (Number(body.interval) || 5) * 1000), endsAt: now() + Math.min(900, Number(body.expiresIn) || 600) * 1000, cancelled: false };
      return { userCode: body.userCode.slice(0, 20), verifyUrl: verify.href, expiresAt: enrolling.endsAt };
    },
    // Waits for the approval in the browser: { account }. A new key comes with a new sign-in, so earlier pairings no longer hold.
    async signInWait() {
      const current = enrolling;
      if (!current) throw fail('로그인을 먼저 시작하세요.', 'NOT_STARTED');
      try {
        while (!current.cancelled && now() < current.endsAt) {
          await sleep(current.intervalMs);
          if (current.cancelled) break;
          const response = await request('/v1/enroll/poll', { method: 'POST', body: { enrollId: current.enrollId, pollToken: current.pollToken } });
          if (response.status === 429) { await response.body?.cancel().catch(() => {}); current.intervalMs += 5000; continue; }
          if (response.status === 410) { await response.body?.cancel().catch(() => {}); throw fail('로그인이 거부되었거나 시간이 지났습니다. 다시 시도하세요.', 'DENIED'); }
          if (!response.ok) throw await httpError(response, '로그인을 확인');
          const body = await json(response);
          if (body?.status === 'pending') continue;
          const deviceId = typeof body?.device?.id === 'string' && /^[\w.-]{1,64}$/.test(body.device.id) ? body.device.id : null;
          if (body?.status !== 'approved' || !deviceId || typeof body.accessToken !== 'string' || typeof body.refreshToken !== 'string' || !(body.accessExpiresIn > 0)) throw fail('Hub의 로그인 응답이 올바르지 않습니다.', 'HTTP');
          const account = String(body.account?.name ?? '').trim().slice(0, 100) || String(body.account?.email ?? '').trim().slice(0, 100) || '계정';
          save({ account, deviceId, tokens: { access: body.accessToken, refresh: body.refreshToken, accessExpiresAt: now() + body.accessExpiresIn * 1000 },
            key: { privateKey: current.pair.privateKey.toString('base64'), publicKey: current.pair.publicKey.toString('base64') }, hosts: [] });
          return { account };
        }
        throw fail(current.cancelled ? '로그인을 취소했습니다.' : '로그인 시간이 지났습니다. 다시 시도하세요.', current.cancelled ? 'CANCELLED' : 'DENIED');
      } finally { if (enrolling === current) enrolling = null; }
    },
    signInCancel() { if (enrolling) enrolling.cancelled = true; },
    async signOut() {
      const tokens = state().tokens;
      if (tokens) { try { const response = await request('/v1/me', { method: 'DELETE', token: tokens.access, timeout: 10_000 }); await response.body?.cancel().catch(() => {}); } catch { /* it stays on the account's list until removed there */ } }
      save(emptyState());
    },

    // ---- the account's PCs, with what this PC knows about each -----------------------------------------------------------------
    async hosts() {
      const response = await authed('/v1/hosts');
      if (!response.ok) throw await httpError(response, 'PC 목록을 받지');
      const body = await json(response), paired = state().hosts;
      // This PC's own remote access (if it runs one) is in the list too. The Hub names a PC by its host name, so a PC of that name is
      // flagged (`self`), not hidden: another PC may share the name.
      const own = String(hostname() ?? '').slice(0, 80);
      const listed = (Array.isArray(body?.hosts) ? body.hosts : []).filter(item => typeof item?.id === 'string' && HOST_ID.test(item.id)).map(item => {
        const known = paired.find(host => host.hostId === item.id);
        return { hostId: item.id, name: String(item.name ?? '').slice(0, 80) || 'PC', self: Boolean(own) && String(item.name ?? '').slice(0, 80) === own, platform: String(item.platform ?? '').slice(0, 20), online: item.online === true, paired: Boolean(known), scope: known?.scope ?? null,
          fingerprint: known?.fingerprint ?? null, keyChanged: Boolean(known && typeof item.keyHash === 'string' && item.keyHash !== keyHash(b64(known.key))), inAccount: true };
      });
      const extra = paired.filter(host => !listed.some(item => item.hostId === host.hostId)).map(host => ({ hostId: host.hostId, name: host.name, self: false, platform: '', online: false, paired: true, scope: host.scope, fingerprint: host.fingerprint, keyChanged: false, inAccount: false }));
      return [...listed, ...extra];
    },

    // ---- pairing: what the link says (to show and compare), then the request the other PC's owner approves ----------------------
    offer(text) {
      const link = parsePairLink(text);
      return { hostId: link.hostId, name: link.name, hostFingerprint: fingerprint(link.hostKey), myFingerprint: this.fingerprint, alreadyPaired: state().hosts.some(host => host.hostId === link.hostId) };
    },
    async pair(text) {
      const link = parsePairLink(text);
      if (!state().tokens) throw signedOut();
      const key = keyOf();
      let socket;
      try {
        socket = await dial(`${origin.replace(/^http/, 'ws')}/v1/connect/${link.hostId}?mode=pair`, { protocols: [SUBPROTOCOL], headers: { Authorization: `Bearer ${await accessToken()}` } });
        const io = attach(socket);
        await io.opened().catch(error => { throw fail(error.close === 404 ? '이 계정에서 그 PC를 찾지 못했습니다. 같은 계정으로 로그인했는지 확인하세요.' : 'PC에 연결하지 못했습니다. PC가 켜져 있고 원격 접속이 켜져 있는지 확인하세요.', 'HUB_REFUSED'); });
        // A secret that does not match is seen as the PC's answer not opening (the psk is mixed in at its second handshake message).
        const channel = await handshake({ socket, io, hostId: link.hostId, hostKey: link.hostKey, key, mode: 'pair', psk: pairingPsk(link.secret) })
          .catch(error => { throw error.code === 'HOST_KEY' ? fail('페어링 링크가 맞지 않거나 이미 쓴 링크입니다. PC에서 새 링크를 만드세요.', 'DENIED') : error; });
        sealer(socket, channel)({ t: 'pair', name: name() });
        // The other PC asks its owner, who has 2 minutes; a wrong or used link makes it hang up before that.
        const answer = await firstMessage(io, channel, message => message.t === 'paired' || message.t === 'pair-denied', PAIR_MS).catch(error => {
          throw error.code === 'TIMEOUT' || typeof error.code === 'number' ? fail('PC에서 연결을 승인하지 않았습니다. 링크가 만료되었거나 이미 쓴 링크일 수 있습니다. PC에서 새 링크를 만드세요.', 'DENIED') : error;
        });
        if (answer.t !== 'paired') throw fail('PC에서 연결을 거부했습니다.', 'DENIED');
        const host = { hostId: link.hostId, name: String(answer.host?.name ?? link.name).slice(0, 80) || link.name, key: link.hostKey.toString('base64'), scope: answer.scope === 'control' ? 'control' : 'view', fingerprint: fingerprint(link.hostKey), pairedAt: now() };
        save({ ...state(), hosts: [...state().hosts.filter(item => item.hostId !== host.hostId), host] });
        return { hostId: host.hostId, name: host.name, scope: host.scope };
      } finally { try { socket?.close(1000); } catch { /* closed */ } }
    },
    forget(hostId) { save({ ...state(), hosts: state().hosts.filter(host => host.hostId !== hostId) }); },
    pairedHost: hostId => state().hosts.find(host => host.hostId === hostId) ?? null,

    // The link to a paired PC. `on`: { state(open), message(text), closed({ code, message }) }.
    link(hostId, on = {}) {
      const host = state().hosts.find(item => item.hostId === hostId);
      if (!host) throw fail('페어링하지 않은 PC입니다.', 'NOT_PAIRED');
      return createLink({ hostId, hostKey: b64(host.key), key: keyOf(), backoff, on,
        connect: async forceRefresh => dial(`${origin.replace(/^http/, 'ws')}/v1/connect/${hostId}?mode=session`, { protocols: [SUBPROTOCOL], headers: { Authorization: `Bearer ${await accessToken(forceRefresh)}` } }) });
    }
  };
}
