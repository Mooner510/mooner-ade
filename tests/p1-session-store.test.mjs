import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSessionStore } from '../packages/session-store/src/index.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ade-session-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: new FileSessionStore(dir) };
}
test('persists records and replays events from cursor', async t => {
  const { dir, store } = await fixture(t);
  await store.create({ id: 'a1', status: 'running', agentId: 'codex' });
  assert.equal((await store.append('a1', { kind: 'text', text: 'Hello', sequence: 99 })).sequence, 1);
  assert.equal((await store.append('a1', { kind: 'tool' })).sequence, 2);
  const opened = new FileSessionStore(dir);
  assert.deepEqual((await opened.replay('a1', { afterSequence: 1 })).map(e => e.kind), ['tool']);
  assert.equal((await opened.load('a1')).session.agentId, 'codex');
});
test('concurrent append operations produce unique contiguous sequence values', async t => {
  const { store } = await fixture(t);
  await store.create({ id: 'b2', status: 'running' });
  const events = await Promise.all(Array.from({ length: 20 }, (_, i) => store.append('b2', { kind: 'text', text: String(i) })));
  assert.deepEqual(events.map(e => e.sequence), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal((await store.replay('b2')).length, 20);
});
test('restore marks running sessions interrupted without declaring model process resumed', async t => {
  const { dir, store } = await fixture(t);
  await store.create({ id: 'c3', status: 'running' });
  const second = new FileSessionStore(dir);
  assert.equal((await second.recover('c3')).session.status, 'interrupted');
  assert.deepEqual((await second.replay('c3')), []);
});
test('terminal statuses forbid subsequent event appends', async t => {
  const { store } = await fixture(t);
  await store.create({ id: 'd4', status: 'running' });
  await store.setStatus('d4', 'completed');
  await assert.rejects(store.append('d4', { kind: 'text' }), /terminal/);
});
test('rejects traversal and invalid cursors', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.load('../x'), /Invalid/);
  await assert.rejects(store.create({ id: 'x/y' }), /Invalid/);
  await store.create({ id: 'e5', status: 'running' });
  await assert.rejects(store.replay('e5', { afterSequence: -1 }), /Invalid/);
});
test('records are owner-readable files', async t => {
  const { dir, store } = await fixture(t);
  await store.create({ id: 'f6', status: 'running' });
  const files = await readdir(dir);
  assert.deepEqual(files, ['f6.json']);
  const parsed = JSON.parse(await readFile(join(dir,'f6.json'),'utf8'));
  assert.equal(parsed.version, 1);
});
test('appends go to jsonl and a torn tail is dropped then truncated', async t => {
  const { dir, store } = await fixture(t);
  await store.create({ id: 'g7', status: 'running' });
  await store.append('g7', { kind: 'text', text: 'a' });
  await store.append('g7', { kind: 'text', text: 'b' });
  await appendFile(join(dir, 'g7.events.jsonl'), '{"kind":"text","sess');
  const reopened = new FileSessionStore(dir);
  assert.equal((await reopened.replay('g7')).length, 2);
  assert.equal((await reopened.append('g7', { kind: 'text', text: 'c' })).sequence, 3);
  assert.deepEqual((await new FileSessionStore(dir).replay('g7')).map(e => e.text), ['a', 'b', 'c']);
  assert.equal(JSON.parse(await readFile(join(dir, 'g7.json'), 'utf8')).events.length, 0);
});
test('reads legacy single-file records and keeps their events', async t => {
  const { dir, store } = await fixture(t);
  const legacy = { version: 1, session: { id: 'h8', status: 'running' }, events: [{ kind: 'text', sessionId: 'h8', sequence: 1, timestamp: 1 }] };
  await writeFile(join(dir, 'h8.json'), JSON.stringify(legacy));
  assert.equal((await store.append('h8', { kind: 'text' })).sequence, 2);
  await store.setStatus('h8', 'completed');
  assert.equal((await new FileSessionStore(dir).replay('h8')).length, 2);
});
