import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createPluginManager, createPluginStore, updateReview, validManifest, validPluginState, validView } from '../apps/desktop/src/plugin-core.js';
import { compareVersions, createGithub, machineToken, matchAsset, parseVersion, validSource } from '../apps/desktop/src/plugin-updates.js';

const sha = data => createHash('sha256').update(data).digest('hex');
const sealer = () => ({
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(`sealed:${Buffer.from(text).toString('base64')}`),
  decryptString: buffer => Buffer.from(buffer.toString().slice(7), 'base64').toString()
});
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-plugin-updates-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

// ---- versions and source -----------------------------------------------------------------------------------------------
test('versions are read from tags and asset names and ordered like semver', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { parts: [1, 2, 3], pre: '' });
  assert.deepEqual(parseVersion('server-shell-v0.3.0'), { parts: [0, 3, 0], pre: '' });
  assert.deepEqual(parseVersion('plugin/1.0.0-beta.2'), { parts: [1, 0, 0], pre: 'beta.2' });
  assert.equal(parseVersion('latest'), null);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.9'), 1);
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.9'), 1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.deepEqual(matchAsset('my-plugin-{version}.zip', 'my-plugin-v1.4.0.zip'), { version: '1.4.0' });
  assert.equal(matchAsset('my-plugin-{version}.zip', 'my-plugin-x.zip'), null);
  assert.deepEqual(matchAsset('my-plugin.zip', 'my-plugin.zip'), { version: null });
});

test('plugin.json source names a GitHub repository and a zip; setup steps are checked plain text', () => {
  const base = { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, main: 'host.js' };
  assert.deepEqual(validManifest({ ...base, source: { github: 'owner/repo' } }).source, { github: 'owner/repo', asset: 'demo.zip' });
  assert.deepEqual(validSource({ github: 'Owner-1/my.repo', asset: 'demo-{version}.zip' }, 'demo'), { github: 'Owner-1/my.repo', asset: 'demo-{version}.zip' });
  for (const source of [{ github: 'https://github.com/owner/repo' }, { github: 'owner' }, { github: 'owner/..' }, { github: 'owner/repo', asset: '../x.zip' }, { github: 'owner/repo', asset: 'x.tar.gz' }, 'owner/repo']) {
    assert.throws(() => validManifest({ ...base, source }), /source/);
  }
  const manifest = validManifest({ ...base, setup: [{ id: 'account', label: '계정 연결', detail: '로그인‮합니다' }, { id: 'phone', label: '폰 추가', optional: true }] });
  assert.deepEqual(manifest.setup, [{ id: 'account', label: '계정 연결', detail: '로그인합니다' }, { id: 'phone', label: '폰 추가', detail: '', optional: true }]);
  assert.throws(() => validManifest({ ...base, setup: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] }), /setup/);
  assert.throws(() => validManifest({ ...base, setup: [{ id: 'a', label: 'x‮' }] }), /setup/);
});

test('the view carries setup steps, keyed rows, required fields and lists with their own buttons', () => {
  const view = validView({
    status: { tone: 'ok', text: 'ok' },
    info: [{ label: '키', value: 'abc', key: 'pub', copy: true }, { label: '나쁜 키', value: 'x', key: 'Bad Key' }],
    fields: [{ key: 'url', label: '주소', value: '', required: true }],
    actions: [{ id: 'save', label: '저장', primary: true }, { id: 'wipe', label: '지우기', danger: true }],
    setup: { steps: [{ id: 'server', status: 'done', fields: ['url', 'Bad Key'], actions: ['save'], info: ['pub'] }, { id: 'test', status: 'nope' }, { id: 'pair', status: 'active', qr: true, detail: 'a\u0007b' }] },
    lists: [{ id: 'devices', title: '폰', empty: '없음', items: [{ id: 'dev-1', label: 'Pixel', detail: '제어', tag: { text: '접속 중', tone: 'ok' }, actions: [{ id: 'remove', label: '해제', danger: true }] }, { id: 'bad id!', label: 'x' }] }]
  });
  assert.deepEqual(view.info.map(item => item.key), ['pub', undefined]);
  assert.equal(view.fields[0].required, true);
  assert.equal(view.actions[1].danger, true);
  assert.deepEqual(view.setup, [
    { id: 'server', status: 'done', fields: ['url'], info: ['pub'], actions: ['save'] },
    { id: 'pair', status: 'active', detail: 'ab', fields: [], info: [], actions: [], qr: true }
  ]);
  assert.deepEqual(view.lists, [{ id: 'devices', title: '폰', empty: '없음', items: [{ id: 'dev-1', label: 'Pixel', detail: '제어', tag: { text: '접속 중', tone: 'ok' }, actions: [{ id: 'remove', label: '해제', primary: false, danger: true }] }] }]);
});

