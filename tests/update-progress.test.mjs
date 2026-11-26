import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../apps/desktop/src/updater.js', import.meta.url), 'utf8');
const progressSource = source.slice(source.indexOf('function progressWindow('), source.indexOf('// One check or update at a time:'));
const launchSource = source.slice(source.indexOf('const RESTART_DELAY_MS'), source.indexOf('async function restartNow('));

test('update progress uses the main window on Windows and macOS, and clears it on close', () => {
  for (const platform of ['win32', 'darwin']) {
    const events = [], bars = [];
    let destroyed = false, now = 1000;
    const parent = { isDestroyed: () => destroyed, webContents: { send: (...args) => events.push(args) }, setProgressBar: (...args) => bars.push(args) };
    const progress = runInNewContext(`let status = null; ${progressSource}; progressWindow(parent)`, { parent, process: { platform }, Date: { now: () => now } });
    progress.set('준비 중…');
    assert.equal(events[0][0], 'ade:update-progress');
    assert.equal(events[0][1].kind, 'progress');
    assert.equal(events[0][1].fraction, null);
    assert.equal(bars[0][1].mode, 'indeterminate');
    now += 50;
    progress.set('다운로드 중…', .5, false);
    assert.equal(events.length, 1, 'download events are throttled');
    now += 100;
    progress.set('다운로드 중…', .5, false);
    assert.equal(events[1][1].fraction, .5);
    progress.close();
    assert.equal(events[2][1], null);
    assert.deepEqual(bars[2], [-1]);
    destroyed = true;
    progress.set('앱 종료 중…');
    progress.close();
    assert.equal(events.length, 3, 'destroyed windows are ignored');
  }
  const progress = runInNewContext(`let status = null; ${progressSource}; progressWindow(null)`, { Date });
  assert.doesNotThrow(() => { progress.set('준비 중…'); progress.close(); });
});

test('restart countdown uses the position saved when it starts', async () => {
  let position = 'middle-center';
  const events = [], waits = [];
  const current = { autoDownload: false, launch: async () => { position = 'bottom-right'; }, getCountdownPosition: () => position };
  const launchPrepared = runInNewContext(`${launchSource}; launchPrepared`, {
    Date: { now: () => 1000 },
    setTimeout: (done, delay) => { waits.push(delay); done(); },
    progressWindow: () => ({ set() {}, close: status => events.push(status) }),
  });
  await launchPrepared(current, { isDestroyed: () => false });
  assert.deepEqual({ ...events[0] }, { kind: 'countdown', restartAt: 11000, position: 'bottom-right' });
  assert.deepEqual(waits, [10000]);
});
