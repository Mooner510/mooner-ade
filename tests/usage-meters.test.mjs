import test from 'node:test';
import assert from 'node:assert/strict';
import { barWindows, defaultUsageMeters, usageMetersOf } from '../apps/web/src/usage-meters.ts';

test('status-bar meters keep only the windows the user left on', () => {
  const windows = [
    { key: 'session', percent: 1 }, { key: 'weekly', percent: 2 }, { key: 'fable', percent: 3 }, { key: 'weekly-opus', percent: 4 }
  ];
  assert.deepEqual(barWindows(windows, defaultUsageMeters.claude, true).map(item => item.key), ['session', 'weekly', 'fable']);
  assert.deepEqual(barWindows(windows, defaultUsageMeters.claude, false).map(item => item.key), ['weekly', 'fable']);
  assert.deepEqual(usageMetersOf('cursor', { cursor: ['total', 'nope', 'grok'] }), ['total', 'grok']);
  assert.deepEqual(barWindows(windows, [], true), []);
});
