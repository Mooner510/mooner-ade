import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { MAX_FILES, checkZipListing, createPluginManager, createPluginStore, createZipExtractor, grantsFor, systemTar, treeHash, validManifest } from '../apps/desktop/src/plugin-core.js';

const sealer = () => ({
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(`sealed:${Buffer.from(text).toString('base64')}`),
  decryptString: buffer => Buffer.from(buffer.toString().slice(7), 'base64').toString()
});
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-plugin-zip-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const manifest = (extra = {}) => ({ id: 'example', name: 'Example', version: '1.0.0', apiVersion: 1, main: 'host.js', terminal: { bin: 'bin', envPrefix: 'EXAMPLE_' }, mcp: { name: 'example_tools', script: 'bin/cli.js', args: ['mcp'] }, ...extra });
const pluginFiles = (value = manifest(), prefix = 'example/') => ({ [`${prefix}plugin.json`]: JSON.stringify(value), [`${prefix}host.js`]: '// host', [`${prefix}bin/cli.js`]: '// cli' });

// A stored (uncompressed) zip, written by hand so entries tar would never create (`..`, links) can be tested.
function writeZip(file, entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data ?? ''), crc = zlib.crc32(data);
    const folder = entry.name.endsWith('/'), mode = entry.mode ?? (folder ? 0o40755 : 0o100644);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((mode << 16) | (folder ? 0x10 : 0)) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, directory, end]));
  return file;
}
const zipOf = (file, files) => writeZip(file, Object.entries(files).map(([name, data]) => ({ name, data })));

// The OS bsdtar (Windows and macOS ship one). Linux usually has GNU tar only, which cannot read zips.
const tarWorks = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-tar-probe-'));
  try { execFileSync(systemTar(), ['-tf', zipOf(path.join(dir, 'probe.zip'), { 'a.txt': 'a' })], { stdio: 'pipe', windowsHide: true }); return true; }
  catch { return false; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
})();
const needsTar = { skip: tarWorks ? false : 'no bsdtar that reads zips on this machine' };

// A stand-in for tar: the "zip" is JSON { files: {path: text}, link?: path } and is written out as given.
const jsonExtractor = async ({ zip, dest }) => {
  const spec = JSON.parse(fs.readFileSync(zip, 'utf8'));
  for (const [name, data] of Object.entries(spec.files)) { fs.mkdirSync(path.dirname(path.join(dest, name)), { recursive: true }); fs.writeFileSync(path.join(dest, name), data); }
  if (spec.link) fs.symlinkSync(os.tmpdir(), path.join(dest, spec.link), 'junction');
};
const jsonZip = (file, files, extra = {}) => { fs.writeFileSync(file, JSON.stringify({ files, ...extra })); return file; };

function fakeHost() {
  const child = new EventEmitter();
  Object.assign(child, { sent: [], connected: true, exitCode: null, send(message) { child.sent.push(message); }, kill() { child.exitCode = 1; child.connected = false; child.emit('exit', 1); } });
  return child;
}
function setup(t, { answers = [], ask, extractZip = jsonExtractor, enabled = false } = {}) {
  const root = temp(t), dir = path.join(root, 'plugins'), stagingRoot = path.join(root, 'plugin-staging'), hosts = [], asked = [];
  fs.mkdirSync(dir);
  const store = createPluginStore({ file: path.join(root, 'plugins.bin'), crypto: sealer() });
  store.load();
  if (enabled) store.update(state => ({ ...state, enabled: true }));
  const manager = createPluginManager({
    dir, dataRoot: path.join(root, 'plugin-data'), stagingRoot, store, nodeBinary: '/node', extractZip, log: { log() {}, warn() {}, error() {} },
    spawnHost: options => { const child = fakeHost(); hosts.push({ options, child }); return child; },
    ask: async options => { asked.push(options); if (ask) return ask(options); return answers.length ? answers.shift() : 1; }
  });
  t.after(() => manager.close());
  const leftovers = () => fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot) : [];
  return { root, dir, stagingRoot, store, manager, hosts, asked, leftovers };
}

