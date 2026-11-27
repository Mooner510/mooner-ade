import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLastLines, renameRetry, writeIfChanged, writeShared } from '../apps/local-server/src/file-util.js';
import { openChatSession } from '../apps/local-server/src/chat.js';

const temp = async t => { const directory = await mkdtemp(join(tmpdir(), 'ade-file-util-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; };

test('writeIfChanged writes once and leaves an identical file untouched', async t => {
  const directory = await temp(t), file = join(directory, 'a.json');
  assert.equal(await writeIfChanged(file, '{"a":1}'), true);
  const past = new Date(Date.now() - 60_000);
  await utimes(file, past, past);
  assert.equal(await writeIfChanged(file, '{"a":1}'), false);
  assert.equal((await stat(file)).mtimeMs, past.getTime(), 'identical content is not rewritten');
  assert.equal(await writeIfChanged(file, '{"a":2}'), true);
  assert.equal(await readFile(file, 'utf8'), '{"a":2}');
  assert.deepEqual(await readdir(directory), ['a.json'], 'no temp file is left behind');
});

test('writeShared gives equal content one file and new content a new file', async t => {
  const directory = join(await temp(t), 'launch');
  const first = await writeShared(directory, 'prompt', '.md', 'hello');
  assert.equal(await writeShared(directory, 'prompt', '.md', 'hello'), first);
  const other = await writeShared(directory, 'prompt', '.md', 'hello 2');
  assert.notEqual(other, first);
  assert.equal(await readFile(first, 'utf8'), 'hello');
  assert.equal((await readdir(directory)).length, 2);
});

test('readLastLines returns the tail of a long file, with multi-byte text and a torn first line across chunks', async t => {
  const directory = await temp(t), file = join(directory, 'log.jsonl');
  const lines = Array.from({ length: 500 }, (_, index) => JSON.stringify({ seq: index + 1, text: `한글 ${index} ${'x'.repeat(index % 7)}` }));
  await writeFile(file, lines.join('\n') + '\n');
  for (const chunkBytes of [7, 64, 1 << 20]) {
    assert.deepEqual(await readLastLines(file, 40, chunkBytes), lines.slice(-40), `chunk ${chunkBytes}`);
    assert.deepEqual(await readLastLines(file, 500, chunkBytes), lines, `all lines, chunk ${chunkBytes}`);
    assert.deepEqual(await readLastLines(file, 900, chunkBytes), lines, `more than the file has, chunk ${chunkBytes}`);
  }
  await writeFile(file, lines.slice(0, 3).join('\n'));
  assert.deepEqual(await readLastLines(file, 2), lines.slice(1, 3), 'no trailing line break');
  assert.deepEqual(await readLastLines(join(directory, 'missing'), 5), []);
  await writeFile(file, '');
  assert.deepEqual(await readLastLines(file, 5), []);
});

test('opening a chat with a long log reads its tail and keeps every event on disk', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-file-util-')), id = 'long-log', root = join(directory, 'chat', id), chats = [];
  // The chat saves its meta when it closes, so it closes before its folder goes.
  t.after(async () => { for (const chat of chats) await chat.close(); await rm(directory, { recursive: true, force: true }); });
  await mkdir(root, { recursive: true });
  const total = 5200, log = Array.from({ length: total }, (_, index) => JSON.stringify({ seq: index + 1, kind: 'user', text: `메시지 ${index + 1}` })).join('\n') + '\n';
  await writeFile(join(root, 'events.jsonl'), log);
  const chat = await openChatSession({ directory, id, cwd: directory, agent: 'claude', executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))] });
  chats.push(chat);
  const events = chat.replay().events;
  assert.equal(events.length, 4000);
  assert.equal(events[0].seq, total - 4000 + 1);
  assert.equal(events.at(-1).seq, total);
  assert.equal(await readFile(join(root, 'events.jsonl'), 'utf8'), log, 'the log on disk is not trimmed');
});

test('renameRetry tries again while Windows refuses the replace, then succeeds', async () => {
  const calls = [], pauses = [];
  const rename = async () => { calls.push(1); if (calls.length < 4) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); };
  await renameRetry('a', 'b', { rename, wait: async ms => { pauses.push(ms); } });
  assert.equal(calls.length, 4);
  assert.deepEqual(pauses, [10, 20, 30], 'the pause grows with each attempt');
});

test('renameRetry gives up after its attempts and does not retry other errors', async () => {
  let calls = 0;
  const busy = async () => { calls++; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); };
  await assert.rejects(renameRetry('a', 'b', { rename: busy, wait: async () => {}, attempts: 5 }), { code: 'EBUSY' });
  assert.equal(calls, 6, 'the first try plus five more');
  calls = 0;
  const missing = async () => { calls++; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  await assert.rejects(renameRetry('a', 'b', { rename: missing, wait: async () => {} }), { code: 'ENOENT' });
  assert.equal(calls, 1);
});

test('renameRetry replaces a real file', async t => {
  const directory = await temp(t), from = join(directory, 'm.json.tmp'), to = join(directory, 'm.json');
  await writeFile(to, 'old'); await writeFile(from, 'new');
  await renameRetry(from, to);
  assert.equal(await readFile(to, 'utf8'), 'new');
  assert.deepEqual(await readdir(directory), ['m.json']);
});
