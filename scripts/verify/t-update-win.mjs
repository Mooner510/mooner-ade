// Windows: the whole self-update of a packaged build, isolated. Needs `pnpm package` first (apps/desktop/dist/MoonerADE-win32-x64).
//   VERIFY_OUT=<folder from `session.mjs new update --folder-only --reason …`> node scripts/verify/t-update-win.mjs [--installed-from <packaged folder>] [--next-from <packaged folder>] [--full]
//     [--installed-version <x.y.z>] [--next-version <x.y.z>] [--drive [--throttle <MB/s>] | --on-quit | --quit-dialog]
// --quit-dialog is --on-quit with a terminal running when the window is closed: the native "종료할까요?" question (worded after the waiting update) is read through UI Automation
// (dialog-tool.ps1, only windows of the app's own process) and answered with its update button; the terminal has to come back in the new app. The wording is that of the
// *installed* app, so it needs a build that has it as the installed one (--installed-from = the candidate, versions 0.6.0 → 0.6.1, with --no-startup-checks).
// A copy of the build, renamed 0.0.1, runs from a temp folder with its own profile (ADE_USER_DATA_DIR), data, HOME and TEMP and a fake release
// (ADE_UPDATE_URL) offering 9.9.9 as GitHub would (app-only zip + manifest, or with --full only the full zip; sha256 digests). ADE_UPDATE_ANSWER takes
// "지금 업데이트". --installed-from / --next-from take other packaged folders: an older build as the installed one tests an update started by
// an older version's helper (the app that is updated *to* is what has to cope with it).
// --installed-version / --next-version name the two builds (default 0.0.1 and 9.9.9; pass the versions a user has, e.g. 0.5.12 and 0.6.0).
// --drive also works the packaged app over its DevTools port, like a user: a terminal runs a counting loop, the update is started from the settings button
// (adeDesktop.checkUpdate) while the fake release hands the zip out slowly (--throttle, default 6 MB/s), the progress card is captured while it fills, and after the
// restart the same terminal (same shell process, the loop still counting) and the window are checked and captured (shots/ in VERIFY_OUT).
// With --drive the profile is one that finished the first-run tour with a project open (a user who updates, not a first run; --first-run keeps the empty profile), and after the
// restart the new app's own start-up is watched: its notes (changelog window) open once, alone, before the one-time Git card, and a second start of the same copy shows no notice again.
// Checks: the app is replaced by the next version and starts again under the same isolated profile with a window, no console window is visible at any moment
// of the update (console-watch.ps1), the restarted app is not on any console (console-tool.ps1), closing the console it would have shared does not
// end it, the scratch folder is gone, and the real MoonerADE processes were not touched. The 9.9.9 copy gets its isolation written into its main.js
// because the updater starts it from WMI, which hands over no environment.
// With an older build as --installed-from, that build's own helper still flashes its console for a moment: the "no console window" line fails then,
// and the lines about the restarted app show whether it copes (it hands over to a copy that is off the console).
// Works in VERIFY_OUT/update-* and leaves env.json { temp } there; the processes it started are stopped here (found by the temp folder in their path,
// never by name), `session.mjs down <세션>` removes the folder.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { ROOT, S, sleep, WebSocket } from './lib.mjs';

if (process.platform !== 'win32') { console.error('Windows 전용입니다.'); process.exit(2); }
const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const dist = join(ROOT, 'apps/desktop/dist/MoonerADE-win32-x64');
const installedFrom = resolve(option('--installed-from') ?? dist), nextFrom = resolve(option('--next-from') ?? dist);
const installedVersion = option('--installed-version') ?? '0.0.1', nextVersion = option('--next-version') ?? '9.9.9', quitDialog = args.includes('--quit-dialog'), onQuit = args.includes('--on-quit') || quitDialog, drive = args.includes('--drive') || onQuit, throttle = Number(option('--throttle') ?? 6);
if (![installedVersion, nextVersion].every(version => /^\d+\.\d+\.\d+$/.test(version))) { console.error('--installed-version / --next-version는 x.y.z 형식이어야 합니다.'); process.exit(2); }
for (const folder of [installedFrom, nextFrom]) if (!existsSync(join(folder, 'MoonerADE.exe'))) { console.error(`${folder}에 MoonerADE.exe가 없습니다. 먼저 pnpm package를 실행하세요.`); process.exit(2); }
if (existsSync(join(S, 'env.json'))) { console.error(`${S}에 이미 다른 세션이 있습니다. 새 VERIFY_OUT을 쓰세요.`); process.exit(2); }

