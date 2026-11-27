import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createVerifyPlugins } from '../scripts/verify/plugins.mjs';
import { MARKER } from '../scripts/verify/session-dirs.mjs';

const wait = async check => { for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('plugin timeout'); };
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-verify-plugins-')), dataRoot = path.join(root, 'data'), verifyOut = path.join(root, 'out');
  fs.mkdirSync(dataRoot); fs.mkdirSync(verifyOut); fs.writeFileSync(path.join(root, MARKER), '{}');
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify({ id: 'verify-example', name: 'Verify example', version: '1.0.0', apiVersion: 1, main: 'host.js', header: true }));
  fs.writeFileSync(path.join(source, 'host.js'), `
process.on('disconnect', () => process.exit(0));
process.on('message', m => {
 if(m.type==='shutdown') return process.exit(0);
 if(m.type==='init') { process.send({type:'ready'}); process.send({type:'view',view:{status:{text:m.storage?.value||'ready',tone:'ok'},fields:[{key:'secret',label:'Secret',type:'password'}],actions:[{id:'save',label:'Save'}]}}); }
 if(m.type==='action') { process.send({type:'storage',value:{value:m.values.secret}}); process.send({type:'action-result',id:m.id,ok:true,message:'saved'}); }
});`);
  const options = { dataRoot, verifyOut, appVersion: '0.0.0', env: { PATH: process.env.PATH, HOME: path.join(root, 'home'), VERIFY_PLUGIN_DIR: source } };
  const hosts = [];
  const create = () => { const host = createVerifyPlugins(options); hosts.push(host); return host; };
  // Servers a test boots go in `stops`: they must be down before the folder is removed (the runner's own hook order would remove it first, and
  // Windows refuses to delete a folder a running process has open). Removal retries while the last handles are released.
  const stops = [];
  t.after(async () => {
    for (const stop of stops) await stop();
    for (const host of hosts) host.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  return { root, dataRoot, options, create, stops };
}
async function answer(host, pending, accept) {
  const request = await wait(async () => (await host.route('poll', {})).confirmations[0]);
  await host.route('confirm', { id: request.id, accept });
  return pending;
}

test('plugin verification requires a marked session folder holding both the data dir and VERIFY_OUT', t => {
  const s = setup(t);
  assert.throws(() => createVerifyPlugins({ ...s.options, verifyOut: undefined }), /격리/);
  assert.throws(() => createVerifyPlugins({ ...s.options, dataRoot: process.cwd() }), /격리/);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-verify-other-')); t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.throws(() => createVerifyPlugins({ ...s.options, verifyOut: other }), /격리/); // VERIFY_OUT outside the session
  fs.rmSync(path.join(s.root, MARKER));
  assert.throws(() => createVerifyPlugins(s.options), /격리/); // no marker: not a session folder
});

test('browser approval gates real IPC execution, secrets stay sealed, restart restores settings', async t => {
  const s = setup(t), host = s.create();
  const example = async host => (await host.route('state', {})).plugins.find(plugin => plugin.id === 'verify-example');
  assert.equal((await example(host)).state, 'new');
  await answer(host, host.route('setEnabled', { args: [true] }), false);
  assert.equal((await host.route('state', {})).enabled, false);
  await answer(host, host.route('setEnabled', { args: [true] }), true);
  await answer(host, host.route('approve', { args: ['verify-example'] }), false);
  assert.notEqual((await example(host)).state, 'running');
  await answer(host, host.route('approve', { args: ['verify-example'] }), true);
  await wait(async () => (await example(host)).view?.actions.length);
  const secret = 'test-only-secret-value';
  await host.route('action', { args: ['verify-example', 'save', { secret }] });
  const profile = path.join(s.dataRoot, 'verify-plugins');
  assert.ok(!fs.readFileSync(path.join(profile, 'plugins.bin')).includes(Buffer.from(secret)));
  assert.ok(!fs.readFileSync(path.join(profile, 'plugins.json'), 'utf8').includes(secret));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(profile, 'session.key')).mode & 0o777, 0o600);
  host.close();
  const again = s.create();
  await wait(async () => (await example(again)).view?.status?.text === secret);
  assert.equal((await example(again)).header, true);
  const poll = await again.route('poll', {});
  assert.equal((await again.route('poll', { revision: poll.revision })).state, undefined);
  await assert.rejects(again.route('__proto__', {}));
  await assert.rejects(again.route('confirm', { id: 'unknown', accept: true }), /만료/);
  await assert.rejects(again.route('uploadZip', { zip: '../../secret' }), /zip/);
});

test('edited plugins lose approval and closing cancels pending confirmations', async t => {
  const s = setup(t), host = s.create();
  await answer(host, host.route('setEnabled', { args: [true] }), true);
  await answer(host, host.route('approve', { args: ['verify-example'] }), true);
  await wait(async () => (await host.route('state', {})).plugins.find(plugin => plugin.id === 'verify-example')?.state === 'running');
  fs.appendFileSync(path.join(s.dataRoot, 'verify-plugins/plugins/verify-example/host.js'), '\n// changed');
  await wait(async () => (await host.route('state', {})).plugins.find(plugin => plugin.id === 'verify-example')?.state !== 'running');
  const pending = host.route('approve', { args: ['verify-example'] });
  await wait(async () => (await host.route('poll', {})).confirmations.length);
  host.close();
  assert.notEqual((await pending).plugins.find(plugin => plugin.id === 'verify-example')?.state, 'running');
});

test('verification API is absent normally and enforces the existing session and origin checks', async t => {
  const s = setup(t), previous = process.env.VERIFY_OUT;
  process.env.VERIFY_OUT = s.options.verifyOut;
  const { boot } = await import('../scripts/verify/lib.mjs');
  if (previous === undefined) delete process.env.VERIFY_OUT; else process.env.VERIFY_OUT = previous;
  const normal = await boot(); s.stops.push(() => normal.stop());
  assert.equal((await normal.status('verify/plugins/state')).status, 404);
  const active = await boot({ dir: s.root, env: { ADE_DEV: '1', ADE_VERIFY_PLUGINS: '1', VERIFY_OUT: s.options.verifyOut } }); s.stops.push(() => active.stop());
  const state = await active.api('verify/plugins/state');
  assert.equal(state.testSession, true); assert.equal(state.enabled, false);
  for (const [headers, status] of [
    [{ Origin: active.origin, 'Content-Type': 'application/json' }, 401],
    [{ Origin: 'http://evil.invalid', Cookie: active.cookie, 'Content-Type': 'application/json' }, 403],
    [{ Origin: 'null', Cookie: active.cookie, 'Content-Type': 'application/json' }, 403]
  ]) {
    const result = await fetch(`${active.origin}/api/verify/plugins/state`, { method: 'POST', headers, body: '{}' });
    assert.equal(result.status, status);
  }
});
