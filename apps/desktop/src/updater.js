import { app, BrowserWindow, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeclined, describeReasons, normalizeReport, staleUpdateDirs, unknownReport, waitUntilIdle } from './update-policy.js';

export { UPDATE_CHECK_INTERVAL_MS } from './update-policy.js';

// Self-update of the packaged Windows and macOS app from the repository's latest GitHub release.
// The release carries per platform a full zip, an app-only zip (just resources/app) and a small manifest naming the
// shell key (Electron, Node, branding; see package.mjs). When the installed shell key matches, only the app zip is
// fetched and only resources/app is replaced; otherwise the full zip replaces everything. Full update, Windows: after the app exits, a PowerShell helper mirrors the new folder
// over the install folder and starts the app again; user data lives in %APPDATA%, outside the install folder.
// macOS: the zip holds MoonerADE.app (made with ditto so the framework symlinks and signature survive); after the app
// exits, a shell helper swaps the new bundle in for the old one and opens it. User data lives in ~/Library.
// Restarting ends every terminal (they live in the server process), so the app is only restarted once the server reports that nothing
// is running: an agent turn, a Claude with a background task or wakeup pending, a command in a plain shell. If something is, the user
// chooses between waiting for it to finish and "later"; either way the new version is not downloaded until the restart is safe.
// The previous version is not kept (the new files are mirrored over it), and the scratch folder is removed after the helper has run.

const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// Only a packaged copy (exe + resources/app, or MoonerADE.app/Contents/Resources/app) updates itself;
// `pnpm dev` / `pnpm start` run from the source tree, even inside a renamed Electron bundle.
const bundlePath = () => path.resolve(process.execPath, '../../..');
const real = file => { try { return fs.realpathSync(file); } catch { return file; } };
const packagedMac = () => process.platform === 'darwin' && bundlePath().endsWith('.app')
  && real(app.getAppPath()) === path.join(real(bundlePath()), 'Contents', 'Resources', 'app');
const portable = () => (process.platform === 'win32' && path.basename(path.dirname(app.getAppPath())) === 'resources') || packagedMac();

const run = (file, args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exit ${code}`)));
});

// $Work holds this very script, so it cannot delete itself; a short-lived cmd removes the whole scratch folder once PowerShell has exited.
// That also holds when robocopy failed: the extracted copy is not kept, and the next check downloads it again.
const APPLY = [
  'param($ProcessId, $Source, $Target, $Exe, $Work)',
  'Wait-Process -Id $ProcessId -ErrorAction SilentlyContinue',
  'robocopy $Source $Target /MIR /R:30 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null',
  'Start-Process -FilePath $Exe',
  `Start-Process -FilePath cmd.exe -ArgumentList '/c', ('ping -n 4 127.0.0.1 >nul & rmdir /s /q "' + $Work + '"') -WindowStyle Hidden`,
  ''
].join('\n');

// $1 pid, $2 staged new bundle, $3 installed bundle, $4 backup path, $5 stage folder and $6 work folder to delete afterwards.
// Renames stay on one volume (the stage sits next to the install), so the swap is quick and rolls back on failure.
const APPLY_MAC = `#!/bin/sh
while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
if mv "$3" "$4"; then
  if mv "$2" "$3"; then
    /usr/bin/xattr -cr "$3" 2>/dev/null
    rm -rf "$4"
  else
    mv "$4" "$3"
  fi
fi
/usr/bin/open "$3"
rm -rf "$5" "$6"
`;

const PROGRESS_PAGE = `<!doctype html><meta charset="utf-8"><style>
:root{color-scheme:dark light}body{margin:0;padding:20px;font:14px system-ui,'Malgun Gothic',sans-serif;background:#1e1f22;color:#e6e6e6}
#text{margin-bottom:12px}.bar{height:8px;border-radius:4px;background:#3a3c40;overflow:hidden}
#fill{height:100%;width:0;background:#4c8bf5;transition:width .15s}#fill.wait{width:35%;animation:slide 1.1s ease-in-out infinite alternate}
@keyframes slide{from{margin-left:0}to{margin-left:65%}}</style>
<div id="text">준비 중…</div><div class="bar"><div id="fill" class="wait"></div></div>
<script>function set(text,fraction){document.getElementById('text').textContent=text;const f=document.getElementById('fill');
f.classList.toggle('wait',fraction==null);f.style.width=fraction==null?'':Math.round(fraction*100)+'%'}</script>`;

// A small window plus the taskbar bar: the download and install take a while, and the app otherwise looks frozen.
function progressWindow(parent) {
  const win = new BrowserWindow({ width: 380, height: 120, parent: parent ?? undefined, resizable: false, minimizable: false, maximizable: false, closable: false, show: false, autoHideMenuBar: true, title: '업데이트', webPreferences: { sandbox: true, contextIsolation: true } });
  win.setMenu(null);
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PROGRESS_PAGE)}`);
  win.once('ready-to-show', () => win.show());
  let last = 0;
  return {
    // fraction === null shows an indeterminate bar.
    set(text, fraction = null, force = true) {
      const now = Date.now();
      if (!force && now - last < 100) return;
      last = now;
      if (!win.isDestroyed()) void win.webContents.executeJavaScript(`set(${JSON.stringify(text)}, ${fraction})`).catch(() => {});
      const main = parent && !parent.isDestroyed() ? parent : null;
      if (main) fraction === null ? main.setProgressBar(2, { mode: 'indeterminate' }) : main.setProgressBar(fraction);
    },
    close() {
      if (parent && !parent.isDestroyed()) parent.setProgressBar(-1);
      if (!win.isDestroyed()) win.destroy();
    }
  };
}

