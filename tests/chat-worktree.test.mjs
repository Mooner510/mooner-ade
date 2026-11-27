import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { branchCandidates, commitWorktree, conflictPrompt, createChatWorktree, detectWorktree, integrateBranches, listChatWorktrees, mergePreview, mergeWorktree, moveClaudeSession, moveNote, readOwnWorktree, removeWorktree, samePath, worktreeDiff, worktreeStatus, writeOwnWorktree } from '../apps/local-server/src/chat-worktree.js';

const run = promisify(execFile);
const git = (cwd, ...args) => run('git', args, { cwd }).then(result => result.stdout.trim());
const exists = file => stat(file).then(() => true, () => false);

async function repo(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ade-wt-'))); // macOS: /var is /private/var
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const origin = path.join(root, 'repo'), data = path.join(root, 'data');
  await mkdir(path.join(origin, 'src'), { recursive: true }); await mkdir(data);
  await git(origin, 'init', '-q', '-b', 'main');
  await git(origin, 'config', 'user.name', 'test'); await git(origin, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(origin, 'a.txt'), 'one\n'); await writeFile(path.join(origin, 'src', 'b.txt'), 'b\n');
  await git(origin, 'add', '-A'); await git(origin, 'commit', '-q', '-m', 'init');
  return { root, origin: await realpath(origin), data };
}
const realpath = async file => (await import('node:fs/promises')).realpath(file);

test('a chat worktree lives in the data folder on its own branch, from the commit the chat was on, in the same subfolder', async t => {
  const { origin, data } = await repo(t);
  const info = await createChatWorktree({ directory: data, id: 'abcdef12-3456-7890-abcd-ef1234567890', cwd: path.join(origin, 'src') });
  assert.equal(info.branch, 'ade/chat-abcdef12');
  assert.ok(samePath(path.dirname(info.path), path.join(data, 'worktrees')));
  assert.ok(samePath(info.cwd, path.join(info.path, 'src')));
  assert.equal(info.base, await git(origin, 'rev-parse', 'HEAD'));
  assert.equal(info.baseBranch, 'main');
  assert.ok(samePath(info.origin, origin));
  // The origin's checkout is untouched (no nested folder, nothing to ignore).
  assert.equal(await git(origin, 'status', '--porcelain'), '');
  const found = await detectWorktree(info.cwd);
  assert.equal(found.branch, 'ade/chat-abcdef12'); assert.equal(found.kind, 'ade'); assert.ok(samePath(found.origin, origin)); assert.ok(samePath(found.path, info.path));
  assert.equal(await detectWorktree(origin), null, 'the main checkout is not a worktree of its own');
  // The short branch is taken: the next chat with the same prefix gets the full id.
  const second = await createChatWorktree({ directory: data, id: 'abcdef12-ffff-7890-abcd-ef1234567890', cwd: origin });
  assert.equal(second.branch, branchCandidates('abcdef12-ffff-7890-abcd-ef1234567890')[1]);
  await assert.rejects(createChatWorktree({ directory: data, id: 'x', cwd: data }), { code: 'NOT_A_REPOSITORY' });
});

