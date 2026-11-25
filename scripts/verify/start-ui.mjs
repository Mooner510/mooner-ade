// Long-running owner of ONE session folder (VERIFY_OUT; default tmp/main): server + fake Hub + one visible Chrome, recorded in its env.json.
// Start it through `node scripts/verify/session.mjs up` (tmp/main) or `session.mjs new` (an isolated tmp/ade-*): those check first whether it already runs.
// - No web build for the page: the server runs ADE_DEV=1 (in-process Vite, HMR), so web edits show up in the open page by themselves. The only build is apps/web/dist
//   for a phone (see buildDist): made once when missing, `session.mjs build` refreshes it.
// - It follows the server source too: an edit under apps/local-server/src, apps/desktop/src or the verify plugin harness restarts the server alone.
//   The session keeps one port and one ADE_DEV_TOKEN, so the URL and the browser's cookie survive every restart and the open tabs just reconnect.
// - control.json (written by session.mjs restart/use/reset/up) asks for a restart, another source checkout, fresh data or a new Chrome
//   (and may carry VERIFY_PLUGIN_DIR for the next server).
// - Chrome is detached (libuv ties a child to its parent's Windows job, so it would die with this process) and outlives it; `session.mjs down` closes it.
//   It shares only the tab for getDisplayMedia (--auto-accept-this-tab-capture); an "Entire screen" auto-select flag makes captures screen-sized.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { boot, fakeHub, sleep, S, ROOT, WebSocket } from './lib.mjs';
import { branchOf, commandLines, defaultChrome, ensureSession, readEnv, readJson, sessionState } from './session-dirs.mjs';

const name = basename(S), isMain = name === 'main', envFile = join(S, 'env.json'), controlFile = join(S, 'control.json');
const prev = readEnv(S) ?? {};
const mode = process.env.AGENT_DIRS ? 'agent-dirs' : process.env.REAL_AGENTS ? 'real' : 'dummy';
if (isMain && mode !== 'dummy') { console.error('tmp/main은 더미 전용입니다. 실제 계정·API 키는 `node scripts/verify/session.mjs new <목적> --real|--agent-dirs --reason "…"`로 따로 띄우세요.'); process.exit(2); }
if (prev.pid && prev.pid !== process.pid && sessionState(prev, commandLines([prev.pid])).owner) { console.error(`${S}는 이미 실행 중입니다(start-ui pid ${prev.pid}). \`node scripts/verify/session.mjs status\`로 확인하세요.`); process.exit(2); }
ensureSession(S, { kind: isMain ? 'main' : 'isolated', reason: process.env.VERIFY_REASON ?? '' });

const freePort = () => new Promise((res, rej) => { const srv = createServer(); srv.once('error', rej); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); }); });
let port = prev.port || await freePort();
const devToken = /^[0-9a-f]{64}$/.test(prev.token ?? '') ? prev.token : randomBytes(32).toString('hex');
const serverOk = dir => existsSync(join(dir, 'apps/local-server/src/index.js'));
// The phone shows the PC's own UI from apps/web/dist (local-server remote-ui.js `ui/manifest`); the dev server of this session has no build, so without one the app falls back to its old native screens.
// A build is made when the source has none (and on `session.mjs build`); web edits after that are not in it until the next `build`. The page in Chrome still follows the edits by HMR.
const distOk = dir => existsSync(join(dir, 'apps/web/dist/index.html'));
async function buildDist(dir) {
  const webDir = join(dir, 'apps/web'), log = openSync(join(S, 'web-build.log'), 'w');
  try {
    const vite = join(dirname(createRequire(join(webDir, 'package.json')).resolve('vite/package.json')), 'bin/vite.js');
    const code = await new Promise(res => { const c = spawn(process.execPath, [vite, 'build'], { cwd: webDir, stdio: ['ignore', log, log], windowsHide: true }); c.on('exit', code => res(code ?? 1)); c.on('error', () => res(1)); });
    if (code !== 0) throw new Error(`apps/web 빌드 실패(종료 코드 ${code}). ${join(S, 'web-build.log')}`);
  } finally { closeSync(log); }
}
// A checkout from before the shared sessions has the old plugin harness gate (OS temp only), which would stop its server: plugins stay off there.
const pluginsOk = dir => existsSync(join(dir, 'scripts/verify/session-dirs.mjs'));
let source = resolve(process.env.VERIFY_SOURCE || prev.source || ROOT);
if (!serverOk(source)) { console.error(`소스 checkout에 서버가 없습니다: ${source}`); process.exit(2); }

