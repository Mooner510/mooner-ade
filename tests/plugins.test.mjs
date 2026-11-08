import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createPluginManager, createPluginStore, pluginTerminal, scanPlugins, treeHash, validManifest, validView } from '../apps/desktop/src/plugin-core.js';
import { setAgentMcpServers, terminalAgentCommand } from '../apps/local-server/src/terminal-sessions.js';

const sealer = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: text => Buffer.from(`sealed:${Buffer.from(text).toString('base64')}`),
  decryptString: buffer => {
    const text = buffer.toString();
    if (!text.startsWith('sealed:')) throw new Error('bad');
    return Buffer.from(text.slice(7), 'base64').toString();
  }
});
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-plugins-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const manifest = (extra = {}) => ({ id: 'example', name: 'Example', version: '1.0.0', apiVersion: 1, main: 'host.js', terminal: { bin: 'bin', envPrefix: 'EXAMPLE_' }, mcp: { name: 'example_tools', script: 'bin/cli.js', args: ['mcp'] }, ...extra });
function plugin(root, folder = 'example', value = manifest()) {
  const dir = path.join(root, folder);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(value));
  fs.writeFileSync(path.join(dir, 'host.js'), '// host');
  fs.writeFileSync(path.join(dir, 'bin', 'cli.js'), '// cli');
  return dir;
}
// A host process stand-in: records what main sends and lets the test answer.
function fakeHost() {
  const child = new EventEmitter();
  Object.assign(child, { sent: [], connected: true, exitCode: null, send(message) { child.sent.push(message); }, kill() { child.exit(null); }, exit(code) { child.exitCode = code ?? 1; child.connected = false; child.emit('exit', code); } });
  return child;
}
function setup(t, { answers = [] } = {}) {
  const root = temp(t), dir = path.join(root, 'plugins'), hosts = [], asked = [], terminals = [];
  fs.mkdirSync(dir);
  const store = createPluginStore({ file: path.join(root, 'plugins.bin'), crypto: sealer() });
  store.load();
  const manager = createPluginManager({
    dir, dataRoot: path.join(root, 'plugin-data'), store, nodeBinary: '/node', appVersion: '9.9.9', log: { log() {}, warn() {}, error() {} },
    spawnHost: options => { const child = fakeHost(); hosts.push({ options, child }); return child; },
    ask: async options => { asked.push(options); return answers.length ? answers.shift() : 1; },
    onTerminal: config => terminals.push(config)
  });
  t.after(() => manager.close());
  return { root, dir, store, manager, hosts, asked, terminals };
}

test('manifests are checked strictly', () => {
  assert.equal(validManifest(manifest()).mcp.name, 'example_tools');
  for (const bad of [{ apiVersion: 2 }, { id: 'Bad Id' }, { main: '../host.js' }, { main: '/etc/x.js' }, { main: 'C:/x.js' }, { main: 'a\\b.js' }, { main: 'host.sh' },
    { terminal: { envPrefix: 'PATH_' } }, { terminal: { envPrefix: 'ADE_X_' } }, { terminal: { envPrefix: 'lower_' } }, { mcp: { name: 'Bad-Name', script: 'bin/cli.js' } }, { mcp: { name: 'ok_name', script: 'bin/cli.js', args: ["it's"] } },
    // An NTFS alternate data stream is never hashed.
    { main: 'host.js:hidden.js' }, { mcp: { name: 'ok_name', script: 'bin/cli.js:x.js' } }, { terminal: { bin: 'bin:x' } },
    // Prefixes that would reach shell startup, proxies, TLS trust or what the agents read.
    // Names that would fake or reorder MoonerADE's approval dialog.
    { name: 'Example\n\nMoonerADE' }, { name: 'abc\u202Edcba' }, { name: '   ' },
    { terminal: { envPrefix: 'BASH_' } }, { terminal: { envPrefix: 'PROMPT_' } }, { terminal: { envPrefix: 'HTTPS_' } }, { terminal: { envPrefix: 'SSL_' } }, { terminal: { envPrefix: 'JAVA_' } }, { terminal: { envPrefix: 'MCP_' } }]) {
    assert.throws(() => validManifest(manifest(bad)), /./, JSON.stringify(bad));
  }
});

test('descriptions shown in the approval dialog are plain text', () => {
  assert.equal(validManifest(manifest({ description: 'one\r\ntwo\n\n\n\n\u202Ethree\u0007' })).description, 'one\ntwo\n\nthree');
});

test('the tree hash covers names and bytes and refuses links', t => {
  const dir = plugin(temp(t)), first = treeHash(dir);
  assert.equal(treeHash(dir), first);
  fs.writeFileSync(path.join(dir, 'host.js'), '// changed');
  assert.notEqual(treeHash(dir), first);
  const second = treeHash(dir);
  fs.renameSync(path.join(dir, 'bin', 'cli.js'), path.join(dir, 'bin', 'cli2.js'));
  assert.notEqual(treeHash(dir), second);
  try { fs.symlinkSync(path.join(dir, 'host.js'), path.join(dir, 'link.js')); } catch { return; } // no symlink permission on this machine
  assert.throws(() => treeHash(dir), /링크/);
});

