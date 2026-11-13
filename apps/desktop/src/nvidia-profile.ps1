# Turns NVIDIA RTX HDR off for one executable through the driver's own settings store (NvAPI DRS), the same switch NVIDIA's
# predefined profiles for Chrome, Edge and Slack carry. RTX HDR hooks the Present of every D3D11 app it does not know, which holds
# each of MoonerADE's frames ~49 ms (20 fps) while the UI animates. Writing this setting needs an elevated process; nvidia-rtx-hdr.js
# starts this script through one UAC prompt and reads -Result back. Windows PowerShell 5.1 compatible (Add-Type compiles C# 5).
#   -Exe      executable name the setting applies to (e.g. moonerade.exe)
#   -ProfileName  name of the profile to create when no profile lists the executable yet
#   -Undo     remove what -Exe/-ProfileName added: the whole profile if this script created it, otherwise only the setting
#   -Result   file that receives one line: "ok applied <profile>", "ok removed", "ok nothing" or "error <step> <NvAPI status>"
param([Parameter(Mandatory)][string]$Exe, [Parameter(Mandatory)][string]$ProfileName, [Parameter(Mandatory)][string]$Result, [switch]$Undo)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class AdeNvDrs {
  [DllImport("nvapi64.dll", EntryPoint = "nvapi_QueryInterface", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr QueryInterface(uint id);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Fn();
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FnOut(out IntPtr handle);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FnSession(IntPtr session);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FnFindProfile(IntPtr session, [MarshalAs(UnmanagedType.LPWStr)] string name, out IntPtr profile);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FnFindApp(IntPtr session, [MarshalAs(UnmanagedType.LPWStr)] string app, out IntPtr profile, IntPtr application);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FnCreateProfile(IntPtr session, IntPtr info, out IntPtr profile);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FnProfileBuf(IntPtr session, IntPtr profile, IntPtr buffer);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FnProfile(IntPtr session, IntPtr profile);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FnDeleteSetting(IntPtr session, IntPtr profile, uint setting);
  static T Get<T>(uint id) where T : class { IntPtr f = QueryInterface(id); if (f == IntPtr.Zero) throw new Exception("NvAPI function 0x" + id.ToString("X8") + " missing"); return Marshal.GetDelegateForFunctionPointer(f, typeof(T)) as T; }

  // NVDRS_* structs, version 1: 2048-character UTF-16 strings.
  const int STRING = 4096, PROFILE = 4 + STRING + 16, APPLICATION = 8 + STRING * 3, SETTING = 4 + STRING + 20 + 4100 * 2;
  public const uint RTX_HDR_ALLOW = 0x1077A11A;  // 0 = RTX HDR not allowed for this profile's applications
  const int EXECUTABLE_ALREADY_IN_USE = -163;
  static IntPtr Buffer(int size, int version) { IntPtr b = Marshal.AllocHGlobal(size); for (int i = 0; i < size; i += 4) Marshal.WriteInt32(b, i, 0); Marshal.WriteInt32(b, 0, size | (version << 16)); return b; }
  static void Text(IntPtr b, int offset, string value) { char[] c = value.ToCharArray(); for (int i = 0; i < c.Length && i < 2047; i++) Marshal.WriteInt16(b, offset + i * 2, c[i]); }
  static string Fail(string step, int status) { return "error " + step + " " + status; }

  static IntPtr session;
  static string Open() {
    int r = Get<Fn>(0x0150E828)(); if (r != 0) return Fail("initialize", r);
    r = Get<FnOut>(0x0694D52E)(out session); if (r != 0) return Fail("session", r);
    r = Get<FnSession>(0x375DBD6B)(session); return r != 0 ? Fail("load", r) : null;
  }
  static string Save() { int r = Get<FnSession>(0xFCBC7E14)(session); return r != 0 ? Fail("save", r) : null; }
  static IntPtr ProfileOf(string exe) { IntPtr p; IntPtr app = Buffer(APPLICATION, 1); int r = Get<FnFindApp>(0xEEE566B2)(session, exe, out p, app); Marshal.FreeHGlobal(app); return r == 0 ? p : IntPtr.Zero; }
  static string NameOf(IntPtr profile) { IntPtr b = Buffer(PROFILE, 1); try { return Get<FnProfileBuf>(0x61CD6FD6)(session, profile, b) == 0 ? Marshal.PtrToStringUni(new IntPtr(b.ToInt64() + 4)) : ""; } finally { Marshal.FreeHGlobal(b); } }
  // NVDRS_PROFILE: version, name, gpuSupport, isPredefined, numOfApps, numOfSettings.
  static int AppCount(IntPtr profile) { IntPtr b = Buffer(PROFILE, 1); try { return Get<FnProfileBuf>(0x61CD6FD6)(session, profile, b) == 0 ? Marshal.ReadInt32(b, 4 + STRING + 8) : -1; } finally { Marshal.FreeHGlobal(b); } }

  public static string Apply(string exe, string name) {
    string error = Open(); if (error != null) return error;
    IntPtr profile = ProfileOf(exe);
    if (profile == IntPtr.Zero && Get<FnFindProfile>(0x7E4A9A0B)(session, name, out profile) != 0) {
      IntPtr info = Buffer(PROFILE, 1); Text(info, 4, name); Marshal.WriteInt32(info, 4 + STRING, 1);  // gpuSupport: GeForce
      int r = Get<FnCreateProfile>(0xCC176068)(session, info, out profile); Marshal.FreeHGlobal(info); if (r != 0) return Fail("create-profile", r);
    }
    if (ProfileOf(exe) == IntPtr.Zero) {
      IntPtr app = Buffer(APPLICATION, 1); Text(app, 8, exe);
      int r = Get<FnProfileBuf>(0x4347A9DE)(session, profile, app); Marshal.FreeHGlobal(app);
      if (r != 0 && r != EXECUTABLE_ALREADY_IN_USE) return Fail("add-application", r);
    }
    IntPtr setting = Buffer(SETTING, 1);
    Marshal.WriteInt32(setting, 4 + STRING, unchecked((int)RTX_HDR_ALLOW));  // settingId; settingType 0 = DWORD
    Marshal.WriteInt32(setting, 4 + STRING + 20 + 4100, 0);                  // u32CurrentValue
    int status = Get<FnProfileBuf>(0x577DD202)(session, profile, setting); Marshal.FreeHGlobal(setting);
    if (status != 0) return Fail("set", status);
    error = Save(); return error ?? "ok applied " + NameOf(profile);
  }

  public static string Remove(string exe, string name) {
    string error = Open(); if (error != null) return error;
    IntPtr profile = ProfileOf(exe); if (profile == IntPtr.Zero) return "ok nothing";
    // The whole profile goes only when it is the one this script makes (its name, this executable alone); anywhere else, only the setting.
    bool ours = NameOf(profile) == name && AppCount(profile) == 1;
    int r = ours ? Get<FnProfile>(0x17093206)(session, profile) : Get<FnDeleteSetting>(0xE4A26362)(session, profile, RTX_HDR_ALLOW);
    if (r != 0 && r != -160) return Fail("remove", r);  // -160: setting was not set
    error = Save(); return error ?? "ok removed";
  }
}
'@
try { $line = if ($Undo) { [AdeNvDrs]::Remove($Exe.ToLowerInvariant(), $ProfileName) } else { [AdeNvDrs]::Apply($Exe.ToLowerInvariant(), $ProfileName) } }
catch { $line = "error exception $($_.Exception.Message -replace '\s+', ' ')" }
Set-Content -LiteralPath $Result -Value $line -Encoding ASCII
