import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createPluginRegistry } from '../apps/plugin-api/registry.js';
import { pluginApi } from '../apps/plugin-api/active.js';
import { stagePluginApi } from '../apps/desktop/plugin-api-package.mjs';
import { createPluginManager, createPluginStore, treeHash, validManifest } from '../apps/desktop/src/plugin-core.js';

const v1 = pluginApi.get(1);
const v2 = { ...v1, version: 2, host: { ...v1.host, encode: message => ({ ...message, testV2: true }) } };
const manifest = apiVersion => ({ id: 'demo', name: 'Test package', version: '1.0.0', apiVersion, main: 'host.js', workspace: true });
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-plugin-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the manifest selects an exact API, including deprecated and retired versions', () => {
  const dual = createPluginRegistry([{ ...v1, status: 'deprecated' }, v2]);
  assert.equal(validManifest(manifest(1), dual).apiVersion, 1);
  assert.equal(validManifest(manifest(2), dual).apiVersion, 2);
  assert.equal(dual.status(1), 'deprecated');
  assert.throws(() => validManifest(manifest('1'), dual), { code: 'PLUGIN_INVALID' });
  assert.throws(() => validManifest(manifest(3), dual), { code: 'PLUGIN_API_UNSUPPORTED' });
  const v2Only = createPluginRegistry([v2], [1]);
  assert.equal(v2Only.status(1), 'removed');
  assert.throws(() => validManifest(manifest(1), v2Only), { code: 'PLUGIN_API_UNSUPPORTED' });
});

test('v1 workspace requests and events are bounded by the 0.6.3 contract', () => {
  const { workspace } = v1;
  assert.equal(workspace.request('future/action', {}), null);
  assert.equal(workspace.request('git/op', { op: 'future-op' }), null);
  assert.equal(workspace.clientMessage({ type: 'future/event' }), null);
  assert.deepEqual(workspace.request('project/open', { path: '/project', futureOption: true }), { path: '/project' });
  assert.equal(workspace.event({ type: 'future/event' }), null);
  assert.equal(workspace.event({ type: 'chat/event', event: { kind: 'future/event' } }), null);
  assert.deepEqual(workspace.event({ type: 'chat/event', event: { kind: 'result', status: 'success', future: true } }),
    { type: 'chat/event', event: { kind: 'result', status: 'success' } });
  assert.deepEqual(workspace.event({ type: 'terminal/size', id: 't', cols: 80, rows: 24, futureField: true }), { type: 'terminal/size', id: 't', cols: 80, rows: 24 });
  assert.deepEqual(workspace.result('snapshot', { id: 'p', terminals: [{ id: 't', cols: 80, future: true }], future: true }), { id: 'p', terminals: [{ id: 't', cols: 80 }] });
});

test('removal keeps an approved package and its data but never starts its host', async t => {
  const dir = directory(t), folder = path.join(dir, 'demo');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'host.js'), '');
  fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify(manifest(1)));
  const store = createPluginStore({ file: path.join(directory(t), 'plugins.bin'), crypto: {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString()
  } });
  store.load();
  const approved = { hash: treeHash(folder), folder: 'demo', version: '1.0.0', approvedAt: 1 };
  store.update(state => ({ ...state, enabled: true, approved: { demo: approved }, data: { demo: '{"held":true}' } }));
  const manager = createPluginManager({ dir, dataRoot: directory(t), store, registry: createPluginRegistry([v2], [1]),
    spawnHost: () => assert.fail('retired plugin would start'), ask: () => assert.fail('retired plugin would ask for approval') });
  t.after(() => manager.close());
  const snapshot = manager.rescan();
  assert.deepEqual(snapshot.supportedApiVersions, [2]);
  assert.equal(snapshot.plugins[0].id, 'demo');
  assert.equal(snapshot.plugins[0].apiStatus, 'removed');
  assert.equal(snapshot.plugins[0].state, 'incompatible');
  await assert.rejects(manager.approve('demo'));
  assert.deepEqual(store.state.approved.demo, approved);
  assert.equal(store.state.data.demo, '{"held":true}');
  assert.ok(fs.existsSync(path.join(folder, 'host.js')));
});

test('a v2 host uses its selected codec alongside a deprecated v1 host', t => {
  const dir = directory(t), seen = [];
  for (const apiVersion of [1, 2]) {
    const id = `demo-${apiVersion}`, folder = path.join(dir, id);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'host.js'), '');
    fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({ ...manifest(apiVersion), id }));
  }
  const store = { state: { builtin: {} } };
  const manager = createPluginManager({ dir: directory(t), builtinDir: dir, dataRoot: directory(t), store,
    registry: createPluginRegistry([{ ...v1, status: 'deprecated' }, v2]),
    spawnHost() { return Object.assign(new EventEmitter(), { connected: true, send: message => seen.push(message) }); } });
  t.after(() => manager.close());
  assert.deepEqual(manager.rescan().plugins.map(item => item.apiStatus), ['deprecated', 'supported']);
  assert.deepEqual(seen.map(message => [message.apiVersion, message.testV2]), [[1, undefined], [2, true]]);
});

