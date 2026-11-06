import { promises as fs } from 'node:fs';
import path from 'node:path';
import { transcriptOf } from './claude-cache.js';

// Whether a running Claude Code still has (or is about to continue) work, so an update that restarts the app does not cut it off.
// A session that looks idle can still be waiting on a background shell or a Monitor and will carry on by itself when that ends.
// shortcut: Claude Code writes its own state to <config>/sessions/<pid>.json (status: idle | busy | shell | waiting), which is the
// source of truth here; the transcript only adds scheduled wakeups, which that status does not cover. Both are CLI internals
// (checked against v2.1.318/319), so a file that cannot be read counts as busy instead of being guessed idle.
const TAIL = 2 * 1024 * 1024;
// A wakeup fires a little after its scheduled time; within this window it still counts as pending.
const WAKEUP_GRACE = 2 * 60_000;

// busy: a turn or subagent is running; shell: a background shell/PowerShell/Monitor task is running; waiting: a permission or question dialog.
const BUSY_STATUS = { busy: 'turn', shell: 'background', waiting: 'waiting' };

// The last ScheduleWakeup of this process (lines before `startedAt` belong to a process that is gone) is pending until it fires
// (a `scheduled_task_fire` entry) or is stopped. Returns the time it is due, or 0.
export function pendingWakeup(text, { startedAt = 0 } = {}) {
  let due = 0;
  for (const line of text.split('\n')) {
    const result = line.includes('"scheduledFor"'), fire = line.includes('"subtype":"scheduled_task_fire"');
    if (!result && !fire) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // the first line of a tail is usually cut off
    const at = Date.parse(entry.timestamp);
    if (!at || at < startedAt) continue;
    if (fire && entry.type === 'system' && entry.subtype === 'scheduled_task_fire') due = 0;
    else if (result && entry.type === 'user' && typeof entry.toolUseResult?.scheduledFor === 'number') due = entry.toolUseResult.stopped ? 0 : entry.toolUseResult.scheduledFor;
  }
  return due;
}

async function readTail(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat(), length = Math.min(size, TAIL), buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally { await handle.close(); }
}

// Resolves `{ busy: false }` or `{ busy: true, kind, detail }` for the Claude process `pid` that runs under `configDir`.
export async function claudeBusy(configDir, pid, now = Date.now()) {
  let session;
  try { session = JSON.parse(await fs.readFile(path.join(configDir, 'sessions', `${pid}.json`), 'utf8')); }
  catch { return { busy: true, kind: 'unknown', detail: '세션 상태 파일을 읽을 수 없습니다' }; }
  if (session?.pid !== pid) return { busy: true, kind: 'unknown', detail: '세션 상태 파일이 이 프로세스의 것이 아닙니다' };
  if (BUSY_STATUS[session.status]) return { busy: true, kind: BUSY_STATUS[session.status] };
  if (session.status !== 'idle') return { busy: true, kind: 'unknown', detail: `알 수 없는 상태 (${String(session.status).slice(0, 20)})` };
  const file = await transcriptOf(configDir, session).catch(() => null);
  if (file) {
    const due = pendingWakeup(await readTail(file).catch(() => ''), { startedAt: Number(session.startedAt) || 0 });
    if (due && due + WAKEUP_GRACE > now) return { busy: true, kind: 'scheduled', detail: `예약된 작업이 ${new Date(due).toLocaleTimeString('ko-KR')}에 실행될 예정입니다` };
  }
  return { busy: false };
}
