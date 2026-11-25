import test from 'node:test';
import assert from 'node:assert/strict';
import { activityBuckets, dayStamp, reviewRange } from '../apps/web/src/usage-review-model.ts';

test('review periods use local weeks starting Monday', () => {
  const now = new Date(2026, 10, 25, 15, 0, 0).getTime();
  const week = reviewRange('this', now);
  assert.equal(new Date(week.from).getDay(), 1);
  assert.equal(week.to, now);
  const last = reviewRange('last', now);
  assert.equal(last.to, week.from - 1);
  assert.equal(last.from, week.from - 7 * 86_400_000);
  assert.equal(reviewRange('7', now).from, now - 7 * 86_400_000);
  assert.deepEqual(reviewRange('all', now), { from: 0, to: now });
  const custom = reviewRange('custom', now, { from: 20, to: 10 });
  assert.equal(custom.to, 20);
  assert.equal(dayStamp('2026-11-25'), new Date(2026, 10, 25).getTime());
  assert.equal(dayStamp('2026-02-31'), null);
});

test('activity buckets keep days with zero use and align weeks to the ledger time zone', () => {
  const from = Date.parse('2026-11-22T16:00:00Z'), to = Date.parse('2026-11-24T15:30:00Z');
  assert.deepEqual(activityBuckets([{ date: '2026-11-24', value: 4 }], from, to, 'Asia/Seoul', false), [
    { date: '2026-11-23', value: 0 }, { date: '2026-11-24', value: 4 }, { date: '2026-11-25', value: 0 }
  ]);
  assert.deepEqual(activityBuckets([{ date: '2026-11-23', value: 12 }], from, to, 'Asia/Seoul', true), [
    { date: '2026-11-23', value: 12 }
  ]);
});
