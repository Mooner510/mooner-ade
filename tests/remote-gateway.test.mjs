import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { keyPair, pairingPsk } from '../apps/local-server/src/noise.js';
import { createRemoteGateway, normalizeConfig } from '../apps/local-server/src/remote-gateway.js';
import { fakeHub, phone, TOKEN } from './remote-helpers.mjs';

const hostKey = keyPair(), phoneKey = keyPair(), HOST_ID = 'host-test';
const device = { id: 'dev-1', name: 'Pixel' };
const b64 = buffer => buffer.toString('base64');
const config = (hub, extra = {}) => ({
  enabled: true, hubUrl: hub.url, accessToken: TOKEN, hostId: HOST_ID, hostKey: { privateKey: b64(hostKey.privateKey) },
  host: { name: 'Test PC', platform: 'win32', version: '0.0.0' }, devices: [], pairing: null, ...extra
});
const paired = (scope = 'control', key = phoneKey) => [{ id: device.id, name: device.name, key: b64(key.publicKey), scope }];

// A gateway with recording hooks instead of the real server.
function gateway(t, { limits } = {}) {
  const events = [], clients = new Set(), calls = [];
  const hooks = {
    api: async (action, input) => { calls.push({ action, input }); return { action, echo: input }; },
    message: (client, message) => { calls.push({ message }); client.send(JSON.stringify({ type: 'echo', message })); },
    attach: client => clients.add(client),
    detach: client => clients.delete(client),
    check: async name => { if (name === 'known-project') throw Object.assign(new Error('no'), { code: 'REMOTE_FORBIDDEN' }); },
    event: value => { events.push(value); for (const waiter of waiters.splice(0)) waiter(); }
  };
  const waiters = [];
  const event = async (type, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const found = events.find(item => item.type === type);
      if (found) return found;
      if (Date.now() > end) throw new Error(`no ${type} event`);
      await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 50); });
    }
  };
  const remote = createRemoteGateway(hooks, { limits: limits && { ...(createRemoteGateway.LIMITS ?? {}), ...defaults, ...limits } });
  t.after(() => remote.close());
  return { remote, events, event, clients, calls };
}
const defaults = { handshakeMs: 2000, idleMs: 90_000, sessionMs: 3_600_000, pairDecisionMs: 2000, sessions: 8, sessionsPerDevice: 3, pairFailures: 5, pastePerMinute: 10, bufferedBytes: 8 * 1024 * 1024, hubPingMs: 25_000 };

test('remote access is off until enabled with a complete config', () => {
  assert.equal(normalizeConfig(null).enabled, false);
  assert.equal(normalizeConfig({ enabled: false }).enabled, false);
  const base = { enabled: true, hubUrl: 'https://hub.example', accessToken: 'x', hostId: 'h', hostKey: { privateKey: b64(hostKey.privateKey) } };
  assert.equal(normalizeConfig(base).enabled, true);
  assert.equal(normalizeConfig({ ...base, hubUrl: 'http://hub.example' }).enabled, false, 'plain http only to loopback');
  assert.equal(normalizeConfig({ ...base, hubUrl: 'http://127.0.0.1:9' }).enabled, true);
  assert.equal(normalizeConfig({ ...base, hostKey: { privateKey: 'AAAA' } }).enabled, false);
  assert.equal(normalizeConfig({ ...base, accessToken: '' }).enabled, false);
  const devices = normalizeConfig({ ...base, devices: [{ id: 'a', key: b64(phoneKey.publicKey), scope: 'admin' }, { id: 'b', key: 'short', scope: 'view' }, { id: 'c', key: b64(phoneKey.publicKey), scope: 'view' }] }).devices;
  assert.deepEqual(devices.map(item => item.id), ['c']);
});

test('a disabled gateway never connects to the Hub', async t => {
  const hub = await fakeHub(t), { remote } = gateway(t);
  remote.configure(config(hub, { enabled: false }));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(hub.state.hostConnections, 0);
});

test('a paired device opens a session and reaches only allowed actions', async t => {
  const hub = await fakeHub(t), { remote, calls, event } = gateway(t);
  remote.configure(config(hub, { devices: paired('view') }));
  const client = await phone(hub, { device, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID });
  assert.equal(client.hello.scope, 'view');
  assert.equal(client.hello.host.name, 'Test PC');
  assert.ok(client.hello.api.includes('git/status') && !client.hello.api.includes('terminal/open'));
  assert.deepEqual(await client.api('git/status', { projectId: 'p', force: true }), { action: 'git/status', echo: { projectId: 'p' } });
  await assert.rejects(client.api('terminal/open', { projectId: 'p' }), { code: 'REMOTE_FORBIDDEN' });
  await assert.rejects(client.api('project/clone', {}), { code: 'REMOTE_FORBIDDEN' });
  await assert.rejects(client.api('app/state', { state: {} }), { code: 'REMOTE_FORBIDDEN' });
  client.ws({ type: 'terminal/input', projectId: 'p', id: 't', data: 'rm -rf /\r' });
  const refused = await client.event(message => message.type === 'error');
  assert.equal(refused.error.code, 'REMOTE_FORBIDDEN');
  client.ws({ type: 'subscribe', projectId: 'p' });
  assert.deepEqual((await client.event(message => message.type === 'echo')).message, { type: 'subscribe', projectId: 'p' });
  assert.equal(calls.filter(call => call.action === 'terminal/open').length, 0);
  assert.equal((await event('remote/audit')).type, 'remote/audit');
  assert.equal(remote.sessions.length, 1);
});