test('an update asking for more than the installed version is listed for review', () => {
  const before = validManifest({ id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, main: 'host.js', source: { github: 'o/r' } });
  assert.deepEqual(updateReview(before, { ...before, version: '1.1.0' }), []);
  const review = updateReview(before, { ...before, workspace: true, source: { github: 'evil/r', asset: 'demo.zip' } });
  assert.equal(review.length, 2);
  assert.match(review[0], /프로젝트와 터미널/);
  assert.match(review[1], /github\.com\/o\/r → github\.com\/evil\/r/);
});

test('saved update modes and the GitHub account are checked when read', () => {
  const state = validPluginState({ version: 1, updates: { demo: { mode: 'auto', notified: 'v1.2.0' }, bad: { mode: 'sometimes' }, 'Bad Id': { mode: 'auto' } }, github: { token: 'ghp_' + 'a'.repeat(36), login: 'someone', via: 'oauth', at: 5 } });
  assert.deepEqual(state.updates, { demo: { mode: 'auto', notified: '1.2.0' } });
  assert.deepEqual(state.github, { token: 'ghp_' + 'a'.repeat(36), login: 'someone', via: 'oauth', at: 5 });
  assert.equal(validPluginState({ version: 1, github: { token: 'short', login: 'x' } }).github, null);
});

test("this PC's login comes from gh, then git's credential helper, and never prompts", async () => {
  const calls = [];
  const run = async (command, args, options) => { calls.push({ command, args, env: options.env }); return command === 'gh' ? { code: 1, stdout: '' } : { code: 0, stdout: `protocol=https\nhost=github.com\nusername=x\npassword=${'g'.repeat(40)}\n` }; };
  assert.deepEqual(await machineToken({ run, env: {} }), { token: 'g'.repeat(40), via: 'git' });
  assert.equal(calls[1].env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(calls[1].env.GCM_INTERACTIVE, 'never');
  assert.equal(await machineToken({ run: async () => ({ code: 1, stdout: '' }), env: {} }), null);
});

// ---- the release client against a fake GitHub ---------------------------------------------------------------------------
// releases: [{ tag, assets: {name: Buffer}, digests?: {name: 'sha256:..'}, draft?, prerelease? }]. Records every request.
async function fakeGithub(t, { releases, status = 200, privateToken = null }) {
  const requests = [];
  let nextId = 1;
  const byId = new Map();
  const listed = releases.map(release => ({
    tag_name: release.tag, draft: release.draft === true, prerelease: release.prerelease === true,
    assets: Object.entries(release.assets).map(([name, data]) => { const id = nextId++; byId.set(id, data); return { id, name, size: data.length, digest: release.digests?.[name] ?? null }; })
  }));
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, auth: request.headers.authorization ?? null });
    if (privateToken && request.url.startsWith('/repos/') && !request.url.startsWith('/storage/') && request.headers.authorization !== `Bearer ${privateToken}`) { response.writeHead(404); response.end('{}'); return; }
    if (request.url === '/user') {
      if (request.headers.authorization !== `Bearer ${privateToken}`) { response.writeHead(401); response.end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ login: 'owner-bot' })); return;
    }
    if (/^\/repos\/o\/r\/releases\?/.test(request.url)) {
      if (status !== 200) { response.writeHead(status); response.end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(listed)); return;
    }
    const asset = /^\/repos\/o\/r\/releases\/assets\/(\d+)$/.exec(request.url);
    if (asset) { response.writeHead(302, { location: `/storage/${asset[1]}` }); response.end(); return; }
    const stored = /^\/storage\/(\d+)$/.exec(request.url);
    if (stored && byId.has(Number(stored[1]))) { response.writeHead(200); response.end(byId.get(Number(stored[1]))); return; }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { api: `http://127.0.0.1:${server.address().port}`, requests };
}
const sums = files => Buffer.from(Object.entries(files).map(([name, data]) => `${sha(data)}  ${name}`).join('\n'));

