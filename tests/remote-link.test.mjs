// The client side of PC ↔ PC remote (apps/desktop/src/remote-link.js) against a fake Hub that answers like the other PC.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteClient, parsePairLink } from '../apps/desktop/src/remote-link.js';
import { fakeHub, keyHash, memoryStore } from './remote-helpers.mjs';

const fast = { baseMs: 10, maxMs: 40 };
async function signedIn(t, options = {}) {
  const hub = await fakeHub(t, options.hub), store = memoryStore();
  const client = createRemoteClient({ store, baseUrl: hub.url, minPollMs: 0, backoff: fast, name: () => 'ADE · test' });
  await client.signInStart();
  await client.signInWait();
  return { hub, store, client };
}
const paired = async (t, options) => { const ctx = await signedIn(t, options); await ctx.client.pair(ctx.hub.pairLink()); return ctx; };

test('the pairing link follows the phone app rules', () => {
  const key = Buffer.alloc(32, 1).toString('base64url'), secret = Buffer.alloc(32, 2).toString('base64url');
  const good = `moonerade://pair?v=1&k=${key}&h=host_1&t=${secret}&n=${encodeURIComponent('내 PC\u0007')}`;
  const link = parsePairLink(`  ${good}\n`);
  assert.equal(link.hostId, 'host_1');
  assert.equal(link.name, '내 PC');
  assert.equal(link.hostKey.length, 32);
  assert.equal(link.secret.length, 32);
  for (const bad of ['', 'https://pair?v=1', good.replace('v=1', 'v=2'), good.replace(`k=${key}`, 'k=short'), good + '&v=1', good.replace('h=host_1', 'h=a%20b'), good + 'x'.repeat(1100), good.replace('moonerade://pair', 'moonerade://other')])
    assert.throws(() => parsePairLink(bad), { code: 'BAD_LINK' }, bad.slice(0, 60));
});

test('signing in registers a desktop device with a new key and keeps the tokens', async t => {
  const { hub, store, client } = await signedIn(t);
  assert.equal(hub.state.enrollBody.kind, 'desktop');
  assert.equal(Buffer.from(hub.state.enrollBody.key, 'base64').length, 32);
  assert.equal(client.signedIn, true);
  assert.equal(client.account, '무너');
  assert.equal(store.value.key.publicKey, hub.state.enrollBody.key);
  assert.deepEqual(store.value.hosts, []);
  await client.signOut();
  assert.equal(hub.state.signedOut, 1);
  assert.equal(client.signedIn, false);
});

test('a denied sign-in ends with a clear error and stores nothing', async t => {
  const hub = await fakeHub(t, { approve: false }), store = memoryStore();
  const client = createRemoteClient({ store, baseUrl: hub.url, minPollMs: 0 });
  await client.signInStart();
  await assert.rejects(client.signInWait(), { code: 'DENIED' });
  assert.equal(store.writes, 0);
});

test('only a Hub page on the Hub origin is opened for the code, and only https or a local Hub is used', async t => {
  const hub = await fakeHub(t);
  const wrong = createRemoteClient({ store: memoryStore(), baseUrl: hub.url, minPollMs: 0, fetchImpl: async (url, init) => {
    const response = await fetch(url, init);
    if (!String(url).includes('enroll/start')) return response;
    const body = await response.json();
    return Response.json({ ...body, verifyUrl: 'https://evil.example/enroll' });
  } });
  await assert.rejects(wrong.signInStart(), { code: 'HTTP' });
  assert.equal(createRemoteClient({ store: memoryStore(), baseUrl: 'http://hub.example' }).available, false);
});

test('the PC list says which are online and paired, and flags a key that changed', async t => {
  const { hub, client, store } = await signedIn(t);
  let [host] = await client.hosts();
  assert.deepEqual([host.hostId, host.name, host.online, host.paired, host.keyChanged], ['host-1', '작업 PC', true, false, false]);
  await client.pair(hub.pairLink());
  [host] = await client.hosts();
  assert.equal(host.paired, true);
  assert.equal(host.scope, 'control');
  assert.equal(host.fingerprint, hub.hostFingerprint());
  store.value.hosts[0].key = Buffer.alloc(32, 9).toString('base64');
  const again = createRemoteClient({ store, baseUrl: hub.url });
  assert.equal((await again.hosts())[0].keyChanged, true);
  hub.state.online = false;
  assert.equal((await client.hosts())[0].online, false);
});

test('an expired access token is refreshed once and the rotated refresh token is kept', async t => {
  const { hub, client, store } = await signedIn(t);
  hub.state.accessGood = 'aha_other';   // the Hub no longer accepts the token we hold: one 401, a refresh, and the call goes through
  assert.equal((await client.hosts()).length, 1);
  assert.equal(hub.state.refreshes, 1);
  assert.equal(store.value.tokens.refresh, 'ahr_2');
  assert.equal(hub.state.refreshToken, 'ahr_2');
});

test('pairing: the offer shows both fingerprints; the PC pins our key; the PC is stored with its scope', async t => {
  const { hub, client, store } = await signedIn(t, { hub: { scope: 'view' } });
  const offer = client.offer(hub.pairLink());
  assert.equal(offer.hostFingerprint, hub.hostFingerprint());
  assert.equal(offer.myFingerprint, client.fingerprint);
  assert.equal(offer.alreadyPaired, false);
  const result = await client.pair(hub.pairLink());
  assert.deepEqual(result, { hostId: 'host-1', name: '작업 PC', scope: 'view' });
  assert.equal(hub.state.pairings[0].name, 'ADE · test');
  assert.equal(store.value.hosts[0].key, hub.hostKey.publicKey.toString('base64'));
  assert.equal(hub.state.knownKey.toString('base64'), store.value.key.publicKey);
});

