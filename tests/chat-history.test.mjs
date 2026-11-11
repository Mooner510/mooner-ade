import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChatSession, listChatSessions } from '../apps/local-server/src/chat.js';

const settled = async chat => {
  for (let i = 0; i < 200; i++) { if (chat.state().status === 'idle') return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('chat did not settle');
};
for (const agent of ['claude', 'codex', 'cursor']) {
  test(`${agent}: closed chats can be listed and resumed; /clear archives the previous session`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'ade-chat-history-')), chats = [];
    t.after(async () => { for (const chat of chats) await chat.close(); await rm(directory, { recursive: true, force: true }); });
    const options = { directory, id: 'previous', cwd: directory, agent, executable: process.execPath,
      executableArgs: [fileURLToPath(new URL(agent === 'claude' ? './fixtures/fake-claude-stream.mjs' : './fixtures/fake-chat-rpc.mjs', import.meta.url)), ...(agent === 'claude' ? [] : [agent])] };
    const open = async (id = 'previous') => { const chat = await openChatSession({ ...options, id }); chats.push(chat); return chat; };
    let chat = await open();
    assert.deepEqual(await listChatSessions({ directory, agent }), [], 'an unused chat is omitted');
    await chat.send('첫 요청\n두 번째 줄'); await settled(chat);
    const sessionId = chat.state().sessionId;
    await chat.close();
    let sessions = await listChatSessions({ directory, agent });
    assert.equal(sessions.length, 1); assert.equal(sessions[0].id, 'previous');
    const expectedTitle = agent === 'claude' ? 'AI가 붙인 제목' : agent === 'codex' ? 'Codex 테스트 1' : 'Cursor 테스트 1';
    assert.equal(sessions[0].title, expectedTitle); assert.ok(sessions[0].updatedAt > 0);
    assert.deepEqual(await listChatSessions({ directory, agent, exclude: 'previous' }), []);
    assert.deepEqual(await listChatSessions({ directory, agent: agent === 'claude' ? 'codex' : 'claude' }), []);
    chat = await open(); assert.equal(chat.state().sessionId, sessionId);
    assert.ok(chat.replay().events.some(event => event.kind === 'user' && event.text.startsWith('첫 요청')));
    await chat.reset();
    sessions = await listChatSessions({ directory, agent });
    assert.equal(sessions.length, 1); assert.notEqual(sessions[0].id, 'previous');
    const archived = await open(sessions[0].id);
    assert.equal(archived.state().sessionId, sessionId);
    await archived.send('이어서 요청'); await settled(archived);
    assert.ok(archived.replay().events.some(event => event.kind === 'user' && event.text === '이어서 요청'));
  });
}

test('history is scoped to project/provider and ignores incomplete metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-chat-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [id, json] of [['torn', '{'], ['null', 'null'], ['valid', JSON.stringify({ sessionId: 's1', title: 'older Claude session' })]]) {
    await mkdir(join(directory, 'chat', id), { recursive: true }); await writeFile(join(directory, 'chat', id, 'meta.json'), json);
  }
  assert.equal((await listChatSessions({ directory, agent: 'claude' }))[0].id, 'valid');
  assert.deepEqual(await listChatSessions({ directory, agent: 'cursor' }), []);
  assert.deepEqual(await listChatSessions({ directory: join(directory, 'other-project'), agent: 'claude' }), []);
  await assert.rejects(() => listChatSessions({ directory, agent: '../invalid' }), { code: 'INVALID_INPUT' });
});
