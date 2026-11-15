import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NO_ATTACH_CONSOLE, onConsole, shouldLeaveConsole, startOffConsole } from '../apps/desktop/src/console-detach.js';

// Electron redirects stdout and stderr to the console it attaches to; stdin stays what it was.
const attached = fd => fd === 1 || fd === 2;
const base = { platform: 'win32', packaged: true, dev: false, env: {}, argv: ['C:\\ADE\\MoonerADE.exe'], isatty: attached };

test('a packaged Windows app on a console hands over to a copy that is not on one', () => {
  assert.equal(shouldLeaveConsole(base), true);
});

test('every other start stays as it is', () => {
  const stays = (name, change) => assert.equal(shouldLeaveConsole({ ...base, ...change }), false, name);
  stays('macOS', { platform: 'darwin' });
  stays('Linux', { platform: 'linux' });
  stays('a run from the source tree (pnpm start)', { packaged: false });
  stays('pnpm dev', { dev: true });
  stays('no console (Start menu, shortcut, Explorer)', { isatty: () => false });
  stays('the copy this module started', { env: { [NO_ATTACH_CONSOLE]: '1' } });
  stays('Chromium logging asked for through the environment', { env: { ELECTRON_ENABLE_LOGGING: '1' } });
  stays('Chromium logging asked for through a switch', { argv: [...base.argv, '--enable-logging=stderr'] });
});

test('only a real console handle counts, and a failing check is not one', () => {
  assert.equal(onConsole(fd => fd === 0), true);
  assert.equal(onConsole(() => false), false);
  assert.equal(onConsole(() => { throw new Error('bad fd'); }), false);
});

test('the copy gets the same arguments, the marker, and starts detached without hiding its window', () => {
  const calls = [];
  const env = { PATH: 'p', ADE_DATA_DIR: 'd' };
  const spawnProcess = (file, args, options) => { calls.push({ file, args, options }); return { pid: 321, once() {}, unref() { calls.push('unref'); } }; };
  assert.equal(startOffConsole({ execPath: 'C:\\ADE\\MoonerADE.exe', args: ['--flag'], env, spawnProcess }), true);
  assert.equal(calls[0].file, 'C:\\ADE\\MoonerADE.exe');
  assert.deepEqual(calls[0].args, ['--flag']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.windowsHide, undefined, 'windowsHide would hide the first window of a GUI program');
  assert.deepEqual(calls[0].options.env, { ...env, [NO_ATTACH_CONSOLE]: '1' });
  assert.deepEqual(env, { PATH: 'p', ADE_DATA_DIR: 'd' }, 'the caller\'s environment is left alone');
  assert.equal(calls[1], 'unref');
});

test('a copy that did not start leaves the app running', () => {
  assert.equal(startOffConsole({ spawnProcess: () => ({ pid: undefined, once() {}, unref() {} }) }), false);
  assert.equal(startOffConsole({ spawnProcess: () => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }); } }), false);
});

test('main.js leaves the console before it takes the single-instance lock, and drops the marker for its children', () => {
  const main = fs.readFileSync(new URL('../apps/desktop/src/main.js', import.meta.url), 'utf8');
  const leave = main.indexOf('shouldLeaveConsole({ packaged, dev })'), drop = main.indexOf('delete process.env[NO_ATTACH_CONSOLE]'), lock = main.indexOf('requestSingleInstanceLock()');
  assert.ok(leave > 0 && drop > leave && lock > drop, 'order: decide, drop the marker, then the lock');
  assert.match(main, /if \(leavingConsole\) app\.exit\(0\);/);
  assert.match(main, /if \(leavingConsole\) \{[^}]*\} else if \(!app\.requestSingleInstanceLock\(\)\)/);
});
