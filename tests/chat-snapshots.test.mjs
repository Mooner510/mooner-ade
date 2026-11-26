import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyRestore, createTurnSnapshots, diffSnapshots, restorePlan, skippedOf, SNAP_ROOT, snapshotFile, takeSnapshot } from '../apps/local-server/src/chat-snapshots.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const read = file => readFile(file, 'utf8');
async function repo(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ade-snap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(dir, '.gitignore'), 'ignored.txt\nbuild/\n');
  await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n');
  await writeFile(path.join(dir, 'b.txt'), 'bee\n');
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'keep.js'), 'export const keep = 1;\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
// Everything a snapshot must leave alone: HEAD, branches, the index file and what `git status` reports.
const untouched = async dir => ({ head: git(dir, 'rev-parse', 'HEAD'), branches: git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'), status: git(dir, 'status', '--porcelain=v1', '-uall'), index: await readFile(path.join(dir, '.git', 'index')).then(data => data.toString('base64')) });

test('a folder outside any repository is quietly not a snapshot', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ade-snap-plain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await takeSnapshot(dir);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-git');
});

test('a snapshot captures tracked changes and new files that are not ignored, and leaves HEAD, the index and the working tree alone', async t => {
  const dir = await repo(t);
  await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(path.join(dir, 'new.txt'), 'fresh\n');
  await writeFile(path.join(dir, 'ignored.txt'), 'secret\n');
  await mkdir(path.join(dir, 'build')); await writeFile(path.join(dir, 'build', 'out.js'), 'x\n');
  git(dir, 'add', 'b.txt'); // something staged stays staged
  const before = await untouched(dir);
  const snap = await takeSnapshot(dir, { ref: `${SNAP_ROOT}/t/1` });
  assert.equal(snap.ok, true, snap.message);
  assert.deepEqual(await untouched(dir), before);
  assert.equal(path.resolve(snap.top), path.resolve(dir));
  const files = git(dir, 'ls-tree', '-r', '--name-only', snap.commit).split('\n').sort();
  assert.deepEqual(files, ['.gitignore', 'a.txt', 'b.txt', 'new.txt', 'src/keep.js']);
  assert.equal(git(dir, 'show', `${snap.commit}:a.txt`), 'one\ntwo\nthree');
  assert.equal(git(dir, 'rev-parse', `${SNAP_ROOT}/t/1`), snap.commit);
  assert.equal(git(dir, 'rev-parse', `${snap.commit}^`), before.head); // parent: HEAD
  assert.equal(git(dir, 'branch', '--list').trim(), '* main');
  // The same tree again: the last commit is reused, no new one.
  const again = await takeSnapshot(dir, { reuse: { top: snap.top, tree: snap.tree, commit: snap.commit, skipped: snap.skipped } });
  assert.equal(again.commit, snap.commit);
  assert.equal(again.reused, true);
});

test('diff between two snapshots lists added, modified, deleted and renamed files with line counts', async t => {
  const dir = await repo(t);
  const from = await takeSnapshot(dir);
  await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\n');
  await rm(path.join(dir, 'b.txt'));
  await writeFile(path.join(dir, 'added.txt'), '1\n2\n3\n');
  git(dir, 'mv', 'src/keep.js', 'src/kept.js'); // a rename (staged, so it shows in the index copy too)
  await writeFile(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 5]));
  const to = await takeSnapshot(dir);
  const diff = await diffSnapshots(dir, from.commit, to.commit);
  const byPath = Object.fromEntries(diff.files.map(file => [file.path, file]));
  assert.deepEqual({ status: byPath['a.txt'].status, add: byPath['a.txt'].add, del: byPath['a.txt'].del }, { status: 'M', add: 1, del: 1 });
  assert.equal(byPath['b.txt'].status, 'D');
  assert.deepEqual({ status: byPath['added.txt'].status, add: byPath['added.txt'].add }, { status: 'A', add: 3 });
  assert.deepEqual({ status: byPath['src/kept.js'].status, original: byPath['src/kept.js'].original }, { status: 'R', original: 'src/keep.js' });
  assert.equal(byPath['bin.dat'].binary, true);
  assert.equal(diff.count, 5);
  assert.equal(diff.add, 1 + 3 + 0);
  const sides = await snapshotFile(dir, { from: from.commit, to: to.commit, path: 'a.txt' });
  assert.deepEqual(sides, { original: 'one\ntwo\n', modified: 'one\nTWO\n', note: '' });
  assert.equal((await snapshotFile(dir, { from: from.commit, to: to.commit, path: 'bin.dat' })).note, '바이너리 파일입니다.');
});

