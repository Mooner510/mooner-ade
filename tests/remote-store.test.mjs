import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { childConfig, createAuditLog, createRemoteStore, DEVICE_EXPIRY_MS, expireDevices, publicState, validState } from '../apps/desktop/src/remote-store.js';

// Stand-in for Electron's safeStorage: reversible, but not plain text, so a test can tell sealed from clear.
const sealer = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: text => Buffer.from(`sealed:${Buffer.from(text).toString('base64')}`),
  decryptString: buffer => {
    const text = buffer.toString();
    if (!text.startsWith('sealed:')) throw new Error('bad');
    return Buffer.from(text.slice(7), 'base64').toString();
  }
});
const dir = t => { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-remote-store-')); t.after(() => fs.rmSync(value, { recursive: true, force: true })); return value; };
const linked = (extra = {}) => ({
  version: 1, enabled: true, hubUrl: 'https://hub.example', account: { id: 'acc-1', name: 'Me', email: 'me@example.com' },
  tokens: { access: 'access-token', refresh: 'refresh-token', accessExpiresAt: Date.now() + 3600_000 },
  hostId: 'host-1', hostKey: { privateKey: Buffer.alloc(32, 1).toString('base64'), publicKey: Buffer.alloc(32, 2).toString('base64') },
  devices: [{ id: 'phone-1', name: 'Pixel', key: Buffer.alloc(32, 3).toString('base64'), scope: 'control', addedAt: Date.now(), lastSeenAt: null }],
  ...extra
});

test('settings are written sealed and read back', t => {
  const file = path.join(dir(t), 'remote.bin'), store = createRemoteStore({ file, crypto: sealer() });
  assert.equal(store.load().enabled, false);
  assert.equal(store.problem, null);
  store.save(linked());
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('refresh-token') && !raw.includes('Pixel'));
  const again = createRemoteStore({ file, crypto: sealer() });
  assert.equal(again.load().enabled, true);
  assert.equal(again.state.devices[0].name, 'Pixel');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['remote.bin']);
});

test('without encryption remote access stays off and nothing is saved', t => {
  const folder = dir(t), file = path.join(folder, 'remote.bin');
  createRemoteStore({ file, crypto: sealer() }).save(linked());
  const store = createRemoteStore({ file, crypto: sealer(false) });
  assert.equal(store.load().enabled, false);
  assert.equal(store.problem, 'unavailable');
  assert.throws(() => store.save(linked()), { code: 'ENCRYPTION_UNAVAILABLE' });
});

test('a file that does not open turns remote access off', t => {
  const file = path.join(dir(t), 'remote.bin');
  fs.writeFileSync(file, JSON.stringify(linked()));
  const store = createRemoteStore({ file, crypto: sealer() });
  assert.equal(store.load().enabled, false);
  assert.equal(store.problem, 'unreadable');
  assert.equal(store.state.tokens, null);
});

test('loading keeps only well-formed fields and never turns on half-linked settings', () => {
  assert.equal(validState({ ...linked(), version: 2 }).enabled, false);
  assert.equal(validState({ ...linked(), tokens: null }).enabled, false);
  assert.equal(validState({ ...linked(), hostKey: { privateKey: 'x' } }).enabled, false);
  const state = validState(linked({ devices: [
    { id: 'ok', key: 'k', scope: 'view', addedAt: 1 },
    { id: 'bad', key: 'k', scope: 'admin', addedAt: 1 },
    { id: '../x', key: 'k', scope: 'view', addedAt: 1 },
    { id: 'nokey', scope: 'view', addedAt: 1 },
    null
  ], extra: 'dropped' }));
  assert.deepEqual(state.devices.map(item => item.id), ['ok']);
  assert.equal('extra' in state, false);
});

test('unused phones expire after 90 days', () => {
  const now = Date.now(), state = validState(linked({ devices: [
    { id: 'old', key: 'k', scope: 'view', addedAt: now - DEVICE_EXPIRY_MS - 1 },
    { id: 'used', key: 'k', scope: 'view', addedAt: now - DEVICE_EXPIRY_MS - 1, lastSeenAt: now - 1000 },
    { id: 'new', key: 'k', scope: 'view', addedAt: now }
  ] }));
  assert.deepEqual(expireDevices(state, now).devices.map(item => item.id), ['used', 'new']);
  const fresh = validState(linked());
  assert.equal(expireDevices(fresh, now), fresh);
});

test('the server gets no refresh token and the page gets no keys or tokens', () => {
  const state = validState(linked());
  const config = childConfig(state, { pairing: { id: 'p', psk: 'psk', expiresAt: Date.now() + 1000, uri: 'moonerade://pair?t=secret' }, host: { name: 'pc' } });
  assert.equal(config.accessToken, 'access-token');
  assert.ok(!JSON.stringify(config).includes('refresh-token'));
  assert.ok(!JSON.stringify(config).includes('secret'));
  assert.equal(config.hostKey.publicKey, undefined);
  assert.equal(childConfig(state, { pairing: { id: 'p', psk: 'psk', expiresAt: Date.now() - 1 } }).pairing, null);
  assert.deepEqual(childConfig({ ...state, enabled: false }), { enabled: false });
  const page = JSON.stringify(publicState(state));
  for (const secret of ['access-token', 'refresh-token', state.hostKey.privateKey, state.devices[0].key]) assert.ok(!page.includes(secret));
});

test('the audit log appends lines and rotates', t => {
  const file = path.join(dir(t), 'remote-audit.log'), log = createAuditLog(file, { maxBytes: 100 });
  for (let index = 0; index < 5; index++) log({ at: index, kind: 'connected', deviceId: 'phone-1' });
  assert.ok(fs.existsSync(`${file}.1`));
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) assert.equal(JSON.parse(line).kind, 'connected');
});
