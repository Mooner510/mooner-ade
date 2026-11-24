import test from 'node:test';
import assert from 'node:assert/strict';
import { barWindows, defaultUsageMeters, missingMeters, usageMetersOf } from '../apps/web/src/usage-meters.ts';

test('status-bar meters keep only the windows the user left on', () => {
  const windows = [
    { key: 'session', percent: 1 }, { key: 'weekly', percent: 2 }, { key: 'fable', percent: 3 }, { key: 'weekly-opus', percent: 4 }
  ];
  assert.deepEqual(barWindows(windows, defaultUsageMeters.claude, true).map(item => item.key), ['session', 'weekly', 'fable']);
  assert.deepEqual(barWindows(windows, defaultUsageMeters.claude, false).map(item => item.key), ['weekly', 'fable']);
  assert.deepEqual(usageMetersOf('cursor', { cursor: ['total', 'nope', 'grok'] }), ['total', 'grok']);
  assert.deepEqual(usageMetersOf('claude', { claude: ['weekly', 'weekly-opus', 'weekly-sonnet', 'fable'] }), ['weekly', 'fable']);
  assert.deepEqual(barWindows(windows, [], true), []);
});

test('a meter left on but absent from the reading is named, so its missing chip is explained', () => {
  assert.deepEqual(missingMeters('claude', [{ key: 'session' }, { key: 'weekly' }], defaultUsageMeters.claude), ['Fable']);
  assert.deepEqual(missingMeters('claude', [{ key: 'weekly' }, { key: 'fable' }], ['weekly', 'fable', 'credit']), []);
  assert.deepEqual(missingMeters('claude', [{ key: 'weekly' }], ['weekly']), []);
});
