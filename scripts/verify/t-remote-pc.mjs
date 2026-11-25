// PC ↔ PC remote end to end (docs/REMOTE_UI.md): an isolated MoonerADE (Electron, its own profile) opens the ADE of "another PC".
//   the other PC  = a throwaway ADE server (lib.mjs boot) behind a fake Hub that answers the link like the remote-access plugin does,
//                   through the plugin's real allowlist (remote/lib/dispatch.js);
//   this PC       = Electron with its own ADE_USER_DATA_DIR/ADE_DATA_DIR/HOME, driven over CDP.
// Nothing touches the installed app, the real ~/.claude or the Keychain (Chromium's mock keychain), and no browser is opened.
// Usage: node scripts/verify/t-remote-pc.mjs [--plugins <mooner-ade-plugins>]   (needs apps/web/dist: pnpm --filter @mooner/ade-web build)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fakeHub } from '../../tests/remote-helpers.mjs';
import { boot, ROOT, sleep, until, WebSocket } from './lib.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
const plugins = resolve(opt('--plugins', join(ROOT, '../mooner-ade-plugins')));
const { remoteApi, remoteMessage, scopeSummary } = await import(pathToFileURL(join(plugins, 'remote/lib/dispatch.js')).href);
const results = [];
const check = async (name, fn) => { try { await fn(); results.push([true, name]); console.log('PASS', name); } catch (error) { results.push([false, name]); console.log('FAIL', name, '—', error.message); } };
const assert = (value, message) => { if (!value) throw new Error(message); };
const cleanups = [];
const t = { after: fn => cleanups.push(fn) };

