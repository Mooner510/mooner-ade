// NVIDIA RTX HDR (NVIDIA App › Graphics) post-processes every D3D11 app the driver has no profile for. It loads nvppex.dll into
// Chromium's GPU process and holds each DXGI Present ~49 ms, so MoonerADE's UI animates at 20 fps and the GPU process spins half a
// core while it waits. Chrome, Edge and Slack are exempt through NVIDIA's predefined profiles (setting 0x1077A11A "RTX HDR allow" = 0);
// no Chromium switch avoids it without giving up GPU compositing. So on Windows, once after start, this checks whether the GPU
// process has the RTX HDR module and, if so, offers to add that one setting for this executable. Writing it needs admin rights,
// hence one UAC prompt (nvidia-profile.ps1). Nothing is asked again after "다시 묻지 않기" or once the profile is in place.
// No electron import: main.js passes app/dialog in, so tests drive it with fakes.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RTX_HDR_MODULE = 'nvppex.dll';
export const PROFILE_NAME = 'MoonerADE';
const SCRIPT = path.join(import.meta.dirname, 'nvidia-profile.ps1');
const STATE_FILE = 'nvidia-rtx-hdr.json';
// The GPU process loads the module while it brings up D3D; a little after the window shows it is there or it will not come.
const CHECK_DELAY_MS = 8000;

const run = (file, args) => new Promise(resolve => execFile(file, args, { windowsHide: true, timeout: 120_000 }, (error, stdout) => resolve({ error, stdout: String(stdout ?? '') })));

// `tasklist /m <dll> /fi "PID eq <pid>" /fo csv /nh` prints `"Image","PID","Modules"` when the process has the module loaded and an
// INFO line in the system's language otherwise, so only a CSV row naming the PID counts.
export const moduleLoaded = (output, pid) => output.split(/\r?\n/).some(line => line.trim().split('","')[1] === String(pid));

export async function rtxHdrHooked(pid, exec = run) {
  const { stdout } = await exec('tasklist.exe', ['/m', RTX_HDR_MODULE, '/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh']);
  return moduleLoaded(stdout, pid);
}

// PowerShell single-quoted literal; Start-Process re-joins ArgumentList with spaces, so an item with a space keeps double quotes too.
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const argument = value => literal(/\s/.test(value) ? `"${value}"` : value);
export function elevatedCommand({ exe, profile = PROFILE_NAME, result, undo = false, script = SCRIPT }) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Exe', exe, '-ProfileName', profile, '-Result', result, ...(undo ? ['-Undo'] : [])];
  return `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ${args.map(argument).join(',')}`;
}

// Resolves the script's one-line result ("ok applied <profile>", "ok removed", "error <step> <status>"), or "cancelled" when the UAC
// prompt was declined (Start-Process throws and no result file is written).
export async function setRtxHdrProfile({ exe, profile = PROFILE_NAME, undo = false, exec = run, tmp = os.tmpdir() }) {
  const result = path.join(tmp, `ade-nvidia-${process.pid}-${Date.now()}.txt`);
  const { error } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', elevatedCommand({ exe, profile, result, undo })]);
  let line = '';
  try { line = fs.readFileSync(result, 'utf8').trim(); } catch { /* no result: declined or failed to start */ }
  fs.rmSync(result, { force: true });
  return line || (error ? 'cancelled' : 'error no-result');
}

const readState = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };

const DETAIL = [
  'NVIDIA App의 RTX HDR이 무너에이드 화면의 프레임마다 끼어들어, 애니메이션과 마우스 반응이 초당 20프레임으로 끊기고 CPU를 계속 씁니다.',
  '"해결"을 누르면 관리자 권한을 한 번 확인한 뒤 NVIDIA 드라이버에 무너에이드 전용 설정(RTX HDR 끔)을 추가합니다. Chrome·Edge·Slack에 NVIDIA가 기본으로 넣어 둔 것과 같은 설정이며, 다른 게임과 앱의 RTX HDR은 그대로입니다.',
].join('\n\n');
const MANUAL = 'NVIDIA App › 그래픽 › 프로그램 설정에서 MoonerADE를 추가해 RTX HDR을 끄면 같은 효과입니다.';

// Returns the pending check so tests can await it; main.js ignores it.
export function watchRtxHdr({ app, dialog, getWindow, userData, platform = process.platform, env = process.env, exec = run, delayMs = CHECK_DELAY_MS, exe = path.basename(process.execPath), profile = PROFILE_NAME }) {
  if (platform !== 'win32' || env.ADE_NVIDIA_CHECK === '0') return Promise.resolve('off');
  const stateFile = path.join(userData, STATE_FILE);
  if (readState(stateFile).dismissed) return Promise.resolve('dismissed');
  const ask = options => { const window = getWindow(); return window && !window.isDestroyed() ? dialog.showMessageBox(window, { noLink: true, title: '무너에이드', ...options }) : dialog.showMessageBox({ noLink: true, title: '무너에이드', ...options }); };
  return new Promise(resolve => setTimeout(resolve, delayMs).unref?.()).then(async () => {
    const gpu = app.getAppMetrics().find(metric => metric.type === 'GPU');
    if (!gpu || !(await rtxHdrHooked(gpu.pid, exec))) return 'clear';
    const { response, checkboxChecked } = await ask({ type: 'warning', buttons: ['해결', '나중에'], defaultId: 0, cancelId: 1, message: 'NVIDIA RTX HDR 때문에 화면이 끊기고 있습니다', detail: DETAIL, checkboxLabel: '다시 묻지 않기' });
    if (checkboxChecked) fs.writeFileSync(stateFile, JSON.stringify({ dismissed: true }));
    if (response !== 0) return 'later';
    const outcome = await setRtxHdrProfile({ exe: exe.toLowerCase(), profile, exec });
    if (outcome === 'cancelled') return 'cancelled';
    if (!outcome.startsWith('ok')) {
      await ask({ type: 'error', buttons: ['확인'], message: 'NVIDIA 설정을 바꾸지 못했습니다', detail: `${outcome}\n\n${MANUAL}` });
      return 'failed';
    }
    const restart = await ask({ type: 'info', buttons: ['지금 다시 시작', '나중에'], defaultId: 0, cancelId: 1, message: 'NVIDIA 설정을 추가했습니다', detail: '무너에이드를 다시 시작하면 적용됩니다. 진행 중인 터미널은 그대로 이어집니다.' });
    if (restart.response === 0) { app.relaunch(); app.quit(); }
    return 'fixed';
  }).catch(error => { console.warn(`RTX HDR 확인 실패: ${error.message}`); return 'error'; });
}
