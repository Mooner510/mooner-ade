// Long-running: isolated server + fake Hub + visible Chrome. Writes env.json (into VERIFY_OUT) for the driver scripts. Ctrl-C / SIGTERM stops all.
// Chrome shares only the tab for getDisplayMedia (--auto-accept-this-tab-capture); an "Entire screen" auto-select flag makes captures screen-sized.
import { boot, fakeHub, sleep, S, WebSocket } from './lib.mjs'; import { spawn } from 'node:child_process'; import { writeFile, readFile, mkdtemp } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
// No web build at all: both servers run ADE_DEV=1, i.e. they serve apps/web/src through an in-process Vite dev server (HMR, so a source edit shows up in
// the open page within a second; no apps/web/dist, nothing to rebuild or wipe). A production bundle (`pnpm --filter @mooner/ade-web build`) is only for the packaged app.
const dev = { ADE_DEV: '1' };
// VERIFY_TEMP=<an earlier env.json's temp>: reopen that session's data, home and repo (saved API keys and chats) instead of a fresh one.
const hub = await fakeHub(); const s = await boot({ env: { ADE_HUB_URL: hub.url, ...dev }, temp: process.env.VERIFY_TEMP, keep: true });
const second = await boot({ env: { ADE_HUB_URL: hub.url, ...dev }, repoFiles: false }); // for the no-project welcome screen: forget the auto-opened project below
// VERIFY_CHROME=<an earlier env.json's cdp>: a server restart does not need a Chrome restart. Keep that Chrome (its window, tabs and position) and only point its
// first tab at the new server's address; stopping this process then leaves that Chrome running. Without it a new Chrome is started and owned by this process.
const reuse = process.env.VERIFY_CHROME?.replace(/\/$/, ''); const url = `${s.origin}/#token=${s.token}`;
const profile = reuse ? undefined : await mkdtemp(join(tmpdir(), 'ade-verify-chrome-'));
const chrome = reuse ? undefined : spawn(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--window-size=1500,950', '--use-fake-ui-for-media-stream', '--test-type','--auto-accept-this-tab-capture', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', url], { stdio: 'ignore', detached: true, windowsHide: true }); chrome?.unref(); // detached: libuv ties a child to its parent's Windows job, so a non-detached Chrome would die with this process (and a server restart would close it)
let port = reuse ? new URL(reuse).port : undefined; for (let i = 0; i < 600 && !port; i++) { await sleep(100); port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0] || undefined; }
if (reuse) { // navigate the existing tab (the address bar's job) instead of starting a browser
  const tab = (await (await fetch(`${reuse}/json/list`)).json()).find(t => t.type === 'page'); if (!tab) throw new Error(`VERIFY_CHROME: no open tab at ${reuse}`);
  const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url } })); await new Promise(r => ws.on('message', m => JSON.parse(m).id === 1 && r())); ws.close();
}
const previous = reuse ? JSON.parse(await readFile(join(S, 'env.json'), 'utf8').catch(() => '{}')) : {};
await writeFile(join(S, 'env.json'), JSON.stringify({ origin: s.origin, token: s.token, cookie: s.cookie, projectId: s.projectId, repo: s.repo, data: s.data, temp: s.temp, hub: hub.url, cdp: reuse || `http://127.0.0.1:${port}`, startedAt: previous.startedAt ?? Date.now(), chromeProfile: profile ?? previous.chromeProfile, agentBase: s.agents?.base, agentFresh: s.agents?.fresh, keychain: s.agents?.keychain, temp2: second.temp, origin2: second.origin, token2: second.token, cookie2: second.cookie, pid: process.pid, serverPids: [s.child.pid, second.child.pid], chromePid: chrome?.pid ?? previous.chromePid }));
console.log('READY', s.origin, port);
const stop = async () => { chrome?.kill(); await s.stop(); await second.stop(); await hub.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop); setInterval(() => {}, 1 << 30);