// One check or update at a time: the periodic timer, the startup check and the settings button may overlap.
// `applying` stays set once the helper has been started, so no check or prompt can come in during the few seconds the app takes to quit.
let running = false, applying = false;
// Set while an accepted update waits for the running work to finish (it can be hours): { version, controller, report }.
let pending = null;
// Versions the user answered "later" to; background checks leave them alone until the app is restarted.
const declined = createDeclined();

// Resolves to 'unsupported' | 'latest' | 'declined' | 'waiting' | 'updating' | 'error'. `manual` (the settings button) also answers
// "up to date" and failures in a dialog, asks again about a version turned down earlier, and manages an update that is waiting for
// work to finish; background checks stay silent unless a new version is there. `getBusy()` asks the server what a restart would cut off.
export async function checkForUpdate({ repo, asset, window, manual = false, getBusy }) {
  if (!portable()) {
    if (manual) await say(window, { type: 'info', title: '업데이트', message: '설치된 앱(Windows 포터블, macOS .app)에서만 자동 업데이트를 지원합니다.', detail: '소스에서 실행 중이면 git pull로 직접 갱신하세요.' });
    return 'unsupported';
  }
  if (applying) return 'updating';
  if (pending) return manual ? manageWaiting(window) : 'waiting';
  if (running) return 'updating';
  running = true;
  try { return await check({ repo, asset, window, manual, getBusy }); }
  catch (error) {
    if (manual) await say(window, { type: 'error', title: '업데이트', message: `업데이트를 확인하지 못했습니다: ${error instanceof Error ? error.message : String(error)}` });
    else throw error;
    return 'error';
  } finally { running = false; }
}

// An answer that cannot be read counts as busy: the app is not restarted on a guess.
async function readBusy(getBusy) {
  if (!getBusy) return unknownReport('작업 상태를 확인할 수 없습니다');
  try { return normalizeReport(await getBusy()); }
  catch (error) { return unknownReport(error instanceof Error ? error.message : String(error)); }
}

// The settings button while an update waits: keep waiting, stop waiting (and leave this version alone), or restart now.
async function manageWaiting(window) {
  const current = pending;
  if (!current) return 'updating';
  const options = {
    type: 'info', buttons: ['계속 대기', '대기 취소', '지금 업데이트 (세션 종료)'], defaultId: 0, cancelId: 0, title: '업데이트',
    message: `새 버전 ${current.version}은 작업이 모두 끝난 뒤 자동으로 설치됩니다.`,
    detail: `지금 진행 중인 작업:\n${describeReasons(current.report.reasons) || '• 확인 중'}`,
  };
  const { response } = await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
  if (response === 1) { declined.add(current.version); current.controller.abort('cancelled'); return 'declined'; }
  if (response !== 2) return 'waiting';
  const confirmOptions = {
    type: 'warning', buttons: ['지금 업데이트', '취소'], defaultId: 1, cancelId: 1, title: '업데이트',
    message: '실행 중인 작업을 끝내지 않고 지금 업데이트할까요?',
    detail: `모든 터미널과 에이전트가 종료됩니다. 진행 중인 작업, 승인 대기, 백그라운드 작업은 이어지지 않고, Claude 대화는 다시 열 때 resume으로 이어집니다.\n\n${describeReasons(current.report.reasons)}`,
  };
  const confirmed = await (window ? dialog.showMessageBox(window, confirmOptions) : dialog.showMessageBox(confirmOptions));
  if (confirmed.response !== 0 || pending !== current) return 'waiting';
  current.controller.abort('force');
  return 'updating';
}

