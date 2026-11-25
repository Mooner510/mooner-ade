import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// The real updater (apps/desktop/src/updater.js, Windows paths) against a fake GitHub: which release it offers, which zip it takes, and that every way a
// download can go wrong leaves the installed app and the temp folder as they were. `electron` is a stand-in (fixtures/electron-hooks.mjs), prompts are
// answered by the test. Only "종료할 때 업데이트" is used to stage a package, so the helper that replaces the files is never started here
// (scripts/verify/t-update-win.mjs runs that part for real).
const windows = process.platform === 'win32';
const skip = !windows;
const ASSET = 'MoonerADE-win32-x64.zip', APP_ASSET = 'MoonerADE-win32-x64-app.zip', MANIFEST = 'MoonerADE-win32-x64.json';
const SHELL = 'a'.repeat(64), OTHER_SHELL = 'b'.repeat(64);
const PROMPT_NOW = '지금 업데이트', PROMPT_ON_QUIT = '종료할 때 업데이트', PROMPT_LATER = '나중에';

let sandbox = '', scratch = '', zips = null, counter = 0;
const realExecPath = process.execPath, savedWarn = console.warn, saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, ADE_UPDATE_URL: process.env.ADE_UPDATE_URL };

if (windows) {
  register('./fixtures/electron-hooks.mjs', import.meta.url);
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ade-update-flow-')));
  scratch = path.join(sandbox, 'scratch');
  fs.mkdirSync(scratch);
  // The updater's own temp folders (os.tmpdir() is read on every call) land here, where the tests can look at them.
  process.env.TEMP = process.env.TMP = scratch;
  console.warn = () => {}; // the manifest fallback logs a warning on purpose
  const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
  const zip = (name, folder, files) => {
    const source = path.join(sandbox, 'src', name);
    for (const [file, text] of Object.entries(files)) { const target = path.join(source, folder, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
    const out = path.join(sandbox, `${name}.zip`);
    execFileSync(tar, ['-a', '-c', '-f', out, '-C', source, folder]);
    return fs.readFileSync(out);
  };
  const app = { 'package.json': '{"name":"mooner-ade"}', 'apps/desktop/src/main.js': '// new\n' };
  zips = {
    app: zip('app', 'app', app),
    // The updater looks for the running executable's name inside a full bundle; under test that is node's.
    full: zip('full', 'MoonerADE-win32-x64', { [path.basename(process.execPath)]: 'exe', ...Object.fromEntries(Object.entries(app).map(([file, text]) => [`resources/app/${file}`, text])) }),
    wrongLayout: zip('wrong', 'something-else', { 'readme.txt': 'not an app' }),
  };
}
test.after(() => {
  console.warn = savedWarn;
  process.execPath = realExecPath;
  for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value;
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const sha = body => `sha256:${createHash('sha256').update(body).digest('hex')}`;

// A release as GitHub lists it. `files` maps an asset name to what it holds: { body, serve? (sent instead of body), status? (answers with it), cut? (drops the connection half way) }.
const release = (tag, { shell = SHELL, files, ...extra } = {}) => ({
  tag, prerelease: tag.includes('-'), draft: false,
  files: files ?? { [ASSET]: { body: zips.full }, [APP_ASSET]: { body: zips.app }, [MANIFEST]: { body: Buffer.from(JSON.stringify({ version: tag.replace(/^v/, ''), shell })) } },
  ...extra,
});

async function fakeGithub(t, releases, { delayMs = 0 } = {}) {
  const state = { releases, requests: [], apiStatus: 0, apiBody: null, webStatus: 0, delayMs };
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof value === 'string' ? value : JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    state.requests.push(req.url);
    const url = new URL(req.url, 'http://x');
    // github.com's own pages: the redirect of /releases/latest and the atom feed (neither counts against the API's rate limit).
    if (url.pathname === '/Mooner510/mooner-ade/releases/latest' || url.pathname === '/Mooner510/mooner-ade/releases.atom') {
      if (state.webStatus) { res.writeHead(state.webStatus); res.end(); return; }
      const published = state.releases.filter(item => !item.draft);
      if (url.pathname.endsWith('.atom')) { res.writeHead(200, { 'content-type': 'application/atom+xml' }); res.end(`<feed>${published.map(item => `<entry><link rel="alternate" type="text/html" href="https://github.com/Mooner510/mooner-ade/releases/tag/${item.tag}"/></entry>`).join('')}</feed>`); return; }
      const latest = published.find(item => !item.prerelease);
      res.writeHead(latest ? 302 : 200, latest ? { location: `https://github.com/Mooner510/mooner-ade/releases/tag/${latest.tag}` } : {}); res.end(); return;
    }
    if (url.pathname.startsWith('/repos/Mooner510/mooner-ade/releases')) {
      if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
      if (state.apiStatus) return json(res, state.apiStatus, { message: 'API rate limit exceeded' });
      if (state.apiBody !== null) return json(res, 200, state.apiBody);
      const base = `http://127.0.0.1:${server.address().port}`;
      const shape = item => ({ tag_name: item.tag, draft: item.draft, prerelease: item.prerelease, assets: Object.entries(item.files).map(([name, file]) => ({ name, size: file.body.length, digest: sha(file.body), browser_download_url: `${base}/assets/${item.tag}/${name}` })) });
      // /releases/latest is the newest published release that is neither a draft nor a prerelease; the list holds all of them.
      if (url.pathname.endsWith('/latest')) { const latest = state.releases.find(item => !item.draft && !item.prerelease); return latest ? json(res, 200, shape(latest)) : json(res, 404, { message: 'Not Found' }); }
      return json(res, 200, state.releases.map(shape));
    }
    const [, , tag, name] = url.pathname.split('/'), file = state.releases.find(item => item.tag === tag)?.files[decodeURIComponent(name ?? '')];
    if (!file) { res.writeHead(404); res.end(); return; }
    if (file.status) { res.writeHead(file.status); res.end(); return; }
    const sent = file.serve ?? file.body;
    res.writeHead(200, { 'content-length': file.body.length });
    if (file.cut) { res.write(sent.subarray(0, Math.floor(sent.length / 2))); setTimeout(() => res.socket.destroy(), 50); return; }
    res.end(sent);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return Object.assign(state, { url: `http://127.0.0.1:${server.address().port}`, stop: () => { server.closeAllConnections(); server.close(); } });
}

// One installed app (its own folder, version and shell key) with a fresh copy of updater.js, which keeps its state (declined versions, a staged update) per copy.
async function setup(t, { current, beta = false, releases, shell = SHELL, answer = () => 2, getBusy = async () => ({ busy: false, reasons: [] }), delayMs = 0 }) {
  const id = ++counter, root = path.join(sandbox, `install-${id}`), appPath = path.join(root, 'resources', 'app');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, 'package.json'), JSON.stringify({ name: 'mooner-ade', version: current }));
  fs.writeFileSync(path.join(appPath, 'old.txt'), 'old files stay while nothing was installed');
  if (shell) { fs.mkdirSync(path.join(root, 'resources', 'runtime'), { recursive: true }); fs.writeFileSync(path.join(root, 'resources', 'runtime', 'runtime.json'), JSON.stringify({ shell })); }
  // A full update goes into the folder of the running executable: each case gets its own, writable like an installation of the user's.
  process.execPath = path.join(root, path.basename(realExecPath));
  const github = await fakeGithub(t, releases, { delayMs });
  const electron = globalThis.__adeElectron = { version: current, appPath, messages: [], errors: [], quits: 0, onMessage: options => answer(options, electron, github) };
  process.env.ADE_UPDATE_URL = github.url;
  const updater = await import(`../apps/desktop/src/updater.js?case=${id}`);
  const check = (extra = {}) => updater.checkForUpdate({ repo: 'Mooner510/mooner-ade', asset: ASSET, window: null, beta, manual: false, getBusy, beforeRestart: () => {}, ...extra });
  const tree = () => fs.readdirSync(root, { recursive: true }).sort().map(name => { const file = path.join(root, name); return `${name}:${fs.statSync(file).isFile() ? sha(fs.readFileSync(file)) : 'dir'}`; });
  return { check, github, electron, updater, root, before: tree(), tree };
}
const button = label => options => options.buttons.indexOf(label);
const prompts = electron => electron.messages.filter(options => options.buttons?.includes(PROMPT_LATER));
const updateDirs = () => fs.readdirSync(scratch).filter(name => name.startsWith('mooner-update-'));
const zipRequests = github => github.requests.filter(url => url.startsWith('/assets/') && url.endsWith('.zip'));

test('a stable 0.5.12 is offered 0.6.0, never 0.6.0-beta5, and nothing is downloaded before the user answers', { skip }, async t => {
  const ctx = await setup(t, { current: '0.5.12', releases: [release('v0.6.0'), release('v0.6.0-beta5'), release('v0.5.12')], answer: button(PROMPT_LATER) });
  assert.equal(await ctx.check(), 'declined');
  const [prompt] = prompts(ctx.electron);
  assert.match(prompt.message, /^새 버전 0\.6\.0을 사용할 수 있습니다\.$/);
  assert.match(prompt.detail, /현재 버전은 0\.5\.12입니다/);
  assert.ok(ctx.github.requests.includes('/repos/Mooner510/mooner-ade/releases/latest'), 'the stable channel asks for the latest release only');
  assert.ok(!ctx.github.requests.some(url => url.includes('per_page')), 'and never reads the list that holds the betas');
  assert.deepEqual(zipRequests(ctx.github), []);
});

test('before 0.6.0 is published a stable user hears nothing about 0.6.0-beta5', { skip }, async t => {
  const ctx = await setup(t, { current: '0.5.12', releases: [release('v0.6.0-beta5'), release('v0.5.12')] });
  assert.equal(await ctx.check(), 'latest');
  assert.equal(ctx.electron.messages.length, 0);
});

test('a beta tag that was published as an ordinary release is still kept from the stable channel', { skip }, async t => {
  const ctx = await setup(t, { current: '0.5.12', releases: [release('v0.6.0-beta5', { prerelease: false }), release('v0.5.12')] });
  assert.equal(await ctx.check(), 'latest');
  assert.equal(ctx.electron.messages.length, 0);
});

test('a manual check says so when this version is the newest', { skip }, async t => {
  const ctx = await setup(t, { current: '0.5.12', releases: [release('v0.5.12')], answer: button('확인') });
  assert.equal(await ctx.check({ manual: true }), 'latest');
  assert.match(ctx.electron.messages[0].message, /최신 버전을 사용 중입니다/);
  assert.match(ctx.electron.messages[0].detail, /0\.5\.12/);
});

test('a 0.6.0-beta5 user is taken up to 0.6.0 on either channel', { skip }, async t => {
  for (const beta of [false, true]) {
    const ctx = await setup(t, { current: '0.6.0-beta5', beta, releases: [release('v0.6.0'), release('v0.6.0-beta5')], answer: button(PROMPT_LATER) });
    assert.equal(await ctx.check(), 'declined', `beta=${beta}`);
    assert.match(prompts(ctx.electron)[0].message, /새 버전 0\.6\.0을/, `beta=${beta}`);
  }
});

test('the beta channel offers the newest prerelease, but a stable release outranks its betas', { skip }, async t => {
  const newestBeta = await setup(t, { current: '0.6.0-beta5', beta: true, releases: [release('v0.6.0-beta6'), release('v0.6.0-beta5')], answer: button(PROMPT_LATER) });
  await newestBeta.check();
  assert.match(prompts(newestBeta.electron)[0].message, /^새 베타 버전 0\.6\.0-beta6을/);
  assert.ok(newestBeta.github.requests.some(url => url.includes('per_page')));
  const stable = await setup(t, { current: '0.5.12', beta: true, releases: [release('v0.6.0-beta5'), release('v0.6.0'), release('v0.5.12')], answer: button(PROMPT_LATER) });
  await stable.check();
  assert.match(prompts(stable.electron)[0].message, /^새 버전 0\.6\.0을/);
  const optedIn = await setup(t, { current: '0.5.12', beta: true, releases: [release('v0.6.0-beta5'), release('v0.5.12')], answer: button(PROMPT_LATER) });
  await optedIn.check();
  assert.match(prompts(optedIn.electron)[0].message, /^새 베타 버전 0\.6\.0-beta5을/, 'someone who turned betas on is offered the beta');
});

test('an older or equal release is never offered, and a draft is ignored', { skip }, async t => {
  for (const [current, beta, releases] of [
    ['0.6.0', false, [release('v0.5.12')]],
    ['0.6.0', true, [release('v0.6.0-beta5'), release('v0.5.12')]],
    ['0.6.0', true, [release('v0.6.0')]],
    ['0.6.0-beta5', true, [release('v0.6.0-beta5')]],
    ['0.6.0-beta5', true, [release('v0.6.0-beta4')]],
    ['0.5.12', true, [release('v0.6.0', { draft: true }), release('v0.5.12')]],
  ]) {
    const ctx = await setup(t, { current, beta, releases });
    assert.equal(await ctx.check(), 'latest', `${current} beta=${beta} ${releases.map(item => item.tag)}`);
    assert.equal(ctx.electron.messages.length, 0);
  }
});

test('a release whose zips are not uploaded yet is not offered (the workflow publishes the release before the builds finish)', { skip }, async t => {
  const empty = await setup(t, { current: '0.5.12', releases: [release('v0.6.0', { files: {} }), release('v0.5.12')] });
  assert.equal(await empty.check(), 'latest');
  const macOnly = await setup(t, { current: '0.5.12', releases: [release('v0.6.0', { files: { 'MoonerADE-darwin-arm64.zip': { body: zips.full } } }), release('v0.5.12')] });
  assert.equal(await macOnly.check(), 'latest');
  assert.equal(macOnly.electron.messages.length + empty.electron.messages.length, 0);
  const fullOnly = await setup(t, { current: '0.5.12', releases: [release('v0.6.0', { files: { [ASSET]: { body: zips.full } } })], answer: button(PROMPT_LATER) });
  assert.equal(await fullOnly.check(), 'declined', 'the full zip alone is enough to offer it');
});

// ---- which zip --------------------------------------------------------------------------------------------------------------------------------------------

// Takes the update on quit and returns what was fetched; the staged update is dropped again from the settings button.
async function fetchedFor(t, options) {
  const ctx = await setup(t, { current: '0.5.12', answer: button(PROMPT_ON_QUIT), ...options });
  assert.equal(await ctx.check(), 'staged');
  const fetched = zipRequests(ctx.github).map(url => url.split('/').pop()), manifestAsked = ctx.github.requests.some(url => url.endsWith(MANIFEST));
  ctx.electron.onMessage = button('받지 않기');
  assert.equal(await ctx.check({ manual: true }), 'declined');
  assert.deepEqual(updateDirs(), [], 'dropping the staged update removes its scratch folder');
  return { fetched, manifestAsked, ctx };
}

test('the app-only zip is taken when the manifest names the installed shell, the full zip in every other case', { skip }, async t => {
  assert.deepEqual((await fetchedFor(t, { releases: [release('v0.6.0')] })).fetched, [APP_ASSET]);
  assert.deepEqual((await fetchedFor(t, { releases: [release('v0.6.0', { shell: OTHER_SHELL })] })).fetched, [ASSET], 'a new Electron/Node means a full update');
  const noRuntime = await fetchedFor(t, { releases: [release('v0.6.0')], shell: null });
  assert.deepEqual(noRuntime.fetched, [ASSET], 'a build that predates app-only updates has no shell key');
  assert.equal(noRuntime.manifestAsked, false, 'and does not even fetch the manifest');
  const withFiles = (extra, manifest) => release('v0.6.0', { files: { [ASSET]: { body: zips.full }, [APP_ASSET]: { body: zips.app }, ...extra, ...manifest !== undefined && { [MANIFEST]: manifest } } });
  assert.deepEqual((await fetchedFor(t, { releases: [withFiles({}, { body: Buffer.from('{ not json') })] })).fetched, [ASSET], 'an unreadable manifest');
  assert.deepEqual((await fetchedFor(t, { releases: [withFiles({}, { body: Buffer.from(JSON.stringify({ version: '0.5.99', shell: SHELL })) })] })).fetched, [ASSET], 'a manifest of another version');
  assert.deepEqual((await fetchedFor(t, { releases: [withFiles({}, { body: Buffer.from(JSON.stringify({ version: '0.6.0', shell: SHELL })), status: 404 })] })).fetched, [ASSET], 'a manifest that cannot be fetched');
  assert.deepEqual((await fetchedFor(t, { releases: [withFiles({}, { body: Buffer.from(JSON.stringify({ version: '0.6.0', shell: SHELL })), serve: Buffer.from(JSON.stringify({ version: '0.6.0', shell: OTHER_SHELL })) })] })).fetched, [ASSET], 'a manifest whose hash does not match');
  assert.deepEqual((await fetchedFor(t, { releases: [release('v0.6.0', { files: { [ASSET]: { body: zips.full }, [MANIFEST]: { body: Buffer.from(JSON.stringify({ version: '0.6.0', shell: SHELL })) } } })] })).fetched, [ASSET], 'no app-only zip');
});

// ---- failures leave the app as it was -----------------------------------------------------------------------------------------------------------------

// The download goes wrong in the given way: an error box, no restart, nothing left in the temp folder, the install folder untouched and nothing staged.
async function failsCleanly(t, label, releases, { prepare, expect = /업데이트하지 못했습니다/, shell = null } = {}) {
  const ctx = await setup(t, { current: '0.5.12', releases, answer: button(PROMPT_ON_QUIT), shell });
  const restore = prepare?.(ctx);
  try { assert.equal(await ctx.check(), 'error', label); } finally { restore?.(); }
  assert.equal(ctx.electron.errors.length, 1, `${label}: one error box`);
  assert.match(ctx.electron.errors[0].content, expect, label);
  assert.equal(ctx.electron.quits, 0, `${label}: the app is not quit`);
  assert.deepEqual(updateDirs(), [], `${label}: scratch folder removed`);
  assert.deepEqual(ctx.tree(), ctx.before, `${label}: installed files untouched`);
  assert.equal(await ctx.updater.applyStagedUpdate(), false, `${label}: nothing is waiting to be installed`);
  return ctx;
}

test('a download whose sha256 differs from the release is refused', { skip }, async t => {
  const body = zips.full, bad = Buffer.from(body); bad[bad.length - 1] ^= 0xff;
  const ctx = await failsCleanly(t, 'sha256', [release('v0.6.0', { files: { [ASSET]: { body, serve: bad } } })], { expect: /해시가 릴리스와 다릅니다/ });
  // The same session recovers once the release is fixed (the lock of "one check at a time" was let go). The timer waits ten minutes after a failure, the settings button does not.
  ctx.github.releases[0].files[ASSET].serve = undefined;
  ctx.electron.onMessage = button(PROMPT_ON_QUIT);
  assert.equal(await ctx.check(), 'error', 'the timer is held back for now');
  assert.equal(await ctx.check({ manual: true }), 'staged');
  ctx.electron.onMessage = button('받지 않기');
  assert.equal(await ctx.check({ manual: true }), 'declined');
});

test('HTTP errors, a dropped connection and a vanished server leave the app alone', { skip }, async t => {
  await failsCleanly(t, 'HTTP 404', [release('v0.6.0', { files: { [ASSET]: { body: zips.full, status: 404 } } })], { expect: /HTTP 404/ });
  await failsCleanly(t, 'HTTP 500', [release('v0.6.0', { files: { [ASSET]: { body: zips.full, status: 500 } } })], { expect: /HTTP 500/ });
  await failsCleanly(t, 'cut half way', [release('v0.6.0', { files: { [ASSET]: { body: zips.full, cut: true } } })], { expect: /네트워크 연결이 끊겼/ });
  await failsCleanly(t, 'server gone after the prompt', [release('v0.6.0')], { expect: /네트워크 연결이 끊겼/, prepare: ctx => { const answer = ctx.electron.onMessage; ctx.electron.onMessage = options => { const choice = answer(options); ctx.github.stop(); return choice; }; } });
});

test('a disk that fills up while downloading leaves the app alone', { skip }, async t => {
  const { Writable } = await import('node:stream');
  await failsCleanly(t, 'ENOSPC', [release('v0.6.0')], {
    expect: /디스크 공간이 부족합니다/,
    prepare() {
      const create = fs.createWriteStream;
      fs.createWriteStream = () => new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })); } });
      return () => { fs.createWriteStream = create; };
    },
  });
});