const temp = realpathSync(mkdtempSync(join(S, 'update-')));
writeFileSync(join(S, 'env.json'), JSON.stringify({ temp, startedAt: Date.now() }));
const dirs = Object.fromEntries(['install', 'next', 'release', 'user', 'data', 'home', 'tmp'].map(name => [name, join(temp, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir);
const results = [], record = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };
const lower = value => String(value ?? '').toLowerCase();

// ---- helpers -------------------------------------------------------------------------------------------------------
// Progress output would arrive as CLIXML on stderr; stderr is dropped.
const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ${script}`, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const processes = () => { const out = ps('Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress').trim(); const list = out ? JSON.parse(out) : []; return Array.isArray(list) ? list : [list]; };
const inTemp = item => lower(item.ExecutablePath).startsWith(`${lower(temp)}\\`) || lower(item.CommandLine).includes(lower(temp));
const ours = () => processes().filter(inTemp);
const realApps = () => processes().filter(item => /^moonerade\.exe$/i.test(item.Name) && !inTemp(item)).map(item => item.ProcessId).sort((a, b) => a - b);
const robocopy = (from, to) => { const run = spawnSync('robocopy', [from, to, '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { windowsHide: true }); if (run.status >= 8) throw new Error(`robocopy ${run.status}`); };
const tool = (mode, pid) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts/verify/console-tool.ps1'), '-Mode', mode, '-ProcessId', String(pid)], { windowsHide: true }).status;
const alive = pid => processes().some(item => item.ProcessId === pid);
// ---- --drive: the packaged app's page over its DevTools port (only the page of the app itself, on 127.0.0.1) ---------------------------------------------
async function cdp(port) {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find(item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url));
  if (!page) throw new Error('앱의 화면이 아직 없습니다.');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => { ws.once('open', done); ws.once('error', fail); });
  let id = 0;
  const waiting = new Map();
  ws.on('message', raw => { const message = JSON.parse(raw); const entry = waiting.get(message.id); if (entry) { waiting.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; waiting.set(key, { resolve, reject }); ws.send(JSON.stringify({ id: key, method, params })); setTimeout(() => { if (waiting.delete(key)) reject(new Error(`CDP timeout ${method}`)); }, 20_000); });
  const ev = async expression => { const result = await send('Runtime.evaluate', { expression: `(async()=>{${expression}})()`, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  const shot = async name => { const result = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(S, 'shots', `${name}.png`), Buffer.from(result.data, 'base64')); return name; };
  return { send, ev, shot, close: () => ws.close() };
}
// The page of a (re)started app: its server is up and the preload bridge is there.
async function appPage(port, ms = 90_000) {
  const end = Date.now() + ms;
  let last = new Error('timeout');
  while (Date.now() < end) {
    try { const page = await cdp(port); if (await page.ev('return document.readyState === "complete" && Boolean(window.adeDesktop)')) return page; page.close(); } catch (error) { last = error; }
    await sleep(500);
  }
  throw last;
}
const post = (page, action, body) => page.ev(`const response = await fetch('/api/${action}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }); const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;`);
// What is on the screen of a page, as the notices (the tour, the splash, the changelog window, the cards in the dock strip) are seen by a user.
const SCREEN = `
  const shown = element => Boolean(element && element.getClientRects().length);
  const modal = document.querySelector('.changelog:not(.closing)'); // a closed dialog plays its exit (160ms) on a detached copy marked .closing
  return JSON.stringify({ tour: shown(document.querySelector('.tour')), splash: shown(document.querySelector('.splash')), modal: shown(modal), entry: modal?.querySelector('.changelog-entry')?.getAttribute('aria-label') ?? null,
    cards: [...document.querySelectorAll('.notice-dock > *, .hint-card, .bg-anim-tip, .chat-mode-tip')].filter(shown).map(element => element.getAttribute('aria-label') || String(element.className).slice(0, 30)),
    dot: [...document.querySelectorAll('button[aria-label^="변경 내역"]')].map(button => button.getAttribute('aria-label')).join('|') });`;
// From the moment the restarted app has a page: every change of what is on the screen, with the time. Stops with `stop()`.
function watchStartup(port) {
  const timeline = [], watching = { stop: false };
  const done = (async () => {
    const page = await appPage(port, 90_000);
    let last = '';
    while (!watching.stop) {
      try { const now = await page.ev(SCREEN); if (now !== last) { last = now; timeline.push({ at: Date.now(), ...JSON.parse(now) }); } } catch { /* the page reloads while it starts */ }
      await sleep(100);
    }
    page.close();
  })();
  return { timeline, stop: async () => { watching.stop = true; await done.catch(() => {}); } };
}
// A project the next start reopens by itself (the page saves its own open list only when the user changes it), kept in the saved state beside the profile's settings.
async function keepProjectOpen(page, project) {
  const state = await post(page, 'app/state', {});
  await post(page, 'app/state', { state: { openProjects: [{ id: project.id, root: project.root }], activeProjectId: project.id, settings: state.settings } });
  await sleep(2500); // the 0.5.12 page may save its own (empty) list once after it booted: look again
  const now = await post(page, 'app/state', {});
  if (!now.openProjects?.some(item => item.id === project.id)) await post(page, 'app/state', { state: { openProjects: [{ id: project.id, root: project.root }], activeProjectId: project.id, settings: now.settings } });
}
const visibleWindows = pids => ps(`Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class Win { delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l); [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  public static string[] Of(uint[] pids) { var list = new List<string>(); var set = new HashSet<uint>(pids);
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (set.Contains(p) && IsWindowVisible(h)) { var c = new StringBuilder(256); GetClassName(h, c, 256); list.Add(p + ":" + c); } return true; }, IntPtr.Zero); return list.ToArray(); } }
'@
[Win]::Of([uint32[]](${pids.join(',')})) | ConvertTo-Json -Compress`).trim();

// ---- the two builds ------------------------------------------------------------------------------------------------
const exeOf = root => join(root, 'MoonerADE.exe');
const setVersion = (root, version) => { const file = join(root, 'resources/app/package.json'); writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), version })); };
const installed = join(dirs.install, 'MoonerADE-win32-x64'), next = join(dirs.next, 'MoonerADE-win32-x64'), startsLog = join(temp, 'next-starts.log');
robocopy(installedFrom, installed); setVersion(installed, installedVersion);
robocopy(nextFrom, next); setVersion(next, nextVersion);
const freePort = () => new Promise(done => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); }); });
const cdpPort = drive ? await freePort() : 0, nextPort = drive ? await freePort() : 0; // the restarted app gets a port of its own: the old app's children may still hold the first one
const isolated = { ADE_USER_DATA_DIR: dirs.user, ADE_DATA_DIR: dirs.data, ADE_NVIDIA_CHECK: '0', USERPROFILE: dirs.home, HOME: dirs.home, TEMP: dirs.tmp, TMP: dirs.tmp, CLAUDE_CONFIG_DIR: join(dirs.home, '.claude'), CODEX_HOME: join(dirs.home, '.codex') };
{ // The updater starts the new app from WMI, which gives it the user's default environment, so the copy carries its isolation itself.
  const file = join(next, 'resources/app/apps/desktop/src/main.js'), code = readFileSync(file, 'utf8'), anchor = '// Keep the existing profile when changing the displayed product name.';
  if (!code.includes(anchor)) throw new Error('main.js에서 프로필 지정 위치를 찾지 못했습니다.');
  // Every start of this copy leaves a line (pid, parent, the marker it was given, whether stdout is a console), so a hand-over shows up as two starts.
  const note = '`${process.pid} ppid=${process.ppid} marker=${process.env.ELECTRON_NO_ATTACH_CONSOLE ?? ""} console=${process.getBuiltinModule("node:tty").isatty(1)}\\n`';
  const injected = `// injected by scripts/verify/t-update-win.mjs\nObject.assign(process.env, ${JSON.stringify(isolated)});\n${drive ? `app.commandLine.appendSwitch('remote-debugging-port', '${nextPort}');\n` : ''}try { process.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(startsLog)}, ${note}); } catch { /* the log is only evidence */ }\n${anchor}`;
  writeFileSync(file, code.replace(anchor, () => injected));
}
const runtimeShell = root => JSON.parse(readFileSync(join(root, 'resources/runtime/runtime.json'), 'utf8')).shell;
const asset = 'MoonerADE-win32-x64', tar = join(process.env.SystemRoot, 'System32', 'tar.exe');
const full = args.includes('--full') || runtimeShell(installed) !== runtimeShell(next);
if (full && !args.includes('--full')) console.log('NOTE 두 빌드의 shell 키가 달라 전체 업데이트로 진행합니다.');
if (full) execFileSync(tar, ['-a', '-c', '-f', join(dirs.release, `${asset}.zip`), '-C', dirs.next, 'MoonerADE-win32-x64']);
else {
  writeFileSync(join(dirs.release, `${asset}.zip`), 'unused: the app-only zip is enough');
  execFileSync(tar, ['-a', '-c', '-f', join(dirs.release, `${asset}-app.zip`), '-C', join(next, 'resources'), 'app']);
  writeFileSync(join(dirs.release, `${asset}.json`), JSON.stringify({ version: nextVersion, shell: runtimeShell(next) }));
}

