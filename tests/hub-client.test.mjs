import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHubClient, validEntry } from '../apps/desktop/src/hub-client.js';
import { createPluginStore, validPluginState } from '../apps/desktop/src/plugin-core.js';
import { sha256, startFakeHub } from '../scripts/verify/hub-fake.mjs';

const sealer = () => ({
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(`sealed:${Buffer.from(text).toString('base64')}`),
  decryptString: buffer => Buffer.from(buffer.toString().slice(7), 'base64').toString()
});
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-hub-client-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

async function setup(t, { clock = { now: Date.now() }, ...options } = {}) {
  const root = temp(t), hub = await startFakeHub();
  t.after(() => hub.close());
  const store = createPluginStore({ file: path.join(root, 'plugins.bin'), crypto: sealer() });
  store.load();
  const client = createHubClient({ store, baseUrl: hub.url, now: () => clock.now, name: () => 'ADE · test-pc', ...options });
  const signIn = async () => { const start = await client.deviceStart(); return client.devicePoll(start); };
  return { root, hub, store, client, clock, signIn };
}
const grants = { terminal: true, workspace: true };

test('signing in: the code page is the Hub\'s own, the session is sealed and plugins.json holds no token', async t => {
  const env = await setup(t);
  assert.equal(env.client.signedIn, false);
  const start = await env.client.deviceStart();
  assert.equal(start.userCode, 'BCDF-GHJK');
  assert.equal(new URL(start.verifyUrl).origin, env.hub.url);
  const { key, ...enroll } = env.hub.requests[0].body;
  assert.deepEqual(enroll, { kind: 'app', name: 'ADE · test-pc', platform: process.platform });
  assert.equal(Buffer.from(key, 'base64').length, 32, 'a 32-byte key, as the Hub wants');
  assert.equal(env.hub.requests[0].auth, null, 'nothing is sent with the enroll request');
  await env.client.deviceStart();
  assert.equal(env.hub.requests[1].body.key, key, 'the same every time, so the Hub replaces this PC\'s earlier device instead of adding one');
  const other = Buffer.alloc(32, 7).toString('base64');
  await createHubClient({ store: env.store, baseUrl: env.hub.url, key: () => other }).deviceStart();
  assert.equal(env.hub.requests[2].body.key, other, 'a client sends the key it is given');
  assert.notEqual(other, key);
  env.hub.approval = 'manual';
  assert.deepEqual(await env.client.devicePoll(start), { wait: 0 });
  env.hub.approve();
  assert.deepEqual(await env.client.devicePoll(start), { account: '시험 계정' });
  assert.equal(env.client.signedIn, true);
  assert.equal(env.client.account, '시험 계정');
  const plain = fs.readFileSync(path.join(env.root, 'plugins.json'), 'utf8'), sealed = fs.readFileSync(path.join(env.root, 'plugins.bin'));
  assert.ok(!plain.includes(env.hub.access) && !plain.includes(env.hub.refresh), 'the tokens are not in plugins.json');
  assert.deepEqual(JSON.parse(plain).hub, { account: '시험 계정', at: JSON.parse(plain).hub.at });
  assert.ok(Buffer.from(sealed.toString().slice(7), 'base64').toString().includes(env.hub.refresh), 'they are in the sealed file');
  // A new start reads the sealed half back.
  const reopened = createPluginStore({ file: path.join(env.root, 'plugins.bin'), crypto: sealer() });
  reopened.load();
  assert.equal(reopened.state.hub.secret.access, env.hub.access);
  assert.equal(reopened.state.hub.secret.deviceId, 'device-1');
  assert.ok(!Object.keys(reopened.state.hub).includes('secret'), 'not enumerable, so a spread of the state never carries it');
});

test('a sign-in page on another origin, a denied code and a broken answer are refused', async t => {
  const env = await setup(t);
  const elsewhere = createHubClient({ store: env.store, baseUrl: env.hub.url, fetchImpl: async () => Response.json({ enrollId: 'e', pollToken: 'p', userCode: 'BCDF-GHJK', verifyUrl: 'https://evil.example/enroll?code=BCDF-GHJK', interval: 2, expiresIn: 600 }) });
  await assert.rejects(elsewhere.deviceStart(), { code: 'HTTP' });
  const start = await env.client.deviceStart();
  env.hub.approval = 'deny';
  await assert.rejects(env.client.devicePoll(start), { code: 'DENIED' });
  const broken = createHubClient({ store: env.store, baseUrl: env.hub.url, fetchImpl: async () => Response.json({ status: 'approved', device: { id: 'd' }, accessToken: 'aha_x' }) });
  await assert.rejects(broken.devicePoll(start), { code: 'HTTP' });
  assert.equal(env.client.signedIn, false);
  // Only https, or this machine, is a Hub address.
  assert.equal(createHubClient({ store: env.store, baseUrl: 'http://hub.example' }).available, false);
  assert.equal(createHubClient({ store: env.store, baseUrl: 'not a url' }).available, false);
  await assert.rejects(createHubClient({ store: env.store, baseUrl: 'http://hub.example' }).deviceStart(), { code: 'HUB_UNAVAILABLE' });
  assert.equal(createHubClient({ store: env.store, baseUrl: 'https://hub.example/x' }).url, 'https://hub.example');
});

