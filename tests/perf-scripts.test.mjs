import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const node = (args) => execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });

test('perf session status exits 0', () => {
  const out = node(['scripts/perf/session.mjs', 'status']);
  assert.match(out, /perf|없습니다/);
});

test('ps-tree rssKb on self', () => {
  const out = node(['-e', "import { rssKb } from './scripts/perf/ps-tree.mjs'; console.log(rssKb(process.pid)>0?'ok':'bad');"]);
  assert.equal(out.trim(), 'ok');
});