import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createChannel, createHandshake, fingerprint, keyPair, MAX_CHUNK, pairingPsk, prologue } from '../apps/local-server/src/noise.js';

const { vectors } = JSON.parse(readFileSync(new URL('./fixtures/noise-vectors.json', import.meta.url), 'utf8'));
const hex = value => Buffer.from(value, 'hex');

for (const vector of vectors) {
  test(`cacophony vector ${vector.protocol_name}`, () => {
    const initiator = createHandshake({
      initiator: true, prologue: hex(vector.init_prologue), s: keyPair(hex(vector.init_static)), e: keyPair(hex(vector.init_ephemeral)),
      rs: hex(vector.init_remote_static), psk: vector.init_psks ? hex(vector.init_psks[0]) : null
    });
    const responder = createHandshake({
      initiator: false, prologue: hex(vector.resp_prologue), s: keyPair(hex(vector.resp_static)), e: keyPair(hex(vector.resp_ephemeral)),
      psk: vector.resp_psks ? hex(vector.resp_psks[0]) : null
    });
    const [first, second, ...transport] = vector.messages;
    const m1 = initiator.writeMessage(hex(first.payload));
    assert.equal(m1.toString('hex'), first.ciphertext);
    assert.equal(responder.readMessage(m1).toString('hex'), first.payload);
    const m2 = responder.writeMessage(hex(second.payload));
    assert.equal(m2.toString('hex'), second.ciphertext);
    assert.equal(initiator.readMessage(m2).toString('hex'), second.payload);
    assert.ok(initiator.complete && responder.complete);
    assert.equal(initiator.handshakeHash.toString('hex'), vector.handshake_hash);
    assert.equal(responder.handshakeHash.toString('hex'), vector.handshake_hash);
    assert.equal(responder.remoteStatic.toString('hex'), keyPair(hex(vector.init_static)).publicKey.toString('hex'));
    const sides = [initiator.split(), responder.split()];
    transport.forEach((message, index) => {
      const [from, to] = index % 2 === 0 ? sides : [sides[1], sides[0]];
      const sealed = from.send.encrypt(Buffer.alloc(0), hex(message.payload));
      assert.equal(sealed.toString('hex'), message.ciphertext);
      assert.equal(to.receive.decrypt(Buffer.alloc(0), sealed).toString('hex'), message.payload);
    });
  });
}

function pair({ psk = null, hostId = 'host-1', clientPrologue, clientRs } = {}) {
  const host = keyPair(), phone = keyPair();
  const p = prologue({ pattern: psk ? 'pair' : 'session', transport: 'relay', hostId });
  const client = createHandshake({ initiator: true, prologue: clientPrologue ?? p, s: phone, rs: clientRs ?? host.publicKey, psk });
  const server = createHandshake({ initiator: false, prologue: p, s: host, psk });
  return { host, phone, client, server };
}

test('handshake gives both sides matching channels and the host learns the phone key', () => {
  const { phone, client, server } = pair();
  server.readMessage(client.writeMessage());
  client.readMessage(server.writeMessage());
  assert.deepEqual(server.remoteStatic, phone.publicKey);
  const a = createChannel(client.split()), b = createChannel(server.split());
  for (const part of a.seal(Buffer.from('hello'))) assert.equal(b.open(part).toString(), 'hello');
});

test('a different prologue (another host or transport) fails the handshake', () => {
  const { client, server } = pair({ clientPrologue: prologue({ pattern: 'session', transport: 'direct', hostId: 'host-1' }) });
  assert.throws(() => server.readMessage(client.writeMessage()), { code: 'NOISE_FAILED' });
});

test('a client that pinned the wrong host key cannot complete', () => {
  const { client, server } = pair({ clientRs: keyPair().publicKey });
  assert.throws(() => server.readMessage(client.writeMessage()), { code: 'NOISE_FAILED' });
});

