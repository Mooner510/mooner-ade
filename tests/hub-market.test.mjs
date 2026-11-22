import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHubClient } from '../apps/desktop/src/hub-client.js';
import { createPluginManager, createPluginStore, validManifest } from '../apps/desktop/src/plugin-core.js';
import { startFakeHub } from '../scripts/verify/hub-fake.mjs';

// The plugin market and Hub updates through the real manager and the real Hub client, against a fake Hub. The "zip" is JSON { files }
// (like plugin-updates.test.mjs), unpacked by a stand-in for tar.
const sealer = () => ({
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(`sealed:${Buffer.from(text).toString('base64')}`),
  decryptString: buffer => Buffer.from(buffer.toString().slice(7), 'base64').toString()
});
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-hub-market-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const jsonExtractor = async ({ zip, dest }) => {
  const spec = JSON.parse(fs.readFileSync(zip, 'utf8'));
  for (const [name, data] of Object.entries(spec.files)) { fs.mkdirSync(path.dirname(path.join(dest, name)), { recursive: true }); fs.writeFileSync(path.join(dest, name), data); }
};
const manifestOf = (id, version, extra = {}) => ({ id, name: `Plugin ${id}`, version, apiVersion: 1, main: 'host.js', source: { hub: true }, ...extra });
const zipOf = (id, version, extra) => Buffer.from(JSON.stringify({ files: { [`${id}/plugin.json`]: JSON.stringify(manifestOf(id, version, extra)), [`${id}/host.js`]: `// ${version}` } }));
function fakeHost() {
  const child = new EventEmitter();
  Object.assign(child, { sent: [], connected: true, exitCode: null, send(message) { child.sent.push(message); }, kill() { child.exitCode = 1; child.connected = false; child.emit('exit', 1); } });
  return child;
}

// installed: [{ id, version, source? }] already in the plugin folder and approved. answers: the dialog buttons pressed, in order.
async function setup(t, { installed = [], answers = [], signedIn = true, builtin = [], github = null } = {}) {
  const root = temp(t), dir = path.join(root, 'plugins'), builtinDir = path.join(root, 'builtin'), asked = [], notices = [], opened = [], warnings = [];
  const fake = await startFakeHub();
  t.after(() => fake.close());
  fs.mkdirSync(dir, { recursive: true }); // the app makes the plugin folder at start (plugins.js)
  for (const { id, version, source = { hub: true } } of installed) {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'plugin.json'), JSON.stringify(manifestOf(id, version, { source })));
    fs.writeFileSync(path.join(dir, id, 'host.js'), `// ${version}`);
  }
  for (const id of builtin) {
    fs.mkdirSync(path.join(builtinDir, id), { recursive: true });
    fs.writeFileSync(path.join(builtinDir, id, 'plugin.json'), JSON.stringify(manifestOf(id, '1.0.0', { source: undefined })));
    fs.writeFileSync(path.join(builtinDir, id, 'host.js'), '// builtin');
  }
  const store = createPluginStore({ file: path.join(root, 'plugins.bin'), crypto: sealer() });
  store.load();
  const hub = createHubClient({ store, baseUrl: fake.url, name: () => 'ADE · test-pc' });
  const manager = createPluginManager({
    dir, builtinDir: builtin.length ? builtinDir : null, dataRoot: path.join(root, 'plugin-data'), stagingRoot: path.join(root, 'staging'), store, nodeBinary: '/node', extractZip: jsonExtractor, hub, github,
    log: { log() {}, warn: message => warnings.push(message), error() {} }, notify: notice => notices.push(notice), openExternal: url => opened.push(url),
    spawnHost: () => fakeHost(), ask: async options => { asked.push(options); return answers.length ? answers.shift() : 1; }
  });
  t.after(() => manager.close());
  const env = { root, dir, store, manager, fake, hub, asked, notices, opened, warnings, plugin: id => manager.snapshot().plugins.find(item => item.id === id) };
  // Plugins already installed are approved as if their dialog had been answered.
  if (installed.length) {
    store.update(state => ({ ...state, enabled: true }));
    const found = manager.rescan().plugins.filter(item => installed.some(entry => entry.id === item.id));
    store.update(state => ({ ...state, approved: Object.fromEntries(found.map(item => [item.id, { hash: item.hash, folder: item.id, version: item.version, approvedAt: 1 }])) }));
    manager.rescan();
  }
  if (signedIn) { const start = await hub.deviceStart(); await hub.devicePoll(start); }
  return env;
}

