import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChatTitle } from '../apps/local-server/src/chat-title.js';
import { resolveChatTitle as resolveUi, cleanChatTitle } from '../apps/web/src/chat-model.ts';

test('chat titles prefer rename, then AI, then agent, then the first non-slash prompt', () => {
  const users = [{ kind: 'user', text: '/model opus' }, { kind: 'user', text: '첫 질문' }];
  assert.equal(resolveChatTitle({}, users), '첫 질문');
  assert.equal(resolveChatTitle({ ai: 'AI 제목' }, users), 'AI 제목');
  assert.equal(resolveChatTitle({ custom: '직접 이름', ai: 'AI 제목' }, users), '직접 이름');
  assert.equal(resolveChatTitle({ agent: 'Codex 이름', ai: 'AI 제목' }, users), 'AI 제목');
  assert.equal(resolveChatTitle({ agent: 'Cursor 이름' }, users), 'Cursor 이름');
  assert.equal(cleanChatTitle('<pasted_content> 붙여넣기 </pasted_content>'), '붙여넣기');
  assert.equal(resolveUi({ custom: 'UI' }, [{ kind: 'user', text: 'prompt' }]), 'UI');
});
