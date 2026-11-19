import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = (file, args) => new Promise(resolve => {
  execFile(file, args, { timeout: 8_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
});

const readVarint = (data, index) => {
  let value = 0, shift = 0;
  for (let i = index; i < data.length; i++) {
    const byte = data[i];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value, i + 1];
    shift += 7;
    if (shift > 63) return null;
  }
  return null;
};

// Protobuf fields are walked only far enough to read Cursor's context meter (field 5, then 4).
export function decodeConversationTokenDetails(checkpoint) {
  if (!checkpoint?.length) return null;
  const data = Buffer.isBuffer(checkpoint) ? checkpoint : Buffer.from(checkpoint);
  let index = 0, tokens = null, selfSummaryCount = null;
  while (index < data.length) {
    const keyRead = readVarint(data, index);
    if (!keyRead) return null;
    const [key, next] = keyRead;
    index = next;
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) {
      const valueRead = readVarint(data, index);
      if (!valueRead) return null;
      const [value, after] = valueRead;
      index = after;
      // ConversationStateStructure field 17 is how many times this conversation has summarized itself.
      if (field === 17) selfSummaryCount = value;
    } else if (wire === 2) {
      const lenRead = readVarint(data, index);
      if (!lenRead) return null;
      const [length, afterLen] = lenRead;
      index = afterLen;
      if (index + length > data.length) return null;
      const chunk = data.subarray(index, index + length);
      index += length;
      if ((field === 5 || field === 4) && !tokens) tokens = tokenField(chunk);
    } else if (wire === 1) index += 8;
    else if (wire === 5) index += 4;
    else return null; // groups, packed quirks: stop instead of guessing
  }
  if (!tokens) return null;
  return selfSummaryCount == null ? tokens : { ...tokens, selfSummaryCount };
}

// A rise in the store's summary count is Cursor auto-compacting. The first count we see is only a baseline,
// unless this session already had a context meter and that meter just fell (the count field was absent until the summary).
export function cursorAutoCompact(previousCount, reading, preTokens) {
  const count = reading?.selfSummaryCount;
  if (!Number.isInteger(count)) return { count: previousCount ?? null, event: null };
  const event = (post = reading.contextTokens) => ({ kind: 'compact', trigger: 'auto', preTokens: preTokens > 0 ? preTokens : null, postTokens: Number.isFinite(post) ? post : null });
  if (previousCount == null) {
    const dropped = preTokens > 0 && reading.contextTokens > 0 && reading.contextTokens < preTokens * 0.8;
    if (count > 0 && dropped) return { count, event: event() };
    return { count, event: null };
  }
  if (count <= previousCount) return { count, event: null };
  return { count, event: event() };
}

function tokenField(chunk) {
  let used, max, index = 0;
  while (index < chunk.length) {
    const keyRead = readVarint(chunk, index);
    if (!keyRead) return null;
    const [key, next] = keyRead;
    index = next;
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) {
      const valueRead = readVarint(chunk, index);
      if (!valueRead) return null;
      const [value, after] = valueRead;
      index = after;
      if (field === 1) used = value;
      else if (field === 2) max = value;
    } else if (wire === 2) {
      const lenRead = readVarint(chunk, index);
      if (!lenRead) return null;
      index = lenRead[1] + lenRead[0];
    } else if (wire === 1) index += 8;
    else if (wire === 5) index += 4;
    else return null;
  }
  if (used == null || max == null || max <= 0) return null;
  return { usedTokens: used, maxTokens: max };
}

export async function cursorStorePath(sessionId, { home = os.homedir(), env = process.env } = {}) {
  if (!sessionId || typeof sessionId !== 'string' || !/^[\w-]{8,128}$/.test(sessionId)) return null;
  if (env.CURSOR_STORE_CONTEXT === '0') return null;
  const config = env.CURSOR_CONFIG_DIR || path.join(home, '.cursor');
  const acp = path.join(config, 'acp-sessions', sessionId, 'store.db');
  try { await fs.access(acp); return acp; } catch {}
  const chatsRoot = path.join(config, 'chats');
  let folders = [];
  try { folders = await fs.readdir(chatsRoot); } catch { return null; }
  for (const folder of folders) {
  if (!folder || folder.includes('/') || folder.includes('\\')) continue;
    const candidate = path.join(chatsRoot, folder, sessionId, 'store.db');
    try { await fs.access(candidate); return candidate; } catch {}
  }
  return null;
}

const sqlEscape = value => value.replace(/'/g, "''");

export async function readCursorStoreUsage(sessionId, { query = run, storePath = cursorStorePath } = {}) {
  const db = typeof storePath === 'function' ? await storePath(sessionId) : storePath;
  if (!db) return null;
  const metaRow = await query('sqlite3', [db, "SELECT value FROM meta WHERE key = '0' LIMIT 1;"]);
  const hex = metaRow?.trim();
  if (!hex || !/^[0-9a-f]+$/i.test(hex)) return null;
  let meta;
  try { meta = JSON.parse(Buffer.from(hex, 'hex').toString('utf8')); } catch { return null; }
  const rootId = meta?.latestRootBlobId;
  if (typeof rootId !== 'string' || !/^[0-9a-f]+$/i.test(rootId)) return null;
  const blobRow = await query('sqlite3', [db, `SELECT hex(data) FROM blobs WHERE id = '${sqlEscape(rootId)}' LIMIT 1;`]);
  const blobHex = blobRow?.trim();
  if (!blobHex || !/^[0-9a-f]+$/i.test(blobHex)) return null;
  const details = decodeConversationTokenDetails(Buffer.from(blobHex, 'hex'));
  if (!details) return null;
  return { contextTokens: details.usedTokens, contextWindow: details.maxTokens, source: 'store', at: Date.now(), ...(Number.isInteger(details.selfSummaryCount) && { selfSummaryCount: details.selfSummaryCount }) };
}
