import test from 'node:test';
import assert from 'node:assert/strict';
import { fromReplay, limitChip, reduce } from '../apps/web/src/chat-model.ts';

test('the stop line is a thread note naming the rule, in a replay and live', () => {
  const replayed = fromReplay({ events: [{ kind: 'user', text: '시작', seq: 1 }, { kind: 'limit_stop', rule: '5시간 사용량 80%', seq: 2 }], seq: 2 });
  const note = replayed.items.at(-1);
  assert.equal(note.kind, 'note');
  assert.equal(note.text, '제한 규칙(5시간 사용량 80%)에 따라 중지되었습니다');
  assert.deepEqual(note.tones.map(tone => tone.value), ['5시간 사용량 80%']);
  assert.equal(note.fresh, false, 'a replayed line does not play its entrance');
  assert.equal(reduce({ ...replayed, ready: true }, { kind: 'limit_stop', rule: '비용 $1.00', seq: 3 }).items.at(-1).text, '제한 규칙(비용 $1.00)에 따라 중지되었습니다');
});

test('the status chip: every rule as now/max while running, "제한 도달" with the rule once stopped, nothing without a limit', () => {
  assert.equal(limitChip(null), null);
  const limit = { cost: 1, usage: { window: 'session', percent: 80 }, share: { window: 'weekly', percent: 5 }, compact: true, stop: null, now: { cost: 0.5, usage: 61, share: 2 } };
  const running = limitChip(limit);
  assert.equal(running.text, '제한 $0.50/$1.00, 5시간 61/80%, 주간 할당 2/5%');
  assert.equal(limitChip(limit, true).text, '제한 $1.00, 5시간 61/80%, 주간 할당 2/5%', 'the amount already shown beside the chip is not repeated');
  assert.equal(running.stopped, false);
  assert.equal(running.ratio, 0.5 / 1 > 61 / 80 ? 0.5 : 61 / 80, 'the closest rule drives the bar');
  assert.deepEqual(running.rules.map(rule => [rule.name, rule.now, rule.max]), [['비용', '$0.50', '$1.00'], ['5시간 사용량', '61', '80%'], ['주간 할당(추정)', '2', '5%']]);
  const stopped = limitChip({ ...limit, stop: '비용 $1.00', now: {} });
  assert.deepEqual([stopped.text, stopped.stopped, stopped.stop, stopped.ratio], ['제한 도달', true, '비용 $1.00', 1]);
  assert.deepEqual(stopped.rules.map(rule => rule.now), [null, null, null], 'a rule without a reading shows only its max');
  assert.equal(limitChip({ cost: 2, compact: false, stop: null, now: {} }).text, '제한 $2.00');
});
