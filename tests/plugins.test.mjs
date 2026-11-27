import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { binCommands, createPluginManager, createPluginStore, pluginTerminal, probeMcpTools, readIcon, scanPlugins, treeHash, updateReview, validBadge, validManifest, validPluginState, validTools, validView } from '../apps/desktop/src/plugin-core.js';
import { deniedMcpTools, setAgentMcpServers, terminalAgentCommand } from '../apps/local-server/src/terminal-sessions.js';

const sealer = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: text => { if (!available) throw new Error('encryption unavailable'); return Buffer.from(`sealed:${Buffer.from(text).toString('base64')}`) },
  decryptString: buffer => {
    const text = buffer.toString();
    if (!available) throw new Error('encryption unavailable'); // like Electron's
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
  // `held` keeps send callbacks back, as a host that stopped reading its channel would.
  Object.assign(child, { sent: [], held: null, connected: true, exitCode: null, send(message, done) { child.sent.push(message); if (child.held) child.held.push(done); else done?.(); }, kill() { child.exit(null); }, exit(code) { child.exitCode = code ?? 1; child.connected = false; child.emit('exit', code); } });
  return child;
}
function setup(t, { answers = [], toServer, onFeedback, appActions, probeMcp = async () => [] } = {}) {
  const root = temp(t), dir = path.join(root, 'plugins'), hosts = [], asked = [], terminals = [], notices = [], probes = [];
  fs.mkdirSync(dir);
  const store = createPluginStore({ file: path.join(root, 'plugins.bin'), crypto: sealer() });
  store.load();
  const manager = createPluginManager({
    dir, dataRoot: path.join(root, 'plugin-data'), store, nodeBinary: '/node', appVersion: '9.9.9', log: { log() {}, warn() {}, error() {} },
    spawnHost: options => { const child = fakeHost(); hosts.push({ options, child }); return child; },
    ask: async options => { asked.push(options); return answers.length ? answers.shift() : 1; },
    onTerminal: config => terminals.push(config), onFeedback, toServer, notify: notice => notices.push(notice), ...appActions && { appActions },
    probeMcp: options => { probes.push(options); return probeMcp(options); }
  });
  t.after(() => manager.close());
  return { root, dir, store, manager, hosts, asked, terminals, notices, probes };
}

