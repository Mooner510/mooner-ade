import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLimit, limitOptions, limitView, normalizeLimit, POLL_MS, ruleLabel } from '../apps/local-server/src/chat-limit.js';
import { FORCE_GAP } from '../apps/local-server/src/usage.js';

const both = { cost: true, windows: ['session', 'weekly'] };
const win = (key, percent, resetsAt = 1_000_000_000_000) => ({ key, percent, resetsAt });

test('the poll pace is the fastest forced read usage.js allows', () => assert.equal(POLL_MS, FORCE_GAP));

test('what a chat can be limited by: cost where dollars are reported, windows for a plan login of Claude and Codex', () => {
  assert.deepEqual(limitOptions({ agent: 'claude', cost: true, apiKey: false }), both);
  assert.deepEqual(limitOptions({ agent: 'claude', cost: true, apiKey: true }), { cost: true, windows: [] });
  assert.deepEqual(limitOptions({ agent: 'codex', cost: false, apiKey: false }), { cost: false, windows: ['session', 'weekly'] });
  assert.deepEqual(limitOptions({ agent: 'cursor', cost: false, apiKey: false }), { cost: false, windows: [] });
});

test('normalize: keeps what is valid, drops an empty limit, refuses what the chat cannot measure', () => {
  assert.deepEqual(normalizeLimit({ cost: '1.256', usage: { window: 'weekly', percent: 80 }, compact: true }, both), { compact: true, cost: 1.26, usage: { window: 'weekly', percent: 80 } });
  assert.equal(normalizeLimit(null, both), null);
  assert.equal(normalizeLimit({ compact: true }, both), null);
  assert.throws(() => normalizeLimit({ cost: 0 }, both), /비용/);
  assert.throws(() => normalizeLimit({ cost: 1 }, { cost: false, windows: [] }), /비용을 보고하지 않아/);
  assert.throws(() => normalizeLimit({ share: { window: 'session', percent: 5 } }, { cost: true, windows: [] }), /사용량 할당/);
  assert.throws(() => normalizeLimit({ usage: { window: 'daily', percent: 5 } }, both), /사용량 한도/);
  for (const percent of [0, 101, 2.5, 'x']) assert.throws(() => normalizeLimit({ usage: { window: 'session', percent } }, both), /퍼센트/);
});

test('normalize: the share baseline survives an edit of the same window, and starts over for another one', () => {
  const base = { window: 'session', percent: 30, resetsAt: 1 };
  const previous = { share: { window: 'session', percent: 5 }, base };
  assert.deepEqual(normalizeLimit({ share: { window: 'session', percent: 10 } }, both, previous).base, base);
  assert.equal(normalizeLimit({ share: { window: 'weekly', percent: 10 } }, both, previous).base, undefined);
  assert.equal(normalizeLimit({ usage: { window: 'session', percent: 10 } }, both, previous).base, undefined);
});

test('rules read as in the thread line', () => {
  assert.equal(ruleLabel('cost', 1), '비용 $1.00');
  assert.equal(ruleLabel('usage', { window: 'session', percent: 80 }), '5시간 사용량 80%');
  assert.equal(ruleLabel('share', { window: 'weekly', percent: 5 }), '주간 할당 5%');
});

test('cost: reached at the limit, never without a figure', () => {
  const limit = { cost: 1 };
  assert.equal(evaluateLimit(limit, { cost: 0.99, windows: null }).hit, null);
  assert.deepEqual(evaluateLimit(limit, { cost: 1, windows: null }).hit, { kind: 'cost', label: '비용 $1.00' });
  assert.equal(evaluateLimit(limit, { cost: null, windows: null }).hit, null);
});

test('usage limit: the window percent itself; a window that was not read is not a hit', () => {
  const limit = { usage: { window: 'session', percent: 80 } };
  assert.equal(evaluateLimit(limit, { cost: 0, windows: [win('session', 79)] }).hit, null);
  const hit = evaluateLimit(limit, { cost: 0, windows: [win('weekly', 99), win('session', 80, 5)] }).hit;
  assert.deepEqual([hit.kind, hit.label, hit.resetsAt], ['usage', '5시간 사용량 80%', 5]);
  assert.equal(evaluateLimit(limit, { cost: 0, windows: [win('weekly', 99)] }).hit, null);
  assert.equal(evaluateLimit(limit, { cost: 0, windows: null }).hit, null);
});

test('share: the increase since the first reading, measured again after the window resets', () => {
  const limit = { share: { window: 'session', percent: 5 } };
  let step = evaluateLimit(limit, { cost: 0, windows: [win('session', 40)] });
  assert.equal(step.hit, null);
  assert.deepEqual(step.base, { window: 'session', percent: 40, resetsAt: 1_000_000_000_000 });
  assert.equal(step.now.share, 0);
  limit.base = step.base;
  step = evaluateLimit(limit, { cost: 0, windows: [win('session', 44)] });
  assert.equal(step.hit, null); assert.equal(step.now.share, 4);
  assert.equal(evaluateLimit(limit, { cost: 0, windows: [win('session', 45)] }).hit.label, '5시간 할당 5%');
  // The window reset (its reset time moved on): usage restarts at 12%, so the baseline is that reading, not the old one.
  const later = 1_000_000_000_000 + 5 * 3_600_000;
  step = evaluateLimit(limit, { cost: 0, windows: [win('session', 12, later)] });
  assert.equal(step.hit, null); assert.equal(step.now.share, 0); assert.equal(step.base.percent, 12);
  // A drop without a new reset time is a reset too; a jitter of the reset time is not.
  limit.base = { window: 'session', percent: 40, resetsAt: 1_000_000_000_000 };
  assert.equal(evaluateLimit(limit, { cost: 0, windows: [win('session', 3)] }).base.percent, 3);
  assert.equal(evaluateLimit(limit, { cost: 0, windows: [win('session', 41, 1_000_000_005_000)] }).base.percent, 40);
});

test('the first rule reached is the one named; the view carries the rules, the stop and the numbers', () => {
  const limit = { cost: 1, usage: { window: 'weekly', percent: 50 }, compact: true, stop: { rule: '비용 $1.00', live: true } };
  assert.equal(evaluateLimit(limit, { cost: 2, windows: [win('weekly', 90)] }).hit.kind, 'cost');
  assert.deepEqual(limitView(limit, { cost: 2 }), { cost: 1, usage: { window: 'weekly', percent: 50 }, compact: true, stop: '비용 $1.00', now: { cost: 2 } });
});