test('zip listings may hold only relative files and folders within the limits', () => {
  const line = (type, size, name) => `${type}rw-r--r--  0 0      0      ${size} Jan  1  1980 ${name}`;
  const ok = ['p/', 'p/plugin.json', 'p/host.js'];
  checkZipListing(ok.join('\n'), [line('d', 0, ok[0]), line('-', 10, ok[1]), line('-', 7, ok[2])].join('\r\n'));
  for (const name of ['../evil.js', 'p/../../evil.js', '/etc/evil.js', '\\evil.js', 'C:/evil.js', 'p\\..\\evil.js', 'p/host.js:stream', 'p//x.js']) {
    assert.throws(() => checkZipListing(name, line('-', 1, name)), /밖을 가리키는/, name);
  }
  assert.throws(() => checkZipListing('p/link', 'lrwxrwxrwx  0 0      0      0 Jan  1  1980 p/link -> /etc'), /링크/);
  assert.throws(() => checkZipListing('p/hard', `${line('-', 0, 'p/hard')} link to p/host.js`), /링크/);
  assert.throws(() => checkZipListing('p/a\np/b', line('-', 1, 'p/a')), /이름을 읽을 수 없습니다/);
  assert.throws(() => checkZipListing('p/big', line('-', 64 * 1024 * 1024, 'p/big')), /너무 많거나 큽니다/);
  const many = Array.from({ length: MAX_FILES + 1 }, (_, index) => `p/${index}.js`);
  assert.throws(() => checkZipListing(many.join('\n'), many.map(name => line('-', 1, name)).join('\n')), /너무 많거나 큽니다/);
  assert.throws(() => checkZipListing('', ''), /비어/);
});

test('the system tar is the one the OS ships', () => {
  assert.equal(systemTar('win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\tar.exe');
  assert.equal(systemTar('darwin', {}), '/usr/bin/tar');
});

test('the install and approval dialogs list the same grants', async t => {
  const { dir, manager, asked } = setup(t, { answers: [0, 1], enabled: true });
  fs.mkdirSync(path.join(dir, 'example', 'bin'), { recursive: true });
  for (const [name, data] of Object.entries(pluginFiles(manifest(), 'example/'))) fs.writeFileSync(path.join(dir, name), data);
  await manager.approve('example');
  for (const line of grantsFor(validManifest(manifest()))) assert.ok(asked[0].detail.includes(line), line);
  assert.equal(grantsFor(validManifest(manifest({ terminal: undefined, mcp: undefined }))).length, 1);
});

test('a zip dropped into the plugin folder installs after one dialog and turns plugins on', needsTar, async t => {
  const { dir, store, manager, hosts, asked, leftovers } = setup(t, { answers: [0], extractZip: createZipExtractor() });
  const zip = zipOf(path.join(dir, 'example-1.0.0.zip'), { 'example/': '', 'example/bin/': '', ...pluginFiles() });
  assert.equal(store.state.enabled, false);
  assert.deepEqual(manager.droppedZips(), [zip]);
  const result = await manager.installZip(zip);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].buttons, ['설치', '취소']);
  assert.equal(asked[0].cancelId, 1);
  assert.match(asked[0].message, /“Example” 1\.0\.0 플러그인을 설치/);
  assert.match(asked[0].detail, /플러그인 기능도 켭니다/);
  assert.match(asked[0].detail, /id: example/);
  const hash = treeHash(path.join(dir, 'example'));
  assert.ok(asked[0].detail.includes(`SHA-256: ${hash}`));
  assert.equal(store.state.enabled, true);
  assert.deepEqual({ ...store.state.approved.example, approvedAt: 0 }, { hash, folder: 'example', version: '1.0.0', approvedAt: 0 });
  assert.equal(result.plugins[0].state, 'starting');
  assert.match(result.message, /설치했습니다/);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].options.dir, path.join(dir, 'example'));
  assert.ok(!fs.existsSync(zip));
  assert.deepEqual(leftovers(), []);
});

test('plugin.json may sit at the top of the zip', async t => {
  const { dir, manager, hosts } = setup(t, { answers: [0] });
  await manager.installZip(jsonZip(path.join(dir, 'p.zip'), pluginFiles(manifest(), '')));
  assert.ok(fs.existsSync(path.join(dir, 'example', 'plugin.json')));
  assert.equal(hosts.length, 1);
});

