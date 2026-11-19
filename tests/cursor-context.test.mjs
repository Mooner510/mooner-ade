import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cursorAutoCompact, cursorStorePath, decodeConversationTokenDetails, readCursorStoreUsage } from '../apps/local-server/src/cursor-context.js';

const varint = value => {
  const out = [];
  let n = value;
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
};

const fieldKey = (field, wire) => varint((field << 3) | wire);
const fieldVarint = (field, value) => Buffer.concat([fieldKey(field, 0), varint(value)]);
const fieldBytes = (field, payload) => Buffer.concat([fieldKey(field, 2), varint(payload.length), payload]);

test('decodeConversationTokenDetails reads field 5 used/max tokens', () => {
  const details = fieldBytes(5, Buffer.concat([fieldVarint(1, 12_345), fieldVarint(2, 200_000)]));
  const parsed = decodeConversationTokenDetails(details);
  assert.deepEqual(parsed, { usedTokens: 12_345, maxTokens: 200_000 });
});

test('decodeConversationTokenDetails keeps the summary count that follows the token meter', () => {
  const root = Buffer.concat([
    fieldBytes(5, Buffer.concat([fieldVarint(1, 180_000), fieldVarint(2, 200_000)])),
    fieldVarint(17, 2),
  ]);
  assert.deepEqual(decodeConversationTokenDetails(root), { usedTokens: 180_000, maxTokens: 200_000, selfSummaryCount: 2 });
});

test('cursorAutoCompact emits when the summary count rises, and baselines the first count unless the meter just fell', () => {
  assert.deepEqual(cursorAutoCompact(null, { selfSummaryCount: 1, contextTokens: 20_000 }, 0), { count: 1, event: null });
  const first = cursorAutoCompact(null, { selfSummaryCount: 1, contextTokens: 20_000 }, 180_000);
  assert.equal(first.event.trigger, 'auto');
  assert.equal(first.event.preTokens, 180_000);
  assert.equal(first.event.postTokens, 20_000);
  const again = cursorAutoCompact(1, { selfSummaryCount: 2, contextTokens: 30_000 }, 20_000);
  assert.equal(again.event.postTokens, 30_000);
  assert.equal(cursorAutoCompact(2, { selfSummaryCount: 2, contextTokens: 30_000 }, 30_000).event, null);
  assert.equal(cursorAutoCompact(2, { contextTokens: 30_000 }, 30_000).count, 2);
});

test('cursorStorePath prefers acp-sessions then scans chats', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ade-cursor-ctx-'));
  const session = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const acp = path.join(root, '.cursor', 'acp-sessions', session);
  await mkdir(acp, { recursive: true });
  await writeFile(path.join(acp, 'store.db'), '');
  const found = await cursorStorePath(session, { home: root });
  assert.equal(found, path.join(acp, 'store.db'));
});

test('readCursorStoreUsage parses meta and root blob', async () => {
  const root = fieldBytes(5, Buffer.concat([fieldVarint(1, 4_200), fieldVarint(2, 300_000)]));
  const rootId = 'abc123';
  const meta = { latestRootBlobId: rootId };
  const dbDir = await mkdtemp(path.join(os.tmpdir(), 'ade-cursor-db-'));
  const db = path.join(dbDir, 'store.db');
  const query = async (cmd, args) => {
    if (cmd !== 'sqlite3') return null;
    const sql = args[1];
    if (sql.includes("key = '0'")) return Buffer.from(JSON.stringify(meta)).toString('hex') + '\n';
    if (sql.includes('hex(data)')) return root.toString('hex') + '\n';
    return null;
  };
  const reading = await readCursorStoreUsage('sess', { query, storePath: db });
  assert.equal(reading.contextTokens, 4_200);
  assert.equal(reading.contextWindow, 300_000);
  assert.equal(reading.source, 'store');
});