test('a source can name the Hub, with GitHub kept beside it for an older MoonerADE', () => {
  assert.deepEqual(validManifest({ ...manifestOf('demo', '1.0.0'), source: { hub: true } }).source, { hub: true });
  assert.deepEqual(validManifest({ ...manifestOf('demo', '1.0.0'), source: { github: 'o/r', hub: true } }).source, { github: 'o/r', asset: 'demo.zip', hub: true });
  assert.deepEqual(validManifest({ ...manifestOf('demo', '1.0.0'), source: { github: 'o/r' } }).source, { github: 'o/r', asset: 'demo.zip' });
  for (const source of [{ hub: 'yes' }, { hub: false }, {}, { hub: true, asset: 'x.zip' }, { hub: true, github: 'nope' }]) assert.throws(() => validManifest({ ...manifestOf('demo', '1.0.0'), source }), /source/);
});

test('the market lists what the Hub serves next to what is installed; a built-in plugin\'s id is not for sale', async t => {
  const env = await setup(t, { installed: [{ id: 'demo', version: '1.0.0' }], builtin: ['agent-tool'] });
  assert.equal(env.manager.snapshot().hub.catalog.plugins.length, 0, 'not asked yet');
  env.fake.publish({ id: 'demo', version: '1.1.0', name: '데모', description: '설명‮입니다', grants: { workspace: true } });
  env.fake.publish({ id: 'fresh', version: '0.3.0' });
  env.fake.publish({ id: 'agent-tool', version: '9.0.0' });
  const { hub } = await env.manager.hubCatalog();
  assert.equal(hub.catalog.status, 'ok');
  const byId = Object.fromEntries(hub.catalog.plugins.map(plugin => [plugin.id, plugin]));
  assert.deepEqual({ installed: byId.demo.installed, updateAvailable: byId.demo.updateAvailable, name: byId.demo.name, description: byId.demo.description }, { installed: { version: '1.0.0' }, updateAvailable: true, name: '데모', description: '설명입니다' });
  assert.deepEqual({ installed: byId.fresh.installed, updateAvailable: byId.fresh.updateAvailable, reserved: byId.fresh.reserved }, { installed: null, updateAvailable: false, reserved: false });
  assert.equal(byId['agent-tool'].reserved, true);
  await assert.rejects(env.manager.installFromHub('agent-tool'), { code: 'PLUGIN_ZIP' });
  // The answer from the last minute is reused unless asked again.
  const before = env.fake.requests.length;
  await env.manager.hubCatalog();
  assert.equal(env.fake.requests.length, before);
  await env.manager.hubCatalog({ force: true });
  assert.equal(env.fake.requests.length, before + 1);
});

test('installing from the market asks in the zip install dialog, naming the Hub, and runs the plugin', async t => {
  const env = await setup(t, { answers: [0] });
  env.fake.publish({ id: 'fresh', version: '0.3.0', zip: zipOf('fresh', '0.3.0', { workspace: true }) });
  const result = await env.manager.installFromHub('fresh');
  assert.equal(env.asked.length, 1);
  assert.equal(env.asked[0].title, '플러그인 설치');
  assert.match(env.asked[0].detail, /받은 곳: MoonerADE Hub/);
  assert.match(env.asked[0].detail, /업데이트 출처: MoonerADE Hub/);
  assert.match(env.asked[0].detail, /프로젝트와 터미널/, 'what it may do is listed like for any zip');
  assert.match(result.message, /0\.3\.0 플러그인을 설치했습니다/);
  assert.equal(env.plugin('fresh').version, '0.3.0');
  assert.equal(env.plugin('fresh').state, 'starting');
  assert.equal(env.plugin('fresh').update.source.kind, 'hub');
  assert.deepEqual(fs.readdirSync(path.join(env.root, 'staging')), [], 'the download is not left behind');
  // Installing it again changes nothing.
  assert.match((await env.manager.installFromHub('fresh')).message, /이미 최신\(0\.3\.0\)/);
  assert.equal(env.asked.length, 1);
});

