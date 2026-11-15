import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPLY, HELPER_STARTED, helperCommandLine, startHelperArguments, startHelperScript } from '../apps/desktop/src/update-windows.js';

const windows = process.platform === 'win32';
const lines = text => text.split('\n');

test('the restarted app is started off the helper\'s console', () => {
  const rows = lines(APPLY);
  const marker = rows.indexOf("$env:ELECTRON_NO_ATTACH_CONSOLE = '1'"), start = rows.indexOf('Start-Process -FilePath $Exe');
  assert.ok(marker > 0, 'ELECTRON_NO_ATTACH_CONSOLE is set');
  assert.ok(start > marker, 'and set before the app starts');
  assert.ok(rows.indexOf('Wait-Process -Id $ProcessId -ErrorAction SilentlyContinue') < rows.findIndex(row => row.startsWith('robocopy ')), 'the old app is gone before files are replaced');
  assert.ok(!/-WindowStyle/.test(rows[start]), 'the app itself is never started hidden: its first window would stay hidden');
});

test('the helper announces itself before it waits for the app', () => {
  const rows = lines(APPLY);
  assert.match(rows[0], /^param\(/);
  assert.equal(rows[1], `New-Item -ItemType File -Path (Join-Path $Work '${HELPER_STARTED}') -Force | Out-Null`);
  assert.ok(rows.indexOf('Wait-Process -Id $ProcessId -ErrorAction SilentlyContinue') > 1);
});

test('the helper is created without a console window, then with fewer guarantees', () => {
  const script = startHelperScript({ waitSeconds: 7 });
  const attempts = lines(script).filter(row => /^\s+(@\{ (CreateFlags|ShowWindow)|\$null)/.test(row)).map(row => row.trim());
  assert.deepEqual(attempts, [
    '@{ CreateFlags = [uint32]0x08000400; ShowWindow = [uint16]0 },',
    '@{ ShowWindow = [uint16]0 },',
    '$null',
  ], 'CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT first, SW_HIDE next, the plain creation of old versions last');
  assert.match(script, /AddSeconds\(7\)/);
  assert.match(script, /Stop-Process -Id \$result\.ProcessId/, 'a helper that did not come up is stopped before the next attempt');
  assert.match(script, /^exit \$code$/m);
});

test('the helper command line quotes what has spaces and starts hidden as a last defence', () => {
  const command = helperCommandLine({ script: 'C:\\Users\\a b\\Temp\\mooner-update-x\\apply.ps1', pid: 4242, source: 'C:\\t\\new\\app', target: 'C:\\Program Files\\ADE\\resources\\app', exe: 'C:\\Program Files\\ADE\\MoonerADE.exe', work: 'C:\\t' });
  assert.equal(command, 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Users\\a b\\Temp\\mooner-update-x\\apply.ps1" 4242 C:\\t\\new\\app "C:\\Program Files\\ADE\\resources\\app" "C:\\Program Files\\ADE\\MoonerADE.exe" C:\\t');
});

test('the start script runs from a file like apply.ps1, not as an encoded command', () => {
  assert.deepEqual(startHelperArguments('C:\\t\\start.ps1'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\t\\start.ps1']);
});

// Runs a script in Windows PowerShell the way the updater does: from a file, hidden, with the given environment.
const powershell = (script, env = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-update-win-ps-'));
  try {
    const file = path.join(dir, 'test.ps1');
    fs.writeFileSync(file, script);
    return spawnSync('powershell.exe', startHelperArguments(file), { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('both PowerShell scripts parse', { skip: !windows }, () => {
  for (const script of [APPLY, startHelperScript()]) {
    const result = powershell('$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:ADE_TEST_SCRIPT, [ref]$null, [ref]$errors); $errors | ForEach-Object { $_.Message }; exit $errors.Count', { ADE_TEST_SCRIPT: script });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test('the helper starts through WMI and the start script answers once its marker exists', { skip: !windows }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-update-win-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, HELPER_STARTED);
  const command = `powershell.exe -NoProfile -Command "New-Item -ItemType File -Path '${marker}' -Force | Out-Null"`;
  const result = powershell(startHelperScript(), { MOONER_UPDATE_COMMAND: command, MOONER_UPDATE_MARKER: marker });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(marker));
});

test('a helper that never shows up fails the start after every way was tried', { skip: !windows }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-update-win-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const started = Date.now();
  const result = powershell(startHelperScript({ waitSeconds: 1 }), { MOONER_UPDATE_COMMAND: 'cmd.exe /c exit 0', MOONER_UPDATE_MARKER: path.join(dir, HELPER_STARTED) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(Date.now() - started >= 3000, 'three attempts of one second each');
});

test('a command line WMI cannot start fails the start', { skip: !windows }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-update-win-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = powershell(startHelperScript({ waitSeconds: 1 }), { MOONER_UPDATE_COMMAND: 'C:\\no\\such\\folder\\helper.exe', MOONER_UPDATE_MARKER: path.join(dir, HELPER_STARTED) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
});
