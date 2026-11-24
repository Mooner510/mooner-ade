import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheTimerState } from '../apps/web/src/cache-timer-state.ts';

const MINUTE = 60_000, now = 1_000_000_000_000;
// A 1-hour cache whose request started `age` ms ago.
const hour = (age, extra = {}) => ({ at: now - age, ttl: 3600, ...extra });
const done = { at: now - MINUTE, trigger: 'manual' };

test('without a compaction the chip counts down hot, warm, cold', () => {
  assert.deepEqual(cacheTimerState(hour(10 * MINUTE), now, 20), { state: 'hot', left: 50 * MINUTE, total: 60 * MINUTE });
  assert.equal(cacheTimerState(hour(50 * MINUTE), now, 20).state, 'warm', '10 of 60 minutes left is under 20%');
  assert.equal(cacheTimerState(hour(60 * MINUTE), now, 20).state, 'cold');
  assert.equal(cacheTimerState(hour(90 * MINUTE), now, 20).left, 0);
  assert.equal(cacheTimerState(hour(0, { compactAt: now + 54 * MINUTE }), now, 20).total, 54 * MINUTE, 'idle compaction is the end of the countdown');
});

test('a compaction with cache time left shows 보관 with no countdown', () => {
  assert.deepEqual(cacheTimerState(hour(10 * MINUTE, { compacted: done }), now, 20), { state: 'compacted', left: 0, total: 60 * MINUTE });
  assert.equal(cacheTimerState(hour(55 * MINUTE, { compacted: done }), now, 20).state, 'compacted', 'also in the warm phase');
  assert.equal(cacheTimerState(hour(0, { compactAt: now + 54 * MINUTE, compacted: done }), now, 20).left, 0, 'an idle-compaction estimate does not keep a countdown');
});

test('a compaction after the cache expired is still 보관, not cold', () => {
  assert.equal(cacheTimerState(hour(70 * MINUTE, { compacted: done }), now, 20).state, 'compacted');
});

test('the next request arrives without `compacted` and the chip is a timer again', () => {
  assert.equal(cacheTimerState({ at: now, ttl: 3600 }, now, 20).state, 'hot');
});