// ---- the fake GitHub -----------------------------------------------------------------------------------------------
const served = [];
// With --drive the release lookup answers with the installed version itself (nothing newer) until the script offers the update.
const offer = { on: !drive };
const server = http.createServer((req, res) => {
  served.push(req.url);
  if (req.url === '/repos/Mooner510/mooner-ade/releases/latest') {
    const port = server.address().port;
    const assets = readdirSync(dirs.release).map(name => {
      const file = join(dirs.release, name);
      return { name, size: statSync(file).size, digest: `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`, browser_download_url: `http://127.0.0.1:${port}/assets/${name}` };
    });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ tag_name: `v${offer.on ? nextVersion : installedVersion}`, draft: false, assets })); return;
  }
  const name = decodeURIComponent(req.url.replace(/^\/assets\//, '')), file = join(dirs.release, name);
  if (!req.url.startsWith('/assets/') || name.includes('/') || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-length': statSync(file).size });
  if (!drive || !/.zip$/.test(name)) { createReadStream(file).pipe(res); return; }
  // A zip is handed out slowly, so the progress card can be looked at while it fills.
  const chunk = Math.max(1, Math.round(throttle * 1048576 / 20)), body = readFileSync(file);
  let at = 0;
  const timer = setInterval(() => { if (at >= body.length || res.destroyed) { clearInterval(timer); res.end(); return; } res.write(body.subarray(at, at + chunk)); at += chunk; }, 50);
  res.on('close', () => clearInterval(timer));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));

// ---- watch for console windows, then run the installed copy ---------------------------------------------------------
const realBefore = realApps();
const watch = { stop: join(temp, 'watch.stop'), out: join(temp, 'watch.json'), ready: join(temp, 'watch.ready') };
// Not detached: PowerShell without any console does not start (it ends with this script, which it needs anyway).
spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts/verify/console-watch.ps1'), '-Stop', watch.stop, '-Out', watch.out, '-Ready', watch.ready], { stdio: 'ignore', windowsHide: true });
for (let i = 0; i < 150 && !existsSync(watch.ready); i++) await sleep(200);
if (!existsSync(watch.ready)) throw new Error('콘솔 창 감시가 시작되지 않았습니다.');

// A 0.5.12 profile of someone who finished the tour: saved settings with no Git-card field (0.5.12 did not know it), no project open until the script opens one.
const onboarded = drive && !args.includes('--first-run');
if (onboarded) writeFileSync(join(dirs.data, 'app-state.json'), JSON.stringify({ version: 1, openProjects: [], activeProjectId: '', settings: { theme: 'dark', onboarded: true, tourVersion: 2, defaultMode: 'cli', chatTipPending: false, chatPermissionAutoSet: true } }));
const started = Date.now();
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ADE_|ELECTRON_)/.test(name)));
// ELECTRON_NO_ATTACH_CONSOLE: this first start stands in for a launch from Explorer or a shortcut, which has no console to join.
const child = spawn(exeOf(installed), drive ? [`--remote-debugging-port=${cdpPort}`] : [], { env: { ...env, ...isolated, ADE_UPDATE_URL: `http://127.0.0.1:${server.address().port}`, ADE_UPDATE_ANSWER: onQuit ? '종료할 때 업데이트|확인' : '지금 업데이트|중단하고 업데이트|확인', ELECTRON_NO_ATTACH_CONSOLE: '1' }, stdio: 'ignore', detached: true, windowsHide: true, cwd: dirs.home }); // cwd: whatever the app and its children write relative to it (a PowerShell module cache) lands in the temp folder, not in the checkout
child.unref();
let exit = null;
let exitAt = 0;
child.once('exit', (code, signal) => { exit = { code, signal }; exitAt = Date.now(); });
const mains = () => ours().filter(item => lower(item.ExecutablePath) === lower(exeOf(installed)) && !/--type=/.test(item.CommandLine ?? ''));

