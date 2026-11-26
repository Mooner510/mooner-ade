import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSides } from '../apps/web/src/diff-sides.ts';
import { unifiedPatch } from '../apps/web/src/chat-send.ts';

test('a new or deleted file is shown as its lines only: no blank line for the empty side and no extra line for the final newline', () => {
  assert.deepEqual(diffSides('', 'new\n'), { original: '', modified: 'new', whole: 'added' });
  assert.deepEqual(diffSides('', 'a\r\nb\r\n'), { original: '', modified: 'a\r\nb', whole: 'added' });
  assert.deepEqual(diffSides('', 'no newline'), { original: '', modified: 'no newline', whole: 'added' });
  assert.deepEqual(diffSides('', '\n'), { original: '', modified: '\n', whole: 'added' }, 'a file that is one empty line still shows as a change');
  assert.deepEqual(diffSides('gone\n', ''), { original: 'gone', modified: '', whole: 'removed' });
  assert.deepEqual(diffSides('a\n', 'b\n'), { original: 'a\n', modified: 'b\n', whole: null }, 'a changed file keeps both sides as they are');
  assert.deepEqual(diffSides('', ''), { original: '', modified: '', whole: null });
});

test('the patch of a new or deleted file has only its own lines (Monaco names the empty side as one line)', () => {
  // Monaco's change for '' -> 'new\na': original line 1 (the empty model's only line) replaced by modified lines 1-2.
  assert.equal(unifiedPatch('n.txt', '', 'new\na\n', [{ originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 1, modifiedEndLineNumber: 3 }], 3),
    '--- a/n.txt\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+new\n+a');
  assert.equal(unifiedPatch('g.txt', 'gone\n', '', [{ originalStartLineNumber: 1, originalEndLineNumber: 2, modifiedStartLineNumber: 1, modifiedEndLineNumber: 1 }], 3),
    '--- a/g.txt\n+++ b/g.txt\n@@ -1,1 +0,0 @@\n-gone');
});
