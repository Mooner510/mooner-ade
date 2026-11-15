// Windows: the whole self-update of a packaged build, isolated. Needs `pnpm package` first (apps/desktop/dist/MoonerADE-win32-x64).
//   VERIFY_OUT=<folder in the temp dir> node scripts/verify/t-update-win.mjs [--installed-from <packaged folder>] [--next-from <packaged folder>] [--full]
// A copy of the build, renamed 0.0.1, runs from a temp folder with its own profile (ADE_USER_DATA_DIR), data, HOME and TEMP and a fake release
// (ADE_UPDATE_URL) offering 9.9.9 as GitHub would (app-only zip + manifest, or with --full only the full zip; sha256 digests). ADE_UPDATE_ANSWER takes
// "지금 업데이트". --installed-from / --next-from take other packaged folders: an older build as the installed one tests an update started by
// an older version's helper (the app that is updated *to* is what has to cope with it).
// Checks: the app is replaced by 9.9.9 and starts again under the same isolated profile with a window, no console window is visible at any moment
// of the update (console-watch.ps1), the restarted app is not on any console (console-tool.ps1), closing the console it would have shared does not
// end it, the scratch folder is gone, and the real MoonerADE processes were not touched. The 9.9.9 copy gets its isolation written into its main.js
// because the updater starts it from WMI, which hands over no environment.
// With an older build as --installed-from, that build's own helper still flashes its console for a moment: the "no console window" line fails then,
// and the lines about the restarted app show whether it copes (it hands over to a copy that is off the console).
// Leaves env.json { temp } in VERIFY_OUT; the processes it started are stopped here (found by the temp folder in their path, never by name),
// cleanup-ui.mjs removes the folders.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT, S, sleep } from './lib.mjs';

if (process.platform !== 'win32') { console.error('Windows 전용입니다.'); process.exit(2); }
const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const dist = join(ROOT, 'apps/desktop/dist/MoonerADE-win32-x64');
const installedFrom = resolve(option('--installed-from') ?? dist), nextFrom = resolve(option('--next-from') ?? dist);
for (const folder of [installedFrom, nextFrom]) if (!existsSync(join(folder, 'MoonerADE.exe'))) { console.error(`${folder}에 MoonerADE.exe가 없습니다. 먼저 pnpm package를 실행하세요.`); process.exit(2); }
if (existsSync(join(S, 'env.json'))) { console.error(`${S}에 이미 다른 세션이 있습니다. 새 VERIFY_OUT을 쓰세요.`); process.exit(2); }

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ade-verify-update-')));
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
robocopy(installedFrom, installed); setVersion(installed, '0.0.1');
robocopy(nextFrom, next); setVersion(next, '9.9.9');
const isolated = { ADE_USER_DATA_DIR: dirs.user, ADE_DATA_DIR: dirs.data, ADE_NVIDIA_CHECK: '0', USERPROFILE: dirs.home, HOME: dirs.home, TEMP: dirs.tmp, TMP: dirs.tmp, CLAUDE_CONFIG_DIR: join(dirs.home, '.claude'), CODEX_HOME: join(dirs.home, '.codex') };
{ // The updater starts the new app from WMI, which gives it the user's default environment, so the copy carries its isolation itself.
  const file = join(next, 'resources/app/apps/desktop/src/main.js'), code = readFileSync(file, 'utf8'), anchor = '// Keep the existing profile when changing the displayed product name.';
  if (!code.includes(anchor)) throw new Error('main.js에서 프로필 지정 위치를 찾지 못했습니다.');
  // Every start of this copy leaves a line (pid, parent, the marker it was given, whether stdout is a console), so a hand-over shows up as two starts.
  const note = '`${process.pid} ppid=${process.ppid} marker=${process.env.ELECTRON_NO_ATTACH_CONSOLE ?? ""} console=${process.getBuiltinModule("node:tty").isatty(1)}\\n`';
  const injected = `// injected by scripts/verify/t-update-win.mjs\nObject.assign(process.env, ${JSON.stringify(isolated)});\ntry { process.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(startsLog)}, ${note}); } catch { /* the log is only evidence */ }\n${anchor}`;
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
  writeFileSync(join(dirs.release, `${asset}.json`), JSON.stringify({ version: '9.9.9', shell: runtimeShell(next) }));
}