const say = (window, options) => Promise.resolve(window ? dialog.showMessageBox(window, { buttons: ['확인'], ...options }) : dialog.showMessageBox({ buttons: ['확인'], ...options }));

// A request that never answers would hold the one-check-at-a-time lock (and every later check) until undici gives up after minutes.
const REQUEST_TIMEOUT_MS = 30_000;

// The installed bundle's shell key, written by package.mjs; null for builds that predate app-only updates.
const installedShell = () => {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(real(app.getAppPath())), 'runtime', 'runtime.json'), 'utf8')).shell ?? null; }
  catch { return null; }
};

// Streams a release asset to `dest` (or into memory without one) and refuses it unless it matches GitHub's sha256 digest.
// `timeoutMs` bounds the whole request and is for the small manifest; the zips stream for as long as they need.
async function fetchAsset(file, { dest, onProgress, timeoutMs } = {}) {
  const response = await fetch(file.browser_download_url, { headers: { 'User-Agent': app.getName() }, ...timeoutMs && { signal: AbortSignal.timeout(timeoutMs) } });
  if (!response.ok) throw new Error(`다운로드 실패 (HTTP ${response.status})`);
  const hash = createHash('sha256');
  const total = Number(response.headers.get('content-length')) || file.size || 0;
  const chunks = [];
  let received = 0;
  const source = Readable.fromWeb(response.body);
  const tap = async function* (input) {
    for await (const chunk of input) {
      hash.update(chunk); received += chunk.length;
      onProgress?.(received, total);
      yield chunk;
    }
  };
  if (dest) await pipeline(source, tap, fs.createWriteStream(dest));
  else for await (const chunk of tap(source)) chunks.push(chunk);
  if (file.digest !== `sha256:${hash.digest('hex')}`) throw new Error('받은 업데이트 파일의 해시가 릴리스와 다릅니다.');
  return dest ? null : Buffer.concat(chunks);
}

