// The page tells how many tabs need the user (apps/web/src/window-attention.ts); the window shows it where the user looks while working
// in another app: Windows flashes the taskbar button and puts a dot over its icon, macOS badges and bounces the Dock icon. Only the
// app's own page in the main window may ask. The pure parts (the count, the dot) are exported for tests.

export const attentionCount = value => Number.isInteger(value) && value > 0 ? Math.min(value, 99) : 0;

// A filled dot in the app's alert red, BGRA as nativeImage.createFromBitmap wants it, with a soft edge.
export function dotBitmap(size = 16, [r, g, b] = [0xe5, 0x48, 0x4d]) {
  const data = Buffer.alloc(size * size * 4), center = (size - 1) / 2, radius = size / 2 - .5;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const edge = Math.max(0, Math.min(1, radius - Math.hypot(x - center, y - center) + .5)), at = (y * size + x) * 4;
    data[at] = b; data[at + 1] = g; data[at + 2] = r; data[at + 3] = Math.round(edge * 255);
  }
  return data;
}

export function setupAttention({ ipcMain, app, nativeImage, getWindow, trusted, platform = process.platform }) {
  let overlay = null, shown = 0;
  const dot = () => overlay ??= nativeImage.createFromBitmap(dotBitmap(32), { width: 32, height: 32, scaleFactor: 2 });
  ipcMain.on('ade:attention', (event, value, flash) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || !trusted(event)) return;
    const count = attentionCount(value);
    if (count !== shown) {
      shown = count;
      if (platform === 'win32') window.setOverlayIcon(count ? dot() : null, count ? `확인 필요 ${count}개` : '');
      else app.setBadgeCount(count); // macOS Dock; Linux launchers that support it
    }
    if (!count) { window.flashFrame(false); return; }
    if (flash === true && !window.isFocused()) {
      window.flashFrame(true);
      if (platform === 'darwin') app.dock?.bounce('informational');
    }
  });
  // Windows keeps flashing until told otherwise; coming back to the window ends it.
  return { attach(window) { window.on('focus', () => window.flashFrame(false)); } };
}