test('status, commit and a fast-forward merge back into the origin branch', async t => {
  const { origin, data } = await repo(t);
  const info = await createChatWorktree({ directory: data, id: 'ff000001', cwd: origin });
  let status = await worktreeStatus(info);
  assert.deepEqual([status.ahead, status.behind, status.dirty, status.merged, status.originBranch], [0, 0, 0, false, 'main']);
  await writeFile(path.join(info.path, 'a.txt'), 'one\ntwo\n'); await writeFile(path.join(info.path, 'new.txt'), 'new\n');
  status = await worktreeStatus(info);
  assert.equal(status.dirty, 2);
  await assert.rejects(mergeWorktree(info), { code: 'WORKTREE_DIRTY' });
  await assert.rejects(commitWorktree(info, '  '), { code: 'INVALID_INPUT' });
  const commit = await commitWorktree(info, '채팅 작업: 줄 추가');
  assert.equal(commit.committed, true);
  assert.deepEqual(await commitWorktree(info, 'again'), { committed: false });
  const preview = await mergePreview(info);
  assert.equal(preview.fastForward, true); assert.equal(preview.commits.length, 1); assert.equal(preview.commits[0].subject, '채팅 작업: 줄 추가');
  assert.deepEqual(preview.changes.map(change => change.path).sort(), ['a.txt', 'new.txt']);
  const merged = await mergeWorktree(info);
  assert.equal(merged.merged, true); assert.equal(merged.fastForward, true); assert.equal(merged.into, 'main');
  assert.equal(await git(origin, 'rev-parse', 'HEAD'), commit.commit);
  assert.equal((await readFile(path.join(origin, 'a.txt'), 'utf8')).replace(/\r/g, ''), 'one\ntwo\n');
  status = await worktreeStatus(info);
  assert.equal(status.ahead, 0); assert.equal(status.merged, true);
  assert.deepEqual((await mergeWorktree(info)).reason, 'nothing');
});

