// The Windows half of an update, kept apart from Electron so tests can load it (updater.js uses it; macOS has its own helper there).
//
// After the app exits, apply.ps1 mirrors the new files over the install folder and starts the app again. It is started through WMI
// (Win32_Process.Create) because Electron keeps its processes in a Windows job object that is torn down with the app, which kills even
// a detached child; a process the WMI service creates sits outside that job.
//
// Two things made an update show a "CMD window" for some users, and closing it ended the app:
// - The helper is a console program. Created through WMI with no startup settings it gets a visible console window. `-WindowStyle Hidden`
//   hides that window only after it exists, and Windows Terminal (the default terminal on Windows 11) does not hide it at all
//   (microsoft/terminal#12464). So the helper is created with CREATE_NO_WINDOW: its console has no window for anything to show.
// - Electron attaches itself to the console of the process that starts it. The restarted app therefore shared the helper's console,
//   kept it (and its window) open for as long as the app ran, and closing that window ended the app along with it.
//   ELECTRON_NO_ATTACH_CONSOLE makes Electron skip that, so the restarted app belongs to no console at all.

// Created by apply.ps1 as its first act: START_HELPER waits for it, so a helper that never came up is noticed while the app is still running.
export const HELPER_STARTED = 'helper-started';

// $Work holds this very script, so it cannot delete itself; a short-lived cmd removes the whole scratch folder once PowerShell has exited.
// That also holds when robocopy failed: the extracted copy is not kept, and the next check downloads it again.
export const APPLY = [
  'param($ProcessId, $Source, $Target, $Exe, $Work)',
  `New-Item -ItemType File -Path (Join-Path $Work '${HELPER_STARTED}') -Force | Out-Null`,
  'Wait-Process -Id $ProcessId -ErrorAction SilentlyContinue',
  'robocopy $Source $Target /MIR /R:30 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null',
  "$env:ELECTRON_NO_ATTACH_CONSOLE = '1'",
  'Start-Process -FilePath $Exe',
  `Start-Process -FilePath cmd.exe -ArgumentList '/c', ('ping -n 4 127.0.0.1 >nul & rmdir /s /q "' + $Work + '"') -WindowStyle Hidden`,
  ''
].join('\n');

// Win32_Process.Create(CommandLine, ..., ProcessStartupInformation), tried with the settings that leave the helper the least visible first.
// CreateFlags 0x08000400 is CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT: WMI answers 21 (invalid parameter) to CREATE_NO_WINDOW alone but takes it
// next to another flag, and the second one is harmless. If a Windows version refuses or the helper does not show up, ShowWindow 0 (SW_HIDE) is
// next, then plain creation, which is how the helper has always been started. The helper counts as started once it has written its marker file
// (a console program started without a console can die at once with WMI still answering 0); one that did not is stopped before the next try.
// Reads the command line from MOONER_UPDATE_COMMAND and the marker path from MOONER_UPDATE_MARKER. Exit code 0: the helper is running.
export const startHelperScript = ({ waitSeconds = 15 } = {}) => [
  "$ErrorActionPreference = 'Stop'",
  '$code = 1',
  '$attempts = @(',
  '  @{ CreateFlags = [uint32]0x08000400; ShowWindow = [uint16]0 },',
  '  @{ ShowWindow = [uint16]0 },',
  '  $null',
  ')',
  'foreach ($attempt in $attempts) {',
  '  try {',
  '    $arguments = @{ CommandLine = $env:MOONER_UPDATE_COMMAND }',
  '    if ($attempt) { $arguments.ProcessStartupInformation = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property $attempt }',
  '    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $arguments',
  '    if (-not $result -or $result.ReturnValue -ne 0) { continue }',
  `    $deadline = (Get-Date).AddSeconds(${Number(waitSeconds)})`,
  '    while (-not (Test-Path -LiteralPath $env:MOONER_UPDATE_MARKER) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }',
  '    if (Test-Path -LiteralPath $env:MOONER_UPDATE_MARKER) { $code = 0; break }',
  '    Stop-Process -Id $result.ProcessId -Force -ErrorAction SilentlyContinue',
  '  } catch { }',
  '}',
  'exit $code',
  ''
].join('\n');

// The command line WMI starts. `-WindowStyle Hidden` stays as the last defence for the plain attempt.
export const helperCommandLine = ({ script, pid, source, target, exe, work }) =>
  ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, String(pid), source, target, exe, work]
    .map(arg => /\s/.test(arg) ? `"${arg}"` : arg).join(' ');

// powershell.exe's arguments to run the start script from a file, the way apply.ps1 runs (an encoded command is what antivirus products suspect).
export const startHelperArguments = script => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
