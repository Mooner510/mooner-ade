import { execFile, spawn } from 'node:child_process';
import { parseProcessTable } from './terminal-processes.js';

const END = '<<ade-process-table-end>>';
// Each request line ("pid,pid,..." or empty for everything) prints the table and then END. UTF-8 output keeps non-ASCII
// command lines (e.g. Korean paths) intact.
// Listing every process through WMI costs ~85 ms of CPU here plus as much again in the WMI service, every tick. With root
// PIDs, a Toolhelp snapshot (microseconds) finds the processes below them, and WMI is asked only for the command lines of
// processes it has not seen yet, so an idle tick costs no WMI call at all. Without Add-Type it falls back to full listings.
const LOOP = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$fast = $true
try { Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class AdeProcessTree {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry { public uint size, usage, pid; public IntPtr heap; public uint module, threads, ppid; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static string[] Below(uint[] roots) {
    var all = new List<Entry>(); var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) return null;
    try { var entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry)); if (Process32FirstW(snapshot, ref entry)) do { all.Add(entry); } while (Process32NextW(snapshot, ref entry)); }
    finally { CloseHandle(snapshot); }
    var keep = new HashSet<uint>(roots); var rows = new List<string>(); bool grew = true;
    while (grew) { grew = false; foreach (var e in all) if (e.pid != 0 && !keep.Contains(e.pid) && keep.Contains(e.ppid)) { keep.Add(e.pid); grew = true; } }
    foreach (var e in all) if (keep.Contains(e.pid)) rows.Add(e.pid + " " + e.ppid + " " + e.exe);
    return rows.ToArray();
  }
}
'@ } catch { $fast = $false }
$known = @{}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $roots = [uint32[]]@($line -split ',' | Where-Object { $_ -match '^\\d+$' })
  $rows = if ($fast -and $roots.Count) { [AdeProcessTree]::Below($roots) } else { $null }
  if ($null -eq $rows) {
    Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine,Name | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CommandLine) { $_.CommandLine } else { $_.Name })" }
  } else {
    $new = @($rows | Where-Object { -not $known.ContainsKey($_) } | ForEach-Object { $_.Split(' ')[0] })
    $lines = @{}
    if ($new.Count) { Get-CimInstance Win32_Process -Filter (($new | ForEach-Object { "ProcessId=$_" }) -join ' OR ') -Property ProcessId,CommandLine | ForEach-Object { $lines[[string]$_.ProcessId] = $_.CommandLine } }
    $next = @{}
    foreach ($row in $rows) {
      $part = $row.Split(' ', 3)
      $next[$row] = if ($known.ContainsKey($row)) { $known[$row] } elseif ($lines[$part[0]]) { $lines[$part[0]] } else { $part[2] }
      "$($part[0]) $($part[1]) $($next[$row])"
    }
    $known = $next
  }
  '${END}'
}`;

// Starting powershell.exe and loading CIM costs ~0.6 s of CPU, too much to repeat every few seconds, so Windows keeps one
// shell running and asks it again. Given root PIDs, the table may hold only those and the processes below them.
// It is restarted on the next call after it dies or hangs; null means "no reading".
function windowsTable({ timeoutMs }) {
  let child = null, output = '', waiting = null, queue = Promise.resolve();
  const stop = () => { child?.kill(); child = null; };
  const start = () => {
    const shell = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(LOOP, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child = shell; output = '';
    shell.stdout.setEncoding('utf8');
    // A shell that was stopped (timeout, close) may still emit; only the current one answers the pending request.
    shell.stdout.on('data', chunk => {
      if (child !== shell) return;
      output += chunk;
      const end = output.indexOf(END);
      if (end < 0) return;
      const table = output.slice(0, end); output = output.slice(end + END.length);
      waiting?.(parseProcessTable(table));
    });
    const gone = () => { if (child !== shell) return; child = null; waiting?.(null); };
    shell.once('error', gone); shell.once('exit', gone);
    shell.stdin.on('error', () => {});
    shell.unref(); shell.stdout.unref?.(); shell.stdin.unref?.();
  };
  const ask = roots => new Promise(resolve => {
    if (!child) start();
    const timer = setTimeout(() => { stop(); finish(null); }, timeoutMs);
    const finish = value => { clearTimeout(timer); waiting = null; resolve(value); };
    waiting = finish;
    child.stdin.write(`${roots.join(',')}\r\n`);
  });
  const table = (roots = []) => { const next = queue.then(() => ask(roots)); queue = next; return next; };
  return Object.assign(table, { close: stop });
}

function psTable({ timeoutMs }) {
  const table = () => new Promise(resolve => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,args='], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, out) => resolve(error ? null : parseProcessTable(out)));
  });
  return Object.assign(table, { close() {} });
}

export function createProcessTable({ platform = process.platform, timeoutMs = 8000 } = {}) {
  return platform === 'win32' ? windowsTable({ timeoutMs }) : psTable({ timeoutMs });
}