test('cancelling the install dialog installs nothing; a zip that is not the listed plugin is refused', async t => {
  const env = await setup(t, { answers: [1, 0] });
  env.fake.publish({ id: 'fresh', version: '0.3.0', zip: zipOf('fresh', '0.3.0') });
  await env.manager.installFromHub('fresh');
  assert.equal(env.plugin('fresh'), undefined);
  assert.deepEqual(fs.readdirSync(path.join(env.root, 'staging')), []);
  // The Hub lists `other` but serves another plugin's zip under it (its own checksum matches, the manifest does not).
  env.fake.publish({ id: 'other', version: '1.0.0', zip: zipOf('fresh', '0.3.0') });
  await assert.rejects(env.manager.installFromHub('other'), /업데이트 정보\(other 1\.0\.0\)와 다릅니다/);
  assert.equal(env.asked.length, 1, 'no dialog for it');
});

test('installing over a plugin that updated from GitHub shows the change of source in the dialog', async t => {
  const env = await setup(t, { answers: [0], installed: [{ id: 'demo', version: '1.0.0', source: { github: 'o/r', asset: 'demo.zip' } }] });
  env.fake.publish({ id: 'demo', version: '1.1.0', zip: zipOf('demo', '1.1.0') });
  await env.manager.installFromHub('demo');
  assert.equal(env.asked[0].title, '플러그인 업데이트');
  assert.match(env.asked[0].detail, /업데이트 출처가 바뀝니다: github\.com\/o\/r → MoonerADE Hub/);
  assert.equal(env.plugin('demo').version, '1.1.0');
});

test('notify mode: a background round announces a Hub update once; installing asks, naming the Hub', async t => {
  const env = await setup(t, { answers: [0], installed: [{ id: 'demo', version: '1.0.0' }] });
  env.fake.publish({ id: 'demo', version: '1.1.0', zip: zipOf('demo', '1.1.0') });
  assert.equal(env.plugin('demo').update.status, 'idle');
  await env.manager.runUpdateRound();
  await env.manager.runUpdateRound();
  assert.equal(env.notices.length, 1, 'announced once per version');
  assert.match(env.notices[0].body, /Plugin demo 1\.1\.0 업데이트가 있습니다/);
  assert.equal(env.plugin('demo').update.status, 'available');
  assert.equal(env.plugin('demo').update.viaLabel, 'MoonerADE Hub 로그인');
  assert.deepEqual(env.plugin('demo').update.source, { kind: 'hub' });
  assert.equal(env.plugin('demo').version, '1.0.0', 'nothing installed on its own');
  await env.manager.installUpdate('demo');
  assert.match(env.asked[0].detail, /1\.0\.0 → 1\.1\.0/);
  assert.match(env.asked[0].detail, /받은 곳: MoonerADE Hub/);
  assert.equal(env.plugin('demo').version, '1.1.0');
  assert.equal(env.plugin('demo').update.status, 'latest');
});

test('auto mode is turned on in a dialog that names the Hub, then installs updates that ask for nothing new without one', async t => {
  const env = await setup(t, { answers: [0], installed: [{ id: 'demo', version: '1.0.0' }] });
  await env.manager.setUpdateMode('demo', 'auto');
  assert.match(env.asked[0].detail, /MoonerADE Hub에 새 버전이 올라오면 확인 창 없이/);
  assert.doesNotMatch(env.asked[0].detail, /github\.com/);
  env.fake.publish({ id: 'demo', version: '1.2.0', zip: zipOf('demo', '1.2.0') });
  await env.manager.runUpdateRound();
  assert.equal(env.asked.length, 1, 'no install dialog');
  assert.equal(env.plugin('demo').version, '1.2.0');
  assert.match(env.notices.at(-1).body, /1\.0\.0에서 1\.2\.0\(으\)로 자동 업데이트했습니다/);
});

