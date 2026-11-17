import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { codexHistoryEvents, readCodexConversation } from '../apps/local-server/src/cli-conversations.js';

test('Codex imports native user, image, final turn identity and tool results', () => {
  const events = codexHistoryEvents({ id: 'thread', createdAt: 1, updatedAt: 2, turns: [{ id: 'turn', status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'question' }, { type: 'image', url: 'ignored' }] },
    { type: 'commandExecution', id: 'tool', command: 'pwd', status: 'completed', aggregatedOutput: '/repo', exitCode: 0 },
    { type: 'agentMessage', id: 'answer', text: 'answer' },
  ] }] });
  assert.equal(events.find(event => event.kind === 'user').images, 1);
  assert.equal(events.find(event => event.uuid === 'answer').turnId, 'turn');
  assert.equal(events.find(event => event.kind === 'tool_result').content, '/repo');
  assert.equal(events.at(-1).status, 'success');
});

test('Codex history uses read and paginated turns without starting or resuming a writer', async () => {
  const result = await readCodexConversation({ cwd: process.cwd(), executable: process.execPath,
    executableArgs: [fileURLToPath(new URL('./fixtures/fake-chat-rpc.mjs', import.meta.url))], env: { HISTORY_ONLY: '1' } }, '11111111-2222-4333-8444-555555555555');
  assert.equal(result.thread.turns.length, 1);
  assert.equal(result.events.find(event => event.kind === 'user').text, 'history question');
});
