# Windows: asks whether a process shares a console, and can close that console's window the way the X button does.
#   -Mode attached: exit code 10 when the process is attached to a console, 11 when it is not (AttachConsole fails with "invalid handle").
#   -Mode close:    shows the console window (a hidden one is what Windows Terminal would show) and posts WM_CLOSE to it; exit code 10 when it did, 11 when there is none.
# Used by scripts/verify/t-update-win.mjs. This process leaves its own console first, so it never closes the console of whoever started it.
param([Parameter(Mandatory)][ValidateSet('attached', 'close')][string]$Mode, [Parameter(Mandatory)][int]$ProcessId)
Add-Type -Namespace Native -Name Console -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
'@
[void][Native.Console]::FreeConsole()
if (-not [Native.Console]::AttachConsole([uint32]$ProcessId)) { exit 11 }
if ($Mode -eq 'attached') { [void][Native.Console]::FreeConsole(); exit 10 }
$window = [Native.Console]::GetConsoleWindow()
if ($window -eq [IntPtr]::Zero) { [void][Native.Console]::FreeConsole(); exit 11 }
[void][Native.Console]::ShowWindow($window, 7) # minimised, no focus: visible as Windows Terminal's window would be
Start-Sleep -Milliseconds 300
[void][Native.Console]::PostMessage($window, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) # WM_CLOSE
Start-Sleep -Milliseconds 1500
exit 10