test('a zip that is not an update is refused after the download, with the same cleanup', { skip }, async t => {
  await failsCleanly(t, 'wrong layout', [release('v0.6.0', { files: { [ASSET]: { body: zips.wrongLayout } } })], { expect: /업데이트 파일 구성이 올바르지 않습니다/ });
  await failsCleanly(t, 'app zip with a full-zip layout', [release('v0.6.0', { files: { [ASSET]: { body: zips.full }, [APP_ASSET]: { body: zips.full }, [MANIFEST]: { body: Buffer.from(JSON.stringify({ version: '0.6.0', shell: SHELL })) } } })], { expect: /업데이트 파일 구성이 올바르지 않습니다/, shell: SHELL });
  await failsCleanly(t, 'not a zip at all', [release('v0.6.0', { files: { [ASSET]: { body: Buffer.from('this is not a zip') } } })]);
});

test('a failing release lookup throws for the timer and is explained to the settings button', { skip }, async t => {
  for (const [label, prepare, expected] of [
    ['rate limit', github => { github.apiStatus = 403; }, /HTTP 403/],
    ['server error', github => { github.apiStatus = 500; }, /HTTP 500/],
    ['garbage', github => { github.apiBody = '<html>'; }, /./],
  ]) {
    const quiet = await setup(t, { current: '0.5.12', releases: [release('v0.6.0')] });
    prepare(quiet.github);
    await assert.rejects(quiet.check(), expected, `${label}: the timer's check reports it`);
    assert.equal(quiet.electron.messages.length, 0, `${label}: no dialog out of the blue`);
    const manual = await setup(t, { current: '0.5.12', releases: [release('v0.6.0')], answer: button('확인') });
    prepare(manual.github);
    assert.equal(await manual.check({ manual: true }), 'error', label);
    assert.match(manual.electron.messages[0].message, /업데이트를 확인하지 못했습니다/, label);
  }
  const offline = await setup(t, { current: '0.5.12', releases: [release('v0.6.0')], answer: button('확인') });
  offline.github.stop();
  assert.equal(await offline.check({ manual: true }), 'error');
  assert.match(offline.electron.messages[0].message, /업데이트를 확인하지 못했습니다/);
  assert.equal(offline.electron.quits, 0);
});

