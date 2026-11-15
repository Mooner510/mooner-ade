// Windows: keeps the packaged app from living and dying with a console window it did not ask for.
//
// Electron is a GUI program, yet at startup it attaches itself to the console of the process that started it (unless
// ELECTRON_NO_ATTACH_CONSOLE is set), and the console window stays open while any attached process lives. An app started from a PowerShell or
// cmd window therefore shares that console: closing the window ends the app, and a window nobody wanted (the old update helper's) stays on screen.
// The updater now starts the new version off the console (update-windows.js), but a version that is being updated *to* is started by the helper
// of the version it replaces. So an app that finds itself on a console hands over to a copy of itself that is not on one, and exits.
// No Electron import: main.js passes what it knows in, so tests drive this with fakes.
import { spawn } from 'node:child_process';
import tty from 'node:tty';

export const NO_ATTACH_CONSOLE = 'ELECTRON_NO_ATTACH_CONSOLE';

// What Electron redirects to the console it attaches to are stdout and stderr, so a real console handle there means "attached".
export const onConsole = (isatty = tty.isatty) => [0, 1, 2].some(fd => { try { return isatty(fd); } catch { return false; } });

// Only a packaged Windows app: a development run (`pnpm dev`, `pnpm start`) wants its terminal. Whoever asks for Chromium's own log
// (ELECTRON_ENABLE_LOGGING, --enable-logging) is reading the console, so those starts stay on it. A start that already carries the
// marker is the copy this module made, and is never handed over again.
export function shouldLeaveConsole({ platform = process.platform, packaged, dev, env = process.env, argv = process.argv, isatty } = {}) {
  if (platform !== 'win32' || !packaged || dev) return false;
  if (env[NO_ATTACH_CONSOLE] || env.ELECTRON_ENABLE_LOGGING || argv.some(arg => arg.startsWith('--enable-logging'))) return false;
  return onConsole(isatty);
}

// Starts the copy (same arguments, the marker in its environment) and says whether it is running, so the caller may exit.
// It is detached with no stdio and without windowsHide: that would hide the new copy's first window, and this is a GUI program.
export function startOffConsole({ execPath = process.execPath, args = process.argv.slice(1), env = process.env, spawnProcess = spawn } = {}) {
  try {
    const child = spawnProcess(execPath, args, { detached: true, stdio: 'ignore', env: { ...env, [NO_ATTACH_CONSOLE]: '1' } });
    child.once?.('error', () => {});
    child.unref?.();
    return Number.isInteger(child.pid);
  } catch { return false; }
}