test('auto mode does not install a Hub update that asks for a new permission or moves the source; it is announced for review', async t => {
  const env = await setup(t, { answers: [0, 0], installed: [{ id: 'demo', version: '1.0.0' }] });
  await env.manager.setUpdateMode('demo', 'auto');
  env.fake.publish({ id: 'demo', version: '2.0.0', zip: zipOf('demo', '2.0.0', { workspace: true, source: { github: 'o/r', asset: 'demo.zip' } }) });
  await env.manager.runUpdateRound();
  assert.equal(env.plugin('demo').version, '1.0.0');
  assert.equal(env.plugin('demo').update.status, 'available');
  assert.match(env.plugin('demo').update.review.join('\n'), /새 권한: 이 PC의 프로젝트와 터미널/);
  assert.match(env.plugin('demo').update.review.join('\n'), /업데이트 출처가 바뀝니다: MoonerADE Hub → github\.com\/o\/r/);
  assert.match(env.notices.at(-1).body, /새 권한을 요청해 자동으로 설치하지 않았습니다/);
});

test('signed out: a Hub plugin says it needs the sign-in, the background round stays quiet, and a manual check explains', async t => {
  const env = await setup(t, { signedIn: false, installed: [{ id: 'demo', version: '1.0.0' }, { id: 'gh-only', version: '1.0.0', source: { github: 'o/r', asset: 'gh.zip' } }] });
  assert.equal(env.plugin('demo').update.status, 'needs-login');
  assert.equal(env.plugin('gh-only').update.status, 'idle', 'a GitHub plugin does not wait for the Hub');
  await env.manager.runUpdateRound();
  assert.equal(env.fake.requests.length, 0, 'the Hub was not asked');
  assert.deepEqual(env.notices, []);
  assert.deepEqual(env.warnings.filter(text => /demo/.test(text)), [], 'no warning every round');
  await assert.rejects(env.manager.checkUpdates('demo'), { code: 'NOT_SIGNED_IN' });
  await assert.rejects(env.manager.installFromHub('demo'), { code: 'NOT_SIGNED_IN' });
  assert.equal(env.manager.snapshot().hub.signedIn, false);
});

// A GitHub client that only counts what it is asked: a plugin the Hub serves must never reach it.
const spyGithub = () => { const calls = []; return { calls, latest: async (source, id) => { calls.push({ source, id }); throw Object.assign(new Error('GitHub 시험: 연결하지 않습니다'), { code: 'NETWORK' }); }, download: async () => { throw new Error('unused'); } }; };
const githubSource = { github: 'o/r', asset: 'demo.zip' };

test('signed in: a plugin the Hub serves (listed in its catalog or naming it) is updated from the Hub only, never from GitHub', async t => {
  const github = spyGithub();
  const env = await setup(t, { github, answers: [0], installed: [{ id: 'listed', version: '1.0.0', source: githubSource }, { id: 'both', version: '1.0.0', source: { ...githubSource, hub: true } }, { id: 'ghonly', version: '1.0.0', source: githubSource }] });
  env.fake.publish({ id: 'listed', version: '1.1.0', zip: zipOf('listed', '1.1.0') });
  env.fake.publish({ id: 'both', version: '1.0.0', zip: zipOf('both', '1.0.0') });
  // Before the Hub's list is known a plugin that only names GitHub shows what it names; the Hub-declared one is already the Hub's.
  assert.equal(env.plugin('both').update.source.kind, 'hub');
  await env.manager.runUpdateRound();
  assert.deepEqual(env.plugin('listed').update.source, { kind: 'hub' }, 'no github field: the page has nothing GitHub to show');
  assert.equal(env.plugin('listed').update.status, 'available');
  assert.equal(env.plugin('both').update.status, 'latest');
  assert.equal(env.plugin('ghonly').update.source.kind, 'github', 'the Hub does not serve it: GitHub as before');
  assert.deepEqual(github.calls.map(call => call.id), ['ghonly'], 'only the plugin the Hub does not serve went to GitHub');
  // Installing is the Hub's zip, and moving from a GitHub manifest to the Hub's is not "a change of source" for a plugin the Hub serves.
  await env.manager.installUpdate('listed');
  assert.match(env.asked[0].detail, /받은 곳: MoonerADE Hub/);
  assert.doesNotMatch(env.asked[0].detail, /업데이트 출처가 바뀝니다/);
  assert.equal(env.plugin('listed').version, '1.1.0');
});

