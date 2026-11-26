import test from 'node:test';
import assert from 'node:assert/strict';
import { absolutePath, changedRanges, copyIsReference, copyRecord, fence, formatForChat, gitCommandFor, hashText, joinDraft, joinPath, mention, pasteReference, pickTarget, rangeLabel, relativeTo, selectionLines, shorten, unifiedPatch, COPY_RECORD_MS, PATCH_LINES } from '../apps/web/src/chat-send.ts';

const roots = { project: 'C:\\work\\app', repo: 'C:/work' };

test('paths: joined with forward slashes, relative inside the chat folder, absolute outside it', () => {
  assert.equal(joinPath('C:\\work\\app', 'src/a.ts'), 'C:/work/app/src/a.ts');
  assert.equal(joinPath('/home/u/app/', '../lib/./b.ts'), '/home/u/lib/b.ts');
  assert.equal(joinPath('/home/u/app', '/etc/hosts'), '/etc/hosts');
  assert.equal(relativeTo('C:\\work\\app', 'C:/work/app/src/a.ts'), 'src/a.ts');
  assert.equal(relativeTo('c:/WORK/app/', 'C:\\work\\App\\src\\a.ts'), 'src/a.ts', 'Windows paths compare without case');
  assert.equal(relativeTo('/home/u/app', '/home/u/App/a.ts'), '/home/u/App/a.ts', 'POSIX paths keep their case');
  assert.equal(relativeTo('C:/work/app', 'C:/work/app'), '.');
  assert.equal(relativeTo('C:/work/app', 'C:/work/application/a.ts'), 'C:/work/application/a.ts', 'a sibling with the same prefix is outside');
  assert.equal(relativeTo('C:/work/app/worktrees/chat-1', 'C:/work/app/src/a.ts'), 'C:/work/app/src/a.ts', 'a chat in a worktree gets the absolute path');
  assert.equal(absolutePath({ path: 'app/src/a.ts', base: 'repo' }, roots), 'C:/work/app/src/a.ts');
  assert.equal(absolutePath({ path: 'src/a.ts', base: 'repo' }, { project: '/p' }), '/p/src/a.ts', 'no repository: the project root');
});

test('mentions: line ranges after #, folders with a slash, quotes around spaces', () => {
  assert.equal(rangeLabel({ start: 4, end: 4 }), '4');
  assert.equal(mention('src/a.ts', { range: { start: 10, end: 20 } }), '@src/a.ts#10-20');
  assert.equal(mention('src', { folder: true }), '@src/');
  assert.equal(mention('my docs/a b.md', { range: { start: 3, end: 3 } }), '@"my docs/a b.md"#3');
});

test('fence is longer than any backtick run inside', () => {
  assert.equal(fence('a\n', 'sh'), '```sh\na\n```');
  assert.equal(fence('x ```` y'), '`````\nx ```` y\n`````');
});

test('shorten keeps both ends of long output and says how much was cut', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
  const { text, omitted } = shorten(lines);
  assert.equal(omitted, 620);
  assert.match(text, /^line 1\n/);
  assert.match(text, /… \(620줄 생략\) …/);
  assert.match(text, /line 1000$/);
  assert.deepEqual(shorten('short\r\n'), { text: 'short', omitted: 0 });
  const wide = shorten('x'.repeat(100_000), { maxChars: 1000 });
  assert.ok(wide.text.length < 1100 && /자 생략/.test(wide.text));
});

test('formatForChat: editor selection and files are references relative to the chat', () => {
  assert.equal(formatForChat({ kind: 'file', file: { path: 'src/a.ts', base: 'project' }, range: { start: 2, end: 9 } }, roots, 'C:/work/app'), '@src/a.ts#2-9');
  assert.equal(formatForChat({ kind: 'file', file: { path: 'src/a.ts', base: 'project' } }, roots, 'C:/work/app/src'), '@a.ts');
  assert.equal(formatForChat({ kind: 'paths', paths: [{ path: 'src', base: 'project', folder: true }, { path: 'README.md', base: 'project' }] }, roots, 'C:/work/app'), '@src/ @README.md');
});

