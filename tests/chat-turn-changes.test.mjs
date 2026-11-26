import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChatSession } from '../apps/local-server/src/chat.js';
import { createLocalRuntime } from '../apps/local-server/src/runtime.js';
import { commitFile, compareFiles } from '../apps/local-server/src/git-log.js';
import { emptyView, fromReplay, reduce } from '../apps/web/src/chat-model.ts';
import { fileRewindLine, parseTurnRevision, turnDiffSpec } from '../apps/web/src/turn-changes.ts';
import { EMPTY_TREE, workingFiles, workingKey, workingTotals } from '../apps/web/src/working-changes.ts';

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } }).trim();
const until = async (predicate, what = 'condition') => { for (let i = 0; i < 600; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } assert.fail(`timed out waiting for ${what}`); };
async function repo(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ade-turns-')));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(dir, '.gitignore'), 'secret.txt\n');
  await writeFile(path.join(dir, 'a.txt'), 'start\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('a chat records each turn\'s changed files, Rewind puts the files back with the conversation, and the undo returns them', { timeout: 60_000 }, async t => {
  const cwd = await repo(t), data = await mkdtemp(path.join(os.tmpdir(), 'ade-turns-data-'));
  t.after(() => rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const options = { directory: data, id: 'turns', cwd, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-files.mjs', import.meta.url))] };
  let session = await openChatSession(options);
  t.after(() => session.close());
  const stored = kind => session.replay().events.filter(event => event.kind === kind);
  await session.send('write a.txt first edit; write new.txt hello');
  await until(() => stored('turn_changes').length === 1, 'first turn record');
  const first = stored('turn_changes')[0];
  assert.deepEqual(first.files.map(file => [file.path, file.status]), [['a.txt', 'M'], ['new.txt', 'A']]);
  assert.equal(first.add, 2); assert.equal(first.del, 1);
  const answer = session.replay().events.findLast(event => event.kind === 'message');
  assert.equal(first.uuid, answer.uuid);
  await session.send('write a.txt second edit; delete new.txt; write secret.txt ignored');
  await until(() => stored('turn_changes').length === 2, 'second turn record');
  assert.deepEqual(stored('turn_changes')[1].files.map(file => [file.path, file.status]), [['a.txt', 'M'], ['new.txt', 'D']]); // ignored secret.txt is not a change
  // The thread shows the card under each answer, also when the transcript is replayed.
  const view = fromReplay(session.replay()), answers = view.items.filter(item => item.kind === 'assistant');
  assert.deepEqual(answers.map(item => item.changes?.count), [2, 2]);
  // The diff tab reads both sides of a file from the turn's snapshots.
  const spec = turnDiffSpec('turns', first, { path: 'a.txt' }), rev = /^diff:([^:]*):/.exec(spec)[1];
  assert.deepEqual(parseTurnRevision(rev), { chat: 'turns', from: first.from, to: first.to });
  assert.deepEqual(await session.turnFile({ from: first.from, to: first.to, path: 'a.txt' }), { original: 'start\n', modified: 'first edit\n', note: '' });
  // Rewind to the first answer: the dialog's preview, then the conversation and the files.
  const preview = await session.rewindPreview(first.uuid);
  assert.deepEqual({ available: preview.available, restore: preview.restore.sort(), remove: preview.remove }, { available: true, restore: ['a.txt', 'new.txt'], remove: [] });
  const head = git(cwd, 'rev-parse', 'HEAD'), status = git(cwd, 'status', '--porcelain');
  const done = await session.rewind(first.uuid, { files: true });
  assert.deepEqual(done.restored.sort(), ['a.txt', 'new.txt']);
  assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'first edit\n');
  assert.equal(await readFile(path.join(cwd, 'new.txt'), 'utf8'), 'hello\n');
  assert.equal(await readFile(path.join(cwd, 'secret.txt'), 'utf8'), 'ignored\n'); // ignored files are never touched
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), head);
  assert.notEqual(git(cwd, 'status', '--porcelain'), status);
  const rewound = fromReplay(session.replay());
  assert.equal(rewound.items.filter(item => item.kind === 'assistant').length, 1);
  assert.equal(rewound.items.find(item => item.kind === 'assistant').changes.count, 2); // the kept answer keeps its card
  const line = rewound.items.find(item => item.kind === 'file_rewind');
  assert.match(fileRewindLine(line), /파일을 이 시점으로 되돌렸습니다 \(복원 2개\)/);
  assert.ok(rewound.items.some(item => item.kind === 'note' && item.text === '여기까지 되돌렸습니다. 이후 대화는 이어지지 않습니다.'));
  // Undo the file restore: back to the second turn's files; the line loses its undo button.
  const record = stored('file_rewind')[0];
  const undoPreview = await session.undoFileRewind(record.seq, { preview: true });
  assert.equal(undoPreview.available, true);
  await session.undoFileRewind(record.seq);
  assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'second edit\n');
  assert.equal(existsSync(path.join(cwd, 'new.txt')), false);
  const undone = fromReplay(session.replay()).items.filter(item => item.kind === 'file_rewind');
  assert.deepEqual(undone.map(item => [item.undo ?? null, item.undone ?? false]), [[null, true], [record.seq, false]]);
  await assert.rejects(session.undoFileRewind(record.seq), /이미 취소/);
  // Reopened: the same cards and lines come back from the log.
  await session.close();
  session = await openChatSession(options);
  assert.deepEqual(fromReplay(session.replay()).items.filter(item => item.kind === 'assistant').map(item => item.changes?.count), [2]);
  // Forgetting the chat drops its snapshot refs.
  assert.notEqual(git(cwd, 'for-each-ref', 'refs/ade/snap/turns/'), '');
  await session.close({ forget: true });
  assert.equal(git(cwd, 'for-each-ref', 'refs/ade/snap/'), '');
});

