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
  let index = 0;
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
      index = valueRead[1];
    } else if (wire === 2) {
      const lenRead = readVarint(data, index);
      if (!lenRead) return null;
      const [length, afterLen] = lenRead;
      index = afterLen;
      if (index + length > data.length) return null;
      const chunk = data.subarray(index, index + length);
      index += length;
      if (field === 5 || field === 4) {
        const details = tokenField(chunk);
        if (details) return details;
      }
    } else if (wire === 1) index += 8;
    else if (wire === 5) index += 4;
    else return null; // groups, packed quirks: stop instead of guessing
  }
  return null;
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
  const acp = path.join(home, '.cursor', 'acp-sessions', sessionId, 'store.db');
  try { await fs.access(acp); return acp; } catch {}
  const chatsRoot = path.join(home, '.cursor', 'chats');
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
  return { contextTokens: details.usedTokens, contextWindow: details.maxTokens, source: 'store', at: Date.now() };
}