// ---- later, declined, duplicates ----------------------------------------------------------------------------------------------------------------------

test('"나중에" is not asked again by the timer until the app restarts, a manual check asks again, a newer version is asked at once', { skip }, async t => {
  const ctx = await setup(t, { current: '0.5.12', releases: [release('v0.6.0')], answer: button(PROMPT_LATER) });
  assert.equal(await ctx.check(), 'declined');
  const askedFirst = ctx.github.requests.length;
  assert.equal(await ctx.check(), 'declined');
  assert.equal(prompts(ctx.electron).length, 1, 'the second background check is silent');
  assert.deepEqual(ctx.github.requests.slice(askedFirst), ['/repos/Mooner510/mooner-ade/releases/latest'], 'and does not even fetch the manifest');
  assert.equal(await ctx.check({ manual: true }), 'declined');
  assert.equal(prompts(ctx.electron).length, 2, 'the settings button asks again');
  ctx.github.releases.unshift(release('v0.6.1'));
  assert.equal(await ctx.check(), 'declined');
  assert.equal(prompts(ctx.electron).length, 3);
  assert.match(prompts(ctx.electron)[2].message, /0\.6\.1/);
  assert.deepEqual(zipRequests(ctx.github), []);
  const restarted = await setup(t, { current: '0.5.12', releases: [release('v0.6.0')], answer: button(PROMPT_LATER) });
  await restarted.check();
  assert.equal(prompts(restarted.electron).length, 1, 'a fresh app asks about it again');
});

