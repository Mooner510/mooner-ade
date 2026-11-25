import test from 'node:test';
import assert from 'node:assert/strict';
import { barWindows, defaultUsageMeters, headlinePercent, missingMeters, usageMetersOf } from '../apps/web/src/usage-meters.ts';

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

test('the headline number is the account-wide reading: a model-scoped Fable window never speaks for Claude', async () => {
  const { parseClaudeUsage } = await import('../apps/local-server/src/usage.js');
  const limit = (kind, model, percent) => ({ kind, percent, resets_at: '2026-11-30T00:00:00Z', scope: model ? { model: { id: null, display_name: model }, surface: null } : null });
  const windows = parseClaudeUsage({ five_hour: { utilization: 40, resets_at: '2026-11-26T09:00:00Z' }, seven_day: { utilization: 83, resets_at: '2026-11-30T00:00:00Z' },
    limits: [limit('session', null, 40), limit('weekly_all', null, 83), limit('weekly_scoped', 'Fable', 99)] });
  assert.deepEqual(windows.map(item => [item.key, item.percent]), [['session', 40], ['weekly', 83], ['fable', 99]]);
  assert.equal(headlinePercent(windows, true), 83);
  assert.equal(headlinePercent(windows, true, [null, undefined]), 83);
  // The 5-hour window still counts when it is the highest overall reading, and is skipped when the plan hides it.
  assert.equal(headlinePercent([{ key: 'session', percent: 90 }, { key: 'weekly', percent: 83 }, { key: 'fable', percent: 99 }], true), 90);
  assert.equal(headlinePercent([{ key: 'session', percent: 90 }, { key: 'weekly', percent: 83 }, { key: 'fable', percent: 99 }], false), 83);
  // Credit readings still count; a Fable-only account falls back to its Fable window; nothing at all stays empty.
  assert.equal(headlinePercent(windows, true, [95]), 95);
  assert.equal(headlinePercent([{ key: 'fable', percent: 99 }], true), 99);
  assert.equal(headlinePercent([], true, [null]), null);
  // Codex and Cursor go through the same helper and keep their highest window.
  assert.equal(headlinePercent([{ key: 'session', percent: 12 }, { key: 'weekly', percent: 34 }], true, [20]), 34);
  assert.equal(headlinePercent([{ key: 'auto', percent: 10 }, { key: 'api', percent: 5 }, { key: 'total', percent: 61 }], true), 61);
});
