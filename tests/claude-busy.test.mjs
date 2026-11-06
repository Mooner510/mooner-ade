import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeBusy, pendingWakeup } from '../apps/local-server/src/claude-busy.js';
import { parseProcessTable, runningCommands, terminalProcesses } from '../apps/local-server/src/terminal-processes.js';

const sessionId = '5450d9b4-ef97-4365-80a9-40e9e92cc1a0', cwd = '/Users/me/my_project';
const T = iso => Date.parse(iso);
const started = T('2026-11-06T10:00:00.000Z');
// A ScheduleWakeup result, a fired wakeup and a stop, in the shapes Claude Code writes them to the transcript.
const scheduled = (at, dueIso, extra = {}) => JSON.stringify({ type: 'user', timestamp: at, toolUseResult: { scheduledFor: T(dueIso), clampedDelaySeconds: 600, wasClamped: false, ...extra } });
const fired = at => JSON.stringify({ type: 'system', subtype: 'scheduled_task_fire', timestamp: at, taskKind: 'loop', cronKind: 'loop' });

async function config(session, lines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-busy-'));
  await fs.mkdir(path.join(dir, 'sessions'));
  if (session) await fs.writeFile(path.join(dir, 'sessions', `${session.pid}.json`), JSON.stringify({ sessionId, cwd, startedAt: started, ...session }));
  if (lines) {
    const project = path.join(dir, 'projects', '-Users-me-my-project');
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, `${sessionId}.jsonl`), lines.join('\n') + '\n');
  }
  return dir;
}

test('Claude reports its own state: a turn, a background task and a waiting dialog all count as busy', async () => {
  for (const [status, kind] of [['busy', 'turn'], ['shell', 'background'], ['waiting', 'waiting']])
    assert.deepEqual(await claudeBusy(await config({ pid: 42, status }), 42), { busy: true, kind });
  assert.deepEqual(await claudeBusy(await config({ pid: 42, status: 'idle' }), 42), { busy: false });
});

test('a state that cannot be read is never taken for idle', async () => {
  for (const dir of [await config(null), await config({ pid: 43, status: 'idle' }), await config({ pid: 42 }), await config({ pid: 42, status: 'sleeping' })]) {
    const result = await claudeBusy(dir, 42);
    assert.equal(result.busy, true);
    assert.equal(result.kind, 'unknown');
    assert.ok(result.detail);
  }
});

test('an idle Claude with a wakeup still scheduled is busy until it fires', async () => {
  const lines = [scheduled('2026-11-06T10:10:00.000Z', '2026-11-06T10:20:00.000Z')];
  const dir = await config({ pid: 42, status: 'idle' }, lines);
  const before = await claudeBusy(dir, 42, T('2026-11-06T10:15:00.000Z'));
  assert.equal(before.busy, true);
  assert.equal(before.kind, 'scheduled');
  assert.deepEqual(await claudeBusy(dir, 42, T('2026-11-06T10:23:00.000Z')), { busy: false }, 'long past due, within no grace: nothing is coming');
  assert.equal((await claudeBusy(dir, 42, T('2026-11-06T10:21:00.000Z'))).busy, true, 'a moment past due it is still about to fire');
  const afterFire = await config({ pid: 42, status: 'idle' }, [...lines, fired('2026-11-06T10:20:05.000Z')]);
  assert.deepEqual(await claudeBusy(afterFire, 42, T('2026-11-06T10:15:00.000Z')), { busy: false });
});

test('pendingWakeup follows the last schedule of this process', () => {
  const text = lines => lines.join('\n');
  const due = '2026-11-06T10:20:00.000Z';
  assert.equal(pendingWakeup(text([scheduled('2026-11-06T10:10:00.000Z', due)]), { startedAt: started }), T(due));
  assert.equal(pendingWakeup(text([scheduled('2026-11-06T10:10:00.000Z', due), fired('2026-11-06T10:20:01.000Z')]), { startedAt: started }), 0);
  assert.equal(pendingWakeup(text([scheduled('2026-11-06T10:10:00.000Z', due), scheduled('2026-11-06T10:12:00.000Z', due, { stopped: true, cancelledWakeups: 1 })]), { startedAt: started }), 0);
  assert.equal(pendingWakeup(text([scheduled('2026-11-06T10:10:00.000Z', due), fired('2026-11-06T10:20:01.000Z'), scheduled('2026-11-06T10:21:00.000Z', '2026-11-06T10:40:00.000Z')]), { startedAt: started }), T('2026-11-06T10:40:00.000Z'));
  // A wakeup recorded before this process started belongs to a Claude that is gone; a cut-off first line of a tail is skipped.
  assert.equal(pendingWakeup(text([scheduled('2026-11-06T09:50:00.000Z', due)]), { startedAt: started }), 0);
  assert.equal(pendingWakeup(text(['"scheduledFor": 5}', scheduled('2026-11-06T10:10:00.000Z', due)]), { startedAt: started }), T(due));
  assert.equal(pendingWakeup('', { startedAt: started }), 0);
});

test('only commands count under a plain shell, not console helpers', () => {
  const table = parseProcessTable(`
    100 1 pwsh.exe
    101 100 conhost.exe
    102 100 "C:\\Program Files\\nodejs\\node.exe" server.js
    103 102 cmd.exe /c build
    200 1 bash
    201 200 OpenConsole.exe
  `);
  const inspect = terminalProcesses(table);
  assert.deepEqual(inspect(100).descendants.map(item => item.pid), [101, 102, 103]);
  assert.deepEqual(runningCommands(inspect(100).descendants).map(item => item.pid), [102, 103]);
  assert.deepEqual(runningCommands(inspect(200).descendants), []);
  assert.deepEqual(inspect(999).descendants, []);
});
