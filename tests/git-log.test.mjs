import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalRuntime } from '../apps/local-server/src/runtime.js';
import { commitDetails, commitFile, pathCommits, readLog, runOperation } from '../apps/local-server/src/git-log.js';

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function sh(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
let clock = 1_700_000_000;
async function commit(repo, file, content, message) {
  await writeFile(join(repo, file), content);
  sh(repo, 'add', '.');
  clock += 60;
  spawnSync('git', ['commit', '-q', '-m', message], { cwd: repo, env: { ...process.env, ...ID, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` } });
  return sh(repo, 'rev-parse', 'HEAD');
}
async function repository(t) {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'ade-gitlog-')));
  t.after(() => rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'core.autocrlf', 'false');
  sh(repo, 'config', 'user.name', 't'); sh(repo, 'config', 'user.email', 't@t');
  const base = await commit(repo, 'a.txt', 'one\n', 'base');
  return { repo, base, runtime: createLocalRuntime({ root: repo }) };
}
const op = (runtime, input) => runOperation(runtime, input);

test('log: commits with parents, refs with kinds, HEAD, and an unchanged signature', async t => {
  const { repo, runtime, base } = await repository(t);
  sh(repo, 'switch', '-q', '-c', 'feature');
  const f1 = await commit(repo, 'b.txt', 'feature\n', 'feature work');
  sh(repo, 'switch', '-q', 'main');
  const m1 = await commit(repo, 'a.txt', 'two\n', 'main work');
  sh(repo, 'merge', '-q', '--no-ff', '--no-edit', 'feature');
  sh(repo, 'tag', 'v1', base); sh(repo, 'tag', '-a', 'v2', '-m', 'annotated', m1);
  const log = await readLog(runtime, {});
  assert.equal(log.commits.length, 4);
  const merge = log.commits[0];
  assert.deepEqual(merge.p, [m1, f1]);
  assert.equal(log.head.branch, 'main'); assert.equal(log.head.sha, merge.h);
  const byName = Object.fromEntries(log.refs.map(ref => [ref.name, ref]));
  assert.equal(byName.main.kind, 'local'); assert.equal(byName.main.current, true);
  assert.equal(byName.feature.sha, f1);
  assert.equal(byName.v1.kind, 'tag'); assert.equal(byName.v2.sha, m1, 'an annotated tag points at its commit');
  assert.equal(log.me.email, 't@t');
  assert.equal(log.state.op, null);
  assert.deepEqual(await readLog(runtime, { signature: log.signature }), { unchanged: true, signature: log.signature, state: log.state });
  sh(repo, 'branch', 'other');
  assert.ok(!(await readLog(runtime, { signature: log.signature })).unchanged, 'a new branch changes the signature');
  assert.deepEqual((await pathCommits(runtime, { paths: ['b.txt'] })).hashes, [f1]);
});

test('commit details and file contents', async t => {
  const { repo, runtime, base } = await repository(t);
  const second = await commit(repo, 'a.txt', 'one\nmore\n', 'second\n\nbody line');
  sh(repo, 'mv', 'a.txt', 'c.txt'); clock += 60;
  spawnSync('git', ['commit', '-q', '-m', 'rename'], { cwd: repo, env: { ...process.env, ...ID } });
  const renamed = sh(repo, 'rev-parse', 'HEAD');
  const details = await commitDetails(runtime, { sha: second });
  assert.equal(details.message, 'second\n\nbody line');
  assert.deepEqual(details.parents, [base]);
  assert.deepEqual(details.files, [{ status: 'M', path: 'a.txt' }]);
  assert.deepEqual((await commitDetails(runtime, { sha: renamed })).files, [{ status: 'R', original: 'a.txt', path: 'c.txt' }]);
  assert.deepEqual((await commitDetails(runtime, { sha: base })).files, [{ status: 'A', path: 'a.txt' }], 'a root commit lists its files');
  const file = await commitFile(runtime, { sha: second, path: 'a.txt' });
  assert.equal(file.original, 'one\n'); assert.equal(file.modified, 'one\nmore\n');
  assert.equal((await commitFile(runtime, { sha: renamed, path: 'c.txt', original: 'a.txt' })).original, 'one\nmore\n');
  await assert.rejects(commitDetails(runtime, { sha: '--all' }), /해시/);
});

test('branches: create, checkout, rename, delete with restore, tags', async t => {
  const { repo, runtime, base } = await repository(t);
  await op(runtime, { op: 'branch-create', name: 'topic', from: base, checkout: true });
  assert.equal(sh(repo, 'branch', '--show-current'), 'topic');
  await assert.rejects(op(runtime, { op: 'branch-create', name: 'topic', from: base }), error => error.code === 'BRANCH_EXISTS');
  await assert.rejects(op(runtime, { op: 'branch-create', name: '-x', from: base }), /쓸 수 없습니다/);
  await op(runtime, { op: 'checkout', ref: 'refs/heads/main' });
  await op(runtime, { op: 'branch-rename', from: 'topic', to: 'topic2' });
  sh(repo, 'switch', '-q', 'topic2');
  const extra = await commit(repo, 'x.txt', 'x\n', 'unmerged');
  sh(repo, 'switch', '-q', 'main');
  await assert.rejects(op(runtime, { op: 'branch-delete', name: 'topic2' }), error => error.code === 'NOT_MERGED');
  const deleted = await op(runtime, { op: 'branch-delete', name: 'topic2', force: true });
  assert.deepEqual(deleted.restore, { name: 'topic2', sha: extra });
  await op(runtime, { op: 'branch-restore', ...deleted.restore });
  assert.equal(sh(repo, 'rev-parse', 'topic2'), extra);
  await op(runtime, { op: 'tag-create', name: 'v1.0', sha: extra, message: 'release' });
  assert.equal(sh(repo, 'rev-parse', 'v1.0^{commit}'), extra);
  await op(runtime, { op: 'tag-delete', name: 'v1.0' });
  await op(runtime, { op: 'checkout', ref: extra });
  assert.equal(sh(repo, 'branch', '--show-current'), '', 'a revision checks out detached');
});

test('checkout with local changes in the way: refused, then smart (stash and back) or forced', async t => {
  const { repo, runtime } = await repository(t);
  sh(repo, 'switch', '-q', '-c', 'other');
  await commit(repo, 'a.txt', 'other\n', 'other change');
  sh(repo, 'switch', '-q', 'main');
  await writeFile(join(repo, 'a.txt'), 'local edit\n');
  await assert.rejects(op(runtime, { op: 'checkout', ref: 'refs/heads/other' }), error => error.code === 'LOCAL_CHANGES' && error.files.includes('a.txt'));
  const smart = await op(runtime, { op: 'checkout', ref: 'refs/heads/other', mode: 'smart' });
  assert.equal(sh(repo, 'branch', '--show-current'), 'other');
  assert.ok(smart.warning, 'the stash came back with a conflict');
  sh(repo, 'reset', '-q', '--hard'); sh(repo, 'stash', 'drop', '-q');
  sh(repo, 'switch', '-q', 'main');
  await writeFile(join(repo, 'a.txt'), 'local edit\n');
  await op(runtime, { op: 'checkout', ref: 'refs/heads/other', mode: 'force' });
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'other\n');
});

test('merge with a conflict: resolve one side, continue; abort also works', async t => {
  const { repo, runtime } = await repository(t);
  sh(repo, 'switch', '-q', '-c', 'feature');
  await commit(repo, 'a.txt', 'feature\n', 'feature');
  sh(repo, 'switch', '-q', 'main');
  await commit(repo, 'a.txt', 'main\n', 'main');
  const stopped = await op(runtime, { op: 'merge', ref: 'refs/heads/feature' });
  assert.equal(stopped.stopped, true);
  assert.deepEqual(stopped.state, { op: 'merge', conflicts: ['a.txt'] });
  await assert.rejects(op(runtime, { op: 'continue' }), error => error.code === 'CONFLICTS');
  await op(runtime, { op: 'resolve', path: 'a.txt', side: 'theirs' });
  const finished = await op(runtime, { op: 'continue' });
  assert.equal(finished.state.op, null);
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'feature\n');
  assert.equal(sh(repo, 'rev-list', '--count', '--merges', 'HEAD'), '1');
  sh(repo, 'switch', '-q', '-c', 'feature2', 'HEAD~1');
  await commit(repo, 'a.txt', 'again\n', 'again');
  sh(repo, 'switch', '-q', 'main');
  const before = sh(repo, 'rev-parse', 'HEAD');
  assert.equal((await op(runtime, { op: 'merge', ref: 'refs/heads/feature2' })).stopped, true);
  assert.equal((await op(runtime, { op: 'abort' })).state.op, null);
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), before);
});

test('rebase, cherry-pick, revert, reset, undo', async t => {
  const { repo, runtime } = await repository(t);
  sh(repo, 'switch', '-q', '-c', 'feature');
  const picked = await commit(repo, 'b.txt', 'b\n', 'add b');
  sh(repo, 'switch', '-q', 'main');
  await commit(repo, 'c.txt', 'c\n', 'add c');
  await op(runtime, { op: 'rebase', onto: 'refs/heads/main', branch: 'feature' });
  assert.equal(sh(repo, 'branch', '--show-current'), 'feature');
  assert.equal(sh(repo, 'merge-base', '--is-ancestor', 'main', 'feature') === '', true);
  sh(repo, 'switch', '-q', 'main');
  await op(runtime, { op: 'cherry-pick', shas: [picked] });
  assert.equal(sh(repo, 'log', '-1', '--format=%s'), 'add b');
  await op(runtime, { op: 'revert', shas: [sh(repo, 'rev-parse', 'HEAD')] });
  assert.match(sh(repo, 'log', '-1', '--format=%s'), /^Revert "add b"/);
  const head = sh(repo, 'rev-parse', 'HEAD');
  await op(runtime, { op: 'undo-commit', sha: head });
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), sh(repo, 'rev-parse', `${head}^`));
  assert.match(sh(repo, 'status', '--porcelain'), /^D  b\.txt/, 'the undone commit stays staged');
  await assert.rejects(op(runtime, { op: 'undo-commit', sha: picked }), /마지막 커밋/);
  await op(runtime, { op: 'reset', sha: picked, mode: 'hard' });
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), picked);
  await assert.rejects(op(runtime, { op: 'reset', sha: picked, mode: 'weird' }), /리셋/);
});

test('history edits: reword (HEAD and older), drop, squash, interactive rebase', async t => {
  const { repo, runtime } = await repository(t);
  const c1 = await commit(repo, '1.txt', '1\n', 'one');
  const c2 = await commit(repo, '2.txt', '2\n', 'two');
  const c3 = await commit(repo, '3.txt', '3\n', 'three');
  await op(runtime, { op: 'reword', sha: c3, message: 'three (edited)' });
  assert.equal(sh(repo, 'log', '-1', '--format=%s'), 'three (edited)');
  await op(runtime, { op: 'reword', sha: c1, message: '하나 — 고친 메시지\n\n본문' });
  assert.deepEqual(sh(repo, 'log', '--format=%s', '-4').split('\n'), ['three (edited)', 'two', '하나 — 고친 메시지', 'base']);
  const list = () => sh(repo, 'log', '--format=%H %s').split('\n').map(line => line.split(' '));
  const [[h3], [h2]] = list();
  await op(runtime, { op: 'drop', shas: [h2] });
  assert.deepEqual(sh(repo, 'log', '--format=%s').split('\n'), ['three (edited)', '하나 — 고친 메시지', 'base']);
  const [[n3], [n1]] = list();
  await op(runtime, { op: 'squash', shas: [n3, n1], message: 'squashed' });
  assert.deepEqual(sh(repo, 'log', '--format=%s').split('\n'), ['squashed', 'base']);
  assert.equal(sh(repo, 'ls-tree', '--name-only', 'HEAD').split('\n').sort().join(','), '1.txt,3.txt,a.txt');
  const d1 = await commit(repo, 'd1.txt', '1\n', 'd1');
  const d2 = await commit(repo, 'd2.txt', '2\n', 'd2');
  const d3 = await commit(repo, 'd3.txt', '3\n', 'd3');
  await op(runtime, { op: 'rebase-interactive', base: d1, entries: [{ sha: d2, action: 'pick' }, { sha: d1, action: 'reword', message: 'd1 renamed' }, { sha: d3, action: 'fixup' }] });
  assert.deepEqual(sh(repo, 'log', '--format=%s', '-3').split('\n'), ['d1 renamed', 'd2', 'squashed']);
  const stop = await op(runtime, { op: 'rebase-interactive', base: sh(repo, 'rev-parse', 'HEAD'), entries: [{ sha: sh(repo, 'rev-parse', 'HEAD'), action: 'edit' }] });
  assert.equal(stop.stopped, true); assert.equal(stop.state.op, 'rebase');
  assert.equal((await op(runtime, { op: 'continue' })).state.op, null);
  void c2;
});

test('push and update against a local bare remote', async t => {
  const { repo, runtime } = await repository(t);
  const remote = await realpath(await mkdtemp(join(tmpdir(), 'ade-gitlog-remote-')));
  t.after(() => rm(remote, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  sh(remote, 'init', '-q', '--bare', '-b', 'main');
  sh(repo, 'remote', 'add', 'origin', remote);
  await op(runtime, { op: 'push' });
  assert.equal(sh(repo, 'rev-parse', 'origin/main'), sh(repo, 'rev-parse', 'main'));
  assert.equal(sh(repo, 'rev-parse', '--abbrev-ref', 'main@{upstream}'), 'origin/main');
  const local1 = await commit(repo, 'p.txt', 'p\n', 'p1');
  await commit(repo, 'q.txt', 'q\n', 'p2');
  await op(runtime, { op: 'push', upTo: local1 });
  assert.equal(sh(repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], local1);
  assert.equal((await readLog(runtime, {})).refs.find(ref => ref.name === 'main').ahead, 1, 'one commit is left to push');
  await op(runtime, { op: 'fetch' });
  sh(repo, 'switch', '-q', '-c', 'side', 'origin/main'); sh(repo, 'branch', '-q', '-u', 'origin/main');
  sh(repo, 'switch', '-q', 'main');
  await op(runtime, { op: 'push' });
  await op(runtime, { op: 'update', branch: 'side' });
  assert.equal(sh(repo, 'rev-parse', 'side'), sh(repo, 'rev-parse', 'main'), 'another branch fast-forwards from its upstream');
  await op(runtime, { op: 'remote-branch-delete', ref: 'refs/remotes/origin/main' }).catch(() => {});
});
