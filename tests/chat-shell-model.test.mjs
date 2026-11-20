import test from 'node:test';
import assert from 'node:assert/strict';
import { briefDuration, emptyView, fromReplay, reduce } from '../apps/web/src/chat-model.ts';
import { isShellDraft, parseShellInput, shellBang, shellDuration, shellStalled, shellVerdict, shownDraft, stripAnsi, terminalAdvice } from '../apps/web/src/chat-shell.ts';

const start = (seq, id = 'r1', command = 'git status') => ({ kind: 'shell', phase: 'start', id, command, cwd: '/p', shell: 'bash', seq, at: 1000 });
const end = (seq, extra = {}, id = 'r1') => ({ kind: 'shell', phase: 'end', id, status: 'done', exitCode: 0, ms: 420, stdout: 'ok\n', stderr: '', seq, ...extra });
const shells = view => view.items.filter(item => item.kind === 'shell');

test('parseShellInput: ! runs, \\! escapes, a bare ! explains, a Korean first word asks', () => {
  assert.deepEqual(parseShellInput('!git status'), { kind: 'run', command: 'git status' });
  assert.deepEqual(parseShellInput('  ! ls -la '), { kind: 'run', command: 'ls -la' });
  assert.deepEqual(parseShellInput('!'), { kind: 'empty' });
  assert.deepEqual(parseShellInput('\\!중요한 일'), { kind: 'escaped', text: '!중요한 일' });
  assert.deepEqual(parseShellInput('!중요 이거 해줘'), { kind: 'ambiguous', command: '중요 이거 해줘' });
  assert.equal(parseShellInput('안녕! 반가워'), null);
  assert.equal(parseShellInput('/btw !x'), null);
  assert.equal(parseShellInput('please run !ls'), null);
  assert.ok(isShellDraft('!l') && isShellDraft(' !') && !isShellDraft('\\!x') && !isShellDraft('hi !'));
});

test('shellBang/shownDraft: the ! that opens shell mode stays in the text but the textarea shows the text without it', () => {
  assert.equal(shellBang('!ls'), '!');
  assert.equal(shellBang(' !ls'), ' !');
  assert.equal(shellBang('ls !'), '');
  assert.equal(shownDraft('!ls'), 'ls');
  assert.equal(shownDraft('!'), '');
  assert.equal(shownDraft('hi !'), 'hi !');
  assert.equal(shownDraft('\\!x'), '\\!x');
});

test('shell events: start opens a running card, live output grows it, end settles it with the whole stored output', () => {
  let view = reduce(emptyView(), start(1));
  assert.equal(shells(view).length, 1);
  assert.equal(shells(view)[0].status, 'running');
  assert.equal(shells(view)[0].startedAt, 1000);
  view = reduce(view, { kind: 'shell', phase: 'output', id: 'r1', stream: 'stdout', text: 'par' });
  view = reduce(view, { kind: 'shell', phase: 'output', id: 'r1', stream: 'stderr', text: 'warn' });
  view = reduce(view, { kind: 'shell', phase: 'output', id: 'r1', stream: 'stdout', text: 'tial' });
  assert.equal(shells(view)[0].stdout, 'partial');
  assert.equal(shells(view)[0].stderr, 'warn');
  assert.ok(shells(view)[0].lastOutputAt);
  view = reduce(view, end(2, { stdout: 'partial output\n', stderr: 'warn\n', exitCode: 2, status: 'failed' }));
  const card = shells(view)[0];
  assert.equal(card.status, 'failed');
  assert.equal(card.exitCode, 2);
  assert.equal(card.ms, 420);
  assert.equal(card.stdout, 'partial output\n');
  assert.equal(shells(view).length, 1);
  // The same stored events again (a replay or a double delivery) change nothing.
  assert.equal(reduce(view, start(1)), view);
  assert.equal(shells(reduce(view, { kind: 'shell', phase: 'output', id: 'nope', stream: 'stdout', text: 'x' })).length, 1);
});

test('shell events: a replay rebuilds the cards, `sent` marks what went to the agent, an unknown end still shows', () => {
  const view = fromReplay({ events: [start(1), end(2), { kind: 'shell', phase: 'sent', ids: ['r1'], seq: 3 }, { kind: 'user', text: 'hi', seq: 4 }, start(5, 'r2', 'ls'), end(6, { status: 'interrupted', exitCode: null, stdout: '' }, 'r2'), end(7, { stdout: 'late' }, 'cut-off')], seq: 7 });
  const [first, second, orphan] = shells(view);
  assert.equal(first.sent, true);
  assert.equal(first.status, 'done');
  assert.equal(second.sent, undefined);
  assert.equal(second.status, 'interrupted');
  assert.equal(orphan.stdout, 'late');
  assert.deepEqual(view.items.map(item => item.kind), ['shell', 'user', 'shell', 'shell']);
});

test('shell events never become a user message, so the chat title and busy state ignore them', () => {
  const view = reduce(reduce(emptyView(), start(1)), end(2));
  assert.equal(view.items.some(item => item.kind === 'user'), false);
  assert.equal(view.state.chatTitle, '');
});

test('shellVerdict, shellDuration, stalled hint and terminal advice', () => {
  assert.deepEqual(shellVerdict({ status: 'done' }), { text: '완료', detail: '종료 코드 0', tone: 'ok' });
  assert.deepEqual(shellVerdict({ status: 'failed', exitCode: 127 }), { text: '실패', detail: '종료 코드 127', tone: 'bad' });
  assert.deepEqual(shellVerdict({ status: 'failed', exitCode: null, signal: 'SIGTERM' }), { text: '실패', detail: 'SIGTERM', tone: 'bad' });
  assert.equal(shellVerdict({ status: 'timeout' }).tone, 'bad');
  assert.equal(shellVerdict({ status: 'stopped' }).tone, 'warn');
  assert.match(shellVerdict({ status: 'error', error: 'spawn ENOENT' }).detail, /ENOENT/);
  assert.equal(shellDuration(420), '420ms');
  assert.equal(shellDuration(999.6), '1초');
  assert.equal(briefDuration(100), '100ms');
  assert.equal(briefDuration(4_200), '4초');
  assert.equal(shellDuration(12_400), '12초');
  assert.equal(shellDuration(125_000), '2분 5초');
  const running = { status: 'running', startedAt: 0 };
  assert.equal(shellStalled(running, 10_000), false);
  assert.equal(shellStalled(running, 25_000), true);
  assert.equal(shellStalled({ ...running, lastOutputAt: 20_000 }, 25_000), false);
  assert.equal(shellStalled({ status: 'done', startedAt: 0 }, 99_000), false);
  assert.match(terminalAdvice({ status: 'running' }, true), /터미널 탭/);
  assert.match(terminalAdvice({ status: 'failed', needsTerminal: true }, false), /터미널 탭/);
  assert.equal(terminalAdvice({ status: 'done' }, false), '');
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m\rbar'), 'redbar');
});
