// The side-effect-free parts of the phone <-> PC end-to-end rig (scripts/verify/t-phone-e2e.mjs): the relay that can be cut, and the loopback-only guard.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { freePort, pickPort, relayProxy } from '../scripts/verify/phone-relay.mjs';
import { field } from '../scripts/verify/phone-rig.mjs';

const guard = fileURLToPath(new URL('../scripts/verify/loopback-only.cjs', import.meta.url));
const echoServer = async () => {
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.pipe(socket); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
};
const talk = (port, text) => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('error', reject);
  socket.once('data', data => { socket.destroy(); resolve(String(data)); });
  socket.once('connect', () => socket.write(text));
});

test('the relay passes bytes through to the Hub and counts connections', async () => {
  const hub = await echoServer(), port = await freePort(), relay = relayProxy({ port, targetPort: hub.address().port });
  await relay.start();
  try {
    assert.equal(await talk(port, 'ping'), 'ping');
    assert.equal(relay.accepted, 1);
  } finally { await relay.stop(); hub.close(); }
});

test('cut(ms) drops open connections, refuses new ones meanwhile, and listens again on the same port', async () => {
  const hub = await echoServer(), port = await freePort(), relay = relayProxy({ port, targetPort: hub.address().port });
  await relay.start();
  try {
    const open = net.connect(port, '127.0.0.1');
    await new Promise(resolve => open.once('connect', resolve));
    const closed = new Promise(resolve => open.once('close', resolve));
    const cut = relay.cut(400);
    await closed;
    await assert.rejects(talk(port, 'during'), /ECONNREFUSED/);
    await cut;
    assert.equal(await talk(port, 'after'), 'after');
    assert.deepEqual(relay.events.map(event => event.what), ['listening', 'cut 400ms', 'listening again']);
  } finally { await relay.stop(); hub.close(); }
});

test('pickPort keeps a free preferred port and falls back to another when it is taken', async () => {
  const free = await freePort();
  assert.equal(await pickPort(free), free);
  const taken = await echoServer();
  try { assert.notEqual(await pickPort(taken.address().port), taken.address().port); } finally { taken.close(); }
});

test('loopback-only.cjs refuses a connection beyond this machine before any DNS or TCP, and logs it (net.connect, socket.connect and fetch)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-guard-')), logFile = join(dir, 'blocked.log');
  try {
    const out = execFileSync(process.execPath, ['--require', guard, '-e', `
      const net = require('node:net');
      const attempt = start => new Promise(resolve => { const socket = start(); socket.on('error', error => resolve('error ' + error.code)); socket.on('connect', () => resolve('connected')); });
      (async () => {
        const results = [await attempt(() => net.connect(443, 'registry.npmjs.org')), await attempt(() => new net.Socket().connect(443, 'registry.npmjs.org')), await attempt(() => net.connect({ host: 'registry.npmjs.org', port: 443 }))];
        results.push(await fetch('https://registry.npmjs.org/').then(() => 'fetched', error => 'fetch ' + (error.cause?.code ?? error.message)));
        console.log(results.join('|')); process.exit(0);
      })();
      setTimeout(() => { console.log('timeout'); process.exit(2); }, 8000);`], { env: { ...process.env, PHONE_E2E_GUARD_LOG: logFile }, encoding: 'utf8' });
    assert.equal(out.trim(), 'error ECONNREFUSED|error ECONNREFUSED|error ECONNREFUSED|fetch ECONNREFUSED');
    assert.match(readFileSync(logFile, 'utf8'), /blocked registry\.npmjs\.org:443/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loopback-only.cjs lets loopback connections through', async () => {
  const server = await echoServer();
  try {
    // Not execFileSync: the echo server lives in this process, whose event loop a blocking call would stop.
    const { stdout: out } = await promisify(execFile)(process.execPath, ['--require', guard, '-e', `
      const net = require('node:net');
      const socket = net.connect(${server.address().port}, '127.0.0.1');
      socket.on('connect', () => { socket.write('hi'); });
      socket.on('data', data => { console.log(String(data)); process.exit(0); });
      socket.on('error', error => { console.log('error ' + error.code); process.exit(1); });`], { encoding: 'utf8' });
    assert.equal(out.trim(), 'hi');
  } finally { server.close(); }
});

// hubApprove reads the Hub's own form with field(): a regex that quietly stopped matching (a `\b` that had become a backspace character) sent `csrf=undefined`, and the Hub answered 403.
test('field reads an input value by name from the Hub form, and nothing for a missing one', () => {
  const html = '<form method="post"><input type="hidden" name="csrf" value="a_b-c"><input type="hidden" name="code" value=""><input id="name" name="name" required></form>';
  assert.equal(field(html, 'csrf'), 'a_b-c');
  assert.equal(field(html, 'code'), '');
  assert.equal(field(html, 'name'), undefined, 'an input without a value attribute');
  assert.equal(field(html, 'other'), undefined);
});

test('the rig source holds no control characters (an escape that turned into one breaks a regex silently)', () => {
  const source = readFileSync(fileURLToPath(new URL('../scripts/verify/phone-rig.mjs', import.meta.url)), 'utf8');
  assert.equal(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source), false);
});
