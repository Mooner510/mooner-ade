// macOS: the whole self-update of a packaged build, isolated. Needs `pnpm package` first (apps/desktop/dist/MoonerADE.app).
//   VERIFY_OUT=$(mktemp -d -t ade-verify-out) node scripts/verify/t-update.mjs [--old-progress-window] [--windowed]
// A copy of the build, renamed 0.0.1, runs from a temp folder with its own profile (ADE_USER_DATA_DIR), data, HOME and a fake release
// (ADE_UPDATE_URL) offering 9.9.9 as GitHub would (app-only zip + manifest + full zip, sha256 digests). ADE_UPDATE_ANSWER takes
// "지금 업데이트" for it. The main window goes full screen (unless --windowed) before the update quits the app.
// Checks: the progress card is drawn in the main window (screenshots), the old app exits without a signal, the bundle in the temp folder
// becomes 9.9.9 and starts again under the same isolated profile, no new crash report names the temp folder, no Keychain prompt
// (SecurityAgent) appeared, the real profile's lock was not touched. --old-progress-window puts back the separate progress window
// (the code before the fix) in the old copy, to reproduce the crash.
// Leaves env.json { temp } in VERIFY_OUT; the processes it started are stopped here, cleanup-ui.mjs removes the folders.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, S, WebSocket, sleep } from './lib.mjs';

if (process.platform !== 'darwin') { console.error('macOS 전용입니다.'); process.exit(2); }
const args = process.argv.slice(2), oldWindow = args.includes('--old-progress-window'), windowed = args.includes('--windowed');
const dist = join(ROOT, 'apps/desktop/dist/MoonerADE.app');
if (!existsSync(dist)) { console.error('먼저 pnpm package를 실행하세요.'); process.exit(2); }
if (existsSync(join(S, 'env.json'))) { console.error(`${S}에 이미 다른 세션이 있습니다. 새 VERIFY_OUT을 쓰세요.`); process.exit(2); }

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ade-verify-update-')));
writeFileSync(join(S, 'env.json'), JSON.stringify({ temp, startedAt: Date.now() }));
const dirs = Object.fromEntries(['install', 'next', 'release', 'user', 'data', 'home'].map(name => [name, join(temp, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir);
const run = (file, list) => execFileSync(file, list, { stdio: ['ignore', 'pipe', 'pipe'] });
const results = [], record = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };

// ---- the two builds ----------------------------------------------------------------------------------------------
function copyAs(dest, version, patch) {
  const bundle = join(dest, 'MoonerADE.app');
  run('/usr/bin/ditto', [dist, bundle]);
  const app = join(bundle, 'Contents/Resources/app'), pkg = join(app, 'package.json');
  writeFileSync(pkg, JSON.stringify({ ...JSON.parse(readFileSync(pkg, 'utf8')), version }));
  patch?.(app);
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
  return bundle;
}
const installed = copyAs(dirs.install, '0.0.1', oldWindow ? (app => {
  const file = join(app, 'apps/desktop/src/updater.js'), code = readFileSync(file, 'utf8');
  const line = "const inline = process.platform === 'darwin' && main();";
  if (!code.includes(line)) throw new Error('updater.js에서 진행률 분기를 찾지 못했습니다.');
  writeFileSync(file, code.replace(line, 'const inline = false;'));
}) : undefined);
const next = copyAs(dirs.next, '9.9.9');
const asset = `MoonerADE-darwin-${process.arch}`;
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', next, join(dirs.release, `${asset}.zip`)]);
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(next, 'Contents/Resources/app'), join(dirs.release, `${asset}-app.zip`)]);
const { shell } = JSON.parse(readFileSync(join(next, 'Contents/Resources/runtime/runtime.json'), 'utf8'));
writeFileSync(join(dirs.release, `${asset}.json`), JSON.stringify({ version: '9.9.9', shell }));

