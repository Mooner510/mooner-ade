import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTreeStatus } from '../apps/local-server/src/tree-git.js';

const porcelain = (...entries) => `${entries.join('\0')}\0`;

test('tree git colours: each status maps to a state and folders above a change hold it', () => {
  const states = parseTreeStatus(porcelain(
    ' M src/app.js', 'M  src/staged.js', 'A  src/new.js', 'AM src/new-edited.js', '?? notes.txt', '?? scratch/', '!! node_modules/', '!! dist/out.js',
    'R  src/renamed.js', 'src/old.js'
  ).replace('## main\0', ''));
  assert.equal(states['src/app.js'], 'modified');
  assert.equal(states['src/staged.js'], 'modified');
  assert.equal(states['src/new.js'], 'added');
  assert.equal(states['src/new-edited.js'], 'added');
  assert.equal(states['src/renamed.js'], 'modified');
  assert.equal(states['src/old.js'], undefined, 'the source of a rename is not listed');
  assert.equal(states['notes.txt'], 'untracked');
  assert.equal(states['scratch/'], 'untracked', 'a whole new folder is one entry covering what is under it');
  assert.equal(states['node_modules/'], 'ignored');
  assert.equal(states['dist/out.js'], 'ignored');
  assert.equal(states.src, 'modified', 'a folder holding changes');
  assert.equal(states['.'], 'modified');
  assert.equal(states.dist, undefined, 'an ignored file does not make its folder look changed');
  assert.equal(states.node_modules, undefined);
});

test('tree git colours: a project folder below the repository root only sees its own paths', () => {
  const states = parseTreeStatus(porcelain(' M apps/web/a.ts', '?? apps/web/b/', ' M apps/other/c.ts', '!! apps/web/dist/'), 'apps/web/');
  assert.deepEqual(states, { 'a.ts': 'modified', 'b/': 'untracked', 'dist/': 'ignored', '.': 'modified' });
});

test('tree git colours: a clean repository has no states', () => {
  assert.deepEqual(parseTreeStatus(''), {});
});