test('a second check while one runs does nothing, and an update taken on quit is neither asked nor fetched twice', { skip }, async t => {
  const slow = await setup(t, { current: '0.5.12', releases: [release('v0.6.0')], answer: button(PROMPT_LATER), delayMs: 300 });
  const [first, second] = await Promise.all([slow.check(), slow.check()]);
  assert.deepEqual([first, second].sort(), ['declined', 'updating']);
  assert.equal(prompts(slow.electron).length, 1);

  const ctx = await setup(t, { current: '0.5.12', releases: [release('v0.6.0')], answer: button(PROMPT_ON_QUIT) });
  assert.equal(await ctx.check(), 'staged');
  assert.equal(updateDirs().length, 1, 'the package waits on disk');
  assert.match(ctx.electron.messages.at(-1).message, /v0\.6\.0을 받아 두었습니다/);
  const requests = ctx.github.requests.length;
  assert.equal(await ctx.check(), 'staged', 'the timer does not offer it again');
  assert.equal(ctx.github.requests.length, requests, 'and makes no request at all');
  assert.equal(prompts(ctx.electron).length, 1);
  ctx.electron.onMessage = button('종료할 때까지 대기');
  assert.equal(await ctx.check({ manual: true }), 'staged');
  assert.equal(updateDirs().length, 1, 'waiting keeps the package');
  ctx.electron.onMessage = button('받지 않기');
  assert.equal(await ctx.check({ manual: true }), 'declined');
  assert.deepEqual(updateDirs(), []);
  assert.equal(await ctx.check(), 'declined', 'a dropped update is not offered again by the timer');
  assert.equal(await ctx.updater.applyStagedUpdate(), false);
});