const hub = await fakeHub();
let s = null, serverError = '', lastControl = prev.lastControl, queue = Promise.resolve();
async function bootServer() {
  if (!distOk(source)) await buildDist(source).catch(e => { console.error(String(e.message ?? e)); });
  const env = { ADE_HUB_URL: hub.url, ADE_DEV: '1', ADE_DEV_TOKEN: devToken, ...(pluginsOk(source) && { ADE_VERIFY_PLUGINS: '1' }) };
  for (let tries = 0; ; tries++) {
    try {
      const mine = s = await boot({ dir: S, root: source, port, env }); serverError = '';
      // a crash on its own (not a restart): show it in `session.mjs status`; the next source edit starts it again
      mine.child.once('exit', code => { if (s === mine && !mine.stopping) { serverError = `서버가 스스로 종료됨(코드 ${code}): ${mine.stderr.slice(-1500)}`; console.error(serverError); writeEnv(); } });
      return;
    }
    catch (e) {
      if (!/EADDRINUSE/.test(e.message)) throw e;
      if (tries < 10) { await sleep(300); continue; } // the old server's port is not free for a moment
      port = await freePort(); tries = -1; // someone else took it: a new port (the tabs are re-pointed)
    }
  }
}
const origin = () => `http://127.0.0.1:${port}`, url = () => `${origin()}/#token=${devToken}`;

// ---- Chrome: one window per session, kept across server restarts
const profile = join(S, 'chrome');
const cdpAlive = async cdp => Boolean(cdp) && await fetch(`${cdp}/json/version`).then(r => r.ok, () => false);
let cdp, chromePid;
if (await cdpAlive(prev.cdp) && sessionState(prev, commandLines([prev.chromePid])).chrome) ({ cdp, chromePid } = prev);
async function openChrome() {
  rmSync(join(profile, 'DevToolsActivePort'), { force: true });
  const chrome = spawn(defaultChrome(), [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--window-size=1500,950',
    '--use-fake-ui-for-media-stream', '--test-type', '--auto-accept-this-tab-capture', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', 'about:blank'],
  { stdio: 'ignore', detached: true, windowsHide: true });
  chrome.unref();
  let p; for (let i = 0; i < 600 && !p; i++) { await sleep(100); try { p = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] || undefined; } catch { /* not yet */ } }
  if (!p) throw new Error('Chrome의 DevTools 포트를 읽지 못했습니다.');
  cdp = `http://127.0.0.1:${p}`; chromePid = chrome.pid;
}
const call = (wsUrl, method, params) => new Promise((res, rej) => {
  const ws = new WebSocket(wsUrl); ws.on('error', rej);
  ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
  ws.on('message', m => { const msg = JSON.parse(m); if (msg.id === 1) { ws.close(); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); } });
});
// The session's sign-in cookie (the server derives it from ADE_DEV_TOKEN), put into Chrome before a page loads. Otherwise Vite's client opens its HMR socket
// before the page has signed in, is refused, and gives up: web edits then need a manual reload (and a server restart does not reload the page).
async function setCookie() {
  const value = createHash('sha256').update(`ade-dev-session:${devToken}`).digest('hex');
  const browser = (await (await fetch(`${cdp}/json/version`)).json()).webSocketDebuggerUrl;
  await call(browser, 'Storage.setCookies', { cookies: [{ name: 'ade_session', value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }] });
}
const stopServer = async () => { if (s) { s.stopping = true; await s.stop(); } s = null; };
// Tabs of this session that are not on the current address (a new port): point them at it; `all`: every tab of ours (after the server was down they sit
// on Chrome's error page, which has no Vite client to reload itself). Never brings a window forward.
async function pointTabs(all = false) {
  await setCookie();
  const pages = (await (await fetch(`${cdp}/json/list`)).json()).filter(t => t.type === 'page');
  if (!pages.length) { await fetch(`${cdp}/json/new?${url()}`, { method: 'PUT' }); return; }
  const ours = pages.filter(t => t.url.startsWith('http://127.0.0.1:'));
  for (const tab of ours.length ? ours.filter(t => all || !t.url.startsWith(origin() + '/')) : [pages[0]]) await call(tab.webSocketDebuggerUrl, 'Page.navigate', { url: url() });
}