test('a file over the size limit is left out, named in the commit, and never touched by a restore', async t => {
  const dir = await repo(t);
  await writeFile(path.join(dir, 'big.bin'), Buffer.alloc(4096, 1));
  const snap = await takeSnapshot(dir, { maxFileBytes: 1024 });
  assert.deepEqual(snap.skipped, ['big.bin']);
  assert.deepEqual(skippedOf(git(dir, 'cat-file', 'commit', snap.commit)), ['big.bin']);
  assert.equal(git(dir, 'ls-tree', '-r', '--name-only', snap.commit).includes('big.bin'), false);
  await writeFile(path.join(dir, 'big.bin'), Buffer.alloc(8192, 2));
  const now = await takeSnapshot(dir, { maxFileBytes: 1024 });
  const plan = await restorePlan(dir, snap.commit, now.commit);
  assert.deepEqual(plan, { restore: [], remove: [], skipped: [] });
  assert.equal((await stat(path.join(dir, 'big.bin'))).size, 8192);
});

test('restore writes back changed and deleted files, removes files created since, and leaves ignored files, .git, HEAD and the index alone', async t => {
  const dir = await repo(t);
  await writeFile(path.join(dir, 'untracked.txt'), 'was here\n');
  const target = await takeSnapshot(dir);
  const head = git(dir, 'rev-parse', 'HEAD'), index = await readFile(path.join(dir, '.git', 'index'));
  // What a turn did afterwards.
  await writeFile(path.join(dir, 'a.txt'), 'changed\n');
  await rm(path.join(dir, 'b.txt'));
  await rm(path.join(dir, 'untracked.txt'));
  await mkdir(path.join(dir, 'made', 'deep'), { recursive: true }); await writeFile(path.join(dir, 'made', 'deep', 'new.js'), 'new\n');
  await writeFile(path.join(dir, 'ignored.txt'), 'local secret\n');
  git(dir, 'mv', 'src/keep.js', 'src/moved.js');
  const index2 = await readFile(path.join(dir, '.git', 'index'));
  const now = await takeSnapshot(dir);
  const plan = await restorePlan(dir, target.commit, now.commit);
  assert.deepEqual(plan.restore.map(item => item.path).sort(), ['a.txt', 'b.txt', 'src/keep.js', 'untracked.txt']);
  assert.deepEqual(plan.remove.sort(), ['made/deep/new.js', 'src/moved.js']);
  const done = await applyRestore(dir, target.commit, plan);
  assert.deepEqual(done.failed, []);
  assert.equal(await read(path.join(dir, 'a.txt')), 'one\ntwo\n');
  assert.equal(await read(path.join(dir, 'b.txt')), 'bee\n');
  assert.equal(await read(path.join(dir, 'untracked.txt')), 'was here\n');
  assert.equal(await read(path.join(dir, 'src', 'keep.js')), 'export const keep = 1;\n');
  assert.equal(existsSync(path.join(dir, 'src', 'moved.js')), false);
  assert.equal(existsSync(path.join(dir, 'made')), false); // emptied folders go too
  assert.equal(await read(path.join(dir, 'ignored.txt')), 'local secret\n');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(await readFile(path.join(dir, '.git', 'index')), index2); // the index (with the staged rename) is the user's: untouched
  assert.notDeepEqual(index2, index);
});

test('a restore refuses paths that leave the repository or enter .git', async t => {
  const dir = await repo(t);
  const target = await takeSnapshot(dir);
  const done = await applyRestore(dir, target.commit, { restore: [{ path: '../escape.txt', mode: '100644' }, { path: '.git/config', mode: '100644' }], remove: ['.git/HEAD'], skipped: [] });
  assert.equal(done.failed.length, 3);
  assert.equal(existsSync(path.join(dir, '.git', 'HEAD')), true);
  assert.equal(existsSync(path.join(path.dirname(dir), 'escape.txt')), false);
});