// ---- the fake GitHub -----------------------------------------------------------------------------------------------
const served = [];
const server = http.createServer((req, res) => {
  served.push(req.url);
  if (req.url === '/repos/Mooner510/mooner-ade/releases/latest') {
    const port = server.address().port;
    const assets = readdirSync(dirs.release).map(name => {
      const file = join(dirs.release, name);
      return { name, size: statSync(file).size, digest: `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`, browser_download_url: `http://127.0.0.1:${port}/assets/${name}` };
    });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ tag_name: 'v9.9.9', draft: false, assets })); return;
  }
  const name = decodeURIComponent(req.url.replace(/^\/assets\//, '')), file = join(dirs.release, name);
  if (!req.url.startsWith('/assets/') || name.includes('/') || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-length': statSync(file).size }); createReadStream(file).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));

// ---- watch for console windows, then run the installed copy ---------------------------------------------------------
const realBefore = realApps();
const watch = { stop: join(temp, 'watch.stop'), out: join(temp, 'watch.json'), ready: join(temp, 'watch.ready') };
// Not detached: PowerShell without any console does not start (it ends with this script, which it needs anyway).
spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts/verify/console-watch.ps1'), '-Stop', watch.stop, '-Out', watch.out, '-Ready', watch.ready], { stdio: 'ignore', windowsHide: true });
for (let i = 0; i < 150 && !existsSync(watch.ready); i++) await sleep(200);
if (!existsSync(watch.ready)) throw new Error('콘솔 창 감시가 시작되지 않았습니다.');

const started = Date.now();
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ADE_|ELECTRON_)/.test(name)));
// ELECTRON_NO_ATTACH_CONSOLE: this first start stands in for a launch from Explorer or a shortcut, which has no console to join.
const child = spawn(exeOf(installed), [], { env: { ...env, ...isolated, ADE_UPDATE_URL: `http://127.0.0.1:${server.address().port}`, ADE_UPDATE_ANSWER: '지금 업데이트|중단하고 업데이트|확인', ELECTRON_NO_ATTACH_CONSOLE: '1' }, stdio: 'ignore', detached: true, windowsHide: true });
child.unref();
let exit = null;
child.once('exit', (code, signal) => { exit = { code, signal }; });
const mains = () => ours().filter(item => lower(item.ExecutablePath) === lower(exeOf(installed)) && !/--type=/.test(item.CommandLine ?? ''));

let before = null, after = null, finalMain = null;
try {
  for (let i = 0; i < 200 && !before; i++) { before = mains()[0]; if (!before) await sleep(300); }
  record('설치본(0.0.1)이 시작', Boolean(before), before ? `pid ${before.ProcessId}` : '프로세스 없음');
  while (!exit && Date.now() - started < 240_000) await sleep(300);
  record('업데이트 문의에 응답하고 받음', served.some(url => url.endsWith(full ? `${asset}.zip` : `${asset}-app.zip`)), served.join(', '));
  record('이전 앱이 정상 종료', exit?.code === 0, JSON.stringify(exit));
  // The new app may start twice when an older helper starts it on a console (it hands over to a copy), so wait for one that stays.
  for (let i = 0; i < 120 && !after; i++) { await sleep(1000); after = mains().find(item => item.ProcessId !== before?.ProcessId); }
  record('새 버전이 다시 실행', Boolean(after), after ? `pid ${after.ProcessId}` : '프로세스 없음');
  await sleep(10_000);
  finalMain = mains().sort((a, b) => b.ProcessId - a.ProcessId)[0] ?? null;
  const version = (() => { try { return JSON.parse(readFileSync(join(installed, 'resources/app/package.json'), 'utf8')).version; } catch { return null; } })();
  record('설치 폴더의 앱이 9.9.9로 교체', version === '9.9.9', version ?? '읽기 실패');
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
  const realAfter = realApps();
  record('사용 중인 실제 MoonerADE 프로세스는 그대로', JSON.stringify(realBefore) === JSON.stringify(realAfter), `${realBefore.length}개 → ${realAfter.length}개`);
} catch (error) { record('진행', false, error.stack ?? error.message); }

// ---- stop what this run started ------------------------------------------------------------------------------------
writeFileSync(watch.stop, '1');
for (let round = 0; round < 3; round++) {
  for (const item of ours()) { try { process.kill(item.ProcessId); } catch { /* gone */ } }
  await sleep(1500);
}
for (const item of ours()) { console.log(`정리하지 못함: ${item.ProcessId} ${item.Name}`); }
server.close();
writeFileSync(join(S, 'results-update-win.json'), JSON.stringify({ temp, installedFrom, nextFrom, full, exit, results }, null, 2));
console.log(`\n${results.filter(item => item.pass).length}/${results.length} 통과`);
process.exit(0);