test('"지금 업데이트" with work running asks first, and "취소" leaves everything as it was', { skip }, async t => {
  const busy = { busy: true, reasons: [{ project: 'p', terminal: 't', kind: 'turn', agent: 'claude' }] };
  const ctx = await setup(t, { current: '0.5.12', releases: [release('v0.6.0')], getBusy: async () => busy, answer: options => options.buttons.includes(PROMPT_NOW) ? options.buttons.indexOf(PROMPT_NOW) : options.buttons.indexOf('취소') });
  assert.equal(await ctx.check(), 'declined');
  const [prompt, confirm] = ctx.electron.messages;
  assert.equal(prompt.type, 'warning');
  assert.match(prompt.detail, /Claude가 작업 중/);
  assert.match(confirm.message, /중단해도 괜찮습니까/);
  assert.deepEqual(zipRequests(ctx.github), [], 'nothing was fetched before the answer');
  assert.equal(ctx.electron.quits, 0);
  assert.deepEqual(ctx.tree(), ctx.before);
});

test('an install folder the helper could not write to is reported before anything is downloaded', { skip }, async t => {
  for (const [label, release_] of [['app-only', release('v0.6.0')], ['full', release('v0.6.0', { shell: OTHER_SHELL })]]) {
    const ctx = await setup(t, { current: '0.5.12', releases: [release_], answer: button(PROMPT_ON_QUIT) });
    // The folder the new files would go into is gone: what a folder without write access looks like to the probe, which cannot create a file in it.
    fs.rmSync(label === 'full' ? ctx.root : path.join(ctx.root, 'resources', 'app'), { recursive: true });
    assert.equal(await ctx.check(), 'error', label);
    assert.deepEqual(zipRequests(ctx.github), [], `${label}: no zip was fetched`);
    assert.equal(ctx.electron.errors.length, 1);
    assert.match(ctx.electron.errors[0].content, /폴더에 쓸 수 없어 업데이트를 설치할 수 없습니다/, label);
    assert.match(ctx.electron.errors[0].content, /지금 쓰는 버전은 그대로 사용할 수 있습니다/, label);
    assert.equal(ctx.electron.quits, 0);
    assert.deepEqual(updateDirs(), []);
  }
});