function writeEnv(extra = {}) {
  const env = { ...prev, name, kind: isMain ? 'main' : 'isolated', mode, reason: process.env.VERIFY_REASON ?? prev.reason ?? '', origin: origin(), url: url(), token: devToken, cookie: s?.cookie, projectId: s?.projectId,
    repo: join(S, 'repo'), data: join(S, 'data'), temp: S, hub: hub.url, cdp, port, source, branch: branchOf(source), plugins: pluginsOk(source), updatedAt: Date.now(),
    pid: process.pid, serverPids: s && s.child.exitCode === null ? [s.child.pid] : [], chromePid, chromeProfile: profile, serverError, lastControl,
    agentBase: s?.agents?.base, agentFresh: s?.agents?.fresh, keychain: s?.agents?.keychain, ...extra };
  writeFileSync(envFile + '.tmp', JSON.stringify(env, null, 2)); renameSync(envFile + '.tmp', envFile); // readers never see half a file
  Object.assign(prev, env);
}

// ---- everything that touches the server runs one at a time
const run = (what, fn) => queue = queue.then(async () => {
  console.log(`[${new Date().toLocaleTimeString()}] ${what}`);
  try { await fn(); } catch (e) { serverError = String(e.message ?? e).slice(0, 2000); console.error(`실패: ${serverError}`); }
  writeEnv();
});
const restartServer = what => run(what, async () => { const wasDown = !s || Boolean(serverError); await stopServer(); await bootServer(); if (await cdpAlive(cdp)) await pointTabs(wasDown); });

let watchers = [], timer, changed = new Set();
function watchSource() {
  for (const w of watchers) w.close(); watchers = [];
  for (const rel of ['apps/local-server/src', 'apps/desktop/src', 'scripts/verify/plugins.mjs', 'scripts/verify/session-dirs.mjs', 'scripts/verify/usage.mjs']) {
    const p = join(source, rel); if (!existsSync(p)) continue;
    const dir = statSync(p).isDirectory();
    try {
      const w = watch(p, { recursive: dir }, (_event, file) => {
        if (dir && file && !/\.(m?js|cjs|json)$/i.test(file)) return;
        changed.add(dir && file ? `${rel}/${String(file).replaceAll('\\', '/')}` : rel); clearTimeout(timer);
        timer = setTimeout(() => { const list = [...changed]; changed = new Set(); restartServer(`서버 소스 변경 → 서버 재시작: ${list.slice(0, 3).join(', ')}${list.length > 3 ? ` 외 ${list.length - 3}개` : ''}`); }, 400);
      });
      w.on('error', () => {}); watchers.push(w);
    } catch (e) { console.error(`감시 실패 ${p}: ${e.message}`); }
  }
}

// control.json: { id, action: 'restart' | 'source' | 'reset' | 'chrome', source? }. Handled once; env.json.lastControl tells the caller it is done.
setInterval(() => {
  const c = readJson(controlFile); if (!c?.id || c.id === lastControl) return;
  lastControl = c.id; rmSync(controlFile, { force: true });
  if (c.pluginDir) process.env.VERIFY_PLUGIN_DIR = c.pluginDir; // read by the next server's plugin harness (boot passes this env on)
  if (c.action === 'restart') restartServer('요청 → 서버 재시작');
  else if (c.action === 'source') {
    const next = resolve(c.source ?? '');
    if (!serverOk(next)) return run('소스 변경 거부', async () => { throw new Error(`소스 checkout에 서버가 없습니다: ${next}`); });
    source = next; watchSource(); restartServer(`소스 변경 → ${source} (${branchOf(source)})`);
  } else if (c.action === 'reset') run('데이터 초기화(data·home·repo)', async () => {
    await stopServer();
    for (const d of ['data', 'home', 'repo', 'fake-claude.jsonl', 'ctl.json']) rmSync(join(S, d), { recursive: true, force: true });
    await bootServer(); if (await cdpAlive(cdp)) await pointTabs();
  });
  else if (c.action === 'build') run('폰용 화면 빌드(apps/web/dist)', async () => { await buildDist(source); });
  else if (c.action === 'chrome') run('Chrome 확인', async () => { if (!(await cdpAlive(cdp))) await openChrome(); await pointTabs(); });
  else run(`알 수 없는 요청 ${c.action}`, async () => {});
}, 500);

// ---- start (a server that does not start, e.g. a syntax error mid-edit, leaves the session up: the error is in env.json and the next edit retries)
await bootServer().catch(e => { serverError = String(e.message ?? e).slice(0, 2000); console.error(`서버 시작 실패: ${serverError}`); });
if (!cdp) await openChrome(); // opens about:blank; pointTabs sets the cookie, then loads the app
await pointTabs();
watchSource();
writeEnv({ startedAt: Date.now(), startedBy: process.env.VERIFY_AGENT || '?' });
console.log('READY', origin(), cdp);
const stop = async () => { await stopServer(); await hub.close(); process.exit(0); }; // Chrome stays: `session.mjs down` closes it
process.on('SIGTERM', stop); process.on('SIGINT', stop); setInterval(() => {}, 1 << 30);
