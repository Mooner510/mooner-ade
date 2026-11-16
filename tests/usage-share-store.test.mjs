import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUsageShareStore } from '../apps/local-server/src/usage-share-store.js';

test('usage share store: values survive a restart, bad keys are ignored, null removes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ade-share-store-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const file = path.join(dir, 'usage-share.json');
  const store = createUsageShareStore(file);
  assert.deepEqual(await store.update(undefined), {});
  await store.update({ 'ade:usage-k': { 'max|session': { usd: 3, dUtil: 12 } }, 'ade:usage-share:c1': { cost: 0, readings: {} }, 'other:key': 1, '__proto__x': 2 });
  const again = createUsageShareStore(file), data = await again.update(null);
  assert.deepEqual(data['ade:usage-k'], { 'max|session': { usd: 3, dUtil: 12 } });
  assert.equal(data['other:key'], undefined);
  await again.update({ 'ade:usage-share:c1': null });
  assert.equal(JSON.parse(await readFile(file, 'utf8'))['ade:usage-share:c1'], undefined);
});

test('usage share store: a torn file starts empty instead of failing', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ade-share-store-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const file = path.join(dir, 'usage-share.json');
  await import('node:fs/promises').then(fs => fs.writeFile(file, '{"ade:usage-k":'));
  assert.deepEqual(await createUsageShareStore(file).update({}), {});
});