// ---- a release that cannot be installed, and the version the quit question names ---------------------------------------------------------------------------

test('an update that keeps failing is asked about less and less, then left alone until the settings button or a newer version', { skip }, async t => {
  const clock = { now: Date.UTC(2026, 10, 20) }, minutes = count => count * 60_000;
  t.mock.method(Date, 'now', () => clock.now);
  const body = zips.full, bad = Buffer.from(body); bad[bad.length - 1] ^= 0xff;
  const ctx = await setup(t, { current: '0.5.12', releases: [release('v0.6.0', { files: { [ASSET]: { body, serve: bad } } })], answer: button(PROMPT_ON_QUIT), shell: null });
  const state = () => [prompts(ctx.electron).length, ctx.electron.errors.length, zipRequests(ctx.github).length];
  const later = async (after, extra) => { clock.now += minutes(after); return ctx.check(extra); };

  assert.equal(await ctx.check(), 'error');
  assert.deepEqual(state(), [1, 1, 1], 'asked, downloaded, refused');
  assert.equal(await later(5), 'error');
  assert.deepEqual(state(), [1, 1, 1], 'the next tick, five minutes on, neither asks nor downloads');
  assert.equal(await later(6), 'error');
  assert.deepEqual(state(), [2, 2, 2], 'ten minutes after the failure it asks again, and fails again');
  assert.equal(await later(30), 'error');
  assert.equal(await later(29), 'error');
  assert.deepEqual(state(), [2, 2, 2], 'now an hour is waited');
  assert.equal(await later(2), 'error');
  assert.deepEqual(state(), [3, 3, 3], 'an hour after the second failure it asks a last time');
  assert.equal(await later(60 * 24), 'error');
  assert.equal(await later(60 * 24 * 7), 'error');
  assert.deepEqual(state(), [3, 3, 3], 'after the third failure the timer leaves it alone, for days');

  // The settings button always tries again (and a manual attempt that fails counts like any other).
  assert.equal(await later(1, { manual: true }), 'error');
  assert.deepEqual(state(), [4, 4, 4]);
  assert.equal(await later(60), 'error');
  assert.deepEqual(state(), [4, 4, 4], 'the manual attempt did not bring the timer back');

  // A newer release is another version: asked at once, and this one downloads.
  ctx.github.releases.unshift(release('v0.6.1'));
  assert.equal(await later(1), 'staged');
  assert.match(prompts(ctx.electron).at(-1).message, /0\.6\.1/);
  assert.deepEqual(state(), [5, 4, 5]);
  assert.equal(ctx.updater.stagedUpdateVersion(), '0.6.1', 'the quit question is worded after the update that is waiting');
  ctx.electron.onMessage = button('받지 않기');
  assert.equal(await ctx.check({ manual: true }), 'declined');
  assert.equal(ctx.updater.stagedUpdateVersion(), null);
  assert.deepEqual(updateDirs(), []);
});

test('a check that finds nothing new, or a version turned down, does not touch api.github.com; an unreadable web page falls back to the API', { skip }, async t => {
  for (const beta of [false, true]) {
    const ctx = await setup(t, { current: '0.6.0', beta, releases: [release('v0.6.0')] });
    assert.equal(await ctx.check(), 'latest');
    assert.ok(!ctx.github.requests.some(url => url.startsWith('/repos/')), `no API request (beta ${beta})`);
  }
  const later = await setup(t, { current: '0.5.12', releases: [release('v0.6.0')], answer: button(PROMPT_LATER) });
  assert.equal(await later.check(), 'declined');
  const apiCalls = later.github.requests.filter(url => url.startsWith('/repos/')).length;
  assert.equal(await later.check(), 'declined');
  assert.equal(later.github.requests.filter(url => url.startsWith('/repos/')).length, apiCalls, 'the second timer check never reaches the API');
  const fallback = await setup(t, { current: '0.5.12', releases: [release('v0.6.0')], answer: button(PROMPT_LATER) });
  fallback.github.webStatus = 500;
  assert.equal(await fallback.check(), 'declined');
  assert.ok(fallback.github.requests.some(url => url.startsWith('/repos/')), 'the API answers when the web page cannot');
});