// ---- the other PC ---------------------------------------------------------------------------------------------------------
// An onboarded profile (as a real PC has), so its tour is not on screen in the window.
const otherData = realpathSync(mkdtempSync(join(os.tmpdir(), 'ade-remote-other-')));
cleanups.push(() => rmSync(otherData, { recursive: true, force: true }));
mkdirSync(otherData, { recursive: true });
writeFileSync(join(otherData, 'app-state.json'), JSON.stringify({ version: 1, openProjects: [], activeProjectId: '', settings: { theme: 'dark', onboarded: true, tourVersion: 2, defaultMode: 'cli', chatTipPending: false, chatPermissionAutoSet: true } }));
const other = await boot({ data: otherData });
cleanups.push(() => other.stop());
const summary = scopeSummary('control');
const calls = [], forwards = new Set();
const hub = await fakeHub(t, {
  hostName: 'Other PC', hello: { ...summary, host: { id: 'host-1', name: 'Other PC', platform: process.platform } },
  api: async (action, input) => {
    calls.push(action);
    const request = remoteApi(action, input, 'control');
    const response = await fetch(`${other.origin}/api/${request.action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: other.origin, Cookie: other.cookie }, body: JSON.stringify(request.input ?? {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error?.message ?? 'failed'), { code: value.error?.code ?? 'ERROR' });
    return value;
  },
  // The plugin forwards the window's /ws to the session and filters what a phone may send (remoteMessage).
  onWs: (message, session) => {
    if (!session.hostSocket) {
      const socket = session.hostSocket = new WebSocket(`${other.origin.replace(/^http/, 'ws')}/ws`, { headers: { Origin: other.origin, Cookie: other.cookie } });
      session.queue = [];
      socket.on('open', () => { for (const item of session.queue.splice(0)) socket.send(item); });
      socket.on('message', data => { const text = String(data); if (!text.startsWith('{"type":"fs",')) session.send({ t: 'ws', message: JSON.parse(text) }); });
      forwards.add(socket);
    }
    const clean = JSON.stringify(remoteMessage(message, 'control'));
    if (session.hostSocket.readyState === 1) session.hostSocket.send(clean); else session.queue.push(clean);
  }
});
cleanups.push(() => { for (const socket of forwards) socket.close(); });

// ---- this PC: an isolated Electron ----------------------------------------------------------------------------------------
const temp = realpathSync(mkdtempSync(join(os.tmpdir(), 'ade-remote-pc-')));
cleanups.push(() => rmSync(temp, { recursive: true, force: true }));
const port = 20000 + Math.floor(Math.random() * 20000);
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ADE_') && !name.startsWith('ELECTRON_')));
const electron = createRequire(import.meta.url)(join(ROOT, 'apps/desktop/node_modules/electron'));
const app = spawn(electron, [join(ROOT, 'apps/desktop'), `--remote-debugging-port=${port}`, '--use-mock-keychain'], {
  env: { ...clean, HOME: join(temp, 'home'), ADE_USER_DATA_DIR: join(temp, 'user'), ADE_DATA_DIR: join(temp, 'data'), ADE_HUB_URL: hub.url, ADE_REMOTE_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe']
});
const appLog = [];
app.stdout.on('data', chunk => appLog.push(String(chunk))); app.stderr.on('data', chunk => appLog.push(String(chunk)));
cleanups.push(() => new Promise(done => { if (app.exitCode !== null) return done(); app.once('exit', done); app.kill('SIGTERM'); setTimeout(() => { app.kill('SIGKILL'); done(); }, 5000).unref(); }));

const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(item => item.type === 'page');
async function attach(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject); });
  let id = 0; const waiting = new Map(), logs = [];
  socket.on('message', raw => { const message = JSON.parse(raw); if (message.method === 'Runtime.consoleAPICalled') logs.push(`${message.params.type}: ${message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ')}`.slice(0, 200)); else if (message.method === 'Runtime.exceptionThrown') logs.push(`EXC ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`.slice(0, 300)); if (message.id && waiting.has(message.id)) { const item = waiting.get(message.id); waiting.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); } });
  const send = (method, params = {}) => new Promise((resolveSend, reject) => { const mine = ++id; waiting.set(mine, { resolve: resolveSend, reject }); socket.send(JSON.stringify({ id: mine, method, params })); });
  const ev = async expression => {
    const result = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Runtime.enable');
  return { send, ev, logs, close: () => socket.close(), waitFor: async (expression, ms = 15000) => until(() => ev(`return (${expression})`), ms, 200) };
}

try {
  const main = await until(async () => (await targets()).find(item => item.url.startsWith('http://127.0.0.1') && !item.url.includes('about:blank')), 60000, 500).then(attach);
  await main.waitFor('Boolean(window.adeDesktop?.remote)');
  const remote = name => `window.adeDesktop.remote.${name}`;

  await check('signed out at first', async () => {
    const state = await main.ev(`return await ${remote('state()')}`);
    assert(state.available && !state.signedIn, JSON.stringify(state));
  });
  await check('sign in with a device code, as a desktop device', async () => {
    const started = await main.ev(`return await ${remote('signInStart()')}`);
    assert(started.userCode === 'ABCD-1234', JSON.stringify(started));
    const done = await main.ev(`return await ${remote('signInWait()')}`);
    assert(done.account === '무너', JSON.stringify(done));
    assert(hub.state.enrollBody.kind === 'desktop', `kind ${hub.state.enrollBody.kind}`);
  });
  await check('pair with the link the other PC made (it approves in the fake)', async () => {
    const offer = await main.ev(`return await ${remote(`offer(${JSON.stringify(hub.pairLink())})`)}`);
    assert(offer.hostFingerprint === hub.hostFingerprint() && offer.myFingerprint, JSON.stringify(offer));
    const paired = await main.ev(`return await ${remote(`pair(${JSON.stringify(hub.pairLink())})`)}`);
    assert(paired.scope === 'control', JSON.stringify(paired));
    const hosts = await main.ev(`return await ${remote('hosts()')}`);
    assert(hosts[0]?.paired && hosts[0].online && hosts[0].name === 'Other PC', JSON.stringify(hosts));
  });

  let win;
  await check('opening the PC shows its ADE in a new window of its own', async () => {
    await main.ev(`return await ${remote('open("host-1")')}`);
    const target = await until(async () => (await targets()).find(item => item.url.startsWith('ade-remote://')), 30000, 300);
    win = await attach(target);
    await win.waitFor('Boolean(document.querySelector(".shell, .welcome"))', 30000)
      .catch(async error => { throw new Error(`${error.message}; page: ${(await win.ev('return document.documentElement.outerHTML.slice(0, 400)').catch(e => e.message))}; log: ${appLog.join('').slice(-400)}`); });
  });
  await check('the window knows it is a desktop remote and has no desktop bridge', async () => {
    const info = await win.ev('return { remote: document.documentElement.dataset.remote, client: document.documentElement.dataset.remoteClient, bridge: typeof window.adeDesktop, native: typeof window.AdeRemoteNative, origin: location.origin }');
    assert(info.remote === 'control' && info.client === 'desktop' && info.bridge === 'undefined' && info.native === 'object', JSON.stringify(info));
  });
  await check('the green frame is drawn around the page', async () => {
    const frame = await win.ev('const style = getComputedStyle(document.body, "::after"); return { width: style.borderTopWidth, color: style.borderTopColor, position: style.position, events: style.pointerEvents }');
    assert(frame.width === '3px' && frame.color === 'rgb(34, 197, 94)' && frame.position === 'fixed' && frame.events === 'none', JSON.stringify(frame));
  });
  await check('the other PC\'s recent project is listed, and opening it works through the link', async () => {
    const name = other.repo.split(/[\\/]/).pop();
    await win.waitFor(`document.body.innerText.includes(${JSON.stringify(other.repo)})`, 30000);
    // The picker of the other PC: its recent project row opens the project there (control scope may; the plugin checks it is a known project).
    await win.ev(`const row = [...document.querySelectorAll("button")].find(item => item.textContent.includes(${JSON.stringify(other.repo)})); if (!row) throw new Error("no recent row"); row.click();`);
    await win.waitFor(`document.querySelector(".projects")?.textContent.includes(${JSON.stringify(name)})`, 30000)
      .catch(async error => { throw new Error(`${error.message}; calls ${calls.join(',')}; page: ${(await win.ev('return document.body.innerText.slice(0, 300)')).replace(/\n/g, ' | ')}`); });
    assert(calls.includes('project/open'), 'project/open never went through');
  });
  await check('a terminal opened in the window runs on the other PC, and the events stream is open', async () => {
    // The workspace may still be loading its project when the button first shows: press again until the call goes out.
    // A new project shows the launcher (terminal, Claude, Codex, Cursor); "터미널 zsh" starts a plain shell on the other PC.
    await win.waitFor('[...document.querySelectorAll("button")].some(item => /터미널/.test(item.textContent) && /zsh|bash|sh|PowerShell|cmd/i.test(item.textContent))', 30000);
    await win.ev(`const button = [...document.querySelectorAll("button")].find(item => /터미널/.test(item.textContent) && /zsh|bash|sh|PowerShell|cmd/i.test(item.textContent)); button.click();`);
    await win.waitFor('Boolean(document.querySelector(".xterm"))', 30000).catch(async () => { throw new Error(`no terminal in the page; console: ${win.logs.slice(-6).join(' || ')}; text: ${(await win.ev('return document.body.innerText.replace(/\\s+/g, " ").slice(0, 700)'))}`); });
    await until(() => calls.includes('terminal/open'), 10000, 200).catch(() => { throw new Error(`terminal/open never reached the other PC; calls ${calls.slice(-8).join(',')}`); });
    assert(forwards.size >= 1, 'the window never opened the events stream');
    await until(async () => (await other.api('snapshot', { projectId: other.projectId })).terminals?.length > 0 || (await other.api('snapshot', { projectId: other.projectId })).tabs?.length > 0, 10000, 300);
  });
  await check('a modal keeps the frame on its backdrop', async () => {
    await win.ev('const dialog = document.createElement("dialog"); dialog.id = "probe"; dialog.textContent = "x"; document.body.append(dialog); dialog.showModal();');
    const shadow = await win.ev('return getComputedStyle(document.getElementById("probe"), "::backdrop").boxShadow');
    assert(shadow.includes('rgb(34, 197, 94)'), shadow);
    await win.ev('document.getElementById("probe").close(); document.getElementById("probe").remove();');
  });
  await check('the page cannot reach any network of this PC', async () => {
    const blocked = await win.ev('try { await fetch("https://example.com/", { mode: "no-cors" }); return false; } catch { return true; }');
    assert(blocked, 'a fetch to the internet was not blocked');
  });
  await check('the window did nothing to the other PC that a window may not (no app/state write, ui, project/close)', async () => {
    assert(calls.length > 3, `calls ${calls.join(',')}`);
    for (const forbidden of ['ui', 'project/close', 'dialog/folder']) assert(!calls.includes(forbidden), `${forbidden} was called`);
  });
  await check('opening it again focuses the same window', async () => {
    const answer = await main.ev(`return await ${remote('open("host-1")')}`);
    assert(answer.reused === true, JSON.stringify(answer));
    assert((await targets()).filter(item => item.url.startsWith('ade-remote://')).length === 1, 'a second window opened');
  });
  await check('"창 닫기" closes only the remote window; this ADE stays', async () => {
    await win.ev('const button = [...document.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === "창 닫기"); if (!button) throw new Error("no close button"); button.click();');
    await until(async () => !(await targets()).some(item => item.url.startsWith('ade-remote://')), 10000, 200);
    assert((await targets()).some(item => item.url.startsWith('http://127.0.0.1')), 'the main window is gone');
    const hosts = await main.ev(`return await ${remote('state()')}`);
    assert(hosts.open.length === 0, JSON.stringify(hosts));
  });
  await check('forget removes the pairing', async () => {
    await main.ev(`await ${remote('forget("host-1")')}`);
    const hosts = await main.ev(`return await ${remote('hosts()')}`);
    assert(!hosts[0]?.paired, JSON.stringify(hosts));
  });
} catch (error) {
  console.log('ERROR', error.message);
  console.log(appLog.join('').split('\n').slice(-25).join('\n'));
  results.push([false, `run: ${error.message}`]);
} finally {
  for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch { /* best effort */ } }
}
const failed = results.filter(([passed]) => !passed).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await sleep(100);
process.exit(failed ? 1 : 0);