test('the list and a plugin come back checked; entries that are not plugins are dropped', async t => {
  const env = await setup(t);
  await assert.rejects(env.client.catalog(), { code: 'NOT_SIGNED_IN' });
  await env.signIn();
  env.hub.publish({ id: 'alpha', version: '1.2.0', name: '알파', description: '첫째', grants });
  env.hub.publish({ id: 'beta', version: 'v2.0.0' });
  const { plugins } = await env.client.catalog();
  assert.deepEqual(plugins.map(plugin => [plugin.id, plugin.version, plugin.name]), [['alpha', '1.2.0', '알파'], ['beta', '2.0.0', 'beta']]);
  assert.deepEqual(plugins[0].grants, { terminal: true, mcp: false, workspace: true, feedback: false, header: false });
  assert.equal(env.hub.requests.at(-1).auth, env.hub.access);
  const found = await env.client.latest(null, 'alpha');
  assert.equal(found.version, '1.2.0');
  assert.equal(found.via, 'hub');
  await assert.rejects(env.client.latest(null, 'missing'), { code: 'MISSING' });
  await assert.rejects(env.client.latest(null, '../etc'), { code: 'NOT_FOUND' });
  const good = { id: 'ok-one', version: '1.0.0', sha256: 'a'.repeat(64) };
  assert.equal(validEntry(good).id, 'ok-one');
  for (const bad of [null, [], { ...good, id: 'Bad Id' }, { ...good, id: '../x' }, { ...good, version: 'latest' }, { ...good, sha256: 'xyz' }, { ...good, sha256: undefined }]) assert.equal(validEntry(bad), null);
});

test('the download is checked against the checksum the Hub listed, and a plugin published in between is not installed', async t => {
  const env = await setup(t);
  await env.signIn();
  env.hub.publish({ id: 'alpha', version: '1.0.0', zip: Buffer.from('zip-bytes-1') });
  const found = await env.client.latest(null, 'alpha');
  const { data, sha256: digest } = await env.client.download(found);
  assert.equal(data.toString(), 'zip-bytes-1');
  assert.equal(digest, sha256(data));
  // The Hub moved on after the check.
  env.hub.publish({ id: 'alpha', version: '1.1.0', zip: Buffer.from('zip-bytes-2') });
  await assert.rejects(env.client.download(found), { code: 'CHANGED' });
  // The bytes are not what the Hub itself listed.
  const lying = createHubClient({ store: env.store, baseUrl: env.hub.url, fetchImpl: async (url, init) => url.pathname.endsWith('/download') ? new Response('tampered', { headers: { 'x-plugin-version': '1.1.0', 'x-plugin-sha256': (await env.client.latest(null, 'alpha')).sha256 } }) : fetch(url, init) });
  await assert.rejects(lying.download(await env.client.latest(null, 'alpha')), { code: 'CHECKSUM' });
  // Too large to take, by its announced length.
  const huge = createHubClient({ store: env.store, baseUrl: env.hub.url, fetchImpl: async () => new Response('x', { headers: { 'content-length': String(40 * 1024 * 1024), 'x-plugin-version': '1.1.0', 'x-plugin-sha256': 'a'.repeat(64) } }) });
  await assert.rejects(huge.download({ id: 'alpha', version: '1.1.0', sha256: 'a'.repeat(64) }), { code: 'TOO_LARGE' });
});

test('an expired access token is refreshed once for all callers, and the rotated refresh token is sealed first', async t => {
  const clock = { now: Date.now() };
  const env = await setup(t, { clock });
  await env.signIn();
  env.hub.publish({ id: 'alpha', version: '1.0.0' });
  const firstRefresh = env.hub.refresh;
  // The access token's time runs out (within the margin before it): several calls at once, one refresh.
  clock.now += 3600 * 1000 - 60_000;
  const results = await Promise.all([env.client.catalog(), env.client.catalog(), env.client.latest(null, 'alpha')]);
  assert.equal(results.length, 3);
  assert.equal(env.hub.refreshCalls, 1, 'one refresh served all three');
  assert.notEqual(env.hub.refresh, firstRefresh);
  const reopened = createPluginStore({ file: path.join(env.root, 'plugins.bin'), crypto: sealer() });
  reopened.load();
  assert.equal(reopened.state.hub.secret.refresh, env.hub.refresh, 'the new refresh token is already on disk');
  assert.ok(env.hub.requests.filter(request => request.path === '/v1/token/refresh').every(request => request.body.refreshToken === firstRefresh), 'the old one is sent once, never again');
});

