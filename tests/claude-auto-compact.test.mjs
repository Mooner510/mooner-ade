import test from 'node:test';
import assert from 'node:assert/strict';
import { modelSettingsFor, parseTokenAmount, resolveAutoCompact } from '../apps/local-server/src/claude-auto-compact.js';

test('parseTokenAmount accepts numbers and k/M suffixes', () => {
  assert.equal(parseTokenAmount(350000), 350000);
  assert.equal(parseTokenAmount('350k'), 350000);
  assert.equal(parseTokenAmount('1M'), 1_000_000);
  assert.equal(parseTokenAmount('auto'), 'auto');
  assert.equal(parseTokenAmount('off'), null);
});

test('resolveAutoCompact uses modelSettings and caps at max window', () => {
  const settings = { modelSettings: { 'claude-sonnet-5-5': { autoCompactWindow: 350000 } } };
  assert.deepEqual(resolveAutoCompact({ settings, model: 'claude-sonnet-5-5', maxWindow: 1_000_000 }), { window: 350000, maxWindow: 1_000_000, auto: false, source: 'modelSettings' });
  assert.equal(resolveAutoCompact({ settings, model: 'claude-sonnet-5-5', maxWindow: 200_000 }), null);
  assert.equal(resolveAutoCompact({ settings: { ...settings, autoCompactEnabled: false }, model: 'claude-sonnet-5-5', maxWindow: 1_000_000 }), null);
});

test('auto mode estimates a smaller window than 1M max', () => {
  const resolved = resolveAutoCompact({ settings: {}, env: {}, model: 'claude-sonnet-5-5', maxWindow: 1_000_000 });
  assert.equal(resolved?.window, 350000);
  assert.equal(resolved?.auto, true);
});
