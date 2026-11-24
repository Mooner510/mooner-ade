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

test('the status chip: the rules while running, "제한 도달" with the rule once stopped, nothing without a limit', () => {
  assert.equal(limitChip(null), null);
  const limit = { cost: 1, usage: { window: 'session', percent: 80 }, share: { window: 'weekly', percent: 5 }, compact: true, stop: null, now: { cost: 0.5, usage: 61, share: 2 } };
  const running = limitChip(limit);
  assert.equal(running.text, '$1.00 · 5시간 80% · 주간 할당 5%');
  assert.equal(running.stopped, false);
  assert.equal(running.tip, ['제한', '비용 $0.5000 / $1.00', '5시간 사용량 61% / 80%', '주간 할당(추정) 2% / 5%', '중지되면 자동 압축'].join('\n'));
  const stopped = limitChip({ ...limit, stop: '비용 $1.00', now: {} });
  assert.deepEqual([stopped.text, stopped.stopped], ['제한 도달', true]);
  assert.match(stopped.tip, /비용 \$1\.00에 따라 중지됨/);
  assert.match(stopped.tip, /비용 — \/ \$1\.00/);
});