// Node reads whatever a FIFO or socket at a module path gives it, so the hash must not skip them.
test('the tree hash refuses what is neither a file nor a folder', { skip: process.platform === 'win32' }, async t => {
  const dir = plugin(temp(t));
  const server = net.createServer();
  await new Promise(resolve => server.listen(path.join(dir, 'bin', 'cli'), resolve));
  t.after(() => server.close());
  assert.throws(() => treeHash(dir), /파일이나 폴더가 아닌/);
});

test('scanning lists broken folders with a reason and refuses a second id', t => {
  const root = temp(t);
  plugin(root, 'a');
  plugin(root, 'b');
  fs.mkdirSync(path.join(root, 'c'));
  fs.writeFileSync(path.join(root, 'c', 'plugin.json'), '{');
  fs.mkdirSync(path.join(root, 'not-a-plugin'));
  const list = scanPlugins(root);
  assert.deepEqual(list.map(item => item.folder), ['a', 'b', 'c']);
  assert.equal(list[0].error, null);
  assert.match(list[1].error, /같은 id/);
  assert.match(list[2].error, /plugin.json/);
  assert.deepEqual(scanPlugins(path.join(root, 'missing')), []);
});

test('the store is sealed and fails closed', t => {
  const root = temp(t), file = path.join(root, 'plugins.bin');
  const store = createPluginStore({ file, crypto: sealer() });
  store.save({ version: 1, enabled: true, approved: { 'example': { hash: 'a'.repeat(64), folder: 'example', version: '1', approvedAt: 1 } }, data: { 'example': '{"secret":"x"}' } });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret'));
  const again = createPluginStore({ file, crypto: sealer() });
  assert.equal(again.load().enabled, true);
  const locked = createPluginStore({ file, crypto: sealer(false) });
  assert.equal(locked.load().enabled, false);
  assert.equal(locked.problem, 'unavailable');
  assert.throws(() => locked.save({ version: 1, enabled: true }), /암호화/);
  fs.writeFileSync(file, 'garbage');
  const broken = createPluginStore({ file, crypto: sealer() });
  assert.equal(broken.load().enabled, false);
  assert.equal(broken.problem, 'unreadable');
});

test('views and terminal additions are limited to what was declared', () => {
  const view = validView({ status: { tone: 'evil', text: 'x' }, info: [{ label: 'Key', value: 'abc', copy: true }, { value: 'no label' }], fields: [{ key: 'url', label: 'URL' }, { key: '__proto__', label: 'x' }], actions: [{ id: 'test', label: 'Test' }, { id: 'Bad Id', label: 'x' }] });
  assert.equal(view.status, null);
  assert.equal(view.info.length, 1);
  assert.deepEqual(view.fields.map(field => field.key), ['url']);
  assert.deepEqual(view.actions.map(action => action.id), ['test']);
  const terminal = pluginTerminal(validManifest(manifest()), '/plugins/example', { env: { EXAMPLE_CONNECT: '/c', PATH: '/evil', NODE_OPTIONS: '--require x', EXAMPLE_X: 'a\0b' }, mcpArgs: ['--connect', '/c', "bad'"] }, '/node');
  assert.deepEqual(terminal.env, { EXAMPLE_CONNECT: '/c' });
  assert.deepEqual(terminal.path, [path.join('/plugins/example', 'bin')]);
  assert.deepEqual(terminal.mcp, { name: 'example_tools', command: '/node', args: [path.join('/plugins/example', 'bin', 'cli.js'), 'mcp', '--connect', '/c'] });
});

test('nothing runs until plugins are on and the plugin is approved, and a change stops it', async t => {
  const { dir, manager, hosts, asked, terminals, store } = setup(t, { answers: [1, 0, 1, 0] });
  plugin(dir);
  assert.equal(manager.rescan().plugins[0].state, 'new');
  await assert.rejects(manager.approve('example'), /먼저 플러그인/);
  // Turning on: the first dialog is cancelled, the second accepted.
  assert.equal((await manager.setEnabled(true)).enabled, false);
  assert.equal((await manager.setEnabled(true)).enabled, true);
  assert.equal(hosts.length, 0);
  assert.equal((await manager.approve('example')).plugins[0].state, 'new');
  assert.equal(hosts.length, 0);
  const approved = await manager.approve('example');
  assert.match(asked.at(-1).detail, /SHA-256/);
  assert.equal(approved.plugins[0].state, 'starting');
  assert.equal(hosts.length, 1);
  const { child } = hosts[0];
  assert.equal(child.sent[0].type, 'init');
  assert.equal(child.sent[0].appVersion, '9.9.9');
  child.emit('message', { type: 'terminal', env: { EXAMPLE_CONNECT: '/c' }, mcpArgs: ['--connect', '/c'] });
  child.emit('message', { type: 'ready' });
  assert.equal(manager.snapshot().plugins[0].state, 'running');
  assert.deepEqual(terminals.at(-1).plugins[0].env, { EXAMPLE_CONNECT: '/c' });
  // Storage is sealed by main and given back on the next start.
  child.emit('message', { type: 'storage', value: { key: 'k' } });
  assert.equal(store.state.data['example'], '{"key":"k"}');

  fs.writeFileSync(path.join(dir, 'example', 'host.js'), '// tampered');
  const after = manager.rescan();
  assert.equal(after.plugins[0].state, 'changed');
  assert.equal(child.sent.at(-1).type, 'shutdown');
  assert.deepEqual(terminals.at(-1).plugins, []);
  assert.equal(hosts.length, 1);
});