test('the newest release carrying the asset wins; versions.json, checksums and redirects without the token', async t => {
  const zip = Buffer.from('zip-1.3.0'), other = Buffer.from('other');
  const versions = Buffer.from(JSON.stringify({ demo: '1.3.0', other: '9.0.0' }));
  const { api, requests } = await fakeGithub(t, { releases: [
    { tag: 'v9.9.9', draft: true, assets: { 'demo.zip': Buffer.from('draft') } },
    { tag: 'other-v9.0.0', assets: { 'other.zip': other, SHA256SUMS: sums({ 'other.zip': other }) } },
    { tag: 'bundle-7', assets: { 'demo.zip': zip, 'versions.json': versions, SHA256SUMS: sums({ 'demo.zip': zip, 'versions.json': versions }) } }
  ] });
  const token = 't'.repeat(40);
  const github = createGithub({ api, credential: async () => ({ token, via: 'ade' }) });
  const found = await github.latest({ github: 'o/r', asset: 'demo.zip' }, 'demo');
  assert.equal(found.version, '1.3.0');
  assert.equal(found.tag, 'bundle-7');
  assert.equal(found.sha256, sha(zip));
  assert.equal(found.via, 'ade');
  assert.deepEqual((await github.download(found)).data, zip);
  assert.ok(requests.filter(item => item.url.startsWith('/repos/')).every(item => item.auth === `Bearer ${token}`));
  assert.ok(requests.filter(item => item.url.startsWith('/storage/')).every(item => item.auth === null), 'the token never follows a redirect');
});

test('a release without a checksum, or with a wrong one, is refused', async t => {
  const zip = Buffer.from('zip');
  const none = await fakeGithub(t, { releases: [{ tag: 'v1.0.0', assets: { 'demo.zip': zip } }] });
  await assert.rejects(createGithub({ api: none.api }).latest({ github: 'o/r', asset: 'demo.zip' }, 'demo'), { code: 'NO_CHECKSUM' });
  // GitHub's own digest is enough on its own.
  const digest = await fakeGithub(t, { releases: [{ tag: 'v1.0.1', assets: { 'demo.zip': zip }, digests: { 'demo.zip': `sha256:${sha(zip)}` } }] });
  const found = await createGithub({ api: digest.api }).latest({ github: 'o/r', asset: 'demo.zip' }, 'demo');
  assert.equal(found.version, '1.0.1');
  const wrong = await fakeGithub(t, { releases: [{ tag: 'v1.0.2', assets: { 'demo.zip': zip, SHA256SUMS: sums({ 'demo.zip': Buffer.from('something else') }) } }] });
  const github = createGithub({ api: wrong.api });
  await assert.rejects(github.download(await github.latest({ github: 'o/r', asset: 'demo.zip' }, 'demo')), { code: 'CHECKSUM' });
});

test('a private repository without an account says how to connect one; a token reveals the account name', async t => {
  const token = 'p'.repeat(40);
  const { api } = await fakeGithub(t, { privateToken: token, releases: [] });
  await assert.rejects(createGithub({ api }).latest({ github: 'o/r', asset: 'demo.zip' }, 'demo'), error => error.code === 'NOT_FOUND' && /GitHub 연결/.test(error.message));
  await assert.rejects(createGithub({ api, credential: async () => ({ token: 'x'.repeat(40), via: 'gh' }) }).latest({ github: 'o/r', asset: 'demo.zip' }, 'demo'), /gh 로그인에 이 저장소를 볼 권한/);
  assert.deepEqual(await createGithub({ api }).whoami(token), { login: 'owner-bot' });
  await assert.rejects(createGithub({ api }).whoami('w'.repeat(40)), { code: 'UNAUTHORIZED' });
  await assert.rejects(createGithub({ api }).whoami('short'), { code: 'INVALID_TOKEN' });
});