test('an unknown device or a different key gets no session', async t => {
  const hub = await fakeHub(t), { remote, events } = gateway(t);
  remote.configure(config(hub, { devices: paired('control') }));
  await assert.rejects(phone(hub, { device: { id: 'dev-other', name: 'x' }, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID }), { reason: 'unknown-device' });
  // Right device id, wrong key: the host closes without answering the handshake.
  await assert.rejects(phone(hub, { device, key: keyPair(), hostKey: hostKey.publicKey, hostId: HOST_ID }), { code: 4003 });
  assert.ok(events.some(item => item.kind === 'unknown-key'));
  // A phone that pinned another host key never completes either.
  await assert.rejects(phone(hub, { device, key: phoneKey, hostKey: keyPair().publicKey, hostId: HOST_ID }));
  assert.equal(remote.sessions.length, 0);
});

test('pairing works once, needs the QR secret and the PC to approve', async t => {
  const hub = await fakeHub(t), { remote, event, events } = gateway(t);
  const secret = randomBytes(32), psk = pairingPsk(secret);
  const pairing = { id: 'qr-1', psk: b64(psk), expiresAt: Date.now() + 60_000 };
  remote.configure(config(hub, { pairing }));
  // A wrong secret fails at the second handshake message, on the phone.
  await assert.rejects(phone(hub, { mode: 'pair', device, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID, psk: pairingPsk(randomBytes(32)) }));
  const client = await phone(hub, { mode: 'pair', device, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID, psk, name: 'My Pixel' });
  const request = await event('remote/pair-request');
  assert.equal(request.name, 'My Pixel');
  assert.equal(request.deviceId, device.id);
  assert.equal(request.key, b64(phoneKey.publicKey));
  assert.match(request.fingerprint, /^[0-9A-F]{4}-/);
  assert.equal((await event('remote/pairing-used')).id, 'qr-1');
  remote.decide(request.requestId, 'view');
  const answer = await client.next(message => message.t === 'paired');
  assert.equal(answer.scope, 'view');
  // The QR is spent even if a stale config brings it back.
  remote.configure(config(hub, { pairing }));
  await assert.rejects(phone(hub, { mode: 'pair', device, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID, psk }), { reason: 'no-pairing' });
  assert.ok(events.some(item => item.kind === 'paired' && item.scope === 'view'));
});

test('a denied or unanswered pairing gives no access', async t => {
  const hub = await fakeHub(t), { remote, event } = gateway(t, { limits: { pairDecisionMs: 300 } });
  const psk = pairingPsk(randomBytes(32));
  remote.configure(config(hub, { pairing: { id: 'qr-2', psk: b64(psk), expiresAt: Date.now() + 60_000 } }));
  const client = await phone(hub, { mode: 'pair', device, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID, psk });
  await event('remote/pair-request');
  assert.equal((await client.next(message => message.t === 'pair-denied', 2000)).t, 'pair-denied');
});

test('an expired QR is refused before any handshake', async t => {
  const hub = await fakeHub(t), { remote } = gateway(t);
  const psk = pairingPsk(randomBytes(32));
  remote.configure(config(hub, { pairing: { id: 'qr-3', psk: b64(psk), expiresAt: Date.now() - 1 } }));
  await assert.rejects(phone(hub, { mode: 'pair', device, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID, psk }), { reason: 'no-pairing' });
});

test('revocation from the Hub and removal on the PC end sessions at once', async t => {
  const hub = await fakeHub(t), { remote, event } = gateway(t);
  remote.configure(config(hub, { devices: paired('control') }));
  const first = await phone(hub, { device, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID });
  hub.revoke(device.id);
  await assert.rejects(first.next(() => false, 2000), { code: 4003 });
  assert.equal((await event('remote/revoked')).deviceId, device.id);
  const second = await phone(hub, { device, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID });
  remote.configure(config(hub, { devices: paired('view') })); // a scope change reconnects under the new scope
  await assert.rejects(second.next(() => false, 2000), { code: 4003 });
  const third = await phone(hub, { device, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID });
  assert.equal(third.hello.scope, 'view');
  remote.configure(config(hub, { enabled: false }));
  await assert.rejects(third.next(() => false, 2000), { code: 4003 });
});

