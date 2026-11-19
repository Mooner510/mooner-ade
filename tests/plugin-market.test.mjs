import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Renders a small module from apps/web/src on the server (esbuild bundle, then require).
async function bundle(t, body) {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('vite', { paths: [fileURLToPath(new URL('../apps/web', import.meta.url))] }))('esbuild');
  const directory = await mkdtemp(join(tmpdir(), 'ade-plugin-market-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'out.cjs');
  await build({ stdin: { contents: body, loader: 'tsx', resolveDir: fileURLToPath(new URL('../apps/web/src/', import.meta.url)) }, bundle: true, jsx: 'automatic', platform: 'node', format: 'cjs', external: ['monaco-editor', 'monaco-editor/*'], outfile, loader: { '.css': 'empty' } });
  globalThis.innerWidth = 1200; globalThis.innerHeight = 800; globalThis.document = { addEventListener() {} };
  t.after(() => { delete globalThis.innerWidth; delete globalThis.innerHeight; delete globalThis.document; });
  return require(outfile);
}

// PluginMarket (plugins → 마켓): shown only for a signed-in account; the sign-in itself is on the 정보 page (HubSignIn).
async function render(t, hubJson, { notice = null } = {}) {
  return bundle(t, `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { PluginMarket, grantList } from './PluginMarket';
    export { grantList };
    export const html = renderToStaticMarkup(<PluginMarket hub={${hubJson}} busy="" run={() => {}} bridge={{ hubCatalog: async () => ({}), hubInstall: async () => ({}), signInHub: async () => ({}), cancelHubSignIn: async () => ({}), signOutHub: async () => ({}) }} notice={${JSON.stringify(notice)}} />);
  `);
}

// HubSignIn (정보 page): the only place to sign in to the Hub; nothing is drawn while the Hub is unavailable.
async function renderSignIn(t, hubJson) {
  return bundle(t, `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { HubSignIn } from './PluginSettings';
    export const html = renderToStaticMarkup(<HubSignIn hub={${hubJson}} bridge={{ signInHub: async () => ({}), cancelHubSignIn: async () => ({}), signOutHub: async () => ({}) }} />);
  `);
}

const hub = (extra = {}) => JSON.stringify({ available: true, host: 'ade-hub.example', signedIn: false, account: null, error: null, device: null, catalog: null, ...extra });
const entry = (extra = {}) => ({ id: 'demo', name: 'Demo', description: '설명', version: '1.0.0', size: 2048, grants: { terminal: false, mcp: false, workspace: false, feedback: false, header: false }, publishedAt: 1, installed: null, updateAvailable: false, reserved: false, ...extra });

test('정보: signed out, the Hub row offers the sign-in; the code is shown while the browser approves it', async t => {
  const out = await renderSignIn(t, hub());
  assert.match(out.html, /Hub 계정 로그인/);
  assert.match(out.html, /계정 생성은 개발자에게 별도 문의가 필요합니다/);
  assert.match(out.html, /Hub 로그인/);
  assert.doesNotMatch(out.html, /로그아웃|plugin-market-row/);
  const waiting = await renderSignIn(t, hub({ device: { userCode: 'BCDF-GHJK', verifyUrl: 'https://ade-hub.example/enroll?code=BCDF-GHJK', expiresAt: 1 } }));
  assert.match(waiting.html, /BCDF-GHJK/);
  assert.match(waiting.html, /코드 복사/);
  assert.match(waiting.html, />취소</);
  assert.doesNotMatch(waiting.html, /Hub 로그인<\/button>/);
});

test('정보: signed in, the row names the account and offers signing out; a refused sign-in is shown as text', async t => {
  const out = await renderSignIn(t, hub({ signedIn: true, account: '시험 계정' }));
  assert.match(out.html, /시험 계정으로 로그인되어 있습니다/);
  assert.match(out.html, /로그아웃/);
  assert.doesNotMatch(out.html, /Hub 로그인<\/button>/);
  const refused = await renderSignIn(t, hub({ error: 'MoonerADE Hub 로그인이 끝나 로그아웃했습니다. 다시 로그인하세요.' }));
  assert.match(refused.html, /다시 로그인하세요/);
  assert.equal((await renderSignIn(t, hub({ available: false }))).html, '', 'nothing without a Hub');
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

test('the list is loading, empty or failed; a plugin\'s own words are shown as text', async t => {
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
});

test('a notice from a button is shown in the market', async t => {
  assert.match((await render(t, hub({ signedIn: true, account: 'A' }), { notice: { text: '설치했습니다', error: false, step: 'p1' } })).html, /설치했습니다/);
});
