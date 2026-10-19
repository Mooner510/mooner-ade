import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { watchProjectFiles } from '../apps/local-server/src/project-watch.js';

function fakeWatch(t) {
  const watcher = new EventEmitter();
  let changed, closes = 0;
  watcher.close = () => { closes++; };
  t.mock.method(fs, 'watch', (_root, options, callback) => {
    assert.equal(options.recursive, true);
    changed = callback;
    return watcher;
  });
  t.mock.method(console, 'warn', () => {});
  return { watcher, change: name => changed('change', name), closes: () => closes };
}

test('project watcher batches bounded paths, ignores generated folders and continues after a flush', async t => {
  const fake = fakeWatch(t), batches = [];
  const handle = watchProjectFiles('/project', paths => batches.push(paths));
  t.after(() => handle.close());
  for (const name of ['node_modules/a', 'nested/.git/index', 'dist/a', '.idea/a', null]) fake.change(name);
  for (let i = 0; i < 250; i++) fake.change(`src/${i}.js`);
  fake.change('src/0.js');
  await delay(180);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 200);
  assert.equal(batches[0][0], 'src/0.js');
  fake.change('next.js');
  await delay(180);
  assert.deepEqual(batches[1], ['next.js']);
});

test('asynchronous watcher errors close once and cancel pending and late notifications', async t => {
  const fake = fakeWatch(t), batches = [];
  const handle = watchProjectFiles('/project', paths => batches.push(paths));
  fake.change('pending.js');
  assert.doesNotThrow(() => fake.watcher.emit('error', Object.assign(new Error('limit'), { code: 'EMFILE' })));
  fake.change('late.js');
  handle.close();
  await delay(180);
  assert.equal(fake.closes(), 1);
  assert.deepEqual(batches, []);
  assert.match(console.warn.mock.calls[0].arguments[0], /EMFILE/);
});

test('unsupported recursive watching falls back without throwing', t => {
  t.mock.method(fs, 'watch', () => { throw Object.assign(new Error('unsupported'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' }); });
  t.mock.method(console, 'warn', () => {});
  const handle = watchProjectFiles('/project', () => assert.fail('unexpected event'));
  assert.doesNotThrow(() => handle.close());
  assert.equal(console.warn.mock.calls.length, 1);
});

test('normal project close cancels pending notifications and ignores late events', async t => {
  const fake = fakeWatch(t), batches = [];
  const handle = watchProjectFiles('/project', paths => batches.push(paths));
  fake.change('pending.js'); handle.close(); handle.close(); fake.change('late.js');
  await delay(180);
  assert.equal(fake.closes(), 1);
  assert.deepEqual(batches, []);
});
