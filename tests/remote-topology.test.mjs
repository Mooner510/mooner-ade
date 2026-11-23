// One account, three devices that can all reach each other: ADE A, ADE B (each is a PC that others can open, and a client that opens
// others) and a phone. Every connection is its own pairing and its own link; this checks they do not get in each other's way.
//   ADE A → ADE B · ADE B → ADE A · phone → ADE A · phone → ADE B   (the phone is a second client of the same protocol)
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteClient } from '../apps/desktop/src/remote-link.js';
import { fakeHub, memoryStore } from './remote-helpers.mjs';

const fast = { baseMs: 10, maxMs: 40 };
async function topology(t) {
  const hostA = await fakeHub(t, { hostId: 'ade-a', hostName: 'ade-a', api: action => ({ who: 'A', action }) });
  const hostB = hostA.addHost({ hostId: 'ade-b', hostName: 'ade-b', api: action => ({ who: 'B', action }) });
  // Each device is signed in to the same Hub (the same account) with its own store, key and tokens.
  const device = async hostname => {
    const store = memoryStore(), client = createRemoteClient({ store, baseUrl: hostA.url, minPollMs: 0, backoff: fast, hostname: () => hostname });
    await client.signInStart(); await client.signInWait();
    return { client, store };
  };
  const links = [];
  t.after(() => { for (const link of links) link.close(); });
  const open = async (client, hostId) => { const link = client.link(hostId); links.push(link); await link.whenOpen(); return link; };
  const [adeA, adeB, phone] = [await device('ade-a'), await device('ade-b'), await device('pixel')];
  return { hub: hostA, hostA: { hostId: 'ade-a', pairLink: hostA.pairLink, state: hostA.state }, hostB, adeA, adeB, phone, open };
}

test('A → B, B → A, phone → A and phone → B all work at the same time', async t => {
  const { hostA, hostB, adeA, adeB, phone, open } = await topology(t);
  await adeA.client.pair(hostB.pairLink());
  await adeB.client.pair(hostA.pairLink());
  await phone.client.pair(hostA.pairLink());
  await phone.client.pair(hostB.pairLink());

  const aToB = await open(adeA.client, 'ade-b'), bToA = await open(adeB.client, 'ade-a'), pToA = await open(phone.client, 'ade-a'), pToB = await open(phone.client, 'ade-b');
  // Each link reaches the PC it names, not another one.
  const who = await Promise.all([aToB, bToA, pToA, pToB].map(link => link.call('snapshot')));
  assert.deepEqual(who.map(answer => answer.who), ['B', 'A', 'A', 'B']);
  // PC A answers ADE B and the phone, PC B answers ADE A and the phone: two sessions each, from two different keys.
  for (const host of [hostA, hostB]) {
    const live = host.state.sessions.filter(session => session.mode === 'session');
    assert.equal(live.length, 2, `${host.hostId} sessions`);
    assert.notDeepEqual(live[0].clientKey, live[1].clientKey);
  }
  // One link dropping does not disturb the others.
  pToB.close();
  assert.equal((await aToB.call('x')).who, 'B');
  assert.equal((await pToA.call('x')).who, 'A');
  assert.equal((await bToA.call('x')).who, 'A');
});

test('pairing is per direction: ADE A paired B, ADE B did not pair A, and a PC answers only the devices it paired', async t => {
  const { hub, hostA, hostB, adeA, adeB, phone, open } = await topology(t);
  await adeA.client.pair(hostB.pairLink());
  assert.equal((await open(adeA.client, 'ade-b')).hello.scope, 'control');
  // ADE B never paired PC A: it has nothing to make a link with.
  assert.throws(() => adeB.client.link('ade-a'), { code: 'NOT_PAIRED' });

  // A device with PC A's key pinned (copied from the phone's pairing) but never approved by PC A is turned away by PC A, for good.
  await phone.client.pair(hostA.pairLink());
  const pinned = phone.store.value.hosts.find(host => host.hostId === 'ade-a');
  adeB.store.write({ ...adeB.store.value, hosts: [pinned] });
  const closed = [];
  const stranger = createRemoteClient({ store: adeB.store, baseUrl: hub.url, backoff: fast }).link('ade-a', { closed: info => closed.push(info) });
  t.after(() => stranger.close());
  await assert.rejects(stranger.whenOpen(), { code: 'DENIED' });
  assert.equal(closed[0]?.code, 'DENIED');
});

test('every device lists every PC of the account; a PC whose name is this PC\'s is flagged, not hidden', async t => {
  const { adeA, adeB, phone, hostA, hostB } = await topology(t);
  for (const device of [adeA, adeB, phone]) assert.deepEqual((await device.client.hosts()).map(host => host.hostId), ['ade-a', 'ade-b']);
  // ADE A runs PC A: its list names that entry as its own host name; the phone has no PC of its own.
  assert.deepEqual((await adeA.client.hosts()).map(host => host.self), [true, false]);
  assert.deepEqual((await adeB.client.hosts()).map(host => host.self), [false, true]);
  assert.deepEqual((await phone.client.hosts()).map(host => host.self), [false, false]);
  // An offline PC is listed as offline for everyone, and the others stay reachable.
  hostB.state.online = false;
  assert.deepEqual((await adeA.client.hosts()).map(host => host.online), [true, false]);
  void hostA;
});
