import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fault } from './files.js';
import { transcriptEvents } from './chat-claude.js';
import { seedFromTranscript } from './chat.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 256 * 1024, MAX_LISTED = 50;
export const defaultClaudeDir = () => path.join(os.homedir(), '.claude');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Conversations made with the plain `claude` CLI in this project: <config>/projects/<cwd with non-alphanumerics as '-'>/<session>.jsonl.
// ponytail: only the exact folder name is looked at; very long paths that Claude shortens with a hash are not listed.
export const cliProjectFolder = (dir, cwd) => path.join(dir, 'projects', String(cwd).replace(/[^a-zA-Z0-9]/g, '-'));

// Sessions a running `claude` still writes to (<config>/sessions/<pid>.json); importing one would leave two writers.
async function liveSessions(dir) {
  const live = new Set();
  for (const name of await fs.readdir(path.join(dir, 'sessions')).catch(() => [])) {
    try {
      const info = JSON.parse(await fs.readFile(path.join(dir, 'sessions', name), 'utf8'));
      if (typeof info?.sessionId === 'string' && Number.isInteger(info.pid) && alive(info.pid)) live.add(info.sessionId);
    } catch { /* a file being written, or not ours */ }
  }
  return live;
}
// ADE chats that already continue a given CLI session, so the list opens that chat instead of importing a second copy.
async function chatsBySession(directory) {
  const bySession = new Map(), root = path.join(directory, 'chat');
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(root, entry.name, 'meta.json'), 'utf8'));
      if ((meta?.agent ?? 'claude') === 'claude' && typeof meta.sessionId === 'string') bySession.set(meta.sessionId, entry.name);
    } catch { /* unreadable chat folder */ }
  }
  return bySession;
}
// The title `claude --resume` shows: the name from /rename, else the AI-written one (both are lines in the transcript, the newest wins),
// else the first thing the user typed that is not a slash command. Only the start and the end of a large transcript are read.
const clean = text => text.replace(/<\/?pasted_content(?:\s[^>]*)?>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
async function titleOf(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat(), read = async (position, length) => { const buffer = Buffer.alloc(length), { bytesRead } = await handle.read(buffer, 0, length, position); return buffer.toString('utf8', 0, bytesRead); };
    const head = await read(0, Math.min(size, HEAD_BYTES)), tail = size > HEAD_BYTES ? await read(Math.max(HEAD_BYTES, size - HEAD_BYTES), Math.min(size - HEAD_BYTES, HEAD_BYTES)) : '';
    let custom = '', ai = '';
    for (const text of [head, tail]) for (const line of text.split('\n')) {
      if (!line.includes('-title"')) continue;
      try { const raw = JSON.parse(line); if (raw.type === 'custom-title' && raw.customTitle) custom = raw.customTitle; else if (raw.type === 'ai-title' && raw.aiTitle) ai = raw.aiTitle; } catch { /* a torn line at a cut */ }
    }
    if (custom || ai) return clean(custom || ai);
    const first = transcriptEvents(head).find(event => event.kind === 'user' && clean(event.text) && !clean(event.text).startsWith('/'));
    return first ? clean(first.text) : '';
  } finally { await handle.close(); }
}

export async function listCliSessions({ directory, cwd, configDirs }) {
  const bySession = await chatsBySession(directory), sessions = [], seen = new Set();
  for (const dir of new Set(configDirs)) {
    const folder = cliProjectFolder(dir, cwd), live = await liveSessions(dir);
    for (const name of await fs.readdir(folder).catch(() => [])) {
      const sessionId = name.slice(0, -'.jsonl'.length);
      if (!name.endsWith('.jsonl') || !UUID.test(sessionId) || seen.has(sessionId)) continue;
      try {
        const file = path.join(folder, name), stat = await fs.stat(file);
        const title = await titleOf(file);
        if (!title) continue; // never answered or only commands: nothing worth continuing
        seen.add(sessionId);
        sessions.push({ sessionId, title, updatedAt: stat.mtimeMs, size: stat.size, running: live.has(sessionId), chatId: bySession.get(sessionId) ?? null });
      } catch { /* vanished or unreadable */ }
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_LISTED);
}

// A plain-CLI conversation continued as a chat: same seeding as terminal -> chat, minus the process hand-over.
export async function importCliSession({ directory, id, sessionId, cwd, configDirs }) {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw fault('INVALID_INPUT', '잘못된 세션 ID입니다.');
  for (const dir of new Set(configDirs)) {
    const file = path.join(cliProjectFolder(dir, cwd), `${sessionId}.jsonl`);
    if (!(await fs.access(file).then(() => true, () => false))) continue;
    if ((await liveSessions(dir)).has(sessionId)) throw fault('CHAT_SWITCH_UNSAFE', '터미널에서 실행 중인 대화입니다. Claude를 종료한 뒤 불러오세요.', 409);
    const events = await seedFromTranscript({ directory, id, file, sessionId, configDir: dir === defaultClaudeDir() ? undefined : dir });
    return { events };
  }
  throw fault('NOT_FOUND', 'CLI 대화 기록을 찾을 수 없습니다.', 404);
}
