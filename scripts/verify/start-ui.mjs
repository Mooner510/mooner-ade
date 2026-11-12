// Long-running: isolated server + fake Hub + visible Chrome. Writes env.json (into VERIFY_OUT) for the driver scripts. Ctrl-C / SIGTERM stops all.
// Chrome shares only the tab for getDisplayMedia (--auto-accept-this-tab-capture); an "Entire screen" auto-select flag makes captures screen-sized.
import { boot, fakeHub, sleep, S } from './lib.mjs'; import { spawn } from 'node:child_process'; import { writeFile, readFile, mkdtemp } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const hub = await fakeHub(); const s = await boot({ env: { ADE_HUB_URL: hub.url } });
const second = await boot({ env: { ADE_HUB_URL: hub.url }, repoFiles: false }); // for the no-project welcome screen: forget the auto-opened project below
const profile = await mkdtemp(join(tmpdir(), 'ade-verify-chrome-'));
const chrome = spawn(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--window-size=1500,950', '--use-fake-ui-for-media-stream', '--auto-accept-this-tab-capture', `${s.origin}/#token=${s.token}`], { stdio: 'ignore' });
let port; for (let i = 0; i < 100 && !port; i++) { await sleep(100); port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0] || undefined; }
await writeFile(join(S, 'env.json'), JSON.stringify({ origin: s.origin, token: s.token, cookie: s.cookie, projectId: s.projectId, repo: s.repo, data: s.data, temp: s.temp, hub: hub.url, cdp: `http://127.0.0.1:${port}`, origin2: second.origin, token2: second.token, cookie2: second.cookie, pid: process.pid, chromePid: chrome.pid }));
console.log('READY', s.origin, port);
const stop = async () => { chrome.kill(); await s.stop(); await second.stop(); await hub.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop); setInterval(() => {}, 1 << 30);