test('a diverged origin gets a merge commit (never squash or rebase); the worktree branch keeps its own commits', async t => {
  const { origin, data } = await repo(t);
  const info = await createChatWorktree({ directory: data, id: 'mm000001', cwd: origin });
  await writeFile(path.join(info.path, 'wt.txt'), 'w\n'); await commitWorktree(info, 'worktree change');
  await writeFile(path.join(origin, 'main.txt'), 'm\n'); await git(origin, 'add', '-A'); await git(origin, 'commit', '-q', '-m', 'main change');
  const preview = await mergePreview(info);
  assert.equal(preview.fastForward, false); assert.deepEqual(preview.conflicts, []);
  const merged = await mergeWorktree(info);
  assert.equal(merged.merged, true); assert.equal(merged.fastForward, false);
  const parents = (await git(origin, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ');
  assert.equal(parents.length, 3, 'a merge commit has two parents');
  assert.match(await git(origin, 'log', '--format=%s', '-n', '3'), /worktree change/);
});

test('a predicted conflict stops before the origin is touched, and the conflict prompt asks the agent to merge the origin into its worktree', async t => {
  const { origin, data } = await repo(t);
  const info = await createChatWorktree({ directory: data, id: 'cc000001', cwd: origin });
  await writeFile(path.join(info.path, 'a.txt'), 'worktree\n'); await commitWorktree(info, 'wt edit');
  await writeFile(path.join(origin, 'a.txt'), 'origin\n'); await git(origin, 'commit', '-q', '-am', 'origin edit');
  const head = await git(origin, 'rev-parse', 'HEAD');
  assert.deepEqual((await mergePreview(info)).conflicts, ['a.txt']);
  await assert.rejects(mergeWorktree(info), error => error.code === 'MERGE_CONFLICT' && error.files[0] === 'a.txt' && error.originBranch === 'main');
  assert.equal(await git(origin, 'rev-parse', 'HEAD'), head); assert.equal(await git(origin, 'status', '--porcelain'), '');
  const prompt = conflictPrompt({ originBranch: 'main', branch: info.branch, files: ['a.txt'] });
  assert.match(prompt, /git merge main/); assert.match(prompt, /rebase·squash 금지/); assert.match(prompt, /a\.txt/);
  // The agent does what the prompt says in its worktree; the next merge is a fast-forward.
  await run('git', ['merge', 'main'], { cwd: info.path }).catch(() => {});
  await writeFile(path.join(info.path, 'a.txt'), 'both\n'); await git(info.path, 'commit', '-qam', 'resolve');
  const merged = await mergeWorktree(info);
  assert.equal(merged.fastForward, true);
});

test('a dirty or detached origin is never merged into', async t => {
  const { origin, data } = await repo(t);
  const info = await createChatWorktree({ directory: data, id: 'dd000001', cwd: origin });
  await writeFile(path.join(info.path, 'x.txt'), 'x\n'); await commitWorktree(info, 'x');
  await writeFile(path.join(origin, 'a.txt'), 'local edit\n');
  await assert.rejects(mergeWorktree(info), error => error.code === 'ORIGIN_DIRTY' && error.files.includes('a.txt'));
  await git(origin, 'checkout', '-q', 'a.txt');
  // An untracked file in the origin is not in the way.
  await writeFile(path.join(origin, 'scratch.txt'), 's\n');
  await git(origin, 'checkout', '-q', '--detach');
  await assert.rejects(mergeWorktree(info), { code: 'ORIGIN_DETACHED' });
  await git(origin, 'checkout', '-q', 'main');
  assert.equal((await mergeWorktree(info)).merged, true);
});

test('remove keeps dirty worktrees and unmerged branches unless discarding; discard forces both', async t => {
  const { origin, data } = await repo(t);
  const info = await createChatWorktree({ directory: data, id: 'rr000001', cwd: origin });
  await writeFile(path.join(info.path, 'x.txt'), 'x\n');
  await assert.rejects(removeWorktree(info, { deleteBranch: true }), { code: 'WORKTREE_DIRTY' });
  await commitWorktree(info, 'x');
  const kept = await removeWorktree(info, { deleteBranch: true });
  assert.equal(kept.removed, true); assert.equal(kept.branchDeleted, false); assert.ok(kept.branchKept);
  assert.equal(await exists(info.path), false);
  assert.ok(await git(origin, 'rev-parse', '--verify', info.branch), 'the unmerged branch is still there');
  assert.equal(await exists(`${info.path}.ade.json`), false);

  const other = await createChatWorktree({ directory: data, id: 'rr000002', cwd: origin });
  await writeFile(path.join(other.path, 'y.txt'), 'y\n');
  const gone = await removeWorktree(other, { deleteBranch: true, discard: true });
  assert.equal(gone.branchDeleted, true);
  await assert.rejects(git(origin, 'rev-parse', '--verify', other.branch));
});

test('integration merges other chats\' branches into one worktree and stops at a conflict for its agent to resolve', async t => {
  const { origin, data } = await repo(t);
  const lead = await createChatWorktree({ directory: data, id: 'in000001', cwd: origin });
  const one = await createChatWorktree({ directory: data, id: 'in000002', cwd: origin });
  const two = await createChatWorktree({ directory: data, id: 'in000003', cwd: origin });
  await writeFile(path.join(one.path, 'one.txt'), '1\n'); await commitWorktree(one, 'one');
  await writeFile(path.join(two.path, 'a.txt'), 'two\n'); await commitWorktree(two, 'two');
  await writeFile(path.join(lead.path, 'a.txt'), 'lead\n'); await commitWorktree(lead, 'lead');
  const result = await integrateBranches(lead, [one.branch, two.branch]);
  assert.deepEqual(result.done.map(item => item.branch), [one.branch]);
  assert.equal(result.stopped.branch, two.branch); assert.deepEqual(result.stopped.conflicts, ['a.txt']);
  const status = await worktreeStatus(lead);
  assert.equal(status.midMerge, true); assert.deepEqual(status.conflicted, ['a.txt']);
  await assert.rejects(integrateBranches(lead, [one.branch]), { code: 'WORKTREE_DIRTY' });
  await assert.rejects(integrateBranches(one, ['--upload-pack=x']), { code: 'INVALID_INPUT' });
});

test('diff, list and orphans: worktrees no chat keeps are listed as left over', async t => {
  const { origin, data } = await repo(t);
  const kept = await createChatWorktree({ directory: data, id: 'ls000001', cwd: origin });
  const orphan = await createChatWorktree({ directory: data, id: 'ls000002', cwd: origin });
  await writeFile(path.join(kept.path, 'a.txt'), 'changed\n'); await writeFile(path.join(kept.path, 'n.txt'), 'n\n');
  const diff = await worktreeDiff(kept);
  assert.match(diff.text, /\+changed/); assert.deepEqual(diff.untracked, ['n.txt']);
  await assert.rejects(worktreeDiff(kept, { file: '../x' }), { code: 'INVALID_INPUT' });
  const list = await listChatWorktrees({ directory: data, repos: [origin], owners: [{ path: kept.path, chatId: 'ls000001', title: '작업', open: true, inside: true }] });
  assert.equal(list.length, 2);
  const mine = list.find(item => samePath(item.path, kept.path)), left = list.find(item => samePath(item.path, orphan.path));
  assert.deepEqual([mine.orphan, mine.title, mine.status.dirty], [false, '작업', 2]);
  assert.deepEqual([left.orphan, left.chatId, left.branch], [true, 'ls000002', orphan.branch]);
});

test('a chat remembers the worktree it owns in its own folder', async t => {
  const { root } = await repo(t);
  const chat = path.join(root, 'chat'); await mkdir(chat);
  assert.equal(await readOwnWorktree(chat), null);
  await writeOwnWorktree(chat, { path: '/x/y' });
  assert.deepEqual(await readOwnWorktree(chat), { path: '/x/y' });
  await writeOwnWorktree(chat, null);
  assert.equal(await readOwnWorktree(chat), null);
});

test('moving a Claude session copies its transcript to the new folder and keeps the original and an older copy', async t => {
  const { root } = await repo(t);
  const config = path.join(root, 'claude'), from = path.join(root, 'from'), to = path.join(root, 'to-dir');
  const folder = cwd => path.join(config, 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  const id = '11111111-2222-3333-4444-555555555555';
  await mkdir(path.join(folder(from), id, 'subagents'), { recursive: true });
  await writeFile(path.join(folder(from), `${id}.jsonl`), '{"a":1}\n');
  await writeFile(path.join(folder(from), id, 'subagents', 'x.jsonl'), 'sub\n');
  const moved = await moveClaudeSession({ configDir: config, sessionId: id, from, to });
  assert.equal(moved.copied, true);
  assert.equal(await readFile(path.join(folder(to), `${id}.jsonl`), 'utf8'), '{"a":1}\n');
  assert.equal(await readFile(path.join(folder(to), id, 'subagents', 'x.jsonl'), 'utf8'), 'sub\n');
  assert.ok(await exists(path.join(folder(from), `${id}.jsonl`)), 'the original stays');
  // Back again after the session grew in the new folder: the stale copy is kept as .bak, the newer one wins.
  await writeFile(path.join(folder(to), `${id}.jsonl`), '{"a":1}\n{"b":2}\n');
  await moveClaudeSession({ configDir: config, sessionId: id, from: to, to: from });
  assert.equal(await readFile(path.join(folder(from), `${id}.jsonl`), 'utf8'), '{"a":1}\n{"b":2}\n');
  const { readdir } = await import('node:fs/promises');
  assert.ok((await readdir(folder(from))).some(name => name.endsWith('.bak')));
  // Not under the folder it was started in: found wherever the CLI kept it.
  const elsewhere = await moveClaudeSession({ configDir: config, sessionId: id, from: path.join(root, 'unknown'), to: path.join(root, 'third') });
  assert.equal(elsewhere.copied, true);
  await assert.rejects(moveClaudeSession({ configDir: config, sessionId: '99999999-2222-3333-4444-555555555555', from, to }), { code: 'SESSION_NOT_FOUND' });
});

test('the note to the agent names the new folder and branch', () => {
  assert.match(moveNote('enter', { cwd: '/w/x', branch: 'ade/chat-1' }, '/repo'), /\/w\/x.*ade\/chat-1.*\/repo/s);
  assert.match(moveNote('exit', { originCwd: '/repo' }, '/w/x'), /back to \/repo/);
  // Entering is no request to commit: the agent leaves its changes for the user's merge unless the user asks for a commit.
  assert.match(moveNote('enter', { cwd: '/w/x', branch: 'ade/chat-1' }, '/repo'), /Do not commit on your own.*Commit only when the user asks/s);
  assert.doesNotMatch(moveNote('enter', { cwd: '/w/x', branch: 'ade/chat-1' }, '/repo'), /Commit your work/);
});