// ---- the fake GitHub ----------------------------------------------------------------------------------------------
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
  const name = decodeURIComponent(req.url.replace(/^\/assets\//, ''));
  const file = join(dirs.release, name);
  if (!req.url.startsWith('/assets/') || name.includes('/') || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-length': statSync(file).size }); createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

// ---- watchers -----------------------------------------------------------------------------------------------------
const reports = join(homedir(), 'Library/Logs/DiagnosticReports');
let started = Date.now();
const realLock = join(homedir(), 'Library/Application Support/@mooner/ade-desktop/SingletonLock');
const lockOf = file => { try { return readlinkSync(file); } catch { return null; } };
const realLockBefore = lockOf(realLock);
// A Keychain prompt runs in SecurityAgent, which may linger after an earlier prompt: only a new one counts. A stuck app is also sampled
// for a Keychain call on its main thread (see stuck()).
const agents = () => { try { return execFileSync('pgrep', ['-x', 'SecurityAgent'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; } };
const agentsBefore = new Set(agents());
let securityAgent = false;
const watchKeychain = setInterval(() => { if (agents().some(pid => !agentsBefore.has(pid))) securityAgent = true; }, 300);
const inKeychain = pid => { try { return /SecKeychain|SecItem(Add|CopyMatching)/.test(execFileSync('/usr/bin/sample', [String(pid), '1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return false; } };
// Processes this run started are found by the temp folder's unique path in their command line, never by name.
const ours = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').map(line => line.trim().match(/^(\d+) (.*)$/)).filter(match => match && match[2].includes(temp)).map(match => ({ pid: Number(match[1]), command: match[2] }));
const mainProcess = () => ours().find(item => item.command.startsWith(join(installed, 'Contents/MacOS/Electron')));

// ---- run the old copy ---------------------------------------------------------------------------------------------
started = Date.now();
const cdpPort = 20000 + Math.floor(Math.random() * 20000);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ADE_') && !name.startsWith('ELECTRON_')));
const log = join(S, 'app.log');
const child = spawn(join(installed, 'Contents/MacOS/Electron'), [`--remote-debugging-port=${cdpPort}`], {
  env: { ...env, HOME: dirs.home, ADE_USER_DATA_DIR: dirs.user, ADE_DATA_DIR: dirs.data, ADE_UPDATE_URL: `http://127.0.0.1:${server.address().port}`, ADE_UPDATE_ANSWER: '지금 업데이트|중단하고 업데이트|확인' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const out = [];
child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => out.push(chunk));
let exit = null;
child.once('exit', (code, signal) => { exit = { code, signal }; });

async function page() {
  for (let i = 0; i < 300; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const target = list.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1') && !item.url.includes('about:blank'));
      if (target) return target;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  if (inKeychain(child.pid)) { securityAgent = true; throw new Error('메인 프로세스가 Keychain 호출에서 멈춰 있습니다(암호 창).'); }
  throw new Error('메인 창의 CDP 대상을 찾지 못했습니다.');
}
function connect(url) {
  const socket = new WebSocket(url), pending = new Map();
  let id = 0;
  socket.on('message', data => { const message = JSON.parse(data); pending.get(message.id)?.(message); pending.delete(message.id); });
  const send = (method, params = {}) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); socket.send(JSON.stringify({ id: n, method, params })); });
  return new Promise((resolve, reject) => { socket.once('open', () => resolve({ send, close: () => socket.close() })); socket.once('error', reject); });
}

const shots = [];
let separate = false;
try {
  const cdp = await connect((await page()).webSocketDebuggerUrl);
  const evaluate = async (expression, userGesture = false) => (await cdp.send('Runtime.evaluate', { expression, userGesture, awaitPromise: true, returnByValue: true })).result?.result?.value;
  if (!windowed) {
    // HTML fullscreen of the page makes the BrowserWindow natively full screen (a Space of its own), as the user had it. Too early
    // (before the page has settled) it does nothing, so it is tried a few times. The notch area keeps innerHeight below screen.height.
    const full = () => evaluate('Boolean(document.fullscreenElement) && innerWidth === screen.width');
    let html = '';
    for (let i = 0; i < 5 && !(await full()); i++) {
      await sleep(1500);
      html = await evaluate('document.documentElement.requestFullscreen().then(() => "ok", error => String(error))', true);
      await sleep(1500);
    }
    record('메인 창 전체 화면', await full(), `requestFullscreen: ${html} · ${await evaluate('innerWidth + "x" + innerHeight + " / " + screen.width + "x" + screen.height')}`);
  }
  // Progress card screenshots until the app goes away (the update starts on its own 5 s after launch).
  const seen = new Set();
  while (!exit) {
    if (!separate) separate = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then(r => r.json()).then(list => list.some(item => item.url.startsWith('data:text/html')), () => false);
    const text = await Promise.race([evaluate("document.getElementById('ade-update-progress')?.textContent ?? null").catch(() => null), sleep(2000).then(() => null)]);
    const label = text?.replace(/[\d.]+ \/ [\d.]+ MB|[\d.]+ MB/, 'N MB');
    if (label && !seen.has(label)) {
      seen.add(label);
      const shot = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'png' }), sleep(3000).then(() => null)]);
      if (shot?.result?.data) { const file = join(S, 'shots', `progress-${shots.length + 1}.png`); writeFileSync(file, Buffer.from(shot.result.data, 'base64')); shots.push({ file, text }); }
    }
    if (Date.now() - started > 180_000) { if (inKeychain(child.pid)) securityAgent = true; throw new Error('3분 안에 업데이트로 종료되지 않았습니다.'); }
    await sleep(250);
  }
  cdp.close();
} catch (error) { record('진행', false, error.message); }

while (!exit && Date.now() - started < 200_000) await sleep(200);
record('업데이트 문의에 응답하고 받음', served.some(url => url.endsWith('-app.zip')), served.join(', '));
record(oldWindow ? '별도 진행률 창이 뜸(수정 전 재현)' : '별도 진행률 창 없음', separate === oldWindow);
if (!oldWindow) record('진행률이 메인 창 안 카드로 표시', shots.length > 0, shots.map(shot => `${shot.text} → ${shot.file}`).join(' | '));
record('이전 앱이 정상 종료(시그널 없음)', exit?.signal == null && exit?.code === 0, JSON.stringify(exit));

if (!exit) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
// ---- the restarted copy ---------------------------------------------------------------------------------------------
let restarted = null;
for (let i = 0; i < 150 && !restarted; i++) { await sleep(200); restarted = mainProcess(); }
const version = (() => { try { return JSON.parse(readFileSync(join(installed, 'Contents/Resources/app/package.json'), 'utf8')).version; } catch { return null; } })();
record('임시 폴더의 앱이 9.9.9로 교체', version === '9.9.9', version ?? '읽기 실패');
record('새 버전이 다시 실행', Boolean(restarted), restarted ? `pid ${restarted.pid}` : '프로세스 없음');
await sleep(8000);
record('재실행이 격리 프로필을 사용', Boolean(lockOf(join(dirs.user, 'SingletonLock'))) && lockOf(realLock) === realLockBefore, `격리 lock ${lockOf(join(dirs.user, 'SingletonLock'))}, 실제 lock ${realLockBefore} → ${lockOf(realLock)}`);
let restartEnv = '';
if (restarted) { try { restartEnv = execFileSync('ps', ['eww', '-p', String(restarted.pid), '-o', 'command='], { encoding: 'utf8' }); } catch { /* gone */ } }
record('재실행이 같은 환경 변수를 유지', restartEnv.includes(`ADE_USER_DATA_DIR=${dirs.user}`) && restartEnv.includes(`ADE_DATA_DIR=${dirs.data}`) && !restartEnv.includes('ADE_PTY_ENDPOINT=/'), restarted ? '' : '재실행 없음');

// macOS masks the temp path in a report (/private/var/folders/*/MoonerADE.app/...); the installed app's would read /Applications/.
// ReportCrash writes a few seconds after the crash.
await sleep(5000);
const crashes = existsSync(reports) ? readdirSync(reports).filter(name => name.endsWith('.ips') && statSync(join(reports, name)).mtimeMs >= started).filter(name => { try { return readFileSync(join(reports, name), 'utf8').replaceAll('\\/', '/').includes('/private/var/folders/*/MoonerADE.app/Contents/MacOS/'); } catch { return false; } }) : [];
record('새 크래시 보고 없음', crashes.length === 0, crashes.join(', '));
clearInterval(watchKeychain);
record('Keychain 암호 창(SecurityAgent) 없음', !securityAgent);

// ---- stop what this run started -------------------------------------------------------------------------------------
for (const item of ours().filter(item => item.command.startsWith(join(installed, 'Contents/MacOS/Electron')))) { try { process.kill(item.pid, 'SIGTERM'); } catch { /* gone */ } }
for (let i = 0; i < 50 && mainProcess(); i++) await sleep(200);
await sleep(1000);
for (const item of ours()) { try { process.kill(item.pid, 'SIGKILL'); console.log(`정리: ${item.pid} ${item.command.slice(0, 80)}`); } catch { /* gone */ } }
server.close();
writeFileSync(join(S, `results-update${oldWindow ? '-old' : ''}.json`), JSON.stringify({ oldWindow, windowed, temp, exit, results, shots, crashes }, null, 2));
writeFileSync(log, Buffer.concat(out));
console.log(`\n${results.filter(item => item.pass).length}/${results.length} 통과 · 로그 ${log}`);
process.exit(0);