// ---- the manager: modes, dialogs and automatic installs --------------------------------------------------------------------
// The "zip" is JSON { files } (like plugin-install.test.mjs), unpacked by a stand-in for tar.
const jsonExtractor = async ({ zip, dest }) => {
  const spec = JSON.parse(fs.readFileSync(zip, 'utf8'));
  for (const [name, data] of Object.entries(spec.files)) { fs.mkdirSync(path.dirname(path.join(dest, name)), { recursive: true }); fs.writeFileSync(path.join(dest, name), data); }
};
const manifestOf = (version, extra = {}) => ({ id: 'demo', name: 'Demo', version, apiVersion: 1, main: 'host.js', source: { github: 'o/r', asset: 'demo.zip' }, ...extra });
const pluginZip = (version, extra) => Buffer.from(JSON.stringify({ files: { 'demo/plugin.json': JSON.stringify(manifestOf(version, extra)), 'demo/host.js': `// ${version}` } }));
function fakeHost() {
  const child = new EventEmitter();
  Object.assign(child, { sent: [], connected: true, exitCode: null, send(message) { child.sent.push(message); }, kill() { child.exitCode = 1; child.connected = false; child.emit('exit', 1); } });
  return child;
}
// latest: what the fake release holds ({ version, extra }); answers: the dialog buttons pressed, in order.
function setup(t, { latest, answers = [] }) {
  const root = temp(t), dir = path.join(root, 'plugins'), asked = [], notices = [], hosts = [];
  fs.mkdirSync(path.join(dir, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'demo', 'plugin.json'), JSON.stringify(manifestOf('1.0.0')));
  fs.writeFileSync(path.join(dir, 'demo', 'host.js'), '// 1.0.0');
  const store = createPluginStore({ file: path.join(root, 'plugins.bin'), crypto: sealer() });
  store.load();
  const release = { ...latest };
  const github = {
    latest: async () => ({ repo: 'o/r', tag: `v${release.version}`, version: release.version, asset: { id: 1, name: 'demo.zip' }, sha256: 'x', via: null }),
    download: async found => ({ data: pluginZip(found.version, release.extra) }),
    whoami: async token => { if (token !== 'good'.repeat(10)) throw Object.assign(new Error('bad token'), { code: 'UNAUTHORIZED' }); return { login: 'me' }; }
  };
  const manager = createPluginManager({
    dir, dataRoot: path.join(root, 'plugin-data'), stagingRoot: path.join(root, 'staging'), store, nodeBinary: '/node', extractZip: jsonExtractor, github,
    log: { log() {}, warn() {}, error() {} }, notify: notice => notices.push(notice),
    spawnHost: options => { const child = fakeHost(); hosts.push({ options, child }); return child; },
    ask: async options => { asked.push(options); return answers.length ? answers.shift() : 1; }
  });
  t.after(() => manager.close());
  const plugin = () => manager.snapshot().plugins.find(item => item.id === 'demo');
  return { root, dir, store, manager, asked, notices, hosts, release, plugin };
}
// Approves the plugin as installed (plugins on, hash pinned) without a dialog.
function approve(env) {
  env.store.update(state => ({ ...state, enabled: true }));
  const item = env.manager.rescan().plugins.find(plugin => plugin.id === 'demo');
  env.store.update(state => ({ ...state, approved: { demo: { hash: item.hash, folder: 'demo', version: '1.0.0', approvedAt: 1 } } }));
  env.manager.rescan();
}

test('notify mode: a background round announces a new version once; installing asks in the native dialog', async t => {
  const env = setup(t, { latest: { version: '1.1.0' }, answers: [0] });
  approve(env);
  assert.equal(env.plugin().update.mode, 'notify');
  assert.equal(env.plugin().update.status, 'idle');
  await env.manager.runUpdateRound();
  await env.manager.runUpdateRound();
  assert.equal(env.notices.length, 1, 'announced once per version');
  assert.match(env.notices[0].body, /Demo 1\.1\.0 업데이트가 있습니다/);
  assert.equal(env.plugin().update.status, 'available');
  assert.equal(env.plugin().version, '1.0.0', 'nothing installed on its own');
  const result = await env.manager.installUpdate('demo');
  assert.equal(env.asked.length, 1);
  assert.equal(env.asked[0].title, '플러그인 업데이트');
  assert.match(env.asked[0].detail, /1\.0\.0 → 1\.1\.0/);
  assert.match(env.asked[0].detail, /github\.com\/o\/r 릴리스/);
  assert.match(result.message, /1\.1\.0\(으\)로 업데이트했습니다/);
  assert.equal(env.plugin().version, '1.1.0');
  assert.equal(env.plugin().state, 'starting', 'the new version runs, approved by the dialog');
  assert.equal(env.plugin().update.status, 'latest');
});

test('cancelling the update dialog keeps the installed version and the update on offer', async t => {
  const env = setup(t, { latest: { version: '1.1.0' }, answers: [1] });
  approve(env);
  await env.manager.installUpdate('demo');
  assert.equal(env.plugin().version, '1.0.0');
  assert.equal(env.plugin().update.status, 'available');
  assert.deepEqual(fs.readdirSync(path.join(env.root, 'staging')), [], 'the download is not left behind');
});

test('auto mode is turned on in a native dialog and installs updates that ask for nothing new without one', async t => {
  const env = setup(t, { latest: { version: '1.2.0' }, answers: [1, 0] });
  approve(env);
  await env.manager.setUpdateMode('demo', 'auto');
  assert.equal(env.plugin().update.mode, 'notify', 'cancelled');
  await env.manager.setUpdateMode('demo', 'auto');
  assert.equal(env.plugin().update.mode, 'auto');
  assert.match(env.asked[1].detail, /확인 창 없이/);
  await env.manager.runUpdateRound();
  assert.equal(env.asked.length, 2, 'no install dialog');
  assert.equal(env.plugin().version, '1.2.0');
  assert.equal(env.store.state.approved.demo.version, '1.2.0');
  assert.match(env.notices.at(-1).body, /1\.0\.0에서 1\.2\.0\(으\)로 자동 업데이트했습니다/);
  // Turning it back down needs no dialog.
  await env.manager.setUpdateMode('demo', 'manual');
  assert.equal(env.asked.length, 2);
  assert.equal(env.plugin().update.mode, 'manual');
});