test('manifests are checked strictly', () => {
  assert.equal(validManifest(manifest()).mcp.name, 'example_tools');
  for (const bad of [{ apiVersion: 99 }, { id: 'Bad Id' }, { main: '../host.js' }, { main: '/etc/x.js' }, { main: 'C:/x.js' }, { main: 'a\\b.js' }, { main: 'host.sh' },
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

test('header is a declared grant and secret fields never echo their reported value', () => {
  assert.equal(validManifest(manifest({ header: true })).header, true);
  assert.throws(() => validManifest(manifest({ header: 'true' })));
  assert.match(updateReview(manifest(), manifest({ header: true })).join(' '), /상단 바/);
  const view = validView({ fields: [{ key: 'key', label: 'API key', type: 'password', value: 'secret' }, { key: 'path', label: 'Repository', type: 'folder' }, { key: 'body', label: 'Body', type: 'textarea' }], document: { title: 'Report', text: '<script>private text</script>' } });
  assert.equal(view.fields[0].value, '');
  assert.deepEqual(view.fields.map(field => field.type), ['password', 'folder', 'textarea']);
  assert.equal(view.document.text, '<script>private text</script>');
  const split = validView({ fields: [{ key: 'a', label: 'A' }], panel: { status: { tone: 'ok', text: 'ready' }, lists: [{ id: 'issues', title: 'Issues', items: [] }], panel: { status: { tone: 'ok', text: 'nested' } } } });
  assert.deepEqual(split.fields.map(field => field.key), ['a']); assert.equal(split.lists.length, 0);
  assert.equal(split.panel.status.text, 'ready'); assert.equal(split.panel.lists.length, 1); assert.equal(split.panel.panel, null);
  assert.equal(validView({ document: { title: 'Too long', text: 'a'.repeat(65537) } }).document, null);
});

test('only a running approved plugin can expose a declared header button', async t => {
  const s = setup(t, { answers: [0, 0] });
  plugin(s.dir, 'example', manifest({ header: true }));
  await s.manager.rescan();
  assert.equal(s.manager.snapshot().plugins[0].header, false);
  await s.manager.setEnabled(true); await s.manager.approve('example');
  const host = s.hosts[0].child;
  host.emit('message', { type: 'ready' });
  assert.equal(s.manager.snapshot().plugins[0].header, true);
  await s.manager.revoke('example');
  assert.equal(s.manager.snapshot().plugins[0].header, false);
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
  assert.ok(!fs.readFileSync(path.join(root, 'plugins.json'), 'utf8').includes('secret'));
  const again = createPluginStore({ file, crypto: sealer() });
  assert.equal(again.load().enabled, true);
  assert.equal(again.state.approved.example.hash, 'a'.repeat(64));
  // What is sealed is empty when it cannot be opened, so nothing is approved; the plain settings stay.
  const locked = createPluginStore({ file, crypto: sealer(false) });
  assert.equal(locked.load().enabled, true);
  assert.deepEqual(locked.state.approved, {});
  assert.equal(locked.problem, 'unavailable');
  assert.throws(() => locked.save({ version: 1, enabled: true }), /암호화/);
  fs.writeFileSync(file, 'garbage');
  const broken = createPluginStore({ file, crypto: sealer() });
  assert.equal(broken.load().enabled, true);
  assert.deepEqual(broken.state.data, {});
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

test('workspace is an explicit permission, shown in the approval dialog', async t => {
  assert.equal(validManifest(manifest()).workspace, undefined);
  assert.equal(validManifest(manifest({ workspace: true })).workspace, true);
  assert.equal(validManifest(manifest({ workspace: false })).workspace, undefined);
  assert.throws(() => validManifest(manifest({ workspace: 'yes' })), /workspace/);
  const { dir, manager, asked } = setup(t, { answers: [0, 1] });
  plugin(dir, 'example', manifest({ workspace: true }));
  await manager.setEnabled(true);
  assert.equal(manager.snapshot().plugins[0].workspace, true);
  await manager.approve('example');
  assert.match(asked.at(-1).detail, /프로젝트와 터미널을 열고 조작/);
});

async function workspaceHost(t, value, { connected = true, appActions } = {}) {
  const server = [];
  const env = setup(t, { answers: [0, 0], appActions, toServer: message => { if (!connected) return false; server.push(message); return true; } });
  plugin(env.dir, 'example', value);
  await env.manager.setEnabled(true);
  await env.manager.approve('example');
  const { child } = env.hosts.at(-1);
  child.emit('message', { type: 'ready' });
  return { ...env, child, server };
}

test('a plugin without the workspace permission reaches no session', async t => {
  const { child, server, manager } = await workspaceHost(t, manifest());
  child.emit('message', { type: 'workspace', op: 'open', session: 's1' });
  child.emit('message', { type: 'workspace', op: 'api', session: 's1', id: 1, action: 'recent', input: {} });
  manager.fromServer({ type: 'plugin/workspace', plugin: 'example', op: 'message', session: 's1', text: '{}' });
  manager.serverReset();
  manager.close();
  assert.deepEqual(server, []);
  assert.ok(!child.sent.some(message => message.type === 'workspace'));
});

test('update requests are answered by MoonerADE itself, never by the local server, and a plugin cannot update itself', async t => {
  const asked = [];
  const appActions = async (action, input, from) => { asked.push({ action, input, from }); if (input.force) throw Object.assign(new Error('nope'), { code: 'INCOMPATIBLE' }); return { busy: false }; };
  const { child, server } = await workspaceHost(t, manifest({ workspace: true }), { appActions });
  const answer = async id => { for (let i = 0; i < 50 && !child.sent.some(message => message.id === id); i++) await new Promise(resolve => setTimeout(resolve, 5)); return child.sent.find(message => message.id === id); };
  child.emit('message', { type: 'workspace', op: 'api', session: 's1', id: 1, action: 'app/update', input: { force: false, extra: 1 } });
  child.emit('message', { type: 'workspace', op: 'api', session: 's1', id: 2, action: 'app/update', input: { force: true } });
  child.emit('message', { type: 'workspace', op: 'api', session: 's1', id: 3, action: 'plugins/update', input: { id: 'example' } });
  assert.deepEqual(await answer(1), { type: 'workspace', session: 's1', op: 'api-result', id: 1, ok: true, value: { busy: false } });
  assert.deepEqual(await answer(2), { type: 'workspace', session: 's1', op: 'api-result', id: 2, ok: false, error: { code: 'INCOMPATIBLE', message: 'nope' } });
  assert.equal((await answer(3)).error.code, 'SELF_UPDATE');
  assert.deepEqual(asked.map(item => [item.action, item.input, item.from]), [
    ['app/update', { force: false }, { pluginId: 'example', apiVersion: 1 }],
    ['app/update', { force: true }, { pluginId: 'example', apiVersion: 1 }]
  ], 'fields outside the contract are dropped; the asking plugin and its API version are named');
  assert.deepEqual(server, []);
});

test('workspace requests and answers are relayed under the plugin id, and end with the host', async t => {
  const { child, server, manager, hosts } = await workspaceHost(t, manifest({ workspace: true }));
  child.emit('message', { type: 'workspace', op: 'open', session: 's1' });
  child.emit('message', { type: 'workspace', op: 'api', session: 's1', id: 7, action: 'recent', input: { x: 1 } });
  child.emit('message', { type: 'workspace', op: 'send', session: 's1', message: { type: 'subscribe', projectId: 'p' } });
  // Another plugin's id or a bad session never goes out.
  child.emit('message', { type: 'workspace', op: 'open', session: '../x', plugin: 'other' });
  child.emit('message', { type: 'workspace', op: 'api', session: 's1', id: 'x', action: 'recent' });
  const { generation } = server[0];
  assert.match(generation, /^[a-f0-9-]+$/);
  const address = { type: 'plugin/workspace', plugin: 'example', apiVersion: 1, generation };
  assert.deepEqual(server, [
    { ...address, op: 'open', session: 's1' },
    { ...address, op: 'api', session: 's1', id: 7, action: 'recent', input: { x: 1 } },
    { ...address, op: 'send', session: 's1', message: { type: 'subscribe', projectId: 'p' } }
  ]);

  manager.fromServer({ ...address, op: 'api-result', session: 's1', id: 7, ok: true, value: [{ root: '/p' }] });
  manager.fromServer({ ...address, op: 'message', session: 's1', text: '{"type":"snapshot"}' });
  manager.fromServer({ ...address, op: 'closed', session: 's1' });
  manager.fromServer({ ...address, plugin: 'nobody', op: 'closed', session: 's1' });
  manager.fromServer({ ...address, generation: 'old-host', op: 'closed', session: 's1' });
  assert.deepEqual(child.sent.filter(message => message.type === 'workspace'), [
    { type: 'workspace', op: 'api-result', session: 's1', id: 7, ok: true, value: [{ root: '/p' }] },
    { type: 'workspace', op: 'message', session: 's1', text: '{"type":"snapshot"}' },
    { type: 'workspace', op: 'closed', session: 's1' }
  ]);
  manager.serverReset();
  assert.deepEqual(child.sent.at(-1), { type: 'workspace', op: 'reset' });

  // A crashed host's sessions are closed on the server.
  server.length = 0;
  child.exit(1);
  assert.deepEqual(server, [{ ...address, op: 'close-all' }]);
  assert.equal(hosts.length, 1);
});

test('a stopped host closes its sessions, and a host that stops reading loses the session', async t => {
  const { child, server, manager } = await workspaceHost(t, manifest({ workspace: true }));
  child.emit('message', { type: 'workspace', op: 'open', session: 's1' });
  const address = { type: 'plugin/workspace', plugin: 'example', apiVersion: 1, generation: server.shift().generation };
  child.held = [];
  const big = 'x'.repeat(5 * 1024 * 1024);
  for (let index = 0; index < 2; index++) manager.fromServer({ ...address, op: 'message', session: 's1', text: big });
  assert.equal(server.length, 0);
  manager.fromServer({ ...address, op: 'message', session: 's1', text: big });
  assert.deepEqual(server, [{ ...address, op: 'close', session: 's1' }]);
  // Once the host reads again the backlog drains.
  for (const done of child.held.splice(0)) done?.();
  child.held = null;
  manager.fromServer({ ...address, op: 'message', session: 's1', text: big });
  assert.equal(server.length, 1);

  manager.revoke('example');
  assert.deepEqual(server.at(-1), { ...address, op: 'close-all' });
  assert.equal(child.sent.at(-1).type, 'shutdown');
});

test('without a server the host hears at once that nothing opened', async t => {
  const { child } = await workspaceHost(t, manifest({ workspace: true }), { connected: false });
  child.emit('message', { type: 'workspace', op: 'open', session: 's1' });
  child.emit('message', { type: 'workspace', op: 'api', session: 's1', id: 3, action: 'recent' });
  assert.deepEqual(child.sent.filter(message => message.type === 'workspace'), [
    { type: 'workspace', session: 's1', op: 'closed' },
    { type: 'workspace', session: 's1', op: 'api-result', id: 3, ok: false, error: { code: 'SERVER_UNAVAILABLE', message: '로컬 서버가 실행 중이 아닙니다.' } }
  ]);
});

test('a QR code and a status-bar item are plain text, limited in size', () => {
  assert.deepEqual(validView({ qr: { label: 'Scan', value: 'mooner-ade://pair?x=1' } }).qr, { label: 'Scan', value: 'mooner-ade://pair?x=1' });
  assert.equal(validView({ qr: { value: 'x'.repeat(1001) } }).qr, null);
  assert.equal(validView({ qr: { value: '' } }).qr, null);
  assert.equal(validView({}).qr, null);
  assert.deepEqual(validBadge({ text: '폰 1대\n접속 중', tone: 'info' }), { text: '폰 1대 접속 중', tone: 'info' });
  assert.equal(validBadge({ text: 'x'.repeat(40), tone: 'ok' }).text.length, 24);
  assert.equal(validBadge({ text: 'a\u202Eb', tone: 'ok' }).text, 'ab');
  for (const bad of [null, { text: 'x', tone: 'loud' }, { text: '   ', tone: 'ok' }, { text: 3, tone: 'ok' }]) assert.equal(validBadge(bad), null);
});

test('notifications carry the plugin name and are limited per minute; a badge shows only while running', async t => {
  const { dir, manager, hosts, notices } = setup(t, { answers: [0, 0] });
  plugin(dir);
  await manager.setEnabled(true);
  await manager.approve('example');
  const { child } = hosts[0];
  child.emit('message', { type: 'badge', badge: { text: '접속 중', tone: 'info' } });
  assert.equal(manager.snapshot().plugins[0].badge, null); // not running yet
  child.emit('message', { type: 'ready' });
  assert.deepEqual(manager.snapshot().plugins[0].badge, { text: '접속 중', tone: 'info' });
  child.emit('message', { type: 'badge', badge: null });
  assert.equal(manager.snapshot().plugins[0].badge, null);
  child.emit('message', { type: 'badge', badge: { text: '다시', tone: 'warn' } });

  child.emit('message', { type: 'notify', title: 'MoonerADE 업데이트', body: '지금 설치하세요' });
  assert.deepEqual(notices[0], { id: 'example', title: '플러그인: Example', body: 'MoonerADE 업데이트\n지금 설치하세요' });
  child.emit('message', { type: 'notify', title: '', body: '' });
  for (let index = 0; index < 20; index++) child.emit('message', { type: 'notify', title: `n${index}` });
  assert.equal(notices.length, 10);

  manager.revoke('example');
  assert.equal(manager.snapshot().plugins[0].badge, null);
});

// A tiny stdio MCP server, as a plugin would ship one.
const MCP_SERVER = `
let buffer = '';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.method === 'initialize') { send({ method: 'roots/list', id: 'server-1' }); send({ id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'x', version: '1' } } }); }
    else if (message.method === 'tools/list' && !message.params?.cursor) send({ id: message.id, result: { tools: [{ name: 'run', description: 'Runs ' + process.argv[2], inputSchema: { type: 'object', properties: { command: {}, cwd: {} }, required: ['command'] }, annotations: { destructiveHint: true } }], nextCursor: 'p2' } });
    else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [{ name: 'info', title: 'Info', annotations: { readOnlyHint: true, destructiveHint: true } }] } });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

test('an MCP server is asked for its tools the way an agent would, page by page', async t => {
  // Windows keeps the folder of a just-killed process busy for a moment.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-mcp-')), script = path.join(dir, 'server.js');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  fs.writeFileSync(script, MCP_SERVER);
  const tools = validTools(await probeMcpTools({ command: process.execPath, args: [script, 'commands'], cwd: dir }));
  assert.deepEqual(tools.map(tool => tool.name), ['run', 'info']);
  assert.equal(tools[0].description, 'Runs commands');
  assert.deepEqual(tools[0].params, [{ name: 'command', required: true }, { name: 'cwd', required: false }]);
  assert.equal(tools[0].destructive, true);
  assert.deepEqual([tools[1].title, tools[1].readOnly, tools[1].destructive], ['Info', true, false]);
  // A server that never answers, or exits first, fails instead of hanging.
  fs.writeFileSync(path.join(dir, 'silent.js'), 'setInterval(() => {}, 1000); process.stdin.resume();');
  await assert.rejects(probeMcpTools({ command: process.execPath, args: [path.join(dir, 'silent.js')], cwd: dir, timeoutMs: 300 }), /응답하지 않습니다/);
  fs.writeFileSync(path.join(dir, 'exit.js'), 'process.exit(3);');
  await assert.rejects(probeMcpTools({ command: process.execPath, args: [path.join(dir, 'exit.js')], cwd: dir }), /exit 3/);
});

test('tool lists are plain text with valid names only', () => {
  const tools = validTools([{ name: 'ok_tool', description: 'a‮b' }, { name: 'bad name' }, { name: 'ok_tool' }, null, { name: "it's" }, { name: 'x'.repeat(129) }]);
  assert.deepEqual(tools.map(tool => tool.name), ['ok_tool']);
  assert.equal(tools[0].description, 'ab');
  assert.deepEqual(validTools('nope'), []);
});

test('the commands a plugin adds are named from its bin folder', t => {
  const dir = plugin(temp(t));
  for (const name of ['tool', 'tool.cmd', 'tool.ps1', 'other.sh', 'lib.js', '.hidden']) fs.writeFileSync(path.join(dir, 'bin', name), '');
  assert.deepEqual(binCommands(dir, validManifest(manifest())), ['other', 'tool']);
  assert.deepEqual(binCommands(dir, validManifest(manifest({ terminal: undefined }))), []);
});

test('MCP servers and single tools can be turned off; the choice is sealed and reaches new terminals', async t => {
  const { dir, manager, hosts, terminals, store, probes } = setup(t, { answers: [0, 0], probeMcp: async () => [{ name: 'run', description: 'Runs' }, { name: 'info' }] });
  plugin(dir);
  fs.writeFileSync(path.join(dir, 'example', 'bin', 'example'), '');
  await manager.setEnabled(true);
  await manager.approve('example');
  const { child } = hosts[0];
  assert.deepEqual(manager.snapshot().plugins[0].commands, ['example']);
  child.emit('message', { type: 'ready' });
  // Not offered yet: nothing is asked.
  assert.equal(manager.snapshot().plugins[0].tools.offered, false);
  assert.equal(probes.length, 0);
  child.emit('message', { type: 'terminal', env: { EXAMPLE_CONNECT: '/c' }, mcpArgs: ['--connect', '/c'] });
  assert.equal(manager.snapshot().plugins[0].tools.status, 'loading');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(probes.length, 1);
  assert.deepEqual(probes[0].env, { EXAMPLE_CONNECT: '/c' });
  assert.deepEqual(probes[0].args, [path.join(dir, 'example', 'bin', 'cli.js'), 'mcp', '--connect', '/c']);
  let tools = manager.snapshot().plugins[0].tools;
  assert.equal(tools.status, 'ok');
  assert.deepEqual(tools.list.map(tool => [tool.name, tool.enabled]), [['run', true], ['info', true]]);
  assert.deepEqual(manager.snapshot().plugins[0].env, ['EXAMPLE_CONNECT']);
  // The same server again is not asked again.
  child.emit('message', { type: 'terminal', env: { EXAMPLE_CONNECT: '/c' }, mcpArgs: ['--connect', '/c'] });
  assert.equal(probes.length, 1);

  manager.setMcp('example', { tool: 'run', enabled: false });
  assert.deepEqual(terminals.at(-1).plugins[0].mcp.disabledTools, ['run']);
  tools = manager.snapshot().plugins[0].tools;
  assert.deepEqual(tools.list.map(tool => [tool.name, tool.enabled]), [['run', false], ['info', true]]);
  assert.deepEqual(store.state.mcp.example, { off: false, disabled: ['run'] });
  manager.setMcp('example', { enabled: false });
  assert.equal(terminals.at(-1).plugins[0].mcp, null);
  assert.deepEqual(terminals.at(-1).plugins[0].env, { EXAMPLE_CONNECT: '/c' }); // the rest of the terminal additions stay
  manager.setMcp('example', { enabled: true });
  manager.setMcp('example', { tool: 'run', enabled: true });
  assert.equal(terminals.at(-1).plugins[0].mcp.disabledTools, undefined);
  assert.equal(store.state.mcp.example, undefined);
  assert.throws(() => manager.setMcp('example', { tool: "it's", enabled: false }), /도구 이름/);
  assert.throws(() => manager.setMcp('missing', { enabled: false }), /MCP/);

  manager.refreshTools('example');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(probes.length, 2);
  // A stopped plugin keeps showing what it had.
  manager.setMcp('example', { tool: 'info', enabled: false });
  manager.revoke('example');
  assert.deepEqual(manager.snapshot().plugins[0].tools.list.map(tool => [tool.name, tool.enabled]), [['run', true], ['info', false]]);
  assert.throws(() => manager.refreshTools('example'), /실행 중/);
});

test('saved MCP choices are checked when read', () => {
  const state = validPluginState({ version: 1, mcp: { example: { off: true, disabled: ['a', 'a', "b'c", 3] }, 'Bad Id': { off: true }, empty: { off: false, disabled: [] } } });
  assert.deepEqual(state.mcp, { example: { off: true, disabled: ['a'] } });
  assert.deepEqual(validPluginState({ version: 1, mcp: 'x' }).mcp, {});
});

test('agents leave out the plugin tools the user turned off', async t => {
  const root = temp(t);
  t.after(() => setAgentMcpServers([]));
  setAgentMcpServers([{ name: 'example_tools', command: '/node', args: ['/p/cli.js'], disabledTools: ['run', 'bad name'] }, { name: 'other', command: '/node', args: [] }]);
  assert.deepEqual(deniedMcpTools(), ['mcp__example_tools__run']);
  const codex = await terminalAgentCommand(root, 'off-codex', 'codex');
  assert.match(codex, /mcp_servers\.example_tools\.disabled_tools=\[\W*run\W*\]/);
  assert.ok(!codex.includes('mcp_servers.other.disabled_tools'), codex);
  const claude = await terminalAgentCommand(root, 'off-claude', 'claude');
  const settings = JSON.parse(fs.readFileSync(claude.match(/--settings '([^']+)'/)[1], 'utf8'));
  assert.deepEqual(settings.permissions.deny, ['mcp__example_tools__run']);
  assert.ok(settings.hooks.SessionStart);
  setAgentMcpServers([{ name: 'example_tools', command: '/node', args: [] }]);
  const plain = JSON.parse(fs.readFileSync((await terminalAgentCommand(root, 'on-claude', 'claude')).match(/--settings '([^']+)'/)[1], 'utf8'));
  assert.equal(plain.permissions, undefined);
});

test('feedback is an explicit permission; only a declaring, signed-in plugin submits, and every request gets one answer', async t => {
  assert.equal(validManifest(manifest()).feedback, undefined);
  assert.equal(validManifest(manifest({ feedback: true })).feedback, true);
  assert.throws(() => validManifest(manifest({ feedback: 1 })), /feedback/);
  const statuses = [];
  const env = setup(t, { answers: [0, 0], onFeedback: status => statuses.push(status) });
  plugin(env.dir, 'example', manifest({ feedback: true }));
  await env.manager.setEnabled(true);
  await env.manager.approve('example');
  assert.match(env.asked.at(-1).detail, /피드백/);
  assert.equal(env.manager.snapshot().plugins[0].feedback, true);
  const { child } = env.hosts.at(-1);
  child.emit('message', { type: 'ready' });
  assert.equal((await env.manager.submitFeedback({ meta: {}, images: [] })).error.code, 'FEEDBACK_UNAVAILABLE');
  child.emit('message', { type: 'feedback', available: false, reason: '로그인하지 않았습니다' });
  child.emit('message', { type: 'feedback', available: true, account: 'tester‮' });
  assert.deepEqual(statuses.at(-1), { ok: true, account: 'tester', plugin: 'example' });
  assert.ok(statuses.some(status => status.reason === '로그인하지 않았습니다'));

  const submitted = env.manager.submitFeedback({ meta: { title: 't' }, images: [{ path: '/x/img-1.png', mime: 'image/png' }] });
  const request = child.sent.find(message => message.type === 'feedback/submit');
  assert.deepEqual(request.images, [{ path: '/x/img-1.png', mime: 'image/png' }]);
  child.emit('message', { type: 'feedback/result', id: request.id, ok: true, issueUrl: 'https://github.com/o/r/issues/3', issueNumber: 3 });
  assert.deepEqual(await submitted, { ok: true, issueNumber: 3 }); // the link itself is never passed on
  // An odd URL is dropped too; a host that dies answers what was in flight.
  const second = env.manager.submitFeedback({ meta: {}, images: [] });
  const request2 = child.sent.filter(message => message.type === 'feedback/submit').at(-1);
  child.emit('message', { type: 'feedback/result', id: request2.id, ok: true, issueUrl: 'javascript:alert(1)' });
  assert.deepEqual(await second, { ok: true });
  // A rate limit keeps its wait (capped) for the queue.
  const limited = env.manager.submitFeedback({ meta: {}, images: [] });
  const request3 = child.sent.filter(message => message.type === 'feedback/submit').at(-1);
  child.emit('message', { type: 'feedback/result', id: request3.id, ok: false, error: { code: 'rate_limited', message: 'wait', retryAfter: 999999 } });
  assert.deepEqual(await limited, { ok: false, error: { code: 'rate_limited', message: 'wait', retryAfter: 86_400 } });
  const third = env.manager.submitFeedback({ meta: {}, images: [] });
  child.exit(1);
  assert.equal((await third).error.code, 'PLUGIN_STOPPED');
  assert.equal(statuses.at(-1).ok, false);
});

test('feedback status lookups go only to a signed-in plugin that said it can, and only well-formed answers pass', async t => {
  const env = setup(t, { answers: [0, 0] });
  plugin(env.dir, 'example', manifest({ feedback: true }));
  await env.manager.setEnabled(true);
  await env.manager.approve('example');
  const { child } = env.hosts.at(-1);
  child.emit('message', { type: 'ready' });
  child.emit('message', { type: 'feedback', available: true, account: 'tester' });
  assert.equal(env.manager.feedbackStatus().statusQuery, undefined);
  assert.deepEqual(await env.manager.queryFeedbackStatus({ keys: ['abcdefgh'] }), { ok: false, error: { code: 'unsupported' } });
  assert.ok(!child.sent.some(message => message.type === 'feedback/status'));
  child.emit('message', { type: 'feedback', available: true, account: 'tester', statusQuery: true });
  assert.equal(env.manager.feedbackStatus().statusQuery, true);
  const asked = env.manager.queryFeedbackStatus({ keys: ['abcdefgh', 'ijklmnop'], have: { abcdefgh: 2, 'bad key': 1, ijklmnop: -1, qrstuvwx: 1.5 } });
  const request = child.sent.find(message => message.type === 'feedback/status');
  assert.deepEqual(request.keys, ['abcdefgh', 'ijklmnop']); assert.deepEqual(request.have, { abcdefgh: 2 });
  child.emit('message', { type: 'feedback/status-result', id: request.id, ok: true, latestStable: '0.6.0', items: {
    abcdefgh: { state: 'beta', version: '0.6.0-beta5', body: 'never passed on', commentCount: 2, comments: [{ at: '2026-11-24T01:00:00Z', body: '반영했어요', author: 'x' }, { at: 5, body: 'bad' }] }, ijklmnop: { state: 'shipped' }, 'bad key': { state: 'pending' }, qrstuvwx: { state: 'released', version: 'javascript:alert(1)' } } });
  assert.deepEqual(await asked, { ok: true, latestStable: '0.6.0', items: { abcdefgh: { state: 'beta', version: '0.6.0-beta5', commentCount: 2, comments: [{ at: '2026-11-24T01:00:00Z', body: '반영했어요' }] }, qrstuvwx: { state: 'released' } } });
  const failed = env.manager.queryFeedbackStatus({ keys: ['abcdefgh'] });
  const second = child.sent.filter(message => message.type === 'feedback/status').at(-1);
  child.emit('message', { type: 'feedback/status-result', id: second.id, ok: false, error: { code: 'rate_limited', retryAfter: 999999 } });
  assert.deepEqual(await failed, { ok: false, error: { code: 'rate_limited', retryAfter: 86_400 } });
  const dying = env.manager.queryFeedbackStatus({ keys: ['abcdefgh'] });
  child.exit(1);
  assert.equal((await dying).error.code, 'network_error');
});

test('a plugin that did not declare feedback is never asked and never counted', async t => {
  const statuses = [];
  const env = setup(t, { answers: [0, 0], onFeedback: status => statuses.push(status) });
  plugin(env.dir, 'example', manifest());
  await env.manager.setEnabled(true);
  await env.manager.approve('example');
  const { child } = env.hosts.at(-1);
  child.emit('message', { type: 'ready' });
  child.emit('message', { type: 'feedback', available: true });
  assert.equal(env.manager.feedbackStatus().ok, false);
  assert.equal((await env.manager.submitFeedback({ meta: {}, images: [] })).ok, false);
  assert.ok(!child.sent.some(message => message.type === 'feedback/submit'));
});

test('a plugin may name one SVG icon in its folder; a bad icon only falls back to the generic one', t => {
  assert.equal(validManifest(manifest({ icon: 'assets/icon.svg' })).icon, 'assets/icon.svg');
  for (const icon of ['icon.png', '../icon.svg', '/icon.svg', 'C:/icon.svg', 'a\\icon.svg', 7]) assert.throws(() => validManifest(manifest({ icon })), /icon/);
  const root = temp(t), folder = path.join(root, 'example');
  fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
  for (const file of ['host.js', 'bin/cli.js']) fs.writeFileSync(path.join(folder, file), '');
  const svg = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 12h18"/></svg>\n';
  fs.writeFileSync(path.join(folder, 'icon.svg'), svg);
  fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify(manifest({ icon: 'icon.svg' })));
  const [item] = scanPlugins(root);
  assert.equal(item.error, null); assert.equal(item.icon, svg);
  const named = { icon: 'icon.svg' };
  fs.writeFileSync(path.join(folder, 'icon.svg'), '<html><script>alert(1)</script></html>'); assert.equal(readIcon(folder, named), null);
  fs.writeFileSync(path.join(folder, 'icon.svg'), `<svg>${'x'.repeat(40 * 1024)}</svg>`); assert.equal(readIcon(folder, named), null);
  fs.rmSync(path.join(folder, 'icon.svg')); assert.equal(readIcon(folder, named), null);
  assert.equal(scanPlugins(root)[0].error, null, 'a missing icon does not break the plugin');
  assert.equal(readIcon(folder, {}), null);
});