test('pairing needs the QR psk on both sides', () => {
  const secret = randomBytes(32);
  const ok = pair({ psk: pairingPsk(secret) });
  ok.server.readMessage(ok.client.writeMessage());
  ok.client.readMessage(ok.server.writeMessage());
  assert.ok(ok.client.complete);
  const host = keyPair(), p = prologue({ pattern: 'pair', transport: 'relay', hostId: 'h' });
  const client = createHandshake({ initiator: true, prologue: p, s: keyPair(), rs: host.publicKey, psk: pairingPsk(randomBytes(32)) });
  const server = createHandshake({ initiator: false, prologue: p, s: host, psk: pairingPsk(secret) });
  server.readMessage(client.writeMessage()); // psk is only mixed in at the second message
  assert.throws(() => client.readMessage(server.writeMessage()), { code: 'NOISE_FAILED' });
});

test('tampered, replayed, reordered and oversized transport messages are rejected', () => {
  const { client, server } = pair();
  server.readMessage(client.writeMessage());
  client.readMessage(server.writeMessage());
  const a = createChannel(client.split()), b = createChannel(server.split());
  const [one] = a.seal(Buffer.from('one')), [two] = a.seal(Buffer.from('two'));
  const flipped = Buffer.from(one); flipped[3] ^= 1;
  assert.throws(() => b.open(flipped), { code: 'NOISE_FAILED' });
  assert.throws(() => b.open(two), { code: 'NOISE_FAILED' }); // out of order
  assert.equal(b.open(one).toString(), 'one');
  assert.throws(() => b.open(one), { code: 'NOISE_FAILED' }); // replay
  assert.equal(b.open(two).toString(), 'two');
  assert.throws(() => b.open(Buffer.alloc(70000)), { code: 'MESSAGE_TOO_LARGE' });
});

test('large messages split into parts and reassemble; the total is capped', () => {
  const { client, server } = pair();
  server.readMessage(client.writeMessage());
  client.readMessage(server.writeMessage());
  const a = createChannel(client.split(), { maxMessage: 1024 * 1024 }), b = createChannel(server.split(), { maxMessage: 1024 * 1024 });
  for (const size of [0, 1, MAX_CHUNK - 1, MAX_CHUNK, MAX_CHUNK + 1, 3 * MAX_CHUNK + 17, 1024 * 1024]) {
    const message = randomBytes(size), parts = a.seal(message);
    assert.equal(parts.length, Math.max(1, Math.ceil(size / MAX_CHUNK)));
    for (const item of parts) assert.ok(item.length <= 65535);
    const results = parts.map(item => b.open(item));
    assert.ok(results.slice(0, -1).every(item => item === null));
    assert.deepEqual(results.at(-1), message);
  }
  assert.throws(() => a.seal(Buffer.alloc(1024 * 1024 + 1)), { code: 'MESSAGE_TOO_LARGE' });
  // A peer that keeps sending non-final parts is cut off at the cap.
  const big = createChannel(client.split(), { maxMessage: 4 * 1024 * 1024 });
  const small = createChannel(server.split(), { maxMessage: 100_000 });
  const parts = big.seal(randomBytes(300_000));
  assert.throws(() => parts.forEach(item => small.open(item)), { code: 'MESSAGE_TOO_LARGE' });
});

test('rekeying by count and by time keeps both sides in step', () => {
  let clock = 0;
  const { client, server } = pair();
  server.readMessage(client.writeMessage());
  client.readMessage(server.writeMessage());
  const options = { rekeyMessages: 3, rekeyMs: 1000, now: () => clock };
  const a = createChannel(client.split(), options), b = createChannel(server.split(), options);
  for (let index = 0; index < 20; index++) {
    if (index === 10) clock += 5000;
    const message = randomBytes(index * 1000);
    let out = null;
    for (const item of a.seal(message)) out = b.open(item);
    assert.deepEqual(out, message);
  }
});

test('fingerprints are stable and short', () => {
  const pair1 = keyPair();
  assert.match(fingerprint(pair1.publicKey), /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  assert.equal(fingerprint(pair1.publicKey), fingerprint(keyPair(pair1.privateKey).publicKey));
  assert.notEqual(fingerprint(pair1.publicKey), fingerprint(keyPair().publicKey));
});

test('a low-order public key ends the handshake', () => {
  const host = keyPair(), p = prologue({ pattern: 'session', transport: 'relay', hostId: 'h' });
  const server = createHandshake({ initiator: false, prologue: p, s: host });
  const message = Buffer.concat([Buffer.alloc(32), randomBytes(48 + 16)]); // all-zero ephemeral
  assert.throws(() => server.readMessage(message), { code: 'NOISE_FAILED' });
});
