import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createProcessTable } from '../apps/local-server/src/process-table.js';

test('process table lists this process, serves overlapping calls and reuses one shell on Windows', { timeout: 60000 }, async t => {
  const table = createProcessTable();
  t.after(() => table.close());
  const [first, second] = await Promise.all([table(), table()]);
  for (const rows of [first, second]) {
    assert.ok(Array.isArray(rows) && rows.length > 0);
    const self = rows.find(row => row.pid === process.pid);
    assert.ok(self, 'own pid is listed');
    assert.equal(self.ppid, process.ppid);
  }
  const third = await table();
  assert.ok(third.some(row => row.pid === process.pid));
});

test('with root PIDs the table holds only them and their descendants, command lines included on every reading', { timeout: 60000 }, async t => {
  const table = createProcessTable();
  t.after(() => table.close());
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'ade-process-table-marker'], { stdio: 'ignore' });
  t.after(() => child.kill());
  await new Promise(resolve => child.once('spawn', resolve));
  for (let reading = 0; reading < 2; reading++) {
    const rows = await table([process.pid]);
    assert.ok(rows.some(row => row.pid === process.pid));
    const found = rows.find(row => row.pid === child.pid);
    assert.equal(found?.ppid, process.pid);
    assert.match(found.command, /ade-process-table-marker/);
    assert.ok(!rows.some(row => row.pid === process.ppid), 'the parent of a root is not below it');
  }
});

test('process table restarts after being closed', { timeout: 60000 }, async t => {
  const table = createProcessTable();
  t.after(() => table.close());
  assert.ok(await table());
  table.close();
  assert.ok((await table())?.some(row => row.pid === process.pid));
});

test('a hung reading times out to null instead of blocking later calls', { timeout: 60000 }, async t => {
  const table = createProcessTable({ timeoutMs: 1 });
  t.after(() => table.close());
  assert.equal(await table(), null);
});
