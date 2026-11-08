import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrefixGuide, guideActive, guideGroups, isModifierOnly, isPrefixKey, isTmuxStatusRow, looksLikeTmux, normalizePrefix } from '../apps/web/src/tmux-guide.ts';

const row = (text, filled = false) => ({ text, filled });

test('the default tmux status line is recognised, on the bottom or the top row', () => {
  assert.ok(isTmuxStatusRow(row('[0] 0:bash*                         "devbox" 14:02 07-Nov-26', true)));
  assert.ok(isTmuxStatusRow(row('[work] 0:vim- 1:zsh* 2:node#')), 'text alone is enough when the session name leads');
  assert.ok(looksLikeTmux([row('$ ls'), row('[0] 0:bash*')]));
  assert.ok(looksLikeTmux([row('[0] 0:bash*'), row('$ ls')]), 'status-position top');
});

test('a customised bar still counts when it is one filled row holding a window list', () => {
  assert.ok(isTmuxStatusRow(row(' 0:bash*  1:vim-   main  14:02', true)));
  assert.ok(!isTmuxStatusRow(row(' 0:bash*  1:vim-   main  14:02', false)), 'without the filled background it could be anything');
});

test('a session name cut to 10 characters, as tmux does by default, is still recognised on a filled bar', () => {
  assert.ok(isTmuxStatusRow(row('[guide-tes0:zsh*                  "DESKTOP-ABC" 15:44 07-Nov-26', true)));
  assert.ok(isTmuxStatusRow(row('[guide-tes0:zsh* 1:vim-', true)));
  assert.ok(!isTmuxStatusRow(row('[guide-tes0:zsh*', false)), 'no closing bracket and no filled bar: not enough');
});

test('a clock on a coloured bar is not a window, so only real window lists qualify', () => {
  assert.ok(!isTmuxStatusRow(row(' main  15:44  07-Nov-26', true)));
  assert.ok(!isTmuxStatusRow(row('  12:30:45  cpu 36%', true)));
  assert.ok(isTmuxStatusRow(row(' 0:2048*  main', true)), 'tmux flags (*, -, #) mark a window even when its name is all digits');
  assert.ok(!isTmuxStatusRow(row(' 0:2048  main', true)), 'an unflagged all-digit name looks like a clock: the accepted miss');
});

test('ordinary screen rows are not mistaken for tmux', () => {
  for (const text of ['$ ls -la', '[INFO] 12:30:45 server started', '[user@host dir]$ ', 'user@host:~$ 10:20', 'npm run build', '', '12:30:45 error in module', 'ratio 3:4 chosen']) {
    assert.ok(!isTmuxStatusRow(row(text)), text);
  }
  assert.ok(!isTmuxStatusRow(row('[INFO] 12:30:45 started', true)), 'timestamps are not windows');
  assert.ok(!isTmuxStatusRow(undefined));
  assert.ok(!looksLikeTmux([]));
});

test('"auto" needs tmux on screen, "always" does not look, "off" never shows', () => {
  let looked = 0;
  const probe = result => () => { looked++; return result; };
  assert.equal(guideActive('auto', probe(true)), true);
  assert.equal(guideActive('auto', probe(false)), false);
  looked = 0;
  assert.equal(guideActive('always', probe(false)), true);
  assert.equal(guideActive('off', probe(true)), false);
  assert.equal(looked, 0, 'only "auto" reads the screen');
});

test('the prefix is Ctrl+letter by physical key, so a Korean IME still triggers it', () => {
  const event = extra => ({ type: 'keydown', key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, repeat: false, ...extra });
  assert.ok(isPrefixKey(event(), 'b'));
  assert.ok(isPrefixKey(event({ key: 'ㅠ' }), 'b'));
  assert.ok(!isPrefixKey(event({ ctrlKey: false }), 'b'));
  assert.ok(!isPrefixKey(event({ shiftKey: true }), 'b'));
  assert.ok(!isPrefixKey(event({ altKey: true }), 'b'));
  assert.ok(!isPrefixKey(event({ metaKey: true }), 'b'));
  assert.ok(!isPrefixKey(event({ type: 'keyup' }), 'b'));
  assert.ok(!isPrefixKey(event({ code: 'KeyA' }), 'b'));
  assert.ok(isPrefixKey(event({ code: 'KeyA', key: 'a' }), 'a'), 'a remapped prefix');
  assert.ok(isPrefixKey(event(), ''), 'an empty setting falls back to b');
  assert.equal(normalizePrefix('Q'), 'q');
  assert.equal(normalizePrefix('ab'), 'b');
  assert.equal(normalizePrefix('1'), 'b');
});

test('modifier keys alone do not answer the prefix, IME-processed keys do', () => {
  for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) assert.ok(isModifierOnly(key), key);
  for (const key of ['c', 'Escape', 'ArrowLeft', 'Process', 'Dead', '%']) assert.ok(!isModifierOnly(key), key);
});

function fakeTimers() {
  let now = 0, next = 1; const pending = new Map();
  return {
    set: (fn, ms) => { const id = next++; pending.set(id, { fn, at: now + ms }); return id; },
    clear: id => { pending.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...pending].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]); now = due[1].at; due[1].fn();
      }
      now = end;
    },
    get count() { return pending.size; }
  };
}
function machine(timeout = 10_000) {
  const timers = fakeTimers(), log = [];
  const guide = createPrefixGuide({ timeout, timers, show: () => log.push('show'), hide: () => log.push('hide') });
  return { guide, timers, log };
}

test('the guide shows the moment the prefix is pressed and the next key hides it', () => {
  const { guide, timers, log } = machine();
  guide.prefix(); assert.deepEqual(log, ['show']); assert.equal(guide.state, 'shown');
  guide.key(); assert.deepEqual(log, ['show', 'hide']); assert.equal(guide.state, 'idle');
  assert.equal(timers.count, 0, 'no timer is left behind');
});

test('the guide closes by itself after the timeout, so it cannot cover the screen indefinitely', () => {
  const { guide, timers, log } = machine(10_000);
  guide.prefix(); assert.deepEqual(log, ['show']);
  timers.advance(9_999); assert.deepEqual(log, ['show']);
  timers.advance(1); assert.deepEqual(log, ['show', 'hide']);
  assert.equal(guide.state, 'idle');
});

test('a second prefix (tmux send-prefix) and a blur both close it', () => {
  let { guide, timers, log } = machine();
  guide.prefix(); guide.prefix();
  assert.deepEqual(log, ['show', 'hide']); assert.equal(guide.state, 'idle');
  ({ guide, timers, log } = machine());
  guide.prefix(); guide.cancel(); timers.advance(60_000);
  assert.deepEqual(log, ['show', 'hide'], 'closing twice must not hide twice');
  assert.equal(timers.count, 0);
});

test('keys with nothing shown do nothing, and the guide can be reopened', () => {
  const { guide, log } = machine(1000);
  guide.key(); guide.cancel(); assert.deepEqual(log, []);
  guide.prefix(); guide.key(); guide.prefix();
  assert.deepEqual(log, ['show', 'hide', 'show']);
});

test('the guide lists the everyday tmux keys', () => {
  const keys = guideGroups.flatMap(group => group.items.map(item => item.keys)).join(' ');
  for (const key of ['c', 'n / p', '%', '"', 'z', 'd', '[']) assert.ok(keys.includes(key), key);
  for (const group of guideGroups) for (const item of group.items) assert.ok(item.keys && item.label, 'every entry has a key and a description');
});