let before = null, after = null, finalMain = null, overlayWatch = Promise.resolve();
const drove = { states: [], values: [] };
const readTicks = () => existsSync(drove.tickFile ?? '') ? readFileSync(drove.tickFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => Number(BigInt(line) / 10000n) - 62135596800000) : [];
try {
  for (let i = 0; i < 200 && !before; i++) { before = mains()[0]; if (!before) await sleep(300); }
  record(`설치본(${installedVersion})이 시작`, Boolean(before), before ? `pid ${before.ProcessId}` : '프로세스 없음');
  if (drive && before && onQuit) {
    // "종료할 때 업데이트": the package is downloaded and unpacked while the app goes on, then installed when the user quits (the window's X).
    const page = await appPage(cdpPort);
    if (onboarded) {
      drove.repo = join(temp, 'repo'); mkdirSync(drove.repo); spawnSync('git', ['init', '-q', '-b', 'main', drove.repo], { windowsHide: true });
      const project = await post(page, 'project/open', { path: drove.repo });
      await keepProjectOpen(page, project);
      if (quitDialog) drove.terminal = await post(page, 'terminal/open', { projectId: project.id }); // a live terminal makes the window's X ask what to do with it
    }
    if (quitDialog && !drove.terminal) throw new Error('--quit-dialog needs the onboarded profile (not --first-run)');
    offer.on = true;
    void page.send('Runtime.evaluate', { expression: 'window.adeDesktop.checkUpdate()' }).catch(() => {});
    const staged = () => readdirSync(dirs.tmp).filter(name => name.startsWith('mooner-update-')).some(name => {
      const dir = join(dirs.tmp, name);
      return existsSync(join(dir, 'new')) && readdirSync(join(dir, 'new')).length > 0 && !readdirSync(dir).some(file => file.endsWith('.zip'));
    });
    for (let i = 0; i < 240 && !staged(); i++) await sleep(500);
    await sleep(3000); // the "받아 두었습니다" notice is shown for a second before the check ends
    const stillOld = (() => { try { return JSON.parse(readFileSync(join(installed, 'resources/app/package.json'), 'utf8')).version === installedVersion; } catch { return false; } })();
    record('종료할 때 업데이트: 받아 두는 동안 앱은 계속 실행되고 설치 폴더는 그대로', staged() && !exit && stillOld && alive(before.ProcessId), `받아 둔 폴더 ${staged() ? '있음' : '없음'}, 앱 ${exit ? '종료됨' : '실행 중'}, 설치 폴더 ${stillOld ? '그대로' : '바뀜'}`);
    await page.shot('update-staged');
    // The user quits: the update is installed and the app comes back.
    void page.send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {});
    if (quitDialog) {
      // The question names what the quit does: with an update waiting, "종료" would promise an end that does not happen. Its buttons are not visible to UI Automation (a task dialog),
      // so the text is read and the button is chosen with the keyboard: Electron focuses the last one (취소), Shift+Tab reaches "업데이트하고 다시 시작", Enter presses it.
      const dialogTool = (mode, keys = '') => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts/verify/dialog-tool.ps1'), '-ProcessId', String(before.ProcessId), '-Mode', mode, ...(keys ? ['-Keys', keys] : [])], { encoding: 'utf8', windowsHide: true });
      let question = null, lastRead = '';
      for (let i = 0; i < 40 && !question; i++) {
        await sleep(500);
        try { const run = dialogTool('read'), out = run.stdout.trim(); lastRead = out.slice(0, 300); const list = out ? [].concat(JSON.parse(out)) : []; question = list.find(item => item.texts.some(line => /종료할까요/.test(line))) ?? null; } catch { /* not there yet */ }
      }
      const text = question ? question.texts.join(' ') : '';
      record('종료 확인 창이 받아 둔 업데이트를 실제 동작대로 안내', Boolean(question) && /터미널 1개가 열려 있습니다/.test(text) && /업데이트하고 다시 시작: 받아 둔 업데이트\(v[\d.]+\)를 설치하고 앱을 다시 실행합니다\. 터미널과 채팅은 끝나지 않고 새 창에서 이어집니다/.test(text) && /백그라운드로 남기기: .*설치하지 않고 다음에 종료할 때로 미룹니다/s.test(text) && !/(^|\n)종료: /.test(text), question ? text.replace(/\s+/g, ' ').slice(0, 520) : `창을 찾지 못함 (${lastRead || '출력 없음'})`);
      const answered = question ? dialogTool('keys', '+{TAB}~').status : null; // Shift+Tab, Enter
      record('종료 확인 창의 "업데이트하고 다시 시작"을 키보드로 고름', answered === 0, `dialog-tool 종료 코드 ${answered}`);
    }
  }
  if (drive && before && !onQuit) {
    const page = await appPage(cdpPort);
    drove.origin = await page.ev('return location.origin');
    await page.ev(`localStorage.setItem('ade-update-probe', '1')`);
    drove.repo = join(temp, 'repo');
    mkdirSync(drove.repo);
    spawnSync('git', ['init', '-q', '-b', 'main', drove.repo], { windowsHide: true });
    const project = await post(page, 'project/open', { path: drove.repo });
    drove.terminal = await post(page, 'terminal/open', { projectId: project.id });
    if (onboarded) await keepProjectOpen(page, project);
    drove.pidFile = join(temp, 'shell.pid'); drove.tickFile = join(temp, 'ticks.txt');
    await page.ev(`
      const out = window.__ticker = { text: '' };
      const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws');
      ws.onmessage = event => { try { const message = JSON.parse(event.data); if (message.id === ${JSON.stringify(drove.terminal.id)} && typeof message.data === 'string') out.text = (out.text + message.data).slice(-4000); } catch {} };
      await new Promise((done, fail) => { ws.onopen = done; ws.onerror = () => fail(new Error('websocket')); });
      ws.send(JSON.stringify({ type: 'subscribe', projectId: ${JSON.stringify(project.id)} }));
      out.ws = ws;
    `);
    // The shell's prompt first: a profile may still be loading, and input sent too early is not echoed back.
    for (let i = 0; i < 60 && !/>\s*$/.test(await page.ev('return window.__ticker.text')); i++) await sleep(500);
    const loop = `Set-Content -LiteralPath '${drove.pidFile}' -Value $PID; while ($true) { Add-Content -LiteralPath '${drove.tickFile}' -Value ([DateTime]::UtcNow.Ticks); Start-Sleep -Milliseconds 300 }`;
    await page.ev(`window.__ticker.ws.send(JSON.stringify({ type: 'terminal/input', projectId: ${JSON.stringify(project.id)}, id: ${JSON.stringify(drove.terminal.id)}, data: ${JSON.stringify(`${loop}\r`)} }))`);
    for (let i = 0; i < 60 && readTicks().length < 5; i++) await sleep(500);
    drove.shellPid = Number(existsSync(drove.pidFile) ? readFileSync(drove.pidFile, 'utf8').trim() : 0) || null;
    record('업데이트 전: 터미널의 반복 명령이 실행 중', Boolean(drove.shellPid) && readTicks().length >= 5 && alive(drove.shellPid), `셸 pid ${drove.shellPid}, 기록 ${readTicks().length}번`);
    await page.shot('update-before');
    // The settings button's check, as a user starts it: the fake release now offers the next version.
    offer.on = true;
    void page.send('Runtime.evaluate', { expression: 'window.adeDesktop.checkUpdate()' }).catch(() => {});
    overlayWatch = (async () => {
      let seen = null;
      while (!exit) {
        try {
          seen ??= await cdp(cdpPort);
          const card = await seen.ev(`const box = document.querySelector('#ade-update-progress'); if (!box) return null; const bar = box.querySelector('[role=progressbar]'); return { text: box.innerText.replace(/\\s+/g, ' ').trim(), value: bar?.getAttribute('aria-valuenow') ?? null };`);
          if (card) {
            const step = card.text.replace(/[\d.]+/g, '#');
            if (!drove.states.includes(step)) drove.states.push(step);
            if (card.value !== null) drove.values.push(Number(card.value));
            if (/다운로드 중/.test(card.text) && Number(card.value) >= 30 && !drove.shotDownload) drove.shotDownload = await seen.shot('update-progress-downloading');
            if (/다운로드 중/.test(card.text) && Number(card.value) >= 80 && !drove.shotLate) drove.shotLate = await seen.shot('update-progress-late');
            if (/다시 시작/.test(card.text) && !drove.shotRestart) drove.shotRestart = await seen.shot('update-progress-restart');
          }
        } catch { seen = null; }
        await sleep(120);
      }
    })();
  }
  while (!exit && Date.now() - started < 240_000) await sleep(300);
  record('업데이트 문의에 응답하고 받음', served.some(url => url.endsWith(full ? `${asset}.zip` : `${asset}-app.zip`)), served.join(', '));
  record('이전 앱이 정상 종료', exit?.code === 0, JSON.stringify(exit));
  // The new app may start twice when an older helper starts it on a console (it hands over to a copy), so wait for one that stays.
  for (let i = 0; i < 120 && !after; i++) { await sleep(1000); after = mains().find(item => item.ProcessId !== before?.ProcessId); }
  record('새 버전이 다시 실행', Boolean(after), after ? `pid ${after.ProcessId}` : '프로세스 없음');
  const startup = onboarded && !args.includes('--no-startup-checks') ? watchStartup(nextPort) : null; // (--no-startup-checks: a version without notes of its own, e.g. 0.6.0 → 0.6.1)
  await sleep(10_000);
  finalMain = mains().sort((a, b) => b.ProcessId - a.ProcessId)[0] ?? null;
  if (drive) {
    await overlayWatch;
    const downloading = drove.values.filter(value => Number.isFinite(value));
    if (!onQuit) record('진행 카드가 다운로드 진행률을 그림', drove.states.some(step => /다운로드 중/.test(step)) && Math.max(0, ...downloading) >= 80 && downloading.some(value => value > 0 && value < 100), `${drove.states.join(' → ')} / 진행률 ${downloading.length}번 읽음, 최대 ${Math.max(0, ...downloading)}`);
    if (!onQuit) record('진행 카드가 재시작 단계까지 표시', drove.states.some(step => /다시 시작/.test(step)), `스크린샷 ${[drove.shotDownload, drove.shotLate, drove.shotRestart].filter(Boolean).join(', ') || '없음'}`);
    const page = await appPage(nextPort, 60_000);
    const info = await page.ev('return await window.adeDesktop.appInfo()');
    record('새 앱이 자기 버전을 알림', info.version === nextVersion, JSON.stringify(info));
    const origin = await page.ev('return location.origin'), probe = await page.ev(`return localStorage.getItem('ade-update-probe')`);
    console.log(`NOTE 화면 localStorage는 재시작 뒤 ${probe === '1' ? '유지됨' : '비어 있음'} (주소 ${drove.origin} → ${origin})`);
    // The changelog's "which version ran last" must outlive the page's origin (it changes with every launch): the app keeps it in a file of its own.
    const last = await page.ev(`return window.adeDesktop.changelogStore ? window.adeDesktop.changelogStore.getItem('ade-changelog-last') : 'no-bridge'`);
    if (last === 'no-bridge') console.log('NOTE 이 빌드에는 changelogStore가 없습니다(옛 빌드).');
    else record('변경 내역의 마지막 실행 버전이 앱 데이터 파일에 저장됨', last === nextVersion && existsSync(join(dirs.user, 'changelog-state.json')), `마지막 실행 ${last}, ${existsSync(join(dirs.user, 'changelog-state.json')) ? readFileSync(join(dirs.user, 'changelog-state.json'), 'utf8') : '파일 없음'}`);
    if (drove.terminal) {
      const opened = await post(page, 'project/open', { path: drove.repo });
      const kept = (opened.terminals ?? []).find(item => item.id === drove.terminal.id);
      record('터미널이 새 앱에서 같은 id로 이어짐', Boolean(kept) && !kept.exited, JSON.stringify(kept ?? opened.terminals));
      if (drove.tickFile) { // (--quit-dialog opens a terminal but runs no counting loop in it)
        const ticks = readTicks(), gaps = ticks.slice(1).map((time, index) => time - ticks[index]), resumed = ticks.filter(time => time > exitAt).length;
        record('터미널 안의 셸과 반복 명령이 업데이트를 넘어 계속됨', Boolean(drove.shellPid) && alive(drove.shellPid) && resumed >= 5 && Date.now() - ticks.at(-1) < 3000,
          `셸 pid ${drove.shellPid} ${alive(drove.shellPid) ? '살아 있음' : '없음'}, 이전 앱 종료 뒤 기록 ${resumed}번, 가장 긴 간격 ${Math.max(0, ...gaps)}ms`);
      }
    }
    await page.shot('update-after');
    if (startup) {
      // The notes of the new version open by themselves, once, and nothing else is on the screen with them: the Git card (this profile never saw it) waits until they are closed.
      const screen = async () => JSON.parse(await page.ev(SCREEN));
      for (let i = 0; i < 80 && !(await screen()).modal; i++) await sleep(250);
      const withNotes = await screen();
      record('업데이트 뒤 변경 내역 창이 저절로 열림', withNotes.modal && withNotes.entry?.startsWith('v'), `${withNotes.entry}, 카드 ${JSON.stringify(withNotes.cards)}, 빨간 점 "${withNotes.dot}"`);
      record('변경 내역이 열려 있는 동안 다른 안내가 없음', withNotes.cards.length === 0 && !withNotes.tour && !withNotes.splash, JSON.stringify(withNotes));
      await page.shot('update-after-changelog');
      await page.ev(`document.querySelector('.changelog:not(.closing) button[aria-label="닫기"]').click()`);
      let withCard = null;
      for (let i = 0; i < 40 && !withCard?.cards.length; i++) { await sleep(250); withCard = await screen(); }
      record('변경 내역을 닫으면 Git 안내 카드가 하나만 나옴', !withCard.modal && withCard.cards.length === 1 && /Git 그래프/.test(withCard.cards[0]), JSON.stringify(withCard));
      await sleep(900); // the card slides in
      await page.shot('update-after-gitcard');
      record('변경 내역을 본 뒤에는 빨간 점이 없음', withCard.dot === '변경 내역', `"${withCard.dot}"`);
      await page.ev(`[...document.querySelectorAll('.git-graph-tip button')].find(button => button.textContent.trim() === '확인').click()`);
      await sleep(1500);
      const quiet = await screen();
      record('안내를 모두 마치면 화면에 안내가 남지 않음', !quiet.modal && quiet.cards.length === 0, JSON.stringify(quiet));
      await page.shot('update-after-quiet');
      await startup.stop();
      const overlapping = startup.timeline.filter(item => item.tour || (item.splash && (item.modal || item.cards.length)) || (item.modal && item.cards.length) || item.cards.length > 1);
      const order = startup.timeline.map(item => item.tour ? '둘러보기' : item.splash ? '스플래시' : item.modal ? '변경 내역' : item.cards.length ? '카드' : '-').filter((name, at, list) => name !== list[at - 1]).join(' → ');
      record('안내가 겹친 순간이 한 번도 없음', startup.timeline.length > 0 && overlapping.length === 0, `${startup.timeline.length}개 상태, 순서 ${order}${overlapping.length ? `, 겹침 ${JSON.stringify(overlapping[0])}` : ''}`);
    }
    page.close();
  }
  const version = (() => { try { return JSON.parse(readFileSync(join(installed, 'resources/app/package.json'), 'utf8')).version; } catch { return null; } })();
  record(`설치 폴더의 앱이 ${nextVersion}로 교체`, version === nextVersion, version ?? '읽기 실패');
  record('새 앱이 계속 실행(곧 종료되지 않음)', Boolean(finalMain), finalMain ? `pid ${finalMain.ProcessId}` : '10초 안에 사라짐');
  record('재실행이 격리 프로필을 사용', ours().some(item => lower(item.CommandLine).includes(lower(`--user-data-dir=${dirs.user}`)) || lower(item.CommandLine).includes(lower(`--user-data-dir="${dirs.user}"`))), dirs.user);
  const tree = new Set(ours().filter(item => lower(item.ExecutablePath).startsWith(`${lower(installed)}\\`)).map(item => item.ProcessId));
  const windows = finalMain ? JSON.parse(visibleWindows([...tree]) || '[]') : [];
  record('새 앱의 창이 보임', [].concat(windows).some(item => item.endsWith(':Chrome_WidgetWin_1')), JSON.stringify(windows));
  const attached = finalMain ? tool('attached', finalMain.ProcessId) : null;
  record('새 앱이 콘솔에 붙어 있지 않음', attached === 11, attached === 10 ? '콘솔에 붙어 있음' : `exit ${attached}`);
  const starts = existsSync(startsLog) ? readFileSync(startsLog, 'utf8').trim().split('\n') : [];
  console.log(`NOTE 새 앱의 시작 기록 ${starts.length}번: ${starts.join(' | ')}  (console=true, marker 없음 → 콘솔에 붙은 채 시작; 뒤이어 marker=1 → 콘솔에서 분리된 복사본이 이어받음)`);
  for (let i = 0; i < 40 && readdirSync(dirs.tmp).some(name => name.startsWith('mooner-update-')); i++) await sleep(500);
  record('업데이트 임시 폴더가 정리됨', !readdirSync(dirs.tmp).some(name => name.startsWith('mooner-update-')), readdirSync(dirs.tmp).join(', '));
  // The console windows seen so far are the update's; closing one on purpose comes after, so it is not counted.
  writeFileSync(watch.stop, '1');
  for (let i = 0; i < 100 && !existsSync(watch.out); i++) await sleep(200);
  const seen = existsSync(watch.out) ? JSON.parse(readFileSync(watch.out, 'utf8').replace(/^﻿/, '') || '[]') : null;
  record('업데이트 동안 콘솔 창이 한 번도 보이지 않음', Array.isArray(seen) && seen.length === 0, seen ? seen.map(item => `${item.class} "${item.title}" ${item.lastMs - item.firstMs}ms (부모 ${item.ownerParent})`).join(' | ') : '감시 결과 없음');
  // What the user did: closing the window of the console the app shares. With no console there is nothing to close.
  if (finalMain) {
    const closed = tool('close', finalMain.ProcessId);
    await sleep(4000);
    record('콘솔 창을 닫아도 앱이 살아 있음', closed === 11 || alive(finalMain.ProcessId), closed === 11 ? '닫을 콘솔이 없음' : alive(finalMain.ProcessId) ? '콘솔을 닫았지만 계속 실행' : '콘솔을 닫자 앱이 종료됨');
  }
  if (startup && finalMain) {
    // Closed and opened again (the terminal's own shell may still run, so the app is ended by its pid like a crash would): the same copy now shows no notice at all.
    try { process.kill(finalMain.ProcessId); } catch { /* gone */ }
    for (let i = 0; i < 40 && alive(finalMain.ProcessId); i++) await sleep(250);
    for (const item of ours().filter(entry => /--type=/.test(entry.CommandLine ?? '') && lower(entry.ExecutablePath) === lower(exeOf(installed)))) { try { process.kill(item.ProcessId); } catch { /* gone */ } }
    await sleep(2000);
    spawn(exeOf(installed), [], { env: { ...env, ...isolated, ADE_UPDATE_URL: `http://127.0.0.1:${server.address().port}`, ADE_UPDATE_ANSWER: '확인', ELECTRON_NO_ATTACH_CONSOLE: '1' }, stdio: 'ignore', detached: true, windowsHide: true, cwd: dirs.home }).unref();
    const again = watchStartup(nextPort);
    await sleep(14_000);
    await again.stop();
    const shownAgain = again.timeline.filter(item => item.tour || item.modal || item.cards.length);
    record('다시 실행하면 변경 내역·둘러보기·안내 카드가 다시 뜨지 않음', again.timeline.length > 0 && shownAgain.length === 0, `${again.timeline.length}개 상태${shownAgain.length ? `, 뜬 것 ${JSON.stringify(shownAgain[0])}` : ''}, 마지막 ${JSON.stringify(again.timeline.at(-1))}`);
    try { const page = await appPage(nextPort, 30_000); await page.shot('update-second-start'); page.close(); } catch { /* the screenshot is only evidence */ }
  }
  const realAfter = realApps();
  record('사용 중인 실제 MoonerADE 프로세스는 그대로', JSON.stringify(realBefore) === JSON.stringify(realAfter), `${realBefore.length}개 → ${realAfter.length}개`);
} catch (error) {
  record('진행', false, error.stack ?? error.message);
  // What was left running (apps only; the rest is Chromium's helpers) and the end of the pty-host's log, for whoever reads the failure.
  try { console.log(`NOTE 남은 프로세스: ${ours().filter(item => !/--type=/.test(item.CommandLine ?? '')).map(item => `${item.ProcessId} ${item.Name}`).join(', ') || '없음'}`); } catch { /* diagnostics only */ }
  try { console.log(`NOTE pty-host 로그 끝: ${readFileSync(join(dirs.user, 'pty-host', 'pty-host.log'), 'utf8').trim().split('\n').slice(-5).join(' | ')}`); } catch { /* no log */ }
}

// ---- stop what this run started ------------------------------------------------------------------------------------
writeFileSync(watch.stop, '1');
for (let round = 0; round < 3; round++) {
  for (const item of ours()) { try { process.kill(item.ProcessId); } catch { /* gone */ } }
  await sleep(1500);
}
// The terminal's shell is not under the temp folder (system PowerShell): it ends with its pty-host, or here by the pid it reported itself.
if (drove.shellPid && processes().some(item => item.ProcessId === drove.shellPid && /^(powershell|pwsh)\.exe$/i.test(item.Name))) { try { process.kill(drove.shellPid); } catch { /* gone */ } }
for (const item of ours()) { console.log(`정리하지 못함: ${item.ProcessId} ${item.Name}`); }
server.close();
writeFileSync(join(S, 'results-update-win.json'), JSON.stringify({ temp, installedFrom, nextFrom, full, exit, results }, null, 2));
console.log(`\n${results.filter(item => item.pass).length}/${results.length} 통과`);
process.exit(0);
