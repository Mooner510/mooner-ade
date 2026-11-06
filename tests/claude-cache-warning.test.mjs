import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheSendWarning, cacheSendWarningText, isClaudeMessageText } from '../apps/web/src/claude-cache-warning.ts';

const MINUTE = 60_000, now = 1_000_000_000_000;
const options = { enabled: true, minutes: 10, working: false };
// A 1-hour cache that was last written `age` ms ago.
const hour = age => ({ at: now - age, ttl: 3600, tokens: 120_000 });
const five = age => ({ at: now - age, ttl: 300, tokens: 50_000 });

test('a cold cache always warns', () => {
  assert.deepEqual(cacheSendWarning(hour(61 * MINUTE), now, options), { state: 'cold', left: 0, tokens: 120_000 });
  assert.equal(cacheSendWarning(five(6 * MINUTE), now, options)?.state, 'cold');
  assert.equal(cacheSendWarning(hour(60 * MINUTE), now, options)?.state, 'cold', 'expiring exactly now counts as cold');
});

test('a 1-hour cache warns once the time left is at or under the threshold', () => {
  assert.equal(cacheSendWarning(hour(49 * MINUTE), now, options), undefined, '11 minutes left');
  assert.deepEqual(cacheSendWarning(hour(50 * MINUTE), now, options), { state: 'low', left: 10 * MINUTE, tokens: 120_000 });
  assert.equal(cacheSendWarning(hour(55 * MINUTE), now, options)?.left, 5 * MINUTE);
  assert.equal(cacheSendWarning(hour(40 * MINUTE), now, { ...options, minutes: 30 })?.state, 'low');
  assert.equal(cacheSendWarning(hour(29 * MINUTE), now, { ...options, minutes: 30 }), undefined);
});

test('a 5-minute cache only warns once it is cold, since it is always close to expiring', () => {
  assert.equal(cacheSendWarning(five(0), now, options), undefined);
  assert.equal(cacheSendWarning(five(4 * MINUTE), now, options), undefined);
  assert.equal(cacheSendWarning(five(4.9 * MINUTE), now, { ...options, minutes: 60 }), undefined);
});

test('idle compaction moves the moment the warning counts towards', () => {
  // The cache itself lasts an hour, but idle compaction (what the cache timer counts down to) is only 4 minutes away.
  const compacting = { ...hour(0), compactAt: now + 4 * MINUTE };
  assert.equal(cacheSendWarning(compacting, now, options)?.state, 'low');
  assert.equal(cacheSendWarning({ ...hour(0), compactAt: now - 1 }, now, options)?.state, 'cold');
});

test('nothing warns when disabled, mid-turn, after compaction or without a cache', () => {
  const cold = hour(2 * 60 * MINUTE);
  assert.equal(cacheSendWarning(cold, now, { ...options, enabled: false }), undefined);
  assert.equal(cacheSendWarning(cold, now, { ...options, working: true }), undefined);
  assert.equal(cacheSendWarning({ ...cold, compacted: { at: now, trigger: 'auto' } }, now, options), undefined);
  assert.equal(cacheSendWarning(undefined, now, options), undefined);
});

test('only real messages count as a send', () => {
  assert.equal(isClaudeMessageText('fix the failing test'), true);
  assert.equal(isClaudeMessageText('/usr/bin/env explain this path'), true, 'a path is not a slash command');
  assert.equal(isClaudeMessageText('한글 메시지도 보냅니다'), true);
  for (const nothing of [undefined, '', 'Try "fix lint errors"', '/clear', '/compact keep the plan', '/model', 'look at @src/ind', 'open /usr/b', '/']) assert.equal(isClaudeMessageText(nothing), false, String(nothing));
});

test('the warning text says whether the cache is cold or how long is left', () => {
  assert.match(cacheSendWarningText({ state: 'cold', left: 0, tokens: 120_000 }), /^프롬프트 캐시가 식었습니다\. 컨텍스트 약 120k 토큰이/);
  assert.match(cacheSendWarningText({ state: 'low', left: 5 * MINUTE + 30_000, tokens: 800 }), /^프롬프트 캐시가 5분 30초 뒤 만료됩니다\.\n/);
  assert.doesNotMatch(cacheSendWarningText({ state: 'low', left: 20_000, tokens: 800 }), /토큰/);
  assert.match(cacheSendWarningText({ state: 'low', left: 20_000, tokens: 0 }), /20초 뒤/);
});