test('auto mode never installs an update that asks for a new permission or moves its source; it is announced for review', async t => {
  const env = setup(t, { latest: { version: '2.0.0', extra: { workspace: true } }, answers: [0] });
  approve(env);
  await env.manager.setUpdateMode('demo', 'auto');
  await env.manager.runUpdateRound();
  assert.equal(env.plugin().version, '1.0.0');
  assert.equal(env.plugin().update.status, 'available');
  assert.match(env.plugin().update.review[0], /새 권한: 이 PC의 프로젝트와 터미널/);
  assert.match(env.notices.at(-1).body, /새 권한을 요청해 자동으로 설치하지 않았습니다/);
  // Installing it by hand shows what is new in the dialog.
  env.asked.length = 0;
  await env.manager.installUpdate('demo');
  assert.match(env.asked[0].detail, /전에 없던 것을 요청합니다:\n• 새 권한: 이 PC의 프로젝트와 터미널/);
});

test('a release whose zip is another plugin or another version is not installed', async t => {
  const env = setup(t, { latest: { version: '1.1.0' }, answers: [0] });
  approve(env);
  env.release.extra = { version: '1.0.5' };
  await assert.rejects(env.manager.installUpdate('demo'), /업데이트 정보\(demo 1\.1\.0\)와 다릅니다/);
  assert.equal(env.asked.length, 0);
  assert.equal(env.plugin().version, '1.0.0');
  assert.equal(env.plugin().update.status, 'error');
});

test('manual mode is left out of the background round; a plugin without a source cannot be checked', async t => {
  const env = setup(t, { latest: { version: '1.1.0' } });
  approve(env);
  await env.manager.setUpdateMode('demo', 'manual');
  await env.manager.runUpdateRound();
  assert.equal(env.plugin().update.status, 'idle');
  assert.match((await env.manager.checkUpdates('demo')).message, /Demo 1\.1\.0 업데이트가 있습니다/);
  assert.match((await env.manager.checkUpdates()).message, /업데이트 1개: Demo/);
  fs.writeFileSync(path.join(env.dir, 'demo', 'plugin.json'), JSON.stringify({ ...manifestOf('1.0.0'), source: undefined }));
  env.manager.rescan();
  assert.deepEqual(env.plugin().update, { source: null, mode: 'manual' });
  await assert.rejects(env.manager.checkUpdates('demo'), { code: 'NO_SOURCE' });
});

test('a GitHub token is checked, confirmed with its account name, sealed, and never shown to the page', async t => {
  const env = setup(t, { latest: { version: '1.0.0' }, answers: [1, 0] });
  await assert.rejects(env.manager.connectGithub('bad'.repeat(10)), /bad token/);
  await env.manager.connectGithub('good'.repeat(10));
  assert.equal(env.store.state.github, null, 'cancelled');
  const result = await env.manager.connectGithub(` ${'good'.repeat(10)} `);
  assert.match(env.asked[1].message, /GitHub 계정 me을\(를\) 연결할까요/);
  assert.equal(env.store.state.github.token, 'good'.repeat(10));
  assert.deepEqual({ login: result.github.login, via: result.github.via }, { login: 'me', via: 'pat' });
  assert.ok(!JSON.stringify(env.manager.snapshot()).includes('good'.repeat(10)));
  env.manager.disconnectGithub();
  assert.equal(env.store.state.github, null);
});

test('plugins are told which features this MoonerADE has, and a list button sends its item', async t => {
  const env = setup(t, { latest: { version: '1.0.0' } });
  approve(env);
  const child = env.hosts[0].child;
  assert.deepEqual(child.sent[0].features, ['view.setup', 'view.lists', 'updates']);
  child.emit('message', { type: 'ready' });
  const pending = env.manager.action('demo', 'remove', { device: '1' }, 'dev-1');
  const sent = child.sent.at(-1);
  assert.deepEqual({ action: sent.action, values: sent.values, item: sent.item }, { action: 'remove', values: { device: '1' }, item: 'dev-1' });
  child.emit('message', { type: 'action-result', id: sent.id, ok: true, message: 'done' });
  assert.equal((await pending).message, 'done');
  await assert.rejects(env.manager.action('demo', 'remove', {}, '../x'), /잘못된 항목/);
});
