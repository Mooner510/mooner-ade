import test from 'node:test';
import assert from 'node:assert/strict';
import { addPair, contribution, learnedK, sameWindow } from '../apps/web/src/usage-share.ts';

const reset = 1_800_000_000_000, r = (util, at = reset) => ({ util, resetsAt: at });
const cal = { k: 8.88 }; // dollars per 1%p

test('usage share: a small turn is an estimate, not 0 or 1', () => {
  assert.equal(contribution({ before: r(91), after: r(91), costUsd: 0.9, cal }).label, '≈0.1%p');
  assert.equal(contribution({ before: r(91), after: r(91), costUsd: 0.2, cal }).label, '≈0.023%p');
  assert.equal(contribution({ before: r(91), after: r(91), costUsd: 0.005, cal }).quality, 'tiny', 'under 0.001%p nothing is shown');
});
test('usage share: the estimate stays when the readings allow it, is clamped when they contradict it', () => {
  assert.equal(contribution({ before: r(90), after: r(92), costUsd: 13.3, cal }).label, '≈1.5%p');
  const clamped = contribution({ before: r(91), after: r(91), costUsd: 13.3, cal });
  assert.equal(clamped.label, '≈1%p'); assert.equal(clamped.quality, 'clamped');
});
test('usage share: another window (reset time moved), first sample, no window, no calibration', () => {
  assert.equal(contribution({ before: r(99), after: r(2, reset + 7 * 86_400_000), costUsd: 4.4, cal }).label, '≈0.5%p');
  assert.equal(contribution({ before: null, after: r(40), costUsd: 1.8, cal }).label, '≈0.2%p');
  assert.equal(contribution({ before: r(91), after: null, costUsd: 5, cal }).label, '');
  assert.equal(contribution({ before: r(50), after: r(53), costUsd: 5, cal: null }).label, '+3%p');
  assert.equal(contribution({ before: null, after: r(53), costUsd: 5, cal: null }).label, '');
});
test('usage share: k is learned from whole turns and needs 10 points before it is trusted', () => {
  let sums;
  for (const [usd, d] of [[20, 2], [35, 4], [12, 1]]) sums = addPair(sums, usd, d);
  assert.equal(learnedK(sums), null, '7 points are not enough');
  sums = addPair(sums, 36, 4);
  const learned = learnedK(sums);
  assert.ok(Math.abs(learned.k - 103 / 11) < 1e-9); assert.ok(learned.relErr < 0.1);
  assert.equal(learnedK(undefined), null);
});
test('usage share: reset times jitter under a second but are the same window', () => {
  assert.equal(sameWindow(reset, reset + 700), true);
  assert.equal(sameWindow(reset, reset + 3_600_000), false);
  assert.equal(sameWindow(null, reset), false);
});