test('the thread hangs a turn record on its answer (keeping the chat that made it) and drops one whose answer is gone', () => {
  let view = emptyView();
  view = reduce(view, { kind: 'user', text: 'x', seq: 1 });
  view = reduce(view, { kind: 'message', id: 'm1', uuid: 'u1', blocks: [{ type: 'text', text: 'ok' }], seq: 2 });
  view = reduce(view, { kind: 'turn_changes', chat: 'parent', messageId: 'm1', from: 'a'.repeat(40), to: 'b'.repeat(40), files: [{ path: 'x.ts', status: 'M', add: 1, del: 0 }], count: 1, add: 1, del: 0, seq: 3 });
  const item = view.items.find(entry => entry.kind === 'assistant');
  assert.deepEqual({ chat: item.changes.chat, count: item.changes.count, to: item.changes.to }, { chat: 'parent', count: 1, to: 'b'.repeat(40) });
  // A record for an answer that is not in the view is dropped quietly.
  const same = reduce(view, { kind: 'turn_changes', messageId: 'gone', seq: 4 });
  assert.equal(same.items, view.items);
  // The plain rewind note still says the files stay.
  const rewound = reduce(view, { kind: 'rewind', uuid: 'u1', seq: 5 });
  assert.match(rewound.items.at(-1).text, /에이전트가 이미 바꾼 파일은 그대로입니다/);
});

test('"작업 트리와 Diff" lists files git does not track yet, and a working-tree diff opens against a branch name', async t => {
  const cwd = await repo(t), runtime = createLocalRuntime({ root: cwd });
  await writeFile(path.join(cwd, 'a.txt'), 'changed\n');
  await writeFile(path.join(cwd, 'untracked.txt'), 'new file\n');
  await writeFile(path.join(cwd, 'secret.txt'), 'ignored\n');
  const head = git(cwd, 'rev-parse', 'HEAD');
  const { files } = await compareFiles(runtime, { from: head });
  assert.deepEqual(files.map(file => [file.path, file.status, file.untracked ?? false]), [['a.txt', 'M', false], ['untracked.txt', 'A', true]]);
  assert.deepEqual(await commitFile(runtime, { working: true, parent: 'refs/heads/main', path: 'untracked.txt' }), { original: '', modified: 'new file\n', note: '' });
  // The drawer's list: rows from the compare, line counts from status, specs against HEAD (the empty tree before the first commit).
  const rows = workingFiles(files, [{ path: 'a.txt', status: ' M', added: 1, deleted: 1 }, { path: 'untracked.txt', status: '??', added: 1, deleted: 0 }], head);
  assert.deepEqual(rows.map(row => [row.path, row.spec, row.untracked ?? false]), [['a.txt', `diff:${head}..:a.txt`, false], ['untracked.txt', `diff:${head}..:untracked.txt`, true]]);
  assert.deepEqual(workingTotals(rows), { added: 2, deleted: 1 });
  assert.equal(workingFiles(files, [], null)[0].spec, `diff:${EMPTY_TREE}..:a.txt`);
  assert.notEqual(workingKey([{ path: 'a.txt', status: ' M', added: 1 }], head), workingKey([{ path: 'a.txt', status: ' M', added: 2 }], head));
});
