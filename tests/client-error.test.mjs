import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientErrorText, createClientErrorLog } from '../apps/local-server/src/client-error.js';

test('client error text keeps the message, stack and component, and drops nulls and excess', () => {
  assert.equal(clientErrorText({}), '화면 렌더링 오류: 알 수 없는 오류');
  assert.equal(clientErrorText({ message: '  끊김\0  ' }), '화면 렌더링 오류: 끊김');
  const text = clientErrorText({ message: 'x'.repeat(800), stack: 'Error: x\n    at Shell', componentStack: '\n    at Shell' });
  assert.equal(text.split('\n')[0].length, '화면 렌더링 오류: '.length + 500);
  assert.match(text, /at Shell/);
  assert.match(text, /컴포넌트:/);
});

test('client error log writes once, skips a repeat, rotates, and ignores an empty report', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ade-client-error-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'client-error.log');
  let clock = 1_000;
  const printed = [];
  const record = createClientErrorLog({ file, now: () => clock, error: line => printed.push(line), maxBytes: 40 });
  assert.deepEqual(await record({}), { logged: false });
  assert.equal(printed.length, 0);
  assert.deepEqual(await record({ message: '그리지 못함', stack: 'Error: 그리지 못함\n    at Row' }), { logged: true });
  assert.match(printed[0], /화면 렌더링 오류: 그리지 못함/);
  assert.match(await readFile(file, 'utf8'), /--- 1970-01-01T00:00:01.000Z\n화면 렌더링 오류: 그리지 못함/);
  assert.deepEqual(await record({ message: '그리지 못함', stack: 'Error: 그리지 못함\n    at Row' }), { logged: false });
  clock += 60_000;
  assert.deepEqual(await record({ message: '그리지 못함', stack: 'Error: 그리지 못함\n    at Row' }), { logged: true });
  const renamed = await readFile(`${file}.old`, 'utf8');
  assert.match(renamed, /그리지 못함/);
  assert.doesNotMatch(await readFile(file, 'utf8'), /1970-01-01T00:00:01/);
});
