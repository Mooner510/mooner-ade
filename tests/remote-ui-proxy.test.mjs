// The remote window's page server (apps/desktop/src/remote-ui-proxy.js) against the real host side (local-server/src/remote-ui.js).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRemoteUi, REMOTE_PAGE_CSP } from '../apps/local-server/src/remote-ui.js';
import { createUiProxy } from '../apps/desktop/src/remote-ui-proxy.js';

const ORIGIN = 'ade-remote://abc';
function host(t, { tamper = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ade-remote-ui-'));
  const web = path.join(dir, 'web'), cache = path.join(dir, 'cache'), shots = path.join(dir, 'shots');
  mkdirSync(path.join(web, 'assets'), { recursive: true }); mkdirSync(shots);
  writeFileSync(path.join(web, 'index.html'), '<!doctype html><script type="module" src="/assets/app.js"></script>');
  writeFileSync(path.join(web, 'assets/app.js'), 'console.log("한글 ".repeat(400))');
  writeFileSync(path.join(web, 'assets/font.woff2'), Buffer.from([1, 2, 3, 4]));
  writeFileSync(path.join(shots, 'a.png'), Buffer.from([9, 9, 9]));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ui = createRemoteUi({ webRoot: web, frame: { csp: "default-src 'none'; font-src data:", html: '<html>frame</html>' }, feedbackFile: (id, name) => path.join(shots, name) });
  const calls = [];
  const link = { async call(action, input) {
    calls.push([action, input?.path ?? null]);
    if (action === 'ui/manifest') return ui.manifest(input);
    if (action === 'ui/file') { const reply = await ui.file(input); return tamper ? tamper(reply, input) : reply; }
    throw Object.assign(new Error('x'), { code: 'REMOTE_FORBIDDEN' });
  } };
  return { dir, cache, link, calls };
}
const text = response => response.body.toString('utf8');

test('the page and its files come from the other PC with the CSP of the manifest, and are cached by hash', async t => {
  const { cache, link, calls } = host(t);
  const proxy = createUiProxy({ link, cacheDir: cache, origin: ORIGIN });
  assert.equal((await proxy.prepare()).entry, '/index.html');

  const page = await proxy.respond(`${ORIGIN}/`);
  assert.equal(page.status, 200);
  assert.match(text(page), /assets\/app\.js/);
  assert.equal(page.headers['Content-Security-Policy'], REMOTE_PAGE_CSP);
  assert.equal(page.headers['X-Content-Type-Options'], 'nosniff');
  const script = await proxy.respond(`${ORIGIN}/assets/app.js?x=1`);
  assert.match(text(script), /한글/);
  assert.equal(script.headers['Content-Type'], 'text/javascript');
  assert.equal((await proxy.respond(`${ORIGIN}/assets/font.woff2`)).headers['Access-Control-Allow-Origin'], '*');

  const before = calls.filter(([action]) => action === 'ui/file').length;
  await proxy.respond(`${ORIGIN}/assets/app.js`);
  assert.equal(calls.filter(([action]) => action === 'ui/file').length, before, 'a file that is cached is not asked for again');
  // A second window to the same PC (or the next start) reads the cache without a download.
  const again = createUiProxy({ link: { call: (action, input) => action === 'ui/file' ? Promise.reject(new Error('should not download')) : link.call(action, input) }, cacheDir: cache, origin: ORIGIN });
  await again.prepare();
  assert.match(text(await again.respond(`${ORIGIN}/assets/app.js`)), /한글/);
});

test('the interactive UI frame keeps its own CSP with the page origin filled in', async t => {
  const { cache, link } = host(t);
  const proxy = createUiProxy({ link, cacheDir: cache, origin: ORIGIN });
  await proxy.prepare();
  const frame = await proxy.respond(`${ORIGIN}/ade-ui-frame.html`);
  assert.equal(frame.status, 200);
  assert.match(frame.headers['Content-Security-Policy'], new RegExp(`font-src data: ${ORIGIN}`));
});

test('a file whose bytes do not match the manifest hash is thrown away, never cached or served', async t => {
  const { cache, link } = host(t, { tamper: reply => reply.path === '/assets/app.js' ? { ...reply, data: Buffer.from('evil()').toString('base64'), encoding: undefined } : reply });
  const proxy = createUiProxy({ link, cacheDir: cache, origin: ORIGIN });
  await proxy.prepare();
  const response = await proxy.respond(`${ORIGIN}/assets/app.js`);
  assert.equal(response.status, 502);
  assert.ok(!text(response).includes('evil'));
  for (const name of readdirSync(cache)) assert.ok(!readFileSync(path.join(cache, name), 'utf8').includes('evil'), `${name} was cached`);
});

test('paths outside the manifest and non-page requests get 404; before prepare() it is 503', async t => {
  const { cache, link } = host(t);
  const proxy = createUiProxy({ link, cacheDir: cache, origin: ORIGIN });
  assert.equal((await proxy.respond(`${ORIGIN}/`)).status, 503);
  await proxy.prepare();
  for (const bad of ['/etc/passwd', '/../../secret', '/assets/missing.js', '/index.html.map'])
    assert.equal((await proxy.respond(`${ORIGIN}${bad}`)).status, 404, bad);
});

test('a feedback screenshot of the other PC is fetched every time and never stored', async t => {
  const { cache, link, calls } = host(t);
  const proxy = createUiProxy({ link, cacheDir: cache, origin: ORIGIN });
  await proxy.prepare();
  const first = await proxy.respond(`${ORIGIN}/feedback-file/fb1/a.png`), second = await proxy.respond(`${ORIGIN}/feedback-file/fb1/a.png`);
  assert.deepEqual([...first.body], [9, 9, 9]);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.equal(second.status, 200);
  assert.equal(calls.filter(([, file]) => file === '/feedback-file/fb1/a.png').length, 2);
});

test('an older PC without ui/manifest is told to update; a broken manifest is refused', async t => {
  const { cache } = host(t);
  await assert.rejects(createUiProxy({ link: { call: async () => { throw Object.assign(new Error('x'), { code: 'REMOTE_FORBIDDEN' }); } }, cacheDir: cache, origin: ORIGIN }).prepare(), { code: 'UI_UNSUPPORTED' });
  await assert.rejects(createUiProxy({ link: { call: async () => ({ entry: '/index.html', csp: 'x', files: [] }) }, cacheDir: cache, origin: ORIGIN }).prepare(), { code: 'UI_INVALID' });
});