test('a plugin can ask through a labelled dialog and answer actions', async t => {
  const { dir, manager, hosts, asked } = setup(t, { answers: [0, 0, 0] });
  plugin(dir);
  await manager.setEnabled(true);
  await manager.approve('example');
  const { child } = hosts[0];
  child.emit('message', { type: 'ready' });
  child.emit('message', { type: 'confirm', id: 'c1', message: 'MoonerADE 업데이트', detail: 'trust me' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(asked.at(-1).title, '플러그인: Example');
  assert.match(asked.at(-1).detail, /플러그인 “Example”/);
  assert.deepEqual(child.sent.at(-1), { type: 'confirm-result', id: 'c1', ok: true });

  child.emit('message', { type: 'view', view: { fields: [{ key: 'url', label: 'URL' }], actions: [{ id: 'save', label: 'Save' }] } });
  assert.equal(manager.snapshot().plugins[0].view.actions[0].id, 'save');
  const pending = manager.action('example', 'save', { url: 'https://x', 'bad key': 'y' });
  const request = child.sent.at(-1);
  assert.deepEqual(request.values, { url: 'https://x' });
  child.emit('message', { type: 'action-result', id: request.id, ok: true, message: '저장했습니다.' });
  assert.equal((await pending).message, '저장했습니다.');
  const failing = manager.action('example', 'save', {});
  child.emit('message', { type: 'action-result', id: child.sent.at(-1).id, ok: false, error: 'no' });
  await assert.rejects(failing, /no/);
});

test('a crashing plugin is restarted a few times, then left stopped', async t => {
  const { dir, manager, hosts } = setup(t, { answers: [0, 0] });
  plugin(dir);
  await manager.setEnabled(true);
  await manager.approve('example');
  hosts[0].child.exit(1);
  assert.equal(manager.snapshot().plugins[0].state, 'error');
  manager.revoke('example');
  assert.equal(manager.snapshot().plugins[0].state, 'new');
});

test('agents get approved MCP servers, quoted for the shell', async t => {
  const root = temp(t);
  t.after(() => setAgentMcpServers([]));
  setAgentMcpServers([{ name: 'example_tools', command: 'C:\\Program Files\\node.exe', args: ['C:\\p\\cli.js', 'mcp'] }, { name: 'bad', command: "it's", args: [] }]);
  const codex = await terminalAgentCommand(root, 'mcp-codex', 'codex');
  assert.ok(codex.includes("mcp_servers.example_tools.command="), codex);
  assert.ok(codex.includes('C:/Program Files/node.exe'), codex);
  assert.ok(!codex.includes('bad'), codex);
  const claude = await terminalAgentCommand(root, 'mcp-claude', 'claude');
  const file = claude.match(/--mcp-config '([^']+)'/)[1];
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.example_tools.args, ['C:\\p\\cli.js', 'mcp']);
  setAgentMcpServers([]);
  assert.ok(!(await terminalAgentCommand(root, 'plain', 'claude')).includes('--mcp-config'));
});

// PowerShell also closes a single-quoted string at U+2018-U+201B, so a path holding one must not end the quoting.
test('typographic quotes in plugin paths stay inside the shell quoting', async t => {
  const root = temp(t);
  t.after(() => setAgentMcpServers([]));
  setAgentMcpServers([{ name: 'example_tools', command: '/node', args: ['/p/x\u2019; echo INJECTED; \u2019y/cli.js', 'a\u2018\u201A\u201Bb'] }]);
  const command = await terminalAgentCommand(root, 'quotes', 'codex');
  const windows = process.platform === 'win32';
  const [shell, args] = windows
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `function codex { foreach ($a in $args) { [Console]::Out.WriteLine($a) } }; ${command}`]]
    : ['/bin/sh', ['-c', command.replace(/^codex /, "printf '%s\\n' ")]];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(shell, args, { windowsHide: true });
    let out = '', errors = '';
    child.stdout.on('data', chunk => out += chunk);
    child.stderr.on('data', chunk => errors += chunk);
    child.on('error', reject);
    child.on('exit', code => code ? reject(new Error(errors)) : resolve(out));
  });
  const lines = output.split(/\r?\n/);
  assert.ok(!lines.includes('INJECTED'), output);
  assert.ok(lines.some(line => line.startsWith('mcp_servers.example_tools.args=') && line.includes('; echo INJECTED; ')), output);
});
