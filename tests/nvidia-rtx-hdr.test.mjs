import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { elevatedCommand, moduleLoaded, rtxHdrHooked, setRtxHdrProfile, watchRtxHdr } from '../apps/desktop/src/nvidia-rtx-hdr.js';

const ROW = '"MoonerADE.exe","2240","nvppex.dll"';
const NONE_KO = '정보: 지정된 조건에 일치하는 작업이 없습니다.';

test('tasklist output counts only a CSV row naming the GPU process', () => {
  assert.equal(moduleLoaded(`${ROW}\r\n`, 2240), true);
  assert.equal(moduleLoaded(ROW, '2240'), true);
  assert.equal(moduleLoaded(`${NONE_KO}\r\n`, 2240), false);
  assert.equal(moduleLoaded('INFO: No tasks are running which match the specified criteria.', 2240), false);
  assert.equal(moduleLoaded('"MoonerADE.exe","22400","nvppex.dll"', 2240), false);
  assert.equal(moduleLoaded('', 2240), false);
});

test('the module check asks tasklist about the one GPU process', async () => {
  let call;
  const hooked = await rtxHdrHooked(2240, async (file, args) => { call = [file, args]; return { stdout: ROW }; });
  assert.equal(hooked, true);
  assert.deepEqual(call, ['tasklist.exe', ['/m', 'nvppex.dll', '/fi', 'PID eq 2240', '/fo', 'csv', '/nh']]);
});

test('the elevated command quotes paths with spaces and apostrophes for Start-Process', () => {
  const command = elevatedCommand({ exe: 'moonerade.exe', result: "C:\\Users\\O'Neil\\AppData\\Local\\Temp\\r.txt", script: 'C:\\Program Files\\ADE\\nvidia-profile.ps1', undo: true });
  assert.match(command, /^Start-Process -FilePath powershell\.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList /);
  assert.ok(command.includes(`'"C:\\Program Files\\ADE\\nvidia-profile.ps1"'`));
  assert.ok(command.includes(`'C:\\Users\\O''Neil\\AppData\\Local\\Temp\\r.txt'`));
  assert.ok(command.includes(`'-ProfileName','MoonerADE'`));
  assert.ok(command.endsWith(`,'-Undo'`));
  assert.ok(!elevatedCommand({ exe: 'moonerade.exe', result: 'r.txt' }).includes('-Undo'));
});

// A powershell.exe stand-in: writes what the elevated script would have written, or fails like a declined UAC prompt.
const powershell = line => async (file, args) => {
  assert.equal(file, 'powershell.exe');
  const result = args.at(-1).match(/'-Result','([^']+)'/)[1];
  if (line === null) return { error: new Error('The operation was canceled by the user.'), stdout: '' };
  fs.writeFileSync(result, `${line}\r\n`);
  return { error: null, stdout: '' };
};

test('setting the profile returns the script result and removes the result file', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-nvidia-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  assert.equal(await setRtxHdrProfile({ exe: 'moonerade.exe', exec: powershell('ok applied MoonerADE'), tmp }), 'ok applied MoonerADE');
  assert.equal(await setRtxHdrProfile({ exe: 'moonerade.exe', exec: powershell('error set -137'), tmp }), 'error set -137');
  assert.equal(await setRtxHdrProfile({ exe: 'moonerade.exe', exec: powershell(null), tmp }), 'cancelled');
  assert.deepEqual(fs.readdirSync(tmp), []);
});

function harness(t, { hooked = true, answers = [], script = 'ok applied MoonerADE', state } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-nvidia-user-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  if (state) fs.writeFileSync(path.join(userData, 'nvidia-rtx-hdr.json'), JSON.stringify(state));
  const asked = [], calls = [];
  const app = { getAppMetrics: () => [{ type: 'Browser', pid: 1 }, { type: 'GPU', pid: 2240 }], relaunch: () => calls.push('relaunch'), quit: () => calls.push('quit') };
  const dialog = { showMessageBox: async (...args) => { const options = args.at(-1); asked.push(options); return answers.shift() ?? { response: 1, checkboxChecked: false }; } };
  const ps = powershell(script);
  const exec = async (file, args) => {
    calls.push(file);
    if (file === 'tasklist.exe') return { stdout: hooked ? ROW : NONE_KO };
    return ps(file, args);
  };
  const run = (extra = {}) => watchRtxHdr({ app, dialog, getWindow: () => null, userData, platform: 'win32', env: {}, exec, delayMs: 0, exe: 'MoonerADE.exe', ...extra });
  return { run, asked, calls, userData };
}

test('outside Windows, with the check turned off, or after "다시 묻지 않기" nothing runs', async t => {
  const h = harness(t);
  assert.equal(await h.run({ platform: 'darwin' }), 'off');
  assert.equal(await h.run({ env: { ADE_NVIDIA_CHECK: '0' } }), 'off');
  assert.equal(await harness(t, { state: { dismissed: true } }).run(), 'dismissed');
  assert.deepEqual(h.calls, []);
});

test('a GPU process without the RTX HDR module asks nothing', async t => {
  const h = harness(t, { hooked: false });
  assert.equal(await h.run(), 'clear');
  assert.deepEqual(h.asked, []);
  assert.deepEqual(h.calls, ['tasklist.exe']);
});

test('"나중에" with "다시 묻지 않기" remembers the choice and changes nothing', async t => {
  const h = harness(t, { answers: [{ response: 1, checkboxChecked: true }] });
  assert.equal(await h.run(), 'later');
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0].type, 'warning');
  assert.deepEqual(h.asked[0].buttons, ['해결', '나중에']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.userData, 'nvidia-rtx-hdr.json'), 'utf8')), { dismissed: true });
  assert.deepEqual(h.calls, ['tasklist.exe']);
  assert.equal(await h.run(), 'dismissed');
});

test('"해결" sets the profile for the lower-cased executable and offers a restart', async t => {
  const h = harness(t, { answers: [{ response: 0 }, { response: 0 }] });
  assert.equal(await h.run(), 'fixed');
  assert.deepEqual(h.calls, ['tasklist.exe', 'powershell.exe', 'relaunch', 'quit']);
  assert.equal(h.asked[1].message, 'NVIDIA 설정을 추가했습니다');
});

test('a restart can wait, a declined UAC prompt is quiet and a failure explains the manual way', async t => {
  const later = harness(t, { answers: [{ response: 0 }, { response: 1 }] });
  assert.equal(await later.run(), 'fixed');
  assert.ok(!later.calls.includes('relaunch'));

  const declined = harness(t, { answers: [{ response: 0 }], script: null });
  assert.equal(await declined.run(), 'cancelled');
  assert.equal(declined.asked.length, 1);

  const failed = harness(t, { answers: [{ response: 0 }], script: 'error set -137' });
  assert.equal(await failed.run(), 'failed');
  assert.equal(failed.asked[1].type, 'error');
  assert.match(failed.asked[1].detail, /error set -137/);
  assert.match(failed.asked[1].detail, /NVIDIA App/);
});