test('signed in: automatic mode installs a Hub-served plugin that was installed from GitHub, without asking about the source', async t => {
  const github = spyGithub();
  const env = await setup(t, { github, answers: [0], installed: [{ id: 'listed', version: '1.0.0', source: githubSource }] });
  env.fake.publish({ id: 'listed', version: '1.2.0', zip: zipOf('listed', '1.2.0') });
  await env.manager.hubCatalog();
  await env.manager.setUpdateMode('listed', 'auto');
  assert.match(env.asked[0].detail, /MoonerADE Hub에 새 버전이 올라오면/);
  await env.manager.runUpdateRound({ hubOnly: true });
  assert.equal(env.asked.length, 1, 'no install dialog');
  assert.equal(env.plugin('listed').version, '1.2.0');
  assert.deepEqual(github.calls, []);
});

test('the Hub\'s list alone makes an update known (the dots), and the frequent round only asks about plugins the list shows as newer', async t => {
  const env = await setup(t, { installed: [{ id: 'demo', version: '1.0.0' }, { id: 'same', version: '2.0.0' }] });
  env.fake.publish({ id: 'demo', version: '1.1.0', zip: zipOf('demo', '1.1.0') });
  env.fake.publish({ id: 'same', version: '2.0.0', zip: zipOf('same', '2.0.0') });
  await env.manager.hubCatalog();
  assert.equal(env.plugin('demo').update.available, true);
  assert.equal(env.plugin('demo').update.latest, '1.1.0');
  assert.equal(env.plugin('demo').update.status, 'available');
  assert.equal(env.plugin('same').update.available, false);
  env.fake.requests.length = 0;
  await env.manager.runUpdateRound({ hubOnly: true });
  assert.deepEqual(env.fake.requests.map(request => request.path).sort(), ['/v1/plugins', '/v1/plugins/demo'], 'the list, and only the plugin with a newer version');
  assert.equal(env.plugin('same').update.status, 'latest');
});

test('signed out: a plugin that names both the Hub and GitHub goes back to GitHub; one that names only the Hub waits for the sign-in', async t => {
  const github = spyGithub();
  const env = await setup(t, { github, signedIn: false, installed: [{ id: 'both', version: '1.0.0', source: { ...githubSource, hub: true } }, { id: 'hubonly', version: '1.0.0' }] });
  assert.deepEqual(env.plugin('both').update.source, { kind: 'github', github: 'o/r', asset: 'demo.zip' });
  assert.equal(env.plugin('hubonly').update.status, 'needs-login');
  await env.manager.runUpdateRound();
  assert.deepEqual(github.calls.map(call => call.id), ['both']);
  assert.equal(env.fake.requests.length, 0, 'the Hub was not asked');
});

test('signed in with a Hub that cannot be read: a plugin that only names GitHub is not sent to GitHub in its place', async t => {
  const github = spyGithub();
  const env = await setup(t, { github, installed: [{ id: 'ghonly', version: '1.0.0', source: githubSource }] });
  env.fake.unavailable = true;
  await env.manager.runUpdateRound();
  assert.deepEqual(github.calls, []);
  await assert.rejects(env.manager.checkUpdates('ghonly'), { code: 'HUB_BUSY' });
  assert.deepEqual(github.calls, []);
});