test('a zip with a path climbing out is refused before anything is written', needsTar, async t => {
  const { root, dir, manager, hosts, asked, leftovers } = setup(t, { answers: [0], extractZip: createZipExtractor() });
  const zip = writeZip(path.join(dir, 'evil.zip'), [...Object.entries(pluginFiles()).map(([name, data]) => ({ name, data })), { name: '../../escaped.js', data: 'x' }]);
  await assert.rejects(manager.installZip(zip), /밖을 가리키는/);
  assert.equal(asked.length, 0);
  assert.equal(hosts.length, 0);
  assert.ok(!fs.existsSync(path.join(root, 'escaped.js')) && !fs.existsSync(path.join(path.dirname(root), 'escaped.js')));
  assert.ok(fs.existsSync(zip));
  assert.deepEqual(leftovers(), []);
  // Not asked again for the same file.
  assert.deepEqual(manager.droppedZips(), []);
});

test('a zip holding a link is refused', needsTar, async t => {
  const { dir, manager, hosts, asked } = setup(t, { answers: [0], extractZip: createZipExtractor() });
  const zip = writeZip(path.join(dir, 'link.zip'), [...Object.entries(pluginFiles()).map(([name, data]) => ({ name, data })), { name: 'example/bin/tool', data: '/usr/bin/env', mode: 0o120777 }]);
  await assert.rejects(manager.installZip(zip), /링크/);
  assert.equal(asked.length, 0);
  assert.equal(hosts.length, 0);
});

// Whatever the extractor leaves behind is checked again: a link (here a junction, which needs no privilege on Windows) is refused.
test('a link that appears after extracting is refused', async t => {
  const { dir, manager, asked, leftovers } = setup(t, { answers: [0] });
  await assert.rejects(manager.installZip(jsonZip(path.join(dir, 'p.zip'), pluginFiles(), { link: 'example/bin/outside' })), /링크/);
  assert.equal(asked.length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'example')));
  assert.deepEqual(leftovers(), []);
});

test('a zip with a broken manifest or layout is refused and not retried', async t => {
  const { dir, manager, asked, leftovers } = setup(t, { answers: [0] });
  const bad = jsonZip(path.join(dir, 'bad.zip'), pluginFiles(manifest({ id: 'Bad Id' })));
  await assert.rejects(manager.installZip(bad), /플러그인 id/);
  const missing = jsonZip(path.join(dir, 'missing.zip'), { 'example/plugin.json': JSON.stringify(manifest()) });
  await assert.rejects(manager.installZip(missing), /host\.js 파일이 없습니다/);
  const two = jsonZip(path.join(dir, 'two.zip'), { ...pluginFiles(), 'other/readme.txt': 'x' });
  await assert.rejects(manager.installZip(two), /plugin\.json이 있어야/);
  assert.equal(asked.length, 0);
  assert.ok(fs.existsSync(bad) && fs.existsSync(missing) && fs.existsSync(two));
  assert.deepEqual(manager.droppedZips(), []);
  assert.deepEqual(leftovers(), []);
});

test('cancelling keeps the zip and does not ask again for the same file', async t => {
  const { dir, store, manager, hosts, asked, leftovers } = setup(t, { answers: [1, 1, 0] });
  const zip = jsonZip(path.join(dir, 'example.zip'), pluginFiles());
  await manager.installZip(zip);
  assert.equal(asked.length, 1);
  assert.ok(fs.existsSync(zip));
  assert.ok(!fs.existsSync(path.join(dir, 'example')));
  assert.equal(store.state.enabled, false);
  assert.equal(hosts.length, 0);
  assert.deepEqual(leftovers(), []);
  assert.deepEqual(manager.droppedZips(), []);
  await manager.installZip(zip);
  assert.equal(asked.length, 1);
  // Picking it in the settings page is asking again.
  await manager.installZip(zip, { picked: true });
  assert.equal(asked.length, 2);
  // A new copy of the file is a new zip.
  fs.appendFileSync(zip, ' ');
  assert.deepEqual(manager.droppedZips(), [zip]);
  await manager.installZip(zip);
  assert.equal(asked.length, 3);
  assert.equal(hosts.length, 1);
});

