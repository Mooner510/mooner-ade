import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRemoteUi, listFolders, REMOTE_PAGE_CSP } from '../apps/local-server/src/remote-ui.js';
import { withCtrl, TERMINAL_KEYS } from '../apps/web/src/mobile.ts';

async function bundle() {
  const root = await mkdtemp(path.join(tmpdir(), 'ade-remote-ui-'));
  const web = path.join(root, 'dist'), feedback = path.join(root, 'feedback');
  await mkdir(path.join(web, 'assets'), { recursive: true }); await mkdir(feedback);
  await writeFile(path.join(web, 'index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(path.join(web, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(path.join(web, 'assets', 'app.js.map'), '{}');
  await writeFile(path.join(root, 'secret.txt'), 'outside');
  await writeFile(path.join(feedback, 'shot.png'), Buffer.from([137, 80, 78, 71]));
  const ui = createRemoteUi({ webRoot: web, frame: { csp: "default-src 'none'; font-src data:; sandbox allow-scripts", html: '<p>frame</p>' }, feedbackFile: (id, name) => path.join(feedback, `${id}-${name}`.replace(/^item-/, '')) });
  return { root, ui };
}

test('the phone UI manifest lists the built files with hashes and the UI frame, never source maps', async t => {
  const { root, ui } = await bundle(); t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await ui.manifest();
  assert.deepEqual(manifest.files.map(file => file.path), ['/ade-ui-frame.html', '/assets/app.js', '/index.html']);
  assert.match(manifest.version, /^[0-9a-f]{16}$/);
  assert.equal(manifest.entry, '/index.html');
  assert.equal(manifest.csp, REMOTE_PAGE_CSP);
  assert.ok(manifest.files.every(file => /^[0-9a-f]{64}$/.test(file.hash) && file.size > 0));
  assert.equal((await ui.manifest()).version, manifest.version, 'unchanged files keep the version');
  await writeFile(path.join(root, 'dist', 'assets', 'app.js'), 'console.log(2)');
  assert.notEqual((await ui.manifest()).version, manifest.version, 'a rebuilt file changes it');
});

test('a phone UI file comes back base64 with its type; the entry page and the frame carry their CSP', async t => {
  const { root, ui } = await bundle(); t.after(() => rm(root, { recursive: true, force: true }));
  const page = await ui.file({ path: '/index.html' });
  assert.equal(Buffer.from(page.data, 'base64').toString(), '<!doctype html><div id="root"></div>');
  assert.equal(page.type, 'text/html; charset=utf-8');
  assert.equal(page.csp, REMOTE_PAGE_CSP);
  assert.match(REMOTE_PAGE_CSP, /connect-src 'none'/, 'the page itself never reaches the network');
  const script = await ui.file({ path: '/assets/app.js?v=1' });
  assert.equal(script.type, 'text/javascript'); assert.equal(script.csp, undefined); assert.equal(script.cache, 'immutable');
  const frame = await ui.file({ path: '/ade-ui-frame.html' });
  assert.equal(Buffer.from(frame.data, 'base64').toString(), '<p>frame</p>');
  assert.match(frame.csp, /font-src data: %ORIGIN%/);
  const shot = await ui.file({ path: '/feedback-file/item/shot.png?v=3' });
  assert.equal(shot.type, 'image/png'); assert.equal(shot.cache, 'none');
});

test('a phone UI file outside the bundle, a source map or a missing file is refused', async t => {
  const { root, ui } = await bundle(); t.after(() => rm(root, { recursive: true, force: true }));
  for (const wanted of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt', 'index.html', '/assets/app.js.map', '/a\0b', 42])
    await assert.rejects(ui.file({ path: wanted }), error => ['INVALID_PATH', 'NOT_FOUND'].includes(error.code), String(wanted));
  await assert.rejects(ui.file({ path: '/nope.js' }), { code: 'NOT_FOUND' });
});

test('without a built UI the manifest says so instead of failing obscurely', async () => {
  const ui = createRemoteUi({ webRoot: path.join(tmpdir(), 'ade-no-such-dist-' + process.pid), frame: { csp: '', html: '' }, feedbackFile: () => '' });
  await assert.rejects(ui.manifest(), { code: 'UI_UNAVAILABLE' });
});

test('the phone folder chooser lists subfolders, hidden ones last, and needs an absolute path', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ade-folders-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['b', '.git', 'A']) await mkdir(path.join(root, name));
  await writeFile(path.join(root, 'file.txt'), '');
  const listing = await listFolders({ path: root }, '/');
  assert.deepEqual(listing.folders, ['A', 'b', '.git']);
  assert.equal(listing.parent, path.dirname(root));
  assert.equal((await listFolders({}, root)).path, root, 'no path starts at the default');
  await assert.rejects(listFolders({ path: 'relative/dir' }, root), { code: 'INVALID_PATH' });
  await assert.rejects(listFolders({ path: path.join(root, 'missing') }, root), { code: 'NOT_FOUND' });
});

test('the terminal key row: sticky Ctrl turns the next key into its control code', () => {
  assert.equal(withCtrl('c'), '\x03'); assert.equal(withCtrl('C'), '\x03'); assert.equal(withCtrl('l'), '\x0c');
  assert.equal(withCtrl('['), '\x1b'); assert.equal(withCtrl(' '), '\x00'); assert.equal(withCtrl('?'), '\x7f');
  assert.equal(withCtrl('1'), '1', 'no control code: sent as typed'); assert.equal(withCtrl('\x1b[A'), '\x1b[A');
  assert.ok(TERMINAL_KEYS.some(key => key.ctrl) && TERMINAL_KEYS.every(key => key.ctrl || typeof key.data === 'string'));
});

test('a phone that asks for gzip gets text and the manifest compressed, with the hash of the plain bytes', async t => {
  const { gunzipSync } = await import('node:zlib');
  const { createHash } = await import('node:crypto');
  const { root, ui } = await bundle(); t.after(() => rm(root, { recursive: true, force: true }));
  const big = 'console.log("x");\n'.repeat(500);
  await writeFile(path.join(root, 'dist', 'assets', 'app.js'), big);
  const packed = await ui.manifest({ encoding: 'gzip' });
  assert.equal(packed.encoding, 'gzip');
  const listing = JSON.parse(gunzipSync(Buffer.from(packed.data, 'base64')).toString());
  assert.deepEqual(listing, await ui.manifest(), 'the same listing, compressed');
  const script = await ui.file({ path: '/assets/app.js', encoding: 'gzip' });
  assert.equal(script.encoding, 'gzip');
  const plain = gunzipSync(Buffer.from(script.data, 'base64'));
  assert.equal(plain.toString(), big);
  assert.equal(script.hash, createHash('sha256').update(plain).digest('hex'));
  assert.ok(script.data.length < Buffer.from(big).toString('base64').length / 4);
  assert.equal((await ui.file({ path: '/index.html', encoding: 'gzip' })).encoding, undefined, 'small files go as they are');
  assert.equal((await ui.file({ path: '/assets/app.js' })).encoding, undefined, 'only when asked: an older app reads plain base64');
});

test('the manifest names what the first screen needs: page files biggest first, then the icon font and the Latin fonts, never the Korean one', async t => {
  const { root, ui } = await bundle(); t.after(() => rm(root, { recursive: true, force: true }));
  const web = path.join(root, 'dist'), asset = name => path.join(web, 'assets', name);
  await writeFile(path.join(web, 'index.html'), '<!doctype html><script type="module" crossorigin src="/assets/app.js"></script><link rel="stylesheet" crossorigin href="/assets/app.css"><div id="root"></div>');
  await writeFile(asset('app.css'), [
    '@font-face{font-family:Material Symbols Outlined;src:url(/assets/icons.woff2) format("woff2")}',
    '@font-face{font-family:Inter Variable;src:url(/assets/inter-latin.woff2) format("woff2-variations");unicode-range:U+0000-00FF,U+0131}',
    '@font-face{font-family:Inter Variable;src:url(/assets/inter-greek.woff2) format("woff2-variations");unicode-range:U+0370-0377}',
    '@font-face{font-family:Noto Sans KR Variable;src:url(/assets/noto-latin.woff2) format("woff2-variations");unicode-range:U+0000-00FF}',
    '@font-face{font-family:Noto Sans KR Variable;src:url(/assets/noto-1.woff2) format("woff2-variations");unicode-range:U+AC00-AC7F}',
    'body{color:red}'
  ].join(''));
  for (const name of ['icons.woff2', 'inter-latin.woff2', 'inter-greek.woff2', 'noto-latin.woff2', 'noto-1.woff2']) await writeFile(asset(name), name);
  assert.deepEqual((await ui.manifest()).preload, ['/index.html', '/assets/app.css', '/assets/app.js', '/assets/inter-latin.woff2', '/assets/icons.woff2']);
});

test('gzipReply: the replay of a chat packs only when the phone asks, and unpacks to the same value', async () => {
  const { gzipReply } = await import('../apps/local-server/src/remote-ui.js');
  const { gunzipReply } = await import('../apps/web/src/transport.ts');
  const value = { events: Array.from({ length: 200 }, (_, seq) => ({ seq, text: '가나다 '.repeat(50) })), seq: 200 };
  assert.equal(await gzipReply(value, {}), value);
  const packed = await gzipReply(value, { encoding: 'gzip' });
  assert.equal(packed.encoding, 'gzip');
  assert.ok(packed.data.length < JSON.stringify(value).length / 4);
  assert.deepEqual(await gunzipReply(packed), value);
  assert.equal(await gunzipReply(value), value);
});

test('slimEvents: a phone keeps the previews of the last three images and a tool output up to its limit, and nothing else changes', async () => {
  const { slimEvents, MAX_RESULT } = await import('../apps/local-server/src/chat-replay.js');
  const events = [
    ...[1, 2, 3, 4, 5].map(seq => ({ seq, kind: 'user', text: `m${seq}`, images: 1, previews: [`data:image/jpeg;base64,${seq}`] })),
    { seq: 6, kind: 'tool_result', toolUseId: 't', content: 'x'.repeat(MAX_RESULT + 50), isError: false },
    { seq: 7, kind: 'tool_result', toolUseId: 'u', content: 'short' },
  ];
  const out = slimEvents(events);
  assert.deepEqual(out.map(event => Boolean(event.previews)), [false, false, true, true, true, false, false]);
  assert.equal(out[0].images, 1);
  assert.ok(out[5].content.length < MAX_RESULT + 40 && out[5].content.startsWith('x'.repeat(100)));
  assert.equal(out[6], events[6]);
  assert.equal(events[0].previews.length, 1);
});

test('the plugin contract lets a phone ask for gzip and slim, which the contract would otherwise drop', async () => {
  const { request } = await import('../apps/plugin-api/v1/workspace.js');
  assert.deepEqual(request('chat/open', { projectId: 'p', id: 'c', slim: true, encoding: 'gzip', other: 1 }), { projectId: 'p', id: 'c', slim: true, encoding: 'gzip' });
  for (const action of ['git/log', 'files/list', 'files/read', 'chat/sessions']) assert.equal(request(action, { projectId: 'p', encoding: 'gzip' }).encoding, 'gzip', action);
});

test('swipeClose: a long or quick swipe to the left closes the drawer, a short one springs back, a vertical one is a scroll', async () => {
  const { swipeClose } = await import('../apps/web/src/mobile.ts');
  const make = () => {
    const handlers = {}, nav = { style: {}, offsetWidth: 300 }, closed = [];
    const root = { addEventListener: (type, fn) => { handlers[type] = fn; }, removeEventListener: () => {}, setPointerCapture: () => {} };
    swipeClose(root, nav, () => closed.push(1));
    const event = (x, y, t) => ({ pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, timeStamp: t });
    const gesture = (points) => { handlers.pointerdown(event(...points[0])); for (const point of points.slice(1, -1)) handlers.pointermove(event(...point)); const last = points.at(-1); handlers.pointermove(event(...last)); handlers.pointerup(event(...last)); };
    return { nav, closed, gesture };
  };
  const slow = make(); slow.gesture([[250, 400, 0], [230, 402, 200], [210, 402, 400], [150, 402, 600]]);  // 100 of 300 px, slowly: not a third
  assert.equal(slow.closed.length, 0); assert.equal(slow.nav.style.transform, '');
  const far = make(); far.gesture([[300, 400, 0], [200, 401, 300], [150, 401, 600], [100, 401, 900]]);   // 200 px
  assert.equal(far.closed.length, 1);
  const flick = make(); flick.gesture([[250, 400, 0], [220, 400, 20], [190, 400, 40]]);                    // 60 px in 40 ms
  assert.equal(flick.closed.length, 1);
  const scroll = make(); scroll.gesture([[250, 400, 0], [248, 440, 50], [240, 520, 100], [100, 600, 150]]);
  assert.equal(scroll.closed.length, 0); assert.equal(scroll.nav.style.transform ?? '', '');
});