test('the packaging stage excludes an inactive API directory and checks bundled plugins', t => {
  const source = directory(t), builtin = directory(t), out = path.join(directory(t), 'app');
  for (const version of [1, 2]) {
    fs.mkdirSync(path.join(source, `v${version}`));
    fs.writeFileSync(path.join(source, `v${version}`, 'index.js'), 'export {};');
  }
  fs.writeFileSync(path.join(source, 'versions.json'), JSON.stringify({ supported: [{ version: 2, status: 'supported' }], removed: [1] }));
  stagePluginApi(source, out, builtin);
  assert.deepEqual(fs.readdirSync(out).sort(), ['v2', 'versions.json']);
  fs.mkdirSync(path.join(builtin, 'demo'));
  fs.writeFileSync(path.join(builtin, 'demo', 'plugin.json'), JSON.stringify(manifest(1)));
  assert.throws(() => stagePluginApi(source, out, builtin), /excluded API v1/);
});

test('v2 adds the console tab: manifest, init features, events to the window and requests to the plugin', async t => {
  const real = pluginApi.get(2);
  assert.ok(real, 'v2 is supported');
  assert.deepEqual(pluginApi.versions, [1, 2]);
  assert.equal(validManifest({ ...manifest(2), console: true }).console, true);
  assert.equal(validManifest({ ...manifest(1), console: true }).console, undefined, 'v1 never had a console');
  assert.throws(() => validManifest({ ...manifest(2), console: 'yes' }), { code: 'PLUGIN_INVALID' });
  assert.ok(real.host.encode({ type: 'init' }).features.includes('console'));
  assert.ok(!pluginApi.get(1).host.encode({ type: 'init' }).features.includes('console'));
  const { consoleEvent, consoleRequest } = real.host;
  assert.deepEqual(consoleEvent({ run: 'r1', op: 'out', fd: 2, data: 'x', extra: 1 }), { run: 'r1', op: 'out', fd: 2, data: 'x' });
  assert.equal(consoleEvent({ run: 'bad id', op: 'out', data: 'x' }), null);
  assert.equal(consoleEvent({ run: 'r1', op: 'future' }), null);
  assert.deepEqual(consoleEvent({ run: 'r1', op: 'exit', code: 0, signal: 'rm -rf', durationMs: 12.4 }), { run: 'r1', op: 'exit', code: 0, signal: null, timedOut: false, durationMs: 12 });
  assert.deepEqual(consoleRequest({ op: 'run', run: 'r1', command: 'uptime' }), { type: 'console', op: 'run', run: 'r1', command: 'uptime' });
  assert.deepEqual(consoleRequest({ op: 'password', run: 'r1', save: true }), { type: 'console', op: 'password', run: 'r1' }, 'save only with a typed value');
  assert.throws(() => consoleRequest({ op: 'password', run: 'r1', value: 'a\nb' }));
  assert.throws(() => consoleRequest({ op: 'signal', run: 'r1', signal: 'STOP' }));
  assert.throws(() => consoleRequest({ op: 'run', run: 'r1', command: '' }));

  // Through the manager: only a running plugin that declared `console` gets requests, and only its events reach onConsole.
  const dir = directory(t), sent = [], events = [];
  for (const [id, extra] of [['shell', { console: true }], ['plain', {}]]) {
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, 'host.js'), '');
    fs.writeFileSync(path.join(dir, id, 'plugin.json'), JSON.stringify({ ...manifest(2), id, workspace: false, ...extra }));
  }
  const children = new Map();
  const manager = createPluginManager({ dir: directory(t), builtinDir: dir, dataRoot: directory(t), store: { state: { builtin: {} } }, onConsole: event => events.push(event),
    spawnHost({ id }) { const child = Object.assign(new EventEmitter(), { connected: true, send: message => sent.push([id, message]) }); children.set(id, child); return child; } });
  t.after(() => manager.close());
  manager.rescan();
  for (const child of children.values()) child.emit('message', { type: 'ready' });
  const snapshot = manager.snapshot();
  assert.deepEqual(snapshot.plugins.map(item => [item.id, item.console]), [['plain', false], ['shell', true]]);
  manager.consoleRequest('shell', { op: 'run', run: 'r1', command: 'id' });
  assert.deepEqual(sent.filter(([, message]) => message.type === 'console'), [['shell', { type: 'console', op: 'run', run: 'r1', command: 'id' }]]);
  assert.throws(() => manager.consoleRequest('plain', { op: 'run', run: 'r1', command: 'id' }), { code: 'PLUGIN_NO_CONSOLE' });
  children.get('shell').emit('message', { type: 'console', run: 'r1', op: 'out', fd: 1, data: 'uid=1000\n' });
  children.get('plain').emit('message', { type: 'console', run: 'r1', op: 'out', fd: 1, data: 'not declared' });
  assert.deepEqual(events, [{ plugin: 'shell', run: 'r1', op: 'out', fd: 1, data: 'uid=1000\n' }]);
});
