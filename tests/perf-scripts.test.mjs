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

// ps-tree.mjs reads `ps -o rss=` and is documented for macOS/Linux only; Windows has no such ps (Git Bash's ps rejects -o).
test('ps-tree rssKb on self', { skip: process.platform === 'win32' && 'ps-tree reads RSS from POSIX ps' }, () => {
  const out = node(['-e', "import { rssKb } from './scripts/perf/ps-tree.mjs'; console.log(rssKb(process.pid)>0?'ok':'bad');"]);
  assert.equal(out.trim(), 'ok');
});