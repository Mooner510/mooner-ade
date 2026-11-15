# Windows only: spawn() runs .exe only, so the fake `claude` (a node script) needs a launcher. Builds bin/claude.exe (ignored by git) that runs `node bin/claude <args>`.
$dir = $PSScriptRoot
$src = @'
using System; using System.Diagnostics; using System.IO; using System.Linq;
class P { static int Main(string[] a) {
  var script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "claude");
  var info = new ProcessStartInfo("node", string.Join(" ", new[] { "\"" + script + "\"" }.Concat(a.Select(x => "\"" + x.Replace("\"", "\\\"") + "\"")))) { UseShellExecute = false };
  var p = Process.Start(info); p.WaitForExit(); return p.ExitCode; } }
'@
Add-Type -TypeDefinition $src -OutputType ConsoleApplication -OutputAssembly (Join-Path $dir 'claude.exe')
