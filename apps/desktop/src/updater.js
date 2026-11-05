import { app, BrowserWindow, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Self-update of the packaged Windows and macOS app from the repository's latest GitHub release.
// The release carries per platform a full zip, an app-only zip (just resources/app) and a small manifest naming the
// shell key (Electron, Node, branding; see package.mjs). When the installed shell key matches, only the app zip is
// fetched and only resources/app is replaced; otherwise the full zip replaces everything. Full update, Windows: after the app exits, a PowerShell helper mirrors the new folder
// over the install folder and starts the app again; user data lives in %APPDATA%, outside the install folder.
// macOS: the zip holds MoonerADE.app (made with ditto so the framework symlinks and signature survive); after the app
// exits, a shell helper swaps the new bundle in for the old one and opens it. User data lives in ~/Library.

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

const APPLY = `param($ProcessId, $Source, $Target, $Exe)
Wait-Process -Id $ProcessId -ErrorAction SilentlyContinue
robocopy $Source $Target /MIR /R:30 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
$ok = $LASTEXITCODE -lt 8
Start-Process -FilePath $Exe
if ($ok) { Remove-Item -LiteralPath (Split-Path $Source) -Recurse -Force -ErrorAction SilentlyContinue }
`;

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
let busy = false;

// Resolves to 'unsupported' | 'latest' | 'declined' | 'updating' | 'error'. `manual` (the settings button) also answers
// "up to date" and failures in a dialog; background checks stay silent unless a new version is there.
export async function checkForUpdate({ repo, asset, window, manual = false }) {
  if (!portable()) {
    if (manual) await say(window, { type: 'info', title: '업데이트', message: '설치된 앱(Windows 포터블, macOS .app)에서만 자동 업데이트를 지원합니다.', detail: '소스에서 실행 중이면 git pull로 직접 갱신하세요.' });
    return 'unsupported';
  }
  if (busy) return 'updating';
  busy = true;
  try { return await check({ repo, asset, window, manual }); }
  catch (error) {
    if (manual) await say(window, { type: 'error', title: '업데이트', message: `업데이트를 확인하지 못했습니다: ${error instanceof Error ? error.message : String(error)}` });
    else throw error;
    return 'error';
  } finally { busy = false; }
}

const say = (window, options) => Promise.resolve(window ? dialog.showMessageBox(window, { buttons: ['확인'], ...options }) : dialog.showMessageBox({ buttons: ['확인'], ...options }));

// The installed bundle's shell key, written by package.mjs; null for builds that predate app-only updates.
const installedShell = () => {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(real(app.getAppPath())), 'runtime', 'runtime.json'), 'utf8')).shell ?? null; }
  catch { return null; }
};

// Streams a release asset to `dest` (or into memory without one) and refuses it unless it matches GitHub's sha256 digest.
async function fetchAsset(file, { dest, onProgress } = {}) {
  const response = await fetch(file.browser_download_url, { headers: { 'User-Agent': app.getName() } });
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
      const data = JSON.parse((await fetchAsset(manifest)).toString('utf8'));
      if (data.version === version && data.shell === shell) return { file: appZip, kind: 'app' };
    } catch (error) { console.warn(`업데이트 매니페스트 확인 실패, 전체 업데이트로 진행: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { file: full, kind: 'full' };
}

async function check({ repo, asset, window, manual }) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': app.getName() };
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!response.ok) throw new Error(`GitHub 응답 오류 (HTTP ${response.status})`);
  const release = await response.json();
  const version = String(release.tag_name).replace(/^v/, '');
  release.assets ??= [];
  if (!/^\d+\.\d+\.\d+$/.test(version) || !newer(version, app.getVersion()) || !release.assets.some(item => item.name === asset)) {
    if (manual) await say(window, { type: 'info', title: '업데이트', message: '최신 버전을 사용 중입니다.', detail: `현재 버전은 ${app.getVersion()}입니다.` });
    return 'latest';
  }
  const { file, kind } = await pickPackage(release, asset, version);
  const mb = bytes => (bytes / 1048576).toFixed(1);
  const prompt = {
    type: 'info', buttons: ['업데이트 후 재시작', '나중에'], defaultId: 0, cancelId: 1, title: '업데이트',
    message: `새 버전 ${version}을 사용할 수 있습니다.`,
    detail: `현재 버전은 ${app.getVersion()}입니다. 다운로드 크기는 ${mb(file.size || 0)} MB입니다. 업데이트를 받은 뒤 앱이 잠시 종료되었다가 다시 실행됩니다.`,
  };
  const { response: choice } = await (window ? dialog.showMessageBox(window, prompt) : dialog.showMessageBox(prompt));
  if (choice !== 0) return 'declined';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mooner-update-'));
  const progress = progressWindow(window);
  try {
    const zip = path.join(work, file.name);
    progress.set(`v${version} 다운로드 준비 중…`);
    await fetchAsset(file, {
      dest: zip,
      onProgress: (received, total) => progress.set(total ? `v${version} 다운로드 중… ${mb(received)} / ${mb(total)} MB` : `v${version} 다운로드 중… ${mb(received)} MB`, total ? Math.min(1, received / total) : null, false),
    });
    progress.set('압축 푸는 중…');
    if (process.platform === 'darwin') await applyMac({ zip, work, progress, kind });
    else await applyWindows({ zip, work, progress, kind });
    // The progress window stays up until the app exits, so the restart does not look like a crash.
    app.quit();
    return 'updating';
  } catch (error) {
    progress.close();
    fs.rmSync(work, { recursive: true, force: true });
    dialog.showErrorBox('업데이트', `업데이트하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    return 'error';
  }
}

// The app zip holds the `app` folder (mirrored over resources/app); the full zip holds the whole bundle folder.
const appComplete = dir => fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'apps', 'desktop', 'src', 'main.js'));

async function applyWindows({ zip, work, progress, kind }) {
  const extracted = path.join(work, 'new');
  fs.mkdirSync(extracted);
  await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', extracted]);
  fs.rmSync(zip);
  const [folder] = fs.readdirSync(extracted);
  const source = path.join(extracted, folder ?? '');
  const valid = kind === 'app' ? folder === 'app' && appComplete(source) : !!folder && fs.existsSync(path.join(source, path.basename(process.execPath)));
  if (!valid) throw new Error('업데이트 파일 구성이 올바르지 않습니다.');
  const target = kind === 'app' ? app.getAppPath() : path.dirname(process.execPath);
  const script = path.join(work, 'apply.ps1');
  fs.writeFileSync(script, APPLY);
  // Electron keeps its processes in a Windows job object that is torn down with the app, killing even a detached
  // child. Win32_Process.Create starts the helper from the WMI service instead, outside that job.
  const command = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, String(process.pid), source, target, process.execPath]
    .map(arg => /\s/.test(arg) ? `"${arg}"` : arg).join(' ');
  progress.set('설치를 위해 앱을 다시 시작합니다…');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:MOONER_UPDATE_COMMAND }).ReturnValue'], { MOONER_UPDATE_COMMAND: command });
}

async function applyMac({ zip, work, progress, kind }) {
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
    const script = path.join(work, 'apply.sh');
    fs.writeFileSync(script, APPLY_MAC, { mode: 0o700 });
    progress.set('설치를 위해 앱을 다시 시작합니다…');
    // Detached with no stdio, so the helper outlives the app and finishes the swap once the app's process is gone.
    const helper = spawn('/bin/sh', [script, String(process.pid), next, target, path.join(stage, 'previous.app'), stage, work], { detached: true, stdio: 'ignore' });
    helper.unref();
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
