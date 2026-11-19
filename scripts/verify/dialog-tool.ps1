# Reads, or answers with the keyboard, the native message box a given process shows (UI Automation). Only windows of that process id are looked at.
#   powershell -File dialog-tool.ps1 -ProcessId <pid> -Mode read              prints each window of the process: title, texts, pressable controls (JSON)
#   powershell -File dialog-tool.ps1 -ProcessId <pid> -Mode keys -Keys '+{TAB}~'   brings that dialog forward and sends the keys (SendKeys syntax) to it; exit 0 when sent,
#                                                                              4 when the dialog did not become the foreground window (nothing is sent then: the keys must never reach another window)
# Windows' task dialogs do not expose their buttons to UI Automation, so a button is chosen the way a user does: Shift+Tab / Tab to it and Enter (Electron focuses the last button).
param([Parameter(Mandatory = $true)][int]$ProcessId, [string]$Mode = 'read', [string]$Keys = '')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Fg { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
$automation = [System.Windows.Automation.AutomationElement]
$byProcess = New-Object System.Windows.Automation.PropertyCondition($automation::ProcessIdProperty, $ProcessId)
$found = @(); $dialog = $null
foreach ($window in $automation::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $byProcess)) {
  $texts = @()
  foreach ($item in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($item.Current.ControlType.ProgrammaticName -eq 'ControlType.Text' -and $item.Current.Name) { $texts += $item.Current.Name }
  }
  if ($texts.Count -gt 0) { $dialog = $window }
  $found += [pscustomobject]@{ title = $window.Current.Name; texts = $texts }
}
if ($Mode -eq 'keys') {
  if (-not $dialog) { exit 3 }
  $handle = [IntPtr]$dialog.Current.NativeWindowHandle
  [void][Fg]::SetForegroundWindow($handle); Start-Sleep -Milliseconds 400
  if ([Fg]::GetForegroundWindow() -ne $handle) { exit 4 }
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  exit 0
}
$found | ConvertTo-Json -Depth 4 -Compress
