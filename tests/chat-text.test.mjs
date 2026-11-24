import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createChatTextStore, CHAT_TEXT_TTL_MS, INLINE_CHAT_TEXT_BYTES, MAX_CHAT_TEXT_BYTES } from '../apps/local-server/src/chat-text.js';

test('chat text uses a UTF-8 byte limit and prunes only expired generated files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ade-chat-text-test-'));
  const store = createChatTextStore(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const inline = 'a'.repeat(INLINE_CHAT_TEXT_BYTES), long = '한'.repeat(INLINE_CHAT_TEXT_BYTES / 2);
  assert.equal(await store.prepare(inline), inline);
  assert.equal(await store.prepare(`/skill ${inline}`), `/skill ${inline}`);
  await assert.rejects(store.prepare('a'.repeat(MAX_CHAT_TEXT_BYTES + 1)), { status: 413 });
  const fileFor = async () => /\[\[file:([^\]]+)\]\]/.exec(await store.prepare(long))[1];
  const expired = await fileFor(), recent = await fileFor(), other = join(dirname(expired), 'manual.txt');
  t.after(() => rm(dirname(expired), { recursive: true, force: true }));
  const past = new Date(Date.now() - CHAT_TEXT_TTL_MS - 1000);
  await writeFile(other, 'keep');
  await Promise.all([utimes(expired, past, past), utimes(other, past, past)]);
  await createChatTextStore(root).prune();
  await assert.rejects(readFile(expired), { code: 'ENOENT' });
  assert.equal(await readFile(recent, 'utf8'), long);
  await store.stop(true);
  await assert.rejects(readFile(recent), { code: 'ENOENT' });
  assert.equal(await readFile(other, 'utf8'), 'keep');
});
