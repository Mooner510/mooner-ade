import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { cursorStorePath } from './cursor-context.js';
import { fault } from './files.js';

export const cursorConfigDir = (env = process.env) => env.CURSOR_CONFIG_DIR || path.join(os.homedir(), '.cursor');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Opening a SQLite store is synchronous (the whole server waits, terminals included), so a session is read again only when its file changed. A write may sit in the
// `-wal` file while store.db itself is untouched, so that file's stamp is part of the key.
const sessionMetas = new Map();
const stamp = async file => { const [db, wal] = await Promise.all([fs.stat(file), fs.stat(`${file}-wal`).catch(() => null)]); return { updatedAt: db.mtimeMs, key: `${db.mtimeMs}:${db.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}` }; };
export async function listCursorSessions({ cwd, configDir = cursorConfigDir() }) {
  const hash = createHash('md5').update(path.resolve(cwd)).digest('hex'), root = path.join(configDir, 'chats', hash);
  const { DatabaseSync } = await import('node:sqlite');
  const sessions = [];
  for (const name of await fs.readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!uuid.test(name)) continue;
    const file = path.join(root, name, 'store.db');
    let seen;
    try { seen = await stamp(file); } catch { continue; }
    const held = sessionMetas.get(file);
    if (held?.key === seen.key) { if (held.session) sessions.push(held.session); continue; }
    let db, session = null;
    try {
      db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
      const raw = db.prepare("SELECT value FROM meta WHERE key='0'").get();
      const meta = JSON.parse(Buffer.from(raw?.value ?? '', 'hex').toString('utf8'));
      if (meta.agentId === name) session = { sessionId: name, title: typeof meta.name === 'string' && meta.name.trim() ? meta.name.slice(0, 120) : name.slice(0, 8), updatedAt: seen.updatedAt, file };
    } catch { /* unreadable or newer format: never guess which conversation to take */ }
    finally { db?.close(); }
    sessionMetas.set(file, { key: seen.key, session });
    if (session) sessions.push(session);
    await new Promise(resolve => setImmediate(resolve)); // let terminal output and requests through between two stores
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// A SQLite backup includes committed WAL pages; copying store.db alone can silently drop the last response.
export async function backupCursorStore(source, destination, sessionId, snapshotMeta) {
  const { DatabaseSync, backup } = await import('node:sqlite');
  const db = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get()) throw fault('CHAT_UNSUPPORTED', 'Cursor 대화 저장소 형식을 확인할 수 없습니다.', 409);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const reservation = await fs.open(destination, 'wx', 0o600); await reservation.close();
    try {
      await backup(db, destination);
      if (sessionId) {
        const copy = new DatabaseSync(destination);
        try {
          const row = copy.prepare("SELECT value FROM meta WHERE key='0'").get();
          const meta = snapshotMeta ?? JSON.parse(Buffer.from(row?.value ?? '', 'hex').toString('utf8'));
          if (typeof meta.agentId !== 'string' || !uuid.test(meta.agentId)) throw fault('CHAT_UNSUPPORTED', 'Cursor 세션 메타데이터 형식을 확인할 수 없습니다.', 409);
          // A copied terminal's --force must never bypass the chat's approval cards.
          copy.prepare("UPDATE meta SET value=? WHERE key='0'").run(Buffer.from(JSON.stringify({ ...meta, agentId: sessionId, isRunEverything: false })).toString('hex'));
        } finally { copy.close(); }
      }
    }
    catch (error) { await fs.rm(destination, { force: true }); throw error; }
  } finally { db.close(); }
}

