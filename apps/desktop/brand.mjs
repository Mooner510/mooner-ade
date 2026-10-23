import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as ResEdit from 'resedit';

export const icon = path.join(import.meta.dirname, 'assets/icon.png');

// Windows Explorer shows the icon and name embedded in the .exe, not the BrowserWindow icon.
// Electron keeps its icon group at id 1 and its version strings in en-US (1033).
export function brandExe(exe, productName, version) {
  const binary = ResEdit.NtExecutable.from(readFileSync(exe), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(binary);
  const ico = ResEdit.Data.IconFile.from(readFileSync(path.join(import.meta.dirname, 'assets/icon.ico')));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, ico.icons.map(item => item.data));
  const [info] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  info.setStringValues({ lang: 1033, codepage: 1200 }, {
    CompanyName: 'Mooner', FileDescription: productName, ProductName: productName, FileVersion: version, ProductVersion: version,
    InternalName: `${productName}.exe`, OriginalFilename: `${productName}.exe`, LegalCopyright: ''
  });
  info.removeStringValue({ lang: 1033, codepage: 1200 }, 'SquirrelAwareVersion');
  const [major, minor, patch] = version.split('.').map(Number);
  info.setFileVersion(major, minor, patch, 0, 1033);
  info.setProductVersion(major, minor, patch, 0, 1033);
  info.outputToResourceEntries(resources.entries);
  resources.outputResource(binary);
  writeFileSync(exe, Buffer.from(binary.generate()));
}

// macOS takes the notification icon and identity from the bundle, not from app.dock.setIcon().
// A distinct bundle id keeps Notification Center from reusing the cached Electron icon.
export function brandBundle(bundle, productName) {
  const plist = path.join(bundle, 'Contents/Info.plist');
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) execFileSync('/usr/bin/plutil', ['-replace', key, '-string', productName, plist]);
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.mooner.ade', plist]);
  const icns = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', plist], { encoding: 'utf8' }).trim();
  const temp = mkdtempSync(path.join(os.tmpdir(), 'mooner-ade-icon-'));
  try {
    const iconset = path.join(temp, 'icon.iconset');
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        if (size * scale > 512) continue;
        const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
        execFileSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), icon, '--out', path.join(iconset, name)], { stdio: 'ignore' });
      }
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(bundle, 'Contents/Resources', icns)]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