test('updating replaces the old folder, keeps the saved data and says it is an update', async t => {
  const { dir, store, manager, hosts, asked } = setup(t, { answers: [0, 0] });
  // The old version sits in a folder not named after its id.
  await manager.installZip(jsonZip(path.join(dir, 'v1.zip'), pluginFiles()));
  fs.renameSync(path.join(dir, 'example'), path.join(dir, 'old-name'));
  store.update(state => ({ ...state, approved: { example: { ...state.approved.example, folder: 'old-name' } } }));
  manager.rescan();
  hosts.at(-1).child.emit('message', { type: 'storage', value: { key: 'kept' } });
  const first = hosts.at(-1).child;
  await manager.installZip(jsonZip(path.join(dir, 'v2.zip'), pluginFiles(manifest({ version: '1.1.0' }))));
  assert.equal(asked[1].title, '플러그인 업데이트');
  assert.match(asked[1].detail, /업데이트 \(1\.0\.0 → 1\.1\.0\)/);
  assert.doesNotMatch(asked[1].detail, /플러그인 기능도 켭니다/);
  assert.ok(!fs.existsSync(path.join(dir, 'old-name')));
  assert.equal(store.state.approved.example.version, '1.1.0');
  assert.equal(store.state.approved.example.folder, 'example');
  assert.equal(store.state.data.example, '{"key":"kept"}');
  assert.equal(first.sent.at(-1).type, 'shutdown');
  assert.notEqual(hosts.at(-1).child, first);
  assert.deepEqual(hosts.at(-1).child.sent[0].storage, { key: 'kept' });
  assert.equal(manager.snapshot().plugins.length, 1);
});

test('a folder named after the id that holds another plugin is not replaced', async t => {
  const { dir, manager, asked } = setup(t, { answers: [0, 0] });
  await manager.installZip(jsonZip(path.join(dir, 'other.zip'), pluginFiles(manifest({ id: 'other' }))));
  fs.renameSync(path.join(dir, 'other'), path.join(dir, 'example'));
  manager.rescan();
  await assert.rejects(manager.installZip(jsonZip(path.join(dir, 'example.zip'), pluginFiles())), /다른 플러그인\(other\)/);
  assert.equal(asked.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'example', 'plugin.json'), 'utf8')).id, 'other');
});

test('a change to the zip or the unpacked files during the dialog voids the install', async t => {
  let change;
  const { dir, stagingRoot, store, manager, hosts, leftovers } = setup(t, { ask: async () => { change(); return 0; } });
  const zip = jsonZip(path.join(dir, 'example.zip'), pluginFiles());
  change = () => fs.appendFileSync(zip, ' ');
  await assert.rejects(manager.installZip(zip), /바뀌었습니다/);
  change = () => {
    const staging = fs.readdirSync(stagingRoot).find(name => !name.endsWith('.zip'));
    fs.writeFileSync(path.join(stagingRoot, staging, 'example', 'host.js'), '// swapped');
  };
  await assert.rejects(manager.installZip(zip), /바뀌었습니다/);
  assert.ok(!fs.existsSync(path.join(dir, 'example')));
  assert.equal(store.state.enabled, false);
  assert.deepEqual(store.state.approved, {});
  assert.equal(hosts.length, 0);
  assert.ok(fs.existsSync(zip));
  assert.deepEqual(leftovers(), []);
});

test('zips are asked about one at a time, and a picked zip from elsewhere is kept', async t => {
  const answers = [];
  const { root, dir, manager, asked, hosts } = setup(t, { ask: () => new Promise(resolve => answers.push(resolve)) });
  const one = manager.installZip(jsonZip(path.join(dir, 'one.zip'), pluginFiles(manifest({ id: 'one' }), 'one/')));
  const outside = jsonZip(path.join(root, 'two.zip'), pluginFiles(manifest({ id: 'two', mcp: { name: 'two_tools', script: 'bin/cli.js' } }), 'two/'));
  const two = manager.installZip(outside, { picked: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(asked.length, 1);
  assert.deepEqual(manager.droppedZips(), []);
  answers.shift()(0);
  await one;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(asked.length, 2);
  assert.doesNotMatch(asked[1].detail, /플러그인 기능도 켭니다/);
  answers.shift()(0);
  await two;
  assert.ok(fs.existsSync(outside));
  assert.ok(!fs.existsSync(path.join(dir, 'one.zip')));
  assert.equal(hosts.length, 2);
});
