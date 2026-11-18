import test from 'node:test';
import assert from 'node:assert/strict';
import { dropOptimistic, mergeOptimistic, optimisticKeys } from '../apps/web/src/chat-optimistic.ts';

// A throw while rendering unmounted the whole app (blank screen): dropping the last plain setting left `options: undefined`.
test('dropping a plain setting leaves no options key, so optimisticKeys keeps working', () => {
  const next = dropOptimistic({ model: 'composer-2' }, ['model']);
  assert.deepEqual(next, {});
  assert.deepEqual(optimisticKeys(next), []);
});

test('dropping option keys removes options once it is empty and keeps the rest', () => {
  const current = mergeOptimistic({ model: 'm' }, { options: { a: '1', b: '2' } });
  assert.deepEqual(optimisticKeys(current), ['model', 'opt:a', 'opt:b']);
  assert.deepEqual(dropOptimistic(current, ['opt:a']), { model: 'm', options: { b: '2' } });
  assert.deepEqual(dropOptimistic(current, ['opt:a', 'opt:b']), { model: 'm' });
});