test('formatForChat: terminal text goes in a labelled fence', () => {
  assert.equal(formatForChat({ kind: 'text', text: 'npm ERR! x\n', label: '터미널 출력 (pwsh)' }, roots, 'C:/work/app'), '터미널 출력 (pwsh):\n```\nnpm ERR! x\n```');
});

test('formatForChat: diffs as a patch, a selection, or by location when large', () => {
  const file = { path: 'app/src/a.ts', base: 'repo' };
  const small = { kind: 'diff', file, rev: 'abcdef1234567', patch: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b', ranges: [{ start: 1, end: 1 }] };
  assert.equal(formatForChat(small, roots, 'C:/work/app'), '@src/a.ts의 변경 (커밋 abcdef1):\n```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n```');
  const large = { ...small, patch: Array.from({ length: PATCH_LINES + 5 }, () => '+x').join('\n'), ranges: [{ start: 3, end: 8 }, { start: 40, end: 40 }] };
  const named = formatForChat(large, roots, 'C:/work/app');
  assert.match(named, /^@src\/a\.ts의 변경 \(커밋 abcdef1, 305줄이라 패치 대신 위치만\)\. 바뀐 줄\(변경 후 기준\): 3-8, 40\. 전체는 `git show abcdef123456 -- app\/src\/a\.ts`로 볼 수 있습니다\.$/);
  const picked = { ...small, selection: { text: 'const b = 1;', range: { start: 5, end: 5 }, side: 'original' } };
  assert.equal(formatForChat(picked, roots, 'C:/work/app'), '@src/a.ts (커밋 abcdef1, 변경 전, 5행):\n```ts\nconst b = 1;\n```');
  const working = { ...picked, rev: 'abc..', selection: { ...picked.selection, side: 'modified' } };
  assert.equal(formatForChat(working, roots, 'C:/work/app'), '@src/a.ts#5', 'the working tree side is the file itself');
  const edit = { kind: 'diff', file: { path: 'C:/work/app/src/a.ts', base: 'abs' }, patch: '-a\n+b', ranges: [] };
  assert.match(formatForChat(edit, roots, 'C:/work/app'), /^@src\/a\.ts의 변경 \(에이전트가 수정한 부분\):/);
  const editPick = { ...edit, selection: { text: 'x', range: { start: 2, end: 3 }, side: 'modified' } };
  assert.equal(formatForChat(editPick, roots, 'C:/work/app'), '@src/a.ts (에이전트가 수정한 부분, 변경 후):\n```ts\nx\n```', 'snippet line numbers are not the file\'s');
});

test('formatForChat: commits with a short patch, or named by git show', () => {
  const one = { kind: 'commits', commits: [{ sha: '0123456789abcdef', subject: 'fix: 버그' }], patch: 'diff --git a/x b/x' };
  assert.equal(formatForChat(one, roots, '/'), '커밋 0123456 fix: 버그\n```diff\ndiff --git a/x b/x\n```');
  const many = { kind: 'commits', commits: [{ sha: 'aaaaaaaaaaaaaaaa', subject: 'a' }, { sha: 'bbbbbbbbbbbbbbbb', subject: 'b' }] };
  assert.equal(formatForChat(many, roots, '/'), '커밋 2개:\n- aaaaaaa a\n- bbbbbbb b\n(패치가 길어 생략, `git show aaaaaaaaaaaa bbbbbbbbbbbb`로 볼 수 있습니다.)');
});

test('git commands for each diff tab kind', () => {
  assert.equal(gitCommandFor('abc', 'a.ts'), 'git show abc -- a.ts');
  assert.equal(gitCommandFor('a1..b2', 'my file.ts'), 'git diff a1 b2 -- "my file.ts"');
  assert.equal(gitCommandFor('a1..', 'x'), 'git diff a1 -- x');
});

test('joinDraft appends: a reference with a space, a block as its own paragraph', () => {
  assert.equal(joinDraft('', '@a.ts'), '@a.ts ');
  assert.equal(joinDraft('  \n', '@a.ts'), '@a.ts ');
  assert.equal(joinDraft('봐 줘', '@a.ts#1-2'), '봐 줘 @a.ts#1-2 ');
  assert.equal(joinDraft('봐 줘 ', '@a.ts'), '봐 줘 @a.ts ');
  assert.equal(joinDraft('이 출력\n', 'x:\n```\ny\n```'), '이 출력\n\nx:\n```\ny\n```\n');
});

test('unifiedPatch builds hunks with context from Monaco line changes', () => {
  const a = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n', b = 'l1\nl2\nL3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\n';
  const changes = [
    { originalStartLineNumber: 3, originalEndLineNumber: 3, modifiedStartLineNumber: 3, modifiedEndLineNumber: 3 },
    { originalStartLineNumber: 10, originalEndLineNumber: 0, modifiedStartLineNumber: 11, modifiedEndLineNumber: 11 }
  ];
  assert.equal(unifiedPatch('src\\x.txt', a, b, changes, 1), [
    '--- a/src/x.txt', '+++ b/src/x.txt',
    '@@ -2,3 +2,3 @@', ' l2', '-l3', '+L3', ' l4',
    '@@ -10,1 +10,2 @@', ' l10', '+l11'
  ].join('\n'));
  // Close changes share one hunk.
  assert.equal(unifiedPatch('x', a, b, changes, 4).split('\n').filter(line => line.startsWith('@@')).length, 1);
  // A deletion at the top: the old side starts at line 1, the new side is empty there.
  assert.equal(unifiedPatch('x', 'a\nb\n', 'b\n', [{ originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 }], 0), '--- a/x\n+++ b/x\n@@ -1,1 +0,0 @@\n-a');
  assert.equal(unifiedPatch('x', 'same', 'same', []), '');
  assert.deepEqual(changedRanges(changes), [{ start: 3, end: 3 }, { start: 11, end: 11 }]);
});

test('pickTarget: the focused chat, else the last focused one in this tab, else in the project', () => {
  const chats = [{ id: 'c1', tabId: 't1', focusedAt: 50 }, { id: 'c2', tabId: 't2', focusedAt: 90 }, { id: 'c3', tabId: 't2', focusedAt: 10 }];
  assert.equal(pickTarget(chats, 't2', 'c3')?.id, 'c3');
  assert.equal(pickTarget(chats, 't2', 'editor')?.id, 'c2');
  assert.equal(pickTarget(chats, 't1', 'c2')?.id, 'c1', 'a focus id from another tab does not count');
  assert.equal(pickTarget(chats, 't9', '')?.id, 'c2');
  assert.equal(pickTarget([{ id: 'a', tabId: 't', focusedAt: 0 }, { id: 'b', tabId: 't', focusedAt: 0 }], 't', '')?.id, 'a', 'ties go to the first in order');
  assert.equal(pickTarget([], 't', ''), null);
});

test('paste reference: only the same text, copied lately, and lines rather than words', () => {
  const ref = { kind: 'file', file: { path: 'src/a.ts', base: 'project' }, range: { start: 1, end: 2 } };
  const record = copyRecord('a\r\nb\r\n', ref, 1000);
  assert.equal(hashText('a\nb'), record.hash, 'line endings and the last newline do not matter');
  assert.equal(pasteReference(record, 'a\nb\n', 2000), ref);
  assert.equal(pasteReference(record, 'a\nc', 2000), null, 'the clipboard changed');
  assert.equal(pasteReference(record, 'a\nb', 1000 + COPY_RECORD_MS + 1), null, 'too old');
  assert.equal(pasteReference(null, 'a', 0), null);
  assert.equal(pasteReference(record, '', 2000), null);
  assert.equal(copyIsReference('fooBar', false), false);
  assert.equal(copyIsReference('const x = 1;\n', true), true, 'a whole line copied with no selection');
  assert.equal(copyIsReference('a\nb', false), true);
});

test('selectionLines leaves out a line the selection only touches at its start', () => {
  assert.deepEqual(selectionLines({ startLineNumber: 10, startColumn: 1, endLineNumber: 13, endColumn: 1 }), { start: 10, end: 12 });
  assert.deepEqual(selectionLines({ startLineNumber: 10, startColumn: 4, endLineNumber: 13, endColumn: 2 }), { start: 10, end: 13 });
  assert.deepEqual(selectionLines({ startLineNumber: 7, startColumn: 1, endLineNumber: 7, endColumn: 1 }), { start: 7, end: 7 });
});