export async function snapshotCursorSession({ sessionId, configDir, destination, seen }) {
  const source = await cursorStorePath(sessionId, { env: { CURSOR_CONFIG_DIR: configDir } });
  if (!source) return false;
  const { DatabaseSync } = await import('node:sqlite');
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const archive = path.join(path.dirname(destination), 'store.db'), db = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
  let copy;
  try {
    db.exec('BEGIN');
    const row = db.prepare("SELECT value FROM meta WHERE key='0'").get();
    const meta = JSON.parse(Buffer.from(row?.value ?? '', 'hex').toString('utf8'));
    if (!uuid.test(meta.agentId ?? '') || !/^[a-f0-9]+$/i.test(meta.latestRootBlobId ?? '')) return false;
    copy = new DatabaseSync(archive);
    await fs.chmod(archive, 0o600);
    copy.exec('CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT); BEGIN');
    const known = copy.prepare('SELECT 1 FROM blobs WHERE id=?'), read = db.prepare('SELECT data FROM blobs WHERE id=?'), insert = copy.prepare('INSERT INTO blobs (id,data) VALUES (?,?)');
    // Content-addressed blobs are immutable: retain each once, plus one small root metadata file per completed response.
    // `seen` skips blobs this chat already archived, so a later turn does not read the whole store again.
    for (const { id } of db.prepare('SELECT id FROM blobs').iterate()) {
      if (seen?.has(id)) continue;
      if (known.get(id)) { seen?.add(id); continue; }
      const blob = read.get(id); if (blob) { insert.run(id, blob.data); seen?.add(id); }
    }
    copy.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('0',?)").run(row.value);
    copy.exec('COMMIT');
    await fs.writeFile(destination, JSON.stringify(meta), { flag: 'wx', mode: 0o600 });
  } finally { copy?.close(); db.close(); }
  return true;
}

// shortcut: Cursor ACP has no fork method; immutable backups of completed turns preserve native context until it exposes one.
export async function forkCursorSession({ checkpoint, cwd, configDir = cursorConfigDir(), sessionId = randomUUID() }) {
  if (!uuid.test(sessionId)) throw fault('INVALID_INPUT', '잘못된 Cursor 세션 ID입니다.');
  const root = path.join(configDir, 'acp-sessions', sessionId);
  await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  await fs.mkdir(root, { mode: 0o700 });
  try {
    const saved = checkpoint.endsWith('.json') ? JSON.parse(await fs.readFile(checkpoint, 'utf8')) : undefined;
    await backupCursorStore(saved ? path.join(path.dirname(checkpoint), 'store.db') : checkpoint, path.join(root, 'store.db'), sessionId, saved);
    await fs.writeFile(path.join(root, 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd }), { flag: 'wx', mode: 0o600 });
    return sessionId;
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
}

// The CLI and ACP use separate directories. Export a fresh copy so neither UI can write the other's conversation.
export async function exportCursorSession({ sessionId, cwd, configDir = cursorConfigDir() }) {
  const source = await cursorStorePath(sessionId, { env: { CURSOR_CONFIG_DIR: configDir } });
  if (!source) throw fault('NOT_FOUND', 'Cursor 대화 기록을 찾을 수 없습니다.', 404);
  const next = randomUUID(), hash = createHash('md5').update(path.resolve(cwd)).digest('hex');
  const root = path.join(configDir, 'chats', hash, next);
  try { await backupCursorStore(source, path.join(root, 'store.db'), next); }
  catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
  return next;
}

// The SDK's read-only usage endpoint also accepts local agent IDs; availability depends on the account and session.
export async function readCursorBilledUsage(sessionId, apiKey, fetchImpl = fetch) {
  if (!apiKey || !uuid.test(sessionId ?? '')) return null;
  const response = await fetchImpl(`https://api.cursor.com/v1/agents/${sessionId}/usage`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) return null;
  const data = await response.json(), raw = data.usage;
  if (!raw || !['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every(key => Number.isSafeInteger(raw[key]) && raw[key] >= 0)) return null;
  const charged = data.cost?.chargedCents;
  return { tokens: { input: raw.inputTokens, output: raw.outputTokens, cacheRead: raw.cacheReadTokens, cacheCreate: raw.cacheWriteTokens },
    ...(Number.isFinite(charged) && charged >= 0 && { costUsd: charged / 100 }) };
}