test('a phone that never sends its first message is dropped', async t => {
  const hub = await fakeHub(t), { remote } = gateway(t, { limits: { handshakeMs: 300 } });
  remote.configure(config(hub, { devices: paired('control') }));
  const client = await phone(hub, { device, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID, start: false });
  await assert.rejects(client.next(() => false, 2000), { code: 4008 });
  assert.equal(remote.sessions.length, 0);
});

test('paste images are rate limited per session', async t => {
  const hub = await fakeHub(t), { remote } = gateway(t, { limits: { pastePerMinute: 2 } });
  remote.configure(config(hub, { devices: paired('control') }));
  const client = await phone(hub, { device, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID });
  const paste = { type: 'terminal/paste-image', projectId: 'p', id: 't', mime: 'image/png', data: 'AAAA' };
  client.ws(paste); client.ws(paste); client.ws(paste);
  assert.equal((await client.event(message => message.type === 'error')).error.code, 'RATE_LIMITED');
});

test('a large terminal replay crosses the relay in parts', async t => {
  const hub = await fakeHub(t);
  const big = 'x'.repeat(3 * 1024 * 1024);
  const hooks = { api: async () => ({ big }), message() {}, attach() {}, detach() {}, check: async () => {}, event() {} };
  const remote = createRemoteGateway(hooks);
  t.after(() => remote.close());
  remote.configure(config(hub, { devices: paired('view') }));
  const client = await phone(hub, { device, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID });
  assert.equal((await client.api('snapshot', { projectId: 'p' })).big.length, big.length);
});

test('an expired Hub token is reported so the app can refresh it', async t => {
  const hub = await fakeHub(t), { remote, event } = gateway(t);
  hub.state.rejectToken = true;
  remote.configure(config(hub));
  await event('remote/token-expired');
});

// The real server, driven over IPC the way the desktop app does it.
test('the local server serves a paired phone through the same handlers as the window', async t => {
  const hub = await fakeHub(t);
  const data = await mkdtemp(join(tmpdir(), 'ade-data-')), repo = await realpath(await mkdtemp(join(tmpdir(), 'ade-repo-')));
  const child = spawn(process.execPath, ['apps/local-server/src/index.js'], { env: { ...process.env, ADE_PORT: '0', ADE_DATA_DIR: data, ADE_PTY_ENDPOINT: '', ADE_PTY_TOKEN: '' }, stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
    const removal = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
    await rm(data, removal); await rm(repo, removal);
  });
  const line = await new Promise((resolve, reject) => { child.stdout.once('data', chunk => resolve(String(chunk))); child.once('exit', () => reject(new Error('server exited'))); });
  const [, origin, token] = /(http:\/\/127\.0\.0\.1:\d+)\/#token=(\w+)/.exec(line);
  const auth = await fetch(`${origin}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const local = (action, body = {}) => fetch(`${origin}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) }).then(response => response.json());
  await new Promise((resolve, reject) => spawn('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'ignore' }).on('exit', code => code ? reject(new Error('git init')) : resolve()));
  const project = await local('project/open', { path: repo });
  const busy = () => new Promise(resolve => { const id = Math.random(); const on = message => { if (message?.type === 'busy' && message.id === id) { child.off('message', on); resolve(message); } }; child.on('message', on); child.send({ type: 'busy?', id }); });

  child.send({ type: 'remote/config', config: config(hub, { devices: paired('control') }) });
  const client = await phone(hub, { device, key: phoneKey, hostKey: hostKey.publicKey, hostId: HOST_ID });
  assert.equal(client.hello.scope, 'control');
  assert.equal((await client.api('snapshot', { projectId: project.id })).root, repo);
  assert.equal((await client.api('git/status', { projectId: project.id })).clean, true);
  await assert.rejects(client.api('project/open', { path: tmpdir() }), { code: 'REMOTE_FORBIDDEN' });
  await assert.rejects(client.api('recent/remove', { root: repo }), { code: 'REMOTE_FORBIDDEN' });
  const report = await busy();
  assert.ok(report.busy && report.reasons.some(reason => reason.kind === 'remote'));

  client.ws({ type: 'subscribe', projectId: project.id });
  assert.equal((await client.event(message => message.type === 'snapshot')).snapshot.id, project.id);
  if (!(await local('readiness')).pty?.installed) return;
  const opened = await client.api('terminal/open', { projectId: project.id });
  let output = '';
  client.ws({ type: 'terminal/input', projectId: project.id, id: opened.id, data: 'echo remote-ok\r' });
  // The output arrives through the same broadcast the window gets, in 5 ms batches.
  await client.event(message => { if (message.type === 'terminal' && message.id === opened.id) output += message.data; return /remote-ok[\s\S]*remote-ok/.test(output); }, 15_000);
  await client.api('terminal/close', { projectId: project.id, id: opened.id });
});