test('a snapshot that runs out of time is skipped with the reason', async t => {
  const dir = await repo(t);
  const result = await takeSnapshot(dir, { timeoutMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('turn snapshots: a card per turn, a file rewind to the end of a turn, and undoing it', async t => {
  const dir = await repo(t);
  const events = [];
  let seq = 0;
  const emit = event => events.push({ ...event, seq: ++seq });
  const snaps = createTurnSnapshots({ chatId: 'chat-1', folder: () => dir, emit, events: () => events });
  // Turn 1 edits a.txt (as Bash would: no tool card needed).
  snaps.turnStarted(); await snaps.idle(); // a real turn takes seconds before its first edit
  await writeFile(path.join(dir, 'a.txt'), 'turn one\n');
  await snaps.turnEnded({ uuid: 'u1', messageId: 'm1' });
  const first = events.at(-1);
  assert.equal(first.kind, 'turn_changes');
  assert.deepEqual(first.files.map(file => [file.path, file.status]), [['a.txt', 'M']]);
  assert.equal(first.uuid, 'u1'); assert.equal(first.chat, 'chat-1');
  // Turn 2 changes nothing: still a record (Rewind needs its end snapshot), with no files.
  snaps.turnStarted(); await snaps.turnEnded({ uuid: 'u2', messageId: 'm2' });
  assert.equal(events.at(-1).files, undefined);
  assert.equal(events.at(-1).from, events.at(-1).to);
  // Turn 3: a new file, a deletion and an edit.
  snaps.turnStarted(); await snaps.idle(); // a real turn takes seconds before its first edit
  await writeFile(path.join(dir, 'later.txt'), 'later\n'); await rm(path.join(dir, 'b.txt')); await writeFile(path.join(dir, 'a.txt'), 'turn three\n');
  await snaps.turnEnded({ uuid: 'u3', messageId: 'm3' });
  assert.equal(events.at(-1).count, 3);
  const preview = await snaps.preview({ uuid: 'u1' });
  assert.equal(preview.available, true);
  assert.deepEqual(preview.restore.sort(), ['a.txt', 'b.txt']);
  assert.deepEqual(preview.remove, ['later.txt']);
  const done = await snaps.rewindFiles({ messageId: 'm1' });
  emit({ kind: 'file_rewind', uuid: 'u1', ...done });
  assert.equal(await read(path.join(dir, 'a.txt')), 'turn one\n');
  assert.equal(await read(path.join(dir, 'b.txt')), 'bee\n');
  assert.equal(existsSync(path.join(dir, 'later.txt')), false);
  assert.equal(done.failedCount, 0);
  assert.ok(git(dir, 'for-each-ref', '--format=%(refname)', `${SNAP_ROOT}/chat-1/`).includes('/undo-'));
  // Undo puts back what was there before the rewind.
  const record = events.at(-1);
  const undoPreview = await snaps.undoPreview(record.seq);
  assert.deepEqual(undoPreview.restore.sort(), ['a.txt', 'later.txt']);
  const undone = await snaps.undo(record.seq);
  emit({ kind: 'file_rewind', undo: record.seq, ...undone });
  assert.equal(await read(path.join(dir, 'a.txt')), 'turn three\n');
  assert.equal(await read(path.join(dir, 'later.txt')), 'later\n');
  assert.equal(existsSync(path.join(dir, 'b.txt')), false);
  await assert.rejects(snaps.undo(record.seq), /이미 취소/);
  // The card's diff tab reads both sides from the snapshots.
  const third = events.find(event => event.kind === 'turn_changes' && event.uuid === 'u3');
  assert.deepEqual(await snaps.file({ from: third.from, to: third.to, path: 'a.txt' }), { original: 'turn one\n', modified: 'turn three\n', note: '' });
  // Forgetting the chat removes its refs; the repository's own refs stay.
  await snaps.forget();
  assert.equal(git(dir, 'for-each-ref', '--format=%(refname)', `${SNAP_ROOT}/`), '');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('turn snapshots keep only the newest refs of a chat, and its records stay', async t => {
  const dir = await repo(t);
  const events = [];
  const snaps = createTurnSnapshots({ chatId: 'c', folder: () => dir, emit: event => events.push(event), events: () => events, options: { keep: 3 } });
  for (let turn = 0; turn < 5; turn++) {
    snaps.turnStarted(); await snaps.idle(); await writeFile(path.join(dir, 'a.txt'), `turn ${turn}\n`); await snaps.turnEnded({ uuid: `u${turn}` });
  }
  await new Promise(resolve => setTimeout(resolve, 300)); // pruning runs after each snapshot, off the turn's path
  await snaps.idle();
  const refs = git(dir, 'for-each-ref', '--format=%(refname)', `${SNAP_ROOT}/c/`).split('\n').filter(Boolean);
  assert.equal(refs.length, 3);
  assert.equal(events.filter(event => event.kind === 'turn_changes').length, 5);
  const oldest = events[0];
  const preview = await snaps.preview({ uuid: oldest.uuid });
  // Its commit may still exist until git gc; either way the preview answers instead of failing.
  assert.equal(typeof preview.available, 'boolean');
});

test('a folder that is not a repository gives no records and no rewind', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ade-snap-plain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const events = [];
  const snaps = createTurnSnapshots({ chatId: 'p', folder: () => dir, emit: event => events.push(event), events: () => events });
  snaps.turnStarted(); await writeFile(path.join(dir, 'x.txt'), 'x'); await snaps.turnEnded({ uuid: 'u' });
  assert.deepEqual(events, []);
  assert.deepEqual(await snaps.preview({ uuid: 'u' }), { available: false, reason: '이 지점에는 파일 기록이 없습니다.' });
});

test('records another chat made (a Branch\'s copies) are never restored from', async t => {
  const dir = await repo(t);
  const snap = await takeSnapshot(dir);
  const events = [{ kind: 'turn_changes', chat: 'parent', uuid: 'u1', top: dir, to: snap.commit, seq: 1 }];
  const snaps = createTurnSnapshots({ chatId: 'branch', folder: () => dir, emit: event => events.push(event), events: () => events });
  assert.equal((await snaps.preview({ uuid: 'u1' })).available, false);
  await assert.rejects(snaps.rewindFiles({ uuid: 'u1' }), /파일 기록이 없습니다/);
});

test('with core.autocrlf a restored file gets the line endings a checkout would give it', async t => {
  const dir = await repo(t);
  git(dir, 'config', 'core.autocrlf', 'true');
  await writeFile(path.join(dir, 'crlf.txt'), 'one\r\ntwo\r\n');
  const target = await takeSnapshot(dir);
  assert.equal(git(dir, 'cat-file', '-p', `${target.commit}:crlf.txt`), 'one\ntwo'); // stored normalized, as git add would
  await writeFile(path.join(dir, 'crlf.txt'), 'changed\r\n');
  const now = await takeSnapshot(dir);
  const done = await applyRestore(dir, target.commit, await restorePlan(dir, target.commit, now.commit));
  assert.deepEqual(done.restored, ['crlf.txt']);
  assert.equal(await read(path.join(dir, 'crlf.txt')), 'one\r\ntwo\r\n');
});

test('a repository\'s own filter commands do not run during a snapshot (as for every git call ADE makes)', async t => {
  const dir = await repo(t);
  await writeFile(path.join(dir, '.gitattributes'), '*.cfg filter=rewrite\n');
  git(dir, 'config', 'filter.rewrite.clean', 'sed s/secret/REPLACED/');
  await writeFile(path.join(dir, 'app.cfg'), 'secret\n');
  const snap = await takeSnapshot(dir);
  assert.equal(snap.ok, true, snap.message);
  assert.equal(git(dir, 'cat-file', '-p', `${snap.commit}:app.cfg`), 'secret');
});

test('a folder whose snapshot ran out of time is recorded once, then left alone for a while', async t => {
  const dir = await repo(t);
  const events = [];
  const snaps = createTurnSnapshots({ chatId: 'slow', folder: () => dir, emit: event => events.push(event), events: () => events, options: { timeoutMs: 1 } });
  snaps.turnStarted(); await snaps.turnEnded({ uuid: 'u1' });
  assert.deepEqual(events.map(event => [event.kind, event.failed]), [['turn_changes', 'timeout']]);
  snaps.turnStarted(); await snaps.turnEnded({ uuid: 'u2' });
  assert.equal(events.length, 1);
});
