import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// PluginMarket (the market tab of settings → plugins) rendered on the server: what each state of the Hub sign-in and the list shows, and what it never shows.
async function render(t, hubJson, { notice = null } = {}) {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('vite', { paths: [fileURLToPath(new URL('../apps/web', import.meta.url))] }))('esbuild');
  const directory = await mkdtemp(join(tmpdir(), 'ade-plugin-market-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'market.cjs');
  await build({ stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { PluginMarket, grantList } from './PluginMarket';
    export { grantList };
    export const html = renderToStaticMarkup(<PluginMarket hub={${hubJson}} busy="" run={() => {}} bridge={{ hubCatalog: async () => ({}), hubInstall: async () => ({}), signInHub: async () => ({}), cancelHubSignIn: async () => ({}), signOutHub: async () => ({}) }} notice={${JSON.stringify(notice)}} />);
  `, loader: 'tsx', resolveDir: fileURLToPath(new URL('../apps/web/src/', import.meta.url)) }, bundle: true, jsx: 'automatic', platform: 'node', format: 'cjs', external: ['monaco-editor', 'monaco-editor/*'], outfile, loader: { '.css': 'empty' } });
  globalThis.innerWidth = 1200; globalThis.innerHeight = 800; globalThis.document = { addEventListener() {} };
  t.after(() => { delete globalThis.innerWidth; delete globalThis.innerHeight; delete globalThis.document; });
  return require(outfile);
}
const hub = (extra = {}) => JSON.stringify({ available: true, host: 'ade-hub.example', signedIn: false, account: null, error: null, device: null, catalog: null, ...extra });
const entry = (extra = {}) => ({ id: 'demo', name: 'Demo', description: '설명', version: '1.0.0', size: 2048, grants: { terminal: false, mcp: false, workspace: false, feedback: false, header: false }, publishedAt: 1, installed: null, updateAvailable: false, reserved: false, ...extra });

test('signed out: the market asks to sign in and lists nothing; the code is shown while the browser approves it', async t => {
  const out = await render(t, hub());
  assert.match(out.html, /MoonerADE Hub에 로그인하세요/);
  assert.match(out.html, /GitHub 계정은 필요 없습니다/);
  assert.match(out.html, /Hub 로그인/);
  assert.doesNotMatch(out.html, /plugin-market-row|로그아웃/);
  const waiting = await render(t, hub({ device: { userCode: 'BCDF-GHJK', verifyUrl: 'https://ade-hub.example/enroll?code=BCDF-GHJK', expiresAt: 1 } }));
  assert.match(waiting.html, /BCDF-GHJK/);
  assert.match(waiting.html, /코드 복사/);
  assert.doesNotMatch(waiting.html, /MoonerADE Hub에 로그인하세요/);
});

test('signed in: each plugin shows what it asks for, and installing, updating, installed and reserved look different', async t => {
  const plugins = [
    entry({ id: 'fresh', name: 'Fresh', grants: { workspace: true, terminal: true, mcp: false, feedback: false, header: false } }),
    entry({ id: 'newer', name: 'Newer', version: '2.0.0', installed: { version: '1.0.0' }, updateAvailable: true }),
    entry({ id: 'same', name: 'Same', installed: { version: '1.0.0' } }),
    entry({ id: 'agent-bus', name: 'Taken', reserved: true })
  ];
  const out = await render(t, hub({ signedIn: true, account: '시험 계정', catalog: { status: 'ok', error: null, checkedAt: 1, plugins } }));
  assert.match(out.html, /시험 계정/);
  assert.match(out.html, /ade-hub\.example/);
  assert.equal(out.html.match(/plugin-market-row/g).length, 4);
  assert.match(out.html, /프로젝트·터미널 조작/);
  assert.match(out.html, /터미널 명령/);
  assert.match(out.html, /업데이트 v2\.0\.0/);
  assert.match(out.html, /지금 v1\.0\.0/);
  assert.equal(out.html.match(/설치됨/g).length, 1, 'only the one that is installed and current');
  assert.match(out.html, /설치할 수 없음/);
  assert.equal(out.html.match(/>설치<\/button>/g).length, 1, 'one plugin can be installed');
  assert.match(out.html, /2 KB/);
  assert.match(out.html, /로그아웃/);
  assert.deepEqual(out.grantList({ terminal: true, mcp: true, workspace: false, feedback: true, header: false }), ['터미널 명령', '에이전트 도구', '피드백 전송']);
});

test('the list is loading, empty or failed; a plugin\'s own words and a refused sign-in are shown as text', async t => {
  const loading = await render(t, hub({ signedIn: true, account: 'A', catalog: null }));
  assert.match(loading.html, /목록을 불러오는 중/);
  const empty = await render(t, hub({ signedIn: true, account: 'A', catalog: { status: 'ok', error: null, checkedAt: 1, plugins: [] } }));
  assert.match(empty.html, /아직 없습니다/);
  const failed = await render(t, hub({ signedIn: true, account: 'A', catalog: { status: 'error', error: 'Hub가 준비하지 못했습니다', checkedAt: null, plugins: [] } }));
  assert.match(failed.html, /Hub가 준비하지 못했습니다/);
  assert.match(failed.html, /다시 시도/);
  assert.doesNotMatch(failed.html, /아직 없습니다|불러오는 중/);
  const hostile = await render(t, hub({ signedIn: true, account: '<img src=x onerror=alert(1)>', catalog: { status: 'ok', error: null, checkedAt: 1, plugins: [entry({ name: '<script>alert(1)</script>', description: '<b>굵게</b>' })] } }));
  assert.match(hostile.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(hostile.html, /<script>|<img |<b>굵게/);
  const refused = await render(t, hub({ error: 'MoonerADE Hub 로그인이 끝나 로그아웃했습니다. 다시 로그인하세요.' }));
  assert.match(refused.html, /다시 로그인하세요/);
  const unavailable = await render(t, hub({ available: false }));
  assert.match(unavailable.html, /MoonerADE Hub를 쓸 수 없습니다/);
});

test('a notice from a button is shown, except "sign-in started" (the code box says that)', async t => {
  assert.match((await render(t, hub({ signedIn: true, account: 'A' }), { notice: { text: '설치했습니다', error: false, step: 'p1' } })).html, /설치했습니다/);
  assert.doesNotMatch((await render(t, hub(), { notice: { text: '브라우저에서 로그인하세요', error: false, step: 'signin' } })).html, /브라우저에서 로그인하세요/);
  assert.match((await render(t, hub(), { notice: { text: '로그인하지 못했습니다', error: true, step: 'signin' } })).html, /로그인하지 못했습니다/);
});
