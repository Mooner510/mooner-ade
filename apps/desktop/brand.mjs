import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const icon = path.join(import.meta.dirname, 'assets/icon.png');

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