test('a 401 on a call refreshes and retries once; a refused refresh signs out; a lost account signs out', async t => {
  const env = await setup(t);
  await env.signIn();
  env.hub.expireAccess();
  assert.deepEqual((await env.client.catalog()).plugins, [], 'the Hub said token-expired, the retry worked');
  assert.equal(env.hub.refreshCalls, 1);
  env.hub.revokeAll();
  await assert.rejects(env.client.catalog(), { code: 'UNAUTHORIZED' });
  assert.equal(env.client.signedIn, false, 'the session is forgotten');
  assert.equal(fs.readFileSync(path.join(env.root, 'plugins.json'), 'utf8').includes('시험 계정'), false);
  await assert.rejects(env.client.catalog(), { code: 'NOT_SIGNED_IN' });
  await env.signIn();
  env.hub.denied = true;
  await assert.rejects(env.client.catalog(), { code: 'FORBIDDEN' });
  env.hub.denied = false;
});

test('a Hub that has no plugins ready or does not serve any says so', async t => {
  const env = await setup(t);
  await env.signIn();
  env.hub.unavailable = true;
  await assert.rejects(env.client.catalog(), { code: 'HUB_BUSY' });
  env.hub.unavailable = false; env.hub.disabled = true;
  await assert.rejects(env.client.catalog(), { code: 'HUB_DISABLED' });
});

test('the token goes to the Hub only: a redirect is not followed and a refused answer is not a plugin list', async t => {
  const env = await setup(t);
  await env.signIn();
  const seen = [];
  const other = http.createServer((request, response) => { seen.push(request.headers.authorization ?? null); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"plugins":[]}'); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { other.closeAllConnections(); other.close(resolve); }));
  const redirecting = createHubClient({ store: env.store, baseUrl: env.hub.url, fetchImpl: async () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${other.address().port}/v1/plugins` } }) });
  await assert.rejects(redirecting.catalog(), { code: 'HTTP' });
  assert.deepEqual(seen, [], 'nothing reached the other server');
  const odd = createHubClient({ store: env.store, baseUrl: env.hub.url, fetchImpl: async () => Response.json({ nope: true }) });
  await assert.rejects(odd.catalog(), { code: 'HTTP' });
});

test('signing out tells the Hub and forgets the session even when the Hub cannot be reached', async t => {
  const env = await setup(t);
  await env.signIn();
  await env.client.signOut();
  assert.equal(env.hub.signedOut, 1);
  assert.equal(env.client.signedIn, false);
  await env.signIn();
  const down = createHubClient({ store: env.store, baseUrl: env.hub.url, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await down.signOut();
  assert.equal(env.client.signedIn, false);
});

test('a saved sign-in is checked when read: tokens must look like tokens, and a session without its sealed half is forgotten', async t => {
  const good = { account: 'A', at: 1, deviceId: 'device-1', access: 'aha_' + 'a'.repeat(24), refresh: 'ahr_' + 'b'.repeat(24), accessExpiresAt: 5 };
  assert.deepEqual(validPluginState({ version: 1, hub: good }).hub, good);
  for (const change of [{ access: 'short' }, { refresh: 'has space in it!!!!!!!!!!!!!!' }, { deviceId: '../x' }, { account: '' }, { accessExpiresAt: 'soon' }]) assert.equal(validPluginState({ version: 1, hub: { ...good, ...change } }).hub, null);
  const root = temp(t);
  const store = createPluginStore({ file: path.join(root, 'plugins.bin'), crypto: sealer() });
  store.load();
  store.update(state => ({ ...state, hub: good }));
  fs.rmSync(path.join(root, 'plugins.bin'));
  const reopened = createPluginStore({ file: path.join(root, 'plugins.bin'), crypto: sealer() });
  reopened.load();
  assert.equal(reopened.state.hub?.account, 'A', 'plugins.json still names the account');
  const client = createHubClient({ store: reopened, baseUrl: 'http://127.0.0.1:9' });
  await assert.rejects(client.catalog(), { code: 'NOT_SIGNED_IN' });
  assert.equal(reopened.state.hub, null, 'forgotten, so the page shows signed out');
});