test('pairing refused by the PC, or with a wrong secret, stores nothing', async t => {
  const { hub, client, store } = await signedIn(t);
  hub.state.denyPair = true;
  await assert.rejects(client.pair(hub.pairLink()), { code: 'DENIED' });
  assert.deepEqual(store.value.hosts, []);
  hub.state.denyPair = false;
  const wrong = hub.pairLink().replace(/t=[^&]+/, `t=${Buffer.alloc(32, 1).toString('base64url')}`);
  await assert.rejects(client.pair(wrong), { code: 'DENIED' });
  assert.deepEqual(store.value.hosts, []);
});

test('a paired PC answers api calls, forwards ws messages both ways and reports its state', async t => {
  const { hub, client } = await paired(t, { hub: { api: (action, input) => action === 'snapshot' ? { echoed: input } : (() => { throw Object.assign(new Error('없음'), { code: 'NOT_FOUND' }); })() } });
  const events = [], messages = [];
  const link = client.link('host-1', { state: open => events.push(open), message: text => messages.push(text) });
  t.after(() => link.close());
  await link.whenOpen();
  assert.equal(link.hello.scope, 'control');
  assert.deepEqual(link.hello.api.includes('ui/manifest'), true);
  assert.deepEqual(await link.call('snapshot', { projectId: 'p1' }), { echoed: { projectId: 'p1' } });
  await assert.rejects(link.call('nope'), { code: 'NOT_FOUND', message: '없음' });
  assert.equal(link.send({ type: 'subscribe', projectId: 'p1' }), true);
  const session = hub.state.sessions.at(-1);
  await hub.until(() => session.messages.find(message => message.t === 'ws'), 'a ws message');
  assert.deepEqual(session.messages.find(message => message.t === 'ws').message, { type: 'subscribe', projectId: 'p1' });
  session.send({ t: 'ws', message: { type: 'output', data: 'hi' } });
  await hub.until(() => messages.length, 'a forwarded message');
  assert.deepEqual(JSON.parse(messages[0]), { type: 'output', data: 'hi' });
  assert.deepEqual(events, [true]);
});

test('a dropped session comes back by itself and pending calls fail with REMOTE_DISCONNECTED', async t => {
  let release;
  const stuck = new Promise(resolve => { release = resolve; });
  const { hub, client } = await paired(t, { hub: { api: action => action === 'slow' ? stuck : 'ok' } });
  const events = [];
  const link = client.link('host-1', { state: open => events.push(open) });
  t.after(() => link.close());
  await link.whenOpen();
  const slow = link.call('slow');
  await hub.until(() => hub.state.sessions.at(-1).messages.some(message => message.action === 'slow'), 'the slow call');
  hub.state.sessions.at(-1).ws.close(4001, 'restarting');
  await assert.rejects(slow, { code: 'REMOTE_DISCONNECTED' });
  await hub.until(() => events.join() === 'true,false,true', 'a second session');
  assert.equal(await link.call('x'), 'ok');
  release();
});

test('a close the PC meant ends the link for good; a PC that does not know our key ends it too', async t => {
  const { hub, client } = await paired(t);
  const closed = [];
  const link = client.link('host-1', { closed: info => closed.push(info) });
  t.after(() => link.close());
  await link.whenOpen();
  hub.state.knownKeys = new Set([Buffer.alloc(32, 5).toString('base64')]);   // the PC no longer knows our key: it hangs up with 4003 "unknown key"
  hub.state.sessions.at(-1).ws.close(4001, 'restart');
  await hub.until(() => closed.length, 'the final close');
  assert.equal(closed[0].code, 'DENIED');
  await assert.rejects(link.call('snapshot'), { code: 'DENIED' });
  assert.equal(link.final.code, 'DENIED');

  const { hub: other, client: second, store } = await paired(t);
  store.value.hosts[0].key = Buffer.alloc(32, 3).toString('base64');   // pinned to another key than the PC answers with
  const wrong = createRemoteClient({ store, baseUrl: other.url, backoff: fast }).link('host-1', {});
  t.after(() => wrong.close());
  await assert.rejects(wrong.whenOpen(), { code: 'PROTOCOL' });
  void second;
});

test('a Hub that refuses the upgrade once (token ran out) is retried with a fresh token', async t => {
  const { hub, client } = await paired(t);
  hub.state.accessGood = 'aha_rotated';   // the Hub now only takes a token the next refresh hands out (the one we hold ran out)
  const refreshes = hub.state.refreshes;
  const link = client.link('host-1', {});
  t.after(() => link.close());
  await link.whenOpen();
  assert.equal(hub.state.refreshes, refreshes + 1);
});

test('forgetting a PC removes the pairing; linking to an unpaired PC is refused', async t => {
  const { hub, client, store } = await paired(t);
  client.forget('host-1');
  assert.deepEqual(store.value.hosts, []);
  assert.throws(() => client.link('host-1'), { code: 'NOT_PAIRED' });
  void hub; void keyHash;
});
