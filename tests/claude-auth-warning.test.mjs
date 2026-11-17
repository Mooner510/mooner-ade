import test from 'node:test';
import assert from 'node:assert/strict';
import { authSendWarning, authSendWarningText, authWords } from '../apps/web/src/claude-auth-warning.ts';

const chat = extra => ({ agent: 'claude', turns: 3, auth: 'key', lastAuth: 'login', contextTokens: 52_000, ...extra });
const idle = { working: false };

test('switching is silent; the first message on another login than the last turn ran on asks, in both directions', () => {
  assert.deepEqual(authSendWarning(chat(), idle), { from: 'login', to: 'key', tokens: 52_000 }); // CLI -> API
  assert.deepEqual(authSendWarning(chat({ auth: 'login', lastAuth: 'key' }), idle), { from: 'key', to: 'login', tokens: 52_000 }); // API -> CLI
});

test('no question without a turn to lose, for the same login, while a turn runs, or for other agents', () => {
  assert.equal(authSendWarning(chat({ turns: 0 }), idle), undefined); // a new or cleared chat has no prompt cache
  assert.equal(authSendWarning(chat({ lastAuth: null }), idle), undefined);
  assert.equal(authSendWarning(chat({ lastAuth: 'key' }), idle), undefined); // same login as the last turn
  assert.equal(authSendWarning(chat(), { working: true }), undefined);
  assert.equal(authSendWarning(chat({ agent: 'codex' }), idle), undefined);
  assert.equal(authSendWarning({ agent: 'claude', turns: 2 }, idle), undefined); // a server without the choice
});

test('the question names both logins and what changes', () => {
  const toKey = authSendWarningText(authSendWarning(chat(), idle));
  assert.match(toKey, /지금까지 CLI 플랜으로 답했습니다/); assert.match(toKey, /API 키로 보내면 프롬프트 캐시를 이어 쓰지 못해/); assert.match(toKey, /약 52k 토큰/); assert.match(toKey, /API 요금이 청구됩니다/);
  const toLogin = authSendWarningText(authSendWarning(chat({ auth: 'login', lastAuth: 'key', contextTokens: 400 }), idle));
  assert.match(toLogin, /지금까지 API 키로 답했습니다/); assert.match(toLogin, /CLI 플랜으로 보내면/); assert.match(toLogin, /플랜 한도/); assert.doesNotMatch(toLogin, /토큰\)/);
  assert.deepEqual(authWords, { login: 'CLI 플랜으로', key: 'API 키로' });
});
