// Native "choose folder" dialog for the browser UI, which cannot learn absolute paths itself. The server always runs on the
// user's own machine (127.0.0.1), so the dialog opens on their desktop. The desktop app uses Electron's dialog instead.
import { execFile } from 'node:child_process';
import { fault } from './files.js';

// Windows: the same modern folder picker Explorer and Electron use (IFileOpenDialog with FOS_PICKFOLDERS), driven from
// Windows PowerShell, which every Windows install has. Title and start folder arrive through the environment, never the script.
const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AdeFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRcw {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr bindContext, ref Guid iid, out IShellItem item);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static string Pick(string title, string start) {
    var dialog = (IFileDialog)new FileOpenDialogRcw();
    uint options; dialog.GetOptions(out options);
    dialog.SetOptions(options | 0x20 | 0x40 | 0x800); // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST
    if (!String.IsNullOrEmpty(title)) dialog.SetTitle(title);
    if (!String.IsNullOrEmpty(start)) {
      try { Guid iid = typeof(IShellItem).GUID; IShellItem folder; SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder); dialog.SetFolder(folder); } catch {}
    }
    // Owned by the browser window that was just clicked, so the dialog opens in front of it.
    if (dialog.Show(GetForegroundWindow()) != 0) return null;
    IShellItem item; dialog.GetResult(out item);
    string path; item.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
'@
$picked = [AdeFolderPicker]::Pick($env:ADE_DIALOG_TITLE, $env:ADE_DIALOG_START)
if ($picked) { [Console]::Out.Write($picked) }
`;

function run(file, args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: { ...process.env, ...env }, windowsHide: false, timeout: 30 * 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') return reject(error);
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function pick(title, start) {
  if (process.platform === 'win32') {
    const encoded = Buffer.from(windowsScript, 'utf16le').toString('base64');
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { ADE_DIALOG_TITLE: title, ADE_DIALOG_START: start });
    if (result.code !== 0) throw fault('DIALOG_FAILED', `폴더 선택 창을 열지 못했습니다.\n${result.stderr.trim().slice(-400)}`);
    return result.stdout.trim() || null;
  }
  if (process.platform === 'darwin') {
    const script = start
      ? ['on run argv', 'return POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))', 'end run']
      : ['on run argv', 'return POSIX path of (choose folder with prompt (item 1 of argv))', 'end run'];
    const result = await run('osascript', [...script.flatMap(line => ['-e', line]), title, ...(start ? [start] : [])]);
    if (result.code !== 0) { if (/-128/.test(result.stderr)) return null; throw fault('DIALOG_FAILED', `폴더 선택 창을 열지 못했습니다.\n${result.stderr.trim().slice(-400)}`); }
    const picked = result.stdout.trim();
    return picked.length > 1 ? picked.replace(/\/+$/, '') : picked || null;
  }
  // Linux and other desktops: whichever of zenity or kdialog is installed. Exit code 1 is a cancel in both.
  for (const [file, args] of [
    ['zenity', ['--file-selection', '--directory', `--title=${title}`, ...(start ? [`--filename=${start.replace(/\/*$/, '/')}`] : [])]],
    ['kdialog', ['--getexistingdirectory', start || '.', '--title', title]]
  ]) {
    try {
      const result = await run(file, args);
      if (result.code === 1) return null;
      if (result.code !== 0) throw fault('DIALOG_FAILED', `폴더 선택 창을 열지 못했습니다.\n${result.stderr.trim().slice(-400)}`);
      return result.stdout.trim() || null;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw fault('DIALOG_UNAVAILABLE', '폴더 선택 창을 띄울 수 없습니다. zenity 또는 kdialog를 설치하세요.');
}

// One dialog at a time: a second click while one is open waits for the same answer instead of stacking windows.
let pending = null;
export function chooseFolder(input = {}) {
  const title = typeof input.title === 'string' ? input.title.slice(0, 200) : '폴더 선택';
  const start = typeof input.defaultPath === 'string' && !input.defaultPath.includes('\0') ? input.defaultPath.slice(0, 4096) : '';
  pending ||= pick(title, start).then(path => ({ path }), error => { throw error.code === 'ENOENT' ? fault('DIALOG_UNAVAILABLE', '폴더 선택 창을 띄울 수 없습니다.') : error; }).finally(() => { pending = null; });
  return pending;
}
