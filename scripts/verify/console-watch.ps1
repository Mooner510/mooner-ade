# Windows: records every console window that becomes visible (classic conhost: ConsoleWindowClass, Windows Terminal: CASCADIA_HOSTING_WINDOW_CLASS)
# until the stop file appears, then writes them to the output file as JSON. Windows that were already open when it started are ignored.
# Used by scripts/verify/t-update-win.mjs to prove that an update never shows a console window.
param([Parameter(Mandatory)][string]$Stop, [Parameter(Mandatory)][string]$Out, [Parameter(Mandatory)][string]$Ready)
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Diagnostics; using System.IO; using System.Runtime.InteropServices; using System.Text; using System.Threading;
public static class ConsoleWatch {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  static void Each(Action<IntPtr, string, string, uint> visit) {
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      var cls = c.ToString();
      if (cls != "ConsoleWindowClass" && cls != "CASCADIA_HOSTING_WINDOW_CLASS") return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      uint pid; GetWindowThreadProcessId(h, out pid);
      visit(h, cls, t.ToString(), pid); return true;
    }, IntPtr.Zero);
  }
  public static string Run(string stop, string ready) {
    var before = new HashSet<long>(); Each((h, c, t, p) => before.Add(h.ToInt64()));
    var first = new Dictionary<long, long>(); var last = new Dictionary<long, long>(); var info = new Dictionary<long, string>();
    var sw = Stopwatch.StartNew(); File.WriteAllText(ready, "1");
    while (!File.Exists(stop)) {
      Each((h, c, t, p) => {
        long k = h.ToInt64(); if (before.Contains(k)) return;
        if (!first.ContainsKey(k)) { first[k] = sw.ElapsedMilliseconds; info[k] = c + "\t" + p + "\t" + t.Replace("\t", " ").Replace("\r", " ").Replace("\n", " "); }
        last[k] = sw.ElapsedMilliseconds;
      });
      Thread.Sleep(4);
    }
    var lines = new List<string>();
    foreach (var k in first.Keys) lines.Add(k + "\t" + first[k] + "\t" + last[k] + "\t" + info[k]);
    return string.Join("\n", lines);
  }
}
'@
$rows = foreach ($line in ([ConsoleWatch]::Run($Stop, $Ready) -split "`n" | Where-Object { $_ })) {
  $f = $line -split "`t", 6
  $parent = $null
  try { $conhost = Get-CimInstance Win32_Process -Filter "ProcessId=$($f[4])" -ErrorAction Stop; $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($conhost.ParentProcessId)" -ErrorAction SilentlyContinue } catch { }
  [pscustomobject]@{ hwnd = $f[0]; firstMs = [int64]$f[1]; lastMs = [int64]$f[2]; class = $f[3]; ownerPid = [int]$f[4]; title = $f[5]; ownerParent = $parent.Name }
}
ConvertTo-Json -InputObject @($rows) -Compress | Set-Content -LiteralPath $Out -Encoding UTF8
