import test from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_POLLS, UPDATE_CHECK_INTERVAL_MS, createDeclined, describeReasons, normalizeReport, staleUpdateDirs, unknownReport, waitUntilIdle } from '../apps/desktop/src/update-policy.js';

test('background checks run every 30 minutes', () => {
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 30 * 60 * 1000);
});

test('a version the user turned down is remembered until the app restarts', () => {
  const declined = createDeclined();
  assert.equal(declined.has('0.2.9'), false);
  declined.add('0.2.9');
  assert.equal(declined.has('0.2.9'), true);
  assert.equal(declined.has('0.3.0'), false, 'a newer release is asked about again');
});

// Answers are consumed in order; the sleep resolves at once so no real time passes.
const run = async (answers, options = {}) => {
  const asked = [], controller = options.controller ?? new AbortController();
  const result = await waitUntilIdle({
    signal: controller.signal, sleep: async () => {}, ...options,
    poll: async () => { asked.push(1); const next = answers.shift(); if (options.onPoll) options.onPoll(asked.length, controller); return { busy: next ?? false, reasons: [] }; }
  });
  return { result, polls: asked.length };
};

test('waiting ends only after several idle answers in a row', async () => {
  assert.deepEqual(await run([false, false, false, false]), { result: 'idle', polls: IDLE_POLLS });
  // A busy answer in between starts the count over: the work resumed (or never really stopped).
  assert.deepEqual(await run([false, false, true, false, false, false, false]), { result: 'idle', polls: 7 });
  assert.deepEqual(await run([true, true, true, false, false, false, false]), { result: 'idle', polls: 7 });
});

test('waiting can be cancelled or forced from outside, and never ends on its own while busy', async () => {
  const cancelled = new AbortController(), forced = new AbortController();
  assert.deepEqual(await run(Array(1000).fill(true), { controller: cancelled, onPoll: (count, controller) => { if (count === 5) controller.abort('cancelled'); } }), { result: 'cancelled', polls: 5 });
  assert.deepEqual(await run(Array(1000).fill(true), { controller: forced, onPoll: (count, controller) => { if (count === 3) controller.abort('force'); } }), { result: 'force', polls: 3 });
  const early = new AbortController(); early.abort('cancelled');
  assert.deepEqual(await run([], { controller: early }), { result: 'cancelled', polls: 0 });
  // Hundreds of busy answers (hours at 15 s) still do not end the wait. The sleep yields to the event loop, as a real timer does.
  let finished = false, polls = 0;
  const never = new AbortController();
  const waiting = waitUntilIdle({ poll: async () => ({ busy: ++polls > 0, reasons: [] }), signal: never.signal, sleep: () => new Promise(resolve => setImmediate(resolve)) }).then(result => { finished = true; return result; });
  while (polls < 300) await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  never.abort('cancelled');
  assert.equal(await waiting, 'cancelled');
});

test('a report that cannot be understood counts as busy', () => {
  for (const bad of [null, undefined, 'idle', {}, { busy: 'no' }, { reasons: [] }]) {
    const report = normalizeReport(bad);
    assert.equal(report.busy, true, JSON.stringify(bad));
    assert.equal(report.reasons[0].kind, 'unknown');
  }
  assert.deepEqual(normalizeReport({ busy: false, reasons: [] }), { busy: false, reasons: [], kept: [], keepsTerminals: false });
  assert.deepEqual(normalizeReport({ busy: true, reasons: [null, 'x', { kind: 'turn' }] }), { busy: true, reasons: [{ kind: 'turn' }], kept: [], keepsTerminals: false });
  assert.equal(unknownReport('boom').reasons[0].detail, 'boom');
});

test('reasons are worded per kind and cut off after a few', () => {
  const text = describeReasons([
    { project: 'mooner-ade', terminal: 'web', agent: 'claude', kind: 'turn' },
    { project: 'mooner-ade', terminal: 'api', agent: 'claude', kind: 'background' },
    { project: 'tts', terminal: 'train', kind: 'command', detail: 'python' },
    { project: 'x', terminal: 'y', agent: 'claude', kind: 'scheduled', detail: '오후 3:20:00에 실행될 예정입니다' },
    { project: '', terminal: '', kind: 'unknown', detail: '서버가 응답하지 않습니다' },
  ]);
  assert.match(text, /^• mooner-ade · web: Claude가 작업 중$/m);
  assert.match(text, /^• mooner-ade · api: 백그라운드 작업\(shell·monitor\)이 실행 중/m);
  assert.match(text, /^• tts · train: 명령 실행 중 \(python\)$/m);
  assert.match(text, /^• 상태를 확인할 수 없음 \(서버가 응답하지 않습니다\)$/m);
  const many = describeReasons(Array.from({ length: 9 }, (_, index) => ({ project: 'p', terminal: String(index), kind: 'command' })), 6);
  assert.equal(many.split('\n').length, 7);
  assert.match(many, /그 밖에 3개$/);
});

test('only old update scratch folders are swept', () => {
  const now = Date.UTC(2026, 10, 7), day = 24 * 60 * 60 * 1000;
  const entries = [
    { name: 'mooner-update-abc', mtimeMs: now - 2 * day },
    { name: 'mooner-update-fresh', mtimeMs: now - 3600_000 },
    { name: '.MoonerADE-update-xyz', mtimeMs: now - 3 * day },
    { name: 'something-else', mtimeMs: now - 30 * day },
    { name: 'mooner-updater-notes', mtimeMs: now - 30 * day },
  ];
  assert.deepEqual(staleUpdateDirs(entries, now), ['mooner-update-abc', '.MoonerADE-update-xyz']);
});

test('with terminals kept through the restart, only what does not survive holds the update back', () => {
  const turn = { project: 'a', terminal: 'b', kind: 'turn', agent: 'claude', keeps: true }, plugin = { project: '', terminal: 'p', kind: 'plugin' };
  assert.deepEqual(normalizeReport({ busy: true, keepsTerminals: true, reasons: [turn] }), { busy: false, reasons: [], kept: [turn], keepsTerminals: true });
  assert.deepEqual(normalizeReport({ busy: true, keepsTerminals: true, reasons: [turn, plugin] }), { busy: true, reasons: [plugin], kept: [turn], keepsTerminals: true });
  // A `keeps` mark means nothing unless the server says its terminals are kept.
  assert.equal(normalizeReport({ busy: true, reasons: [turn] }).busy, true);
  assert.equal(normalizeReport({ busy: true, keepsTerminals: 'yes', reasons: [turn] }).busy, true);
  assert.equal(unknownReport('x').keepsTerminals, false);
});
