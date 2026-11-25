// The messages between a remote window's page and this app (apps/desktop/src/remote-bridge.js) and the sealed store of remote-store.js.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBridge } from '../apps/desktop/src/remote-bridge.js';
import { createRemoteStore } from '../apps/desktop/src/remote-store.js';

function setup(link = {}) {
  const posted = [], copied = [], sent = [];
  let closed = 0;
  const fake = { open: true, call: async (action, input) => ({ action, input }), send: message => { sent.push(message); return true; }, ...link };
  const bridge = createBridge({ link: fake, post: value => posted.push(value), copy: text => copied.push(text), close: () => { closed++; } });
  return { bridge, posted, copied, sent, get closed() { return closed; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a call is answered with its id, and a failed call carries the code', async () => {
  const ctx = setup({ call: async action => { if (action === 'bad') throw Object.assign(new Error('거부'), { code: 'REMOTE_FORBIDDEN', files: ['a'] }); return { ok: 1 }; } });
  ctx.bridge.receive(JSON.stringify({ k: 'call', id: 'r1', action: 'snapshot', input: { a: 1 } }));
  ctx.bridge.receive(JSON.stringify({ k: 'call', id: 'r2', action: 'bad' }));
  await tick();
  assert.deepEqual(ctx.posted, [{ k: 'result', id: 'r1', ok: true, value: { ok: 1 } }, { k: 'result', id: 'r2', ok: false, error: { code: 'REMOTE_FORBIDDEN', message: '거부', files: ['a'] } }]);
});

test('link events reach the page only after it said connect, which also tells it the state now', () => {
  const ctx = setup({ open: false });
  ctx.bridge.onMessage('early'); ctx.bridge.onState(true);
  assert.deepEqual(ctx.posted, []);
  ctx.bridge.receive(JSON.stringify({ k: 'connect' }));
  ctx.bridge.onMessage('{"type":"x"}'); ctx.bridge.onState(true);
  assert.deepEqual(ctx.posted, [{ k: 'state', open: false }, { k: 'message', text: '{"type":"x"}' }, { k: 'state', open: true }]);
});

test('send, copy and close act on the link and this PC; haptic and back do nothing', () => {
  const ctx = setup();
  ctx.bridge.receive(JSON.stringify({ k: 'send', message: { type: 'subscribe', projectId: 'p' } }));
  ctx.bridge.receive(JSON.stringify({ k: 'copy', text: 'hello' }));
  ctx.bridge.receive(JSON.stringify({ k: 'haptic' }));
  ctx.bridge.receive(JSON.stringify({ k: 'back', handled: false }));
  ctx.bridge.receive(JSON.stringify({ k: 'close' }));
  assert.deepEqual(ctx.sent, [{ type: 'subscribe', projectId: 'p' }]);
  assert.deepEqual(ctx.copied, ['hello']);
  assert.equal(ctx.closed, 1);
  assert.deepEqual(ctx.posted, []);
});

test('malformed messages are ignored', async () => {
  const ctx = setup();
  for (const raw of ['not json', 'null', '[]', '{"k":"call"}', '{"k":"call","id":1,"action":"x"}', `{"k":"call","id":"a","action":"${'x'.repeat(200)}"}`, '{"k":"send","message":"str"}', '{"k":"copy","text":5}', '{"k":"other"}'])
    ctx.bridge.receive(raw);
  await tick();
  assert.deepEqual([ctx.posted, ctx.sent, ctx.copied, ctx.closed], [[], [], [], 0]);
});

test('the store is sealed, read once, and an unreadable file means signed out', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ade-remote-store-'));
  try {
    let decrypts = 0;
    const crypto = { encryptString: text => Buffer.from(`sealed:${text}`), decryptString: buffer => { decrypts++; const value = buffer.toString('utf8'); if (!value.startsWith('sealed:')) throw new Error('bad'); return value.slice(7); } };
    const file = path.join(dir, 'remote.bin');
    const store = createRemoteStore({ file, crypto });
    assert.equal(store.read(), null);
    store.write({ account: '무너', tokens: { refresh: 'secret-token' } });
    assert.ok(readFileSync(file, 'utf8').startsWith('sealed:'), 'what is written is the sealed form');
    const again = createRemoteStore({ file, crypto });
    assert.equal(again.read().account, '무너');
    again.read(); again.read();
    assert.equal(decrypts, 1, 'the file is opened once per store (the Keychain is asked once), not on every read');
    assert.equal(createRemoteStore({ file, crypto: { ...crypto, decryptString: () => { throw new Error('other user'); } } }).read(), null);
    assert.throws(() => createRemoteStore({ file, crypto: { encryptString: () => { throw new Error('none'); } } }).write({}), { code: 'NO_SECURE_STORAGE' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the page loads resources from its window origin', async () => {
  const { remoteRequestAllowed } = await import('../apps/desktop/src/remote-bridge.js');
  const origin = 'ade-remote://h123';
  for (const url of [origin + '/index.html', 'data:text/plain,x', 'blob:null/123']) assert.ok(remoteRequestAllowed(url, origin));
  for (const url of ['ade-remote://other/file', 'https://example.test', 'file:///local', 'bad url']) assert.equal(remoteRequestAllowed(url, origin), false);
});

test('copy requires a current user activation in the preload', async () => {
  const { runInNewContext } = await import('node:vm');
  const activation = { isActive: false }, sent = [];
  let bridge;
  const electron = {
    ipcRenderer: { on() {}, send: (...args) => sent.push(args) },
    contextBridge: { exposeInMainWorld(_name, api) { bridge = api; } }
  };
  runInNewContext(readFileSync(new URL('../apps/desktop/src/remote-preload.cjs', import.meta.url), 'utf8'),
    { require: () => electron, navigator: { userActivation: activation } });
  const copy = JSON.stringify({ k: 'copy', text: 'sample' });
  bridge.postMessage(copy);
  assert.equal(sent.length, 0);
  activation.isActive = true;
  bridge.postMessage(copy);
  assert.deepEqual(sent, [['ade:remote-bridge:post', copy]]);
});
