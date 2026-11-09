import test from 'node:test';
import assert from 'node:assert/strict';
import { contextTip, tipDue } from '../apps/web/src/tips.ts';

test('context tip appears only from the threshold up and names /clear', () => {
  assert.equal(contextTip(undefined, 150), undefined);
  assert.equal(contextTip(149_999, 150), undefined);
  assert.match(contextTip(180_400, 150), /180k.*\/clear/);
});

test('a tip repeats only after its gap and never past max', () => {
  const now = 1_000_000, minute = 60_000;
  assert.equal(tipDue({}, 'a', now, minute), true);
  assert.equal(tipDue({ a: { n: 1, at: now - 30_000 } }, 'a', now, minute), false);
  assert.equal(tipDue({ a: { n: 1, at: now - 2 * minute } }, 'a', now, minute), true);
  assert.equal(tipDue({ a: { n: 2, at: now - 2 * minute } }, 'a', now, minute, 2), false);
});