// The app-only zip applies when the release's manifest names the installed shell; anything missing or odd means full.
async function pickPackage(release, asset, version) {
  const find = name => release.assets.find(item => item.name === name);
  const full = find(asset), appZip = find(asset.replace(/\.zip$/, '-app.zip')), manifest = find(asset.replace(/\.zip$/, '.json'));
  const shell = installedShell();
  if (appZip && manifest && shell) {
    try {
      const data = JSON.parse((await fetchAsset(manifest, { timeoutMs: REQUEST_TIMEOUT_MS })).toString('utf8'));
      if (data.version === version && data.shell === shell) return { file: appZip, kind: 'app' };
    } catch (error) { console.warn(`업데이트 매니페스트 확인 실패, 전체 업데이트로 진행: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { file: full, kind: 'full' };
}

const mb = bytes => (bytes / 1048576).toFixed(1);

async function check({ repo, asset, window, manual, getBusy }) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': app.getName() };
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GitHub 응답 오류 (HTTP ${response.status})`);
  const release = await response.json();
  const version = String(release.tag_name).replace(/^v/, '');
  release.assets ??= [];
  if (!/^\d+\.\d+\.\d+$/.test(version) || !newer(version, app.getVersion()) || !release.assets.some(item => item.name === asset)) {
    if (manual) await say(window, { type: 'info', title: '업데이트', message: '최신 버전을 사용 중입니다.', detail: `현재 버전은 ${app.getVersion()}입니다.` });
    return 'latest';
  }
  // The timer does not ask again about a version the user answered "later" to (and so does not even fetch its manifest).
  if (!manual && declined.has(version)) return 'declined';
  const { file, kind } = await pickPackage(release, asset, version);
  const report = await readBusy(getBusy), size = `다운로드 크기는 ${mb(file.size || 0)} MB입니다.`;
  // "Later" is the default button in both prompts: the prompt can appear while typing, and a stray Enter must not end every session.
  const prompt = report.busy
    ? {
      type: 'warning', buttons: ['모두 중단되면 업데이트', '나중에'], defaultId: 1, cancelId: 1, title: '업데이트',
      message: `새 버전 ${version}을 사용할 수 있습니다.`,
      detail: `현재 버전은 ${app.getVersion()}입니다. 지금은 아래 작업이 진행 중이라 바로 재시작하면 끊깁니다.\n\n${describeReasons(report.reasons)}\n\n"모두 중단되면 업데이트"를 고르면 위 작업이 모두 끝나고 1분쯤 지난 뒤 받아서 설치하고 재시작합니다. ${size}`,
    }
    : {
      type: 'info', buttons: ['업데이트 후 재시작', '나중에'], defaultId: 1, cancelId: 1, title: '업데이트',
      message: `새 버전 ${version}을 사용할 수 있습니다.`,
      detail: `현재 버전은 ${app.getVersion()}입니다. ${size} 업데이트를 받은 뒤 앱이 잠시 종료되었다가 다시 실행됩니다. 열려 있는 터미널은 종료되고, Claude 대화는 다시 열 때 이어집니다.`,
    };
  const { response: choice } = await (window ? dialog.showMessageBox(window, prompt) : dialog.showMessageBox(prompt));
  if (choice !== 0) { declined.add(version); return 'declined'; }
  return install({ version, file, kind, window, getBusy, mustWait: report.busy });
}

// Waits (without a time limit) until the server has reported idle several times in a row. 'idle' | 'force' | 'cancelled'.
async function settle(version, getBusy) {
  const controller = new AbortController(), state = { version, controller, report: { busy: true, reasons: [] } };
  pending = state;
  try { return await waitUntilIdle({ poll: async () => (state.report = await readBusy(getBusy)), signal: controller.signal }); }
  finally { if (pending === state) pending = null; }
}

async function install({ version, file, kind, window, getBusy, mustWait }) {
  let forced = false;
  if (mustWait) {
    const outcome = await settle(version, getBusy);
    if (outcome === 'cancelled') { declined.add(version); return 'declined'; }
    forced = outcome === 'force';
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mooner-update-'));
  let progress = progressWindow(window), staged = null;
  try {
    const zip = path.join(work, file.name);
    progress.set(`v${version} 다운로드 준비 중…`);
    await fetchAsset(file, {
      dest: zip,
      onProgress: (received, total) => progress.set(total ? `v${version} 다운로드 중… ${mb(received)} / ${mb(total)} MB` : `v${version} 다운로드 중… ${mb(received)} MB`, total ? Math.min(1, received / total) : null, false),
    });
    progress.set('압축 푸는 중…');
    staged = process.platform === 'darwin' ? await stageMac({ zip, progress, kind }) : await stageWindows({ zip, work, kind });
    // Work may have started while this downloaded; the restart is decided on the answer from this moment, not from the prompt's.
    if (!forced && (await readBusy(getBusy)).busy) {
      progress.close();
      const outcome = await settle(version, getBusy);
      if (outcome === 'cancelled') { staged.discard(); fs.rmSync(work, { recursive: true, force: true }); declined.add(version); return 'declined'; }
      progress = progressWindow(window);
    }
    progress.set('설치를 위해 앱을 다시 시작합니다…');
    await staged.launch({ work, progress });
    applying = true;
    // The progress window stays up until the app exits, so the restart does not look like a crash.
    app.quit();
    return 'updating';
  } catch (error) {
    progress.close();
    staged?.discard();
    fs.rmSync(work, { recursive: true, force: true });
    dialog.showErrorBox('업데이트', `업데이트하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    return 'error';
  }
}

// The app zip holds the `app` folder (mirrored over resources/app); the full zip holds the whole bundle folder.
const appComplete = dir => fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'apps', 'desktop', 'src', 'main.js'));

// Unpacks and checks the new files; `launch` hands them to the helper that swaps them in after the app exits, `discard` drops what
// was staged outside `work` (nothing on Windows, where everything sits under `work`, which the caller removes).
async function stageWindows({ zip, work, kind }) {
  const extracted = path.join(work, 'new');
  fs.mkdirSync(extracted);
  await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', extracted]);
  fs.rmSync(zip);
  const [folder] = fs.readdirSync(extracted);
  const source = path.join(extracted, folder ?? '');
  const valid = kind === 'app' ? folder === 'app' && appComplete(source) : !!folder && fs.existsSync(path.join(source, path.basename(process.execPath)));
  if (!valid) throw new Error('업데이트 파일 구성이 올바르지 않습니다.');
  const target = kind === 'app' ? app.getAppPath() : path.dirname(process.execPath);
  return {
    discard() {},
    async launch() {
      const script = path.join(work, 'apply.ps1');
      fs.writeFileSync(script, APPLY);
      // Electron keeps its processes in a Windows job object that is torn down with the app, killing even a detached
      // child. Win32_Process.Create starts the helper from the WMI service instead, outside that job.
      const command = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, String(process.pid), source, target, process.execPath, work]
        .map(arg => /\s/.test(arg) ? `"${arg}"` : arg).join(' ');
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:MOONER_UPDATE_COMMAND }).ReturnValue'], { MOONER_UPDATE_COMMAND: command });
    },
  };
}

async function stageMac({ zip, progress, kind }) {
  const target = real(bundlePath());
  const parent = path.dirname(target);
  // Stage next to the installed bundle: it proves the folder is writable now and keeps the later swap on one volume.
  let stage;
  try { stage = fs.mkdtempSync(path.join(parent, '.MoonerADE-update-')); }
  catch { throw new Error(`${parent} 폴더에 쓸 수 없습니다. 앱을 쓰기 가능한 폴더(예: /Applications)로 옮긴 뒤 다시 시도하세요.`); }
  try {
    const next = path.join(stage, path.basename(target));
    if (kind === 'app') {
      // Copy the installed bundle, swap in the new Contents/Resources/app and re-sign it ad hoc as package.mjs does;
      // the verify and swap below then run exactly as for a full update.
      progress.set('앱 복사 중…');
      await run('/usr/bin/ditto', [target, next]);
      const resources = path.join(next, 'Contents', 'Resources');
      fs.rmSync(path.join(resources, 'app'), { recursive: true, force: true });
      await run('/usr/bin/ditto', ['-x', '-k', zip, resources]);
      fs.rmSync(zip);
      if (!appComplete(path.join(resources, 'app'))) throw new Error('업데이트 파일 구성이 올바르지 않습니다.');
      progress.set('서명 중…');
      await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', next]);
    } else {
      await run('/usr/bin/ditto', ['-x', '-k', zip, stage]);
      fs.rmSync(zip);
    }
    if (!fs.existsSync(path.join(next, 'Contents', 'MacOS', path.basename(process.execPath)))) throw new Error('업데이트 파일 구성이 올바르지 않습니다.');
    progress.set('서명 확인 중…');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', next]);
    return {
      discard() { fs.rmSync(stage, { recursive: true, force: true }); },
      async launch({ work }) {
        const script = path.join(work, 'apply.sh');
        fs.writeFileSync(script, APPLY_MAC, { mode: 0o700 });
        // Detached with no stdio, so the helper outlives the app and finishes the swap once the app's process is gone.
        const helper = spawn('/bin/sh', [script, String(process.pid), next, target, path.join(stage, 'previous.app'), stage, work], { detached: true, stdio: 'ignore' });
        helper.unref();
      },
    };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

// An update the app never got to clean up (killed mid-download, a helper that was interrupted) leaves a scratch folder behind;
// anything of ours older than a day is removed at startup. Younger ones may belong to an update in progress.
export function sweepStaleUpdates(now = Date.now()) {
  if (!portable()) return;
  const dirs = [os.tmpdir(), ...process.platform === 'darwin' ? [path.dirname(real(bundlePath()))] : []];
  for (const dir of dirs) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
        try { return [{ name: entry.name, mtimeMs: fs.statSync(path.join(dir, entry.name)).mtimeMs }]; } catch { return []; }
      });
      for (const name of staleUpdateDirs(entries, now)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch { /* unreadable folder: nothing to clean */ }
  }
}
