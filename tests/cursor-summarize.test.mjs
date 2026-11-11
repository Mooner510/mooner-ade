import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCursorSummarizeOutput, isCursorSummarizeCommand, runCursorSummarize } from '../apps/local-server/src/cursor-summarize.js';

test('isCursorSummarizeCommand matches Cursor compaction slashes', () => {
  for (const text of ['/summarize', '/compact', '/compress', '/compact ']) assert.equal(isCursorSummarizeCommand(text), true, text);
  for (const text of ['/summary', '/compacted', 'summarize']) assert.equal(isCursorSummarizeCommand(text), false, text);
});

test('cleanCursorSummarizeOutput strips retrieval noise and ANSI', () => {
  const raw = 'cursor-retrieval: tracing to /tmp/x.log\n\x1b[1mDone\x1b[0m\n';
  assert.equal(cleanCursorSummarizeOutput(raw), 'Done');
});

test('runCursorSummarize spawns cursor-agent --resume with /summarize', async () => {
  const calls = [];
  const output = await runCursorSummarize({
    executable: 'cursor-agent',
    executableArgs: ['--force'],
    sessionId: 'abc-123',
    cwd: '/repo',
    spawnProcess: (executable, args) => {
      calls.push([executable, args]);
      const listeners = new Map();
      return {
        stdout: { on: (event, fn) => { if (event === 'data') listeners.set('stdout', fn); } },
        stderr: { on: () => {} },
        on: (event, fn) => { if (event === 'close') setImmediate(() => fn(0)); },
        kill() {},
        _emit(data) { listeners.get('stdout')?.(data); },
      };
    },
  });
  assert.equal(output, '');
  assert.deepEqual(calls, [['cursor-agent', ['--force', '--resume', 'abc-123', '--print', '-p', '/summarize', '--output-format', 'text']]]);
});
