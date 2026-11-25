import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { importCursorCliSession } from '../apps/local-server/src/cli-conversations.js';
import { backupCursorStore, exportCursorSession, forkCursorSession, listCursorSessions, readCursorBilledUsage, snapshotCursorSession } from '../apps/local-server/src/cursor-sessions.js';
import { openChatSession, seedChat } from '../apps/local-server/src/chat.js';

const id = '11111111-2222-4333-8444-555555555555';
const metaOf = file => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return JSON.parse(Buffer.from(db.prepare("SELECT value FROM meta WHERE key='0'").get().value, 'hex').toString('utf8')); }
  finally { db.close(); }
};
async function store(configDir, sessionId = id) {
  const file = path.join(configDir, 'acp-sessions', sessionId, 'store.db');
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT)');
  db.prepare('INSERT INTO blobs VALUES (?,?)').run('aa', Buffer.from('first context'));
  db.prepare('INSERT INTO meta VALUES (?,?)').run('0', Buffer.from(JSON.stringify({ agentId: sessionId, latestRootBlobId: 'aa', isRunEverything: true, name: 'Test' })).toString('hex'));
  return { db, file };
}
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ade-cursor-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('Cursor checkpoints retain WAL data once and fork the selected root without changing the source or inheriting --force', async t => {
  const root = await directory(t), configDir = path.join(root, 'cursor'), first = path.join(root, 'checkpoints', 'first.json'), second = path.join(root, 'checkpoints', 'second.json');
  const { db, file } = await store(configDir);
  try {
    assert.equal(await snapshotCursorSession({ sessionId: id, configDir, destination: first }), true);
    db.prepare('INSERT INTO blobs VALUES (?,?)').run('bb', Buffer.from('later context'));
    db.prepare("UPDATE meta SET value=? WHERE key='0'").run(Buffer.from(JSON.stringify({ ...metaOf(file), latestRootBlobId: 'bb' })).toString('hex'));
    await snapshotCursorSession({ sessionId: id, configDir, destination: second });
    const archive = new DatabaseSync(path.join(root, 'checkpoints', 'store.db'), { readOnly: true });
    assert.equal(archive.prepare('SELECT count(*) AS n FROM blobs').get().n, 2); archive.close();
    const fork = await forkCursorSession({ checkpoint: first, configDir, cwd: root });
    const forkMeta = metaOf(path.join(configDir, 'acp-sessions', fork, 'store.db'));
    assert.equal(forkMeta.latestRootBlobId, 'aa'); assert.equal(forkMeta.agentId, fork); assert.equal(forkMeta.isRunEverything, false);
    assert.equal(metaOf(file).latestRootBlobId, 'bb'); assert.equal(metaOf(file).isRunEverything, true);
    await assert.rejects(backupCursorStore(file, file), { code: 'EEXIST' });
    const exported = await exportCursorSession({ sessionId: fork, configDir, cwd: root });
    const listed = await listCursorSessions({ configDir, cwd: root });
    assert.equal(listed[0].sessionId, exported); assert.equal(metaOf(listed[0].file).latestRootBlobId, 'aa');
    assert.equal(await snapshotCursorSession({ sessionId: 'missing', configDir, destination: first }), false);
  } finally { db.close(); }
});

test('Cursor billed usage is optional, validates numbers, and preserves a reported zero charge', async () => {
  const call = async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    return { ok: true, json: async () => ({ usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 5 }, cost: { chargedCents: 0 } }) };
  };
  assert.equal(await readCursorBilledUsage(id, '', () => assert.fail('no key means no request')), null);
  const result = await readCursorBilledUsage(id, 'test-key', call);
  assert.equal(result.costUsd, 0); assert.equal(result.tokens.cacheRead, 100);
  assert.equal(await readCursorBilledUsage(id, 'key', async () => ({ ok: false })), null);
  assert.equal(await readCursorBilledUsage(id, 'key', async () => ({ ok: true, json: async () => ({ usage: { inputTokens: -1 } }) })), null);
});

test('Cursor chat Branch, Rewind and terminal export use independent native sessions at the completed response', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ade-cursor-chat-')), configDir = path.join(root, 'cursor'), events = [];
  const session = await openChatSession({ directory: root, id: 'chat', cwd: root, agent: 'cursor', env: { CURSOR_CONFIG_DIR: configDir }, executable: process.execPath,
    executableArgs: [fileURLToPath(new URL('./fixtures/fake-chat-rpc.mjs', import.meta.url)), 'cursor'], onEvent: event => events.push(event) });
  t.after(async () => { await session.close(); await rm(root, { recursive: true, force: true }); });
  const until = async fn => { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('chat did not settle'); };
  await session.send('first'); await until(() => session.state().status === 'idle');
  const originalId = session.state().sessionId, source = await store(configDir, originalId); source.db.close();
  await session.send('second'); await until(() => session.state().capabilities.branch);
  const message = events.findLast(event => event.kind === 'message' && event.uuid);
  const snapshot = session.branchSnapshot(message.uuid);
  await seedChat({ directory: root, id: 'branch', ...snapshot });
  const branch = JSON.parse(await readFile(path.join(root, 'chat/branch/meta.json'), 'utf8'));
  assert.notEqual(branch.sessionId, originalId);
  assert.equal(metaOf(path.join(configDir, 'acp-sessions', branch.sessionId, 'store.db')).latestRootBlobId, 'aa');
  await session.rewind(message.uuid);
  assert.notEqual(session.state().sessionId, originalId); assert.notEqual(session.state().sessionId, branch.sessionId);
  const handoff = await session.handoff();
  assert.equal(handoff.agent, 'cursor'); assert.notEqual(handoff.sessionId, originalId);
  assert.equal((await listCursorSessions({ configDir, cwd: root }))[0].sessionId, handoff.sessionId);
  assert.equal(metaOf(source.file).agentId, originalId);
});

test('importing a Cursor CLI session copies it and refuses one that is still running', async t => {
  const root = await directory(t), configDir = path.join(root, 'cursor'), cwd = path.join(root, 'proj');
  await mkdir(cwd);
  const hash = createHash('md5').update(path.resolve(cwd)).digest('hex');
  const file = path.join(configDir, 'chats', hash, id, 'store.db');
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO meta VALUES (?,?)').run('0', Buffer.from(JSON.stringify({ agentId: id, latestRootBlobId: 'aa', name: 'CLI chat' })).toString('hex'));
  db.prepare('INSERT INTO blobs VALUES (?,?)').run('aa', Buffer.from('x'));
  db.close();
  await assert.rejects(importCursorCliSession({ directory: root, id: 'imported', sessionId: id, cwd, configDir, running: true, readEvents: async () => [] }), /실행 중/);
  const imported = await importCursorCliSession({ directory: root, id: 'imported', sessionId: id, cwd, configDir, running: false, readEvents: async () => [{ kind: 'user', text: 'hi', seq: 1, at: 1 }] });
  const meta = JSON.parse(await readFile(path.join(root, 'chat/imported/meta.json'), 'utf8'));
  assert.equal(meta.agent, 'cursor');
  assert.equal(imported.sessionId, meta.sessionId);
  assert.notEqual(meta.sessionId, id);
  assert.equal(metaOf(path.join(configDir, 'acp-sessions', meta.sessionId, 'store.db')).agentId, meta.sessionId);
  assert.equal(metaOf(file).agentId, id);
});
