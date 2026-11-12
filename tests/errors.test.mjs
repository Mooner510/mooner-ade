import test from 'node:test';
import assert from 'node:assert/strict';
import { clearErrors, dismissError, errorLog, errorText, pushError } from '../apps/web/src/errors.ts';

test('errors stack newest first, ignore a repeat while its toast is up, and cap the list', () => {
  const scope = `t-${Date.now()}`;
  pushError(scope, '  ');
  assert.equal(errorLog(scope).items.length, 0);
  pushError(scope, '열지 못했습니다');
  const first = errorLog(scope);
  assert.equal(first.items.length, 1);
  assert.equal(first.toastId, first.items[0].id);
  pushError(scope, '열지 못했습니다');
  assert.equal(errorLog(scope).items.length, 1);
  assert.equal(errorLog(scope).toastAt, first.toastAt);
  pushError(scope, '브랜치를 바꾸지 못했습니다');
  assert.deepEqual(errorLog(scope).items.map(item => item.message), ['브랜치를 바꾸지 못했습니다', '열지 못했습니다']);
  for (let i = 0; i < 50; i++) pushError(scope, `e${i}`);
  assert.equal(errorLog(scope).items.length, 40);
  assert.equal(errorLog(scope).items[0].message, 'e49');
  dismissError(scope, errorLog(scope).items[0].id);
  assert.equal(errorLog(scope).items[0].message, 'e48');
  assert.equal(errorLog(scope).toastId, 0);
  clearErrors(scope);
  assert.equal(errorLog(scope).items.length, 0);
  assert.equal(errorText(new Error('끊김')), '끊김');
  assert.equal(errorText(''), '알 수 없는 오류');
  // A fetch that never reached the server is not shown as the browser's bare English text.
  for (const text of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) assert.match(errorText(new TypeError(text)), /서버에 연결할 수 없습니다/);
  assert.equal(errorText(new Error('Failed to fetch')), 'Failed to fetch');
});