test('signing in: the browser is sent to the Hub\'s page, the code is shown until it is approved, then the list and updates are fetched', async t => {
  const env = await setup(t, { signedIn: false, installed: [{ id: 'demo', version: '1.0.0' }] });
  env.fake.publish({ id: 'demo', version: '1.1.0', zip: zipOf('demo', '1.1.0') });
  const started = await env.manager.signInHub();
  assert.equal(started.hub.device.userCode, 'BCDF-GHJK');
  assert.equal(env.opened[0], `${env.fake.url}/enroll?code=BCDF-GHJK`);
  assert.match(started.message, /BCDF-GHJK/);
  assert.equal(started.hub.signedIn, false);
  const waiting = await env.manager.signInHub();
  assert.equal(env.opened.length, 2, 'asking again opens the same page');
  assert.equal(waiting.hub.device.userCode, 'BCDF-GHJK');
  assert.equal(env.fake.requests.filter(request => request.path === '/v1/enroll/start').length, 1);
  // The poll runs every interval (2 s here); the first answer is "approved".
  await until(() => env.manager.snapshot().hub.signedIn, 8000);
  const signed = env.manager.snapshot();
  assert.deepEqual({ account: signed.hub.account, device: signed.hub.device, error: signed.hub.error }, { account: '시험 계정', device: null, error: null });
  await until(() => env.plugin('demo').update.status === 'available', 5000);
  assert.equal(env.manager.snapshot().hub.catalog.plugins.length, 1, 'the list is fetched');
  const text = JSON.stringify(env.manager.snapshot());
  assert.ok(!text.includes(env.fake.access) && !text.includes(env.fake.refresh), 'no token in what the page gets');
});

test('cancelling a sign-in stops waiting for it; signing out forgets the session, the list and the Hub answers', async t => {
  const env = await setup(t, { signedIn: false, installed: [{ id: 'demo', version: '1.0.0' }] });
  env.fake.approval = 'manual';
  await env.manager.signInHub();
  const cancelled = env.manager.cancelHubSignIn();
  assert.equal(cancelled.hub.device, null);
  await sleep(2500);
  assert.equal(env.fake.requests.filter(request => request.path === '/v1/enroll/poll').length, 0, 'it stopped polling');
  env.fake.approval = 'auto';
  const start = await env.hub.deviceStart();
  await env.hub.devicePoll(start);
  env.fake.publish({ id: 'demo', version: '1.1.0', zip: zipOf('demo', '1.1.0') });
  await env.manager.hubCatalog({ force: true });
  await env.manager.checkUpdates('demo');
  assert.equal(env.plugin('demo').update.status, 'available');
  const out = await env.manager.signOutHub();
  assert.match(out.message, /시험 계정\)에서 로그아웃했습니다/);
  assert.equal(env.fake.signedOut, 1);
  assert.equal(out.hub.signedIn, false);
  assert.deepEqual(out.hub.catalog.plugins, []);
  assert.equal(env.plugin('demo').update.status, 'needs-login', 'the old answer is not shown as current');
});

test('a Hub that cannot be reached shows an error in the list; losing the account signs out with the reason', async t => {
  const env = await setup(t);
  env.fake.unavailable = true;
  const failed = await env.manager.hubCatalog();
  assert.equal(failed.hub.catalog.status, 'error');
  assert.match(failed.hub.catalog.error, /아직 준비하지 못했습니다/);
  assert.equal(failed.hub.signedIn, true, 'a busy Hub is not a sign-out');
  env.fake.unavailable = false;
  env.fake.revokeAll();
  const gone = await env.manager.hubCatalog({ force: true });
  assert.equal(gone.hub.signedIn, false);
  assert.match(gone.hub.error, /다시 로그인하세요/);
  assert.deepEqual(gone.hub.catalog.plugins, []);
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return; await sleep(50); } assert.fail('timed out waiting'); }
