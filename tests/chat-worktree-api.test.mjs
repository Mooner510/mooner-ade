import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinWorkspaceRequest, peerWorktree } from '../apps/local-server/src/chat-worktree-routes.js';

const git = (cwd, ...args) => new Promise((resolve, reject) => { let out = ''; const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }); child.stdout.on('data', chunk => { out += chunk; }); child.on('exit', code => code ? reject(new Error(`git ${args}`)) : resolve(out.trim())); });
const exists = file => stat(file).then(() => true, () => false);

async function boot(t) {
  const data = await realpath(await mkdtemp(join(tmpdir(), 'ade-data-'))), repo = await realpath(await mkdtemp(join(tmpdir(), 'ade-repo-')));
  const child = spawn(process.execPath, ['apps/local-server/src/index.js'], { env: { ...process.env, ADE_PORT: '0', ADE_DATA_DIR: data, ADE_PTY_ENDPOINT: '', ADE_PTY_TOKEN: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
    const removal = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
    await rm(data, removal); await rm(repo, removal);
  });
  const line = await new Promise((resolve, reject) => { child.stdout.once('data', chunk => resolve(String(chunk))); child.once('exit', () => reject(new Error('server exited'))); });
  const [, origin, token] = /(http:\/\/127\.0\.0\.1:\d+)\/#token=(\w+)/.exec(line);
  const auth = await fetch(`${origin}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const api = async (action, body = {}, expected = 200) => {
    const response = await fetch(`${origin}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'core.autocrlf', 'false'); await git(repo, 'config', 'user.name', 't'); await git(repo, 'config', 'user.email', 't@example.invalid');
  await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-q', '-m', 'init');
  const project = await api('project/open', { path: repo });
  return { repo, data, call: (action, body, expected) => api(action, { projectId: project.id, ...body }, expected) };
}

test('the merge flow over the API: enter, work, commit inside the flow, fast-forward into the origin, let the worktree go', { timeout: 120_000 }, async t => {
  const { call, repo } = await boot(t);
  await call('chat/open', { id: 'wt-api-0001', agent: 'claude' });
  assert.equal((await call('chat/worktree/status', { id: 'wt-api-0001' })).info, null);
  const { info } = await call('chat/worktree/enter', { id: 'wt-api-0001' });
  assert.equal(info.inside, true); assert.equal(info.branch, 'ade/chat-wt-api-0');
  const opened = await call('chat/open', { id: 'wt-api-0001', agent: 'claude' });
  assert.equal(opened.state.cwd.toLowerCase(), info.cwd.toLowerCase(), 'the chat runs in its worktree');
  assert.ok(opened.events.some(event => event.kind === 'worktree' && event.phase === 'enter'));

  await writeFile(join(info.path, 'b.txt'), 'b\n');
  const detail = await call('chat/worktree/status', { id: 'wt-api-0001', detail: true });
  assert.equal(detail.info.status.dirty, 1); assert.equal(detail.preview.fastForward, true);

  // A dirty origin stops it, with the files named; nothing is merged.
  await writeFile(join(repo, 'a.txt'), 'local\n');
  const stopped = await call('chat/worktree/merge', { id: 'wt-api-0001', message: '채팅 작업' });
  assert.equal(stopped.merged, false); assert.equal(stopped.blocked.code, 'ORIGIN_DIRTY'); assert.deepEqual(stopped.blocked.files, ['a.txt']);
  assert.equal(stopped.committed.committed, true, 'the commit inside the flow happened before the origin check');
  await git(repo, 'checkout', '--', 'a.txt');

  const merged = await call('chat/worktree/merge', { id: 'wt-api-0001' });
  assert.equal(merged.merged, true); assert.equal(merged.fastForward, true); assert.equal(merged.into, 'main');
  assert.equal(await readFile(join(repo, 'b.txt'), 'utf8'), 'b\n');
  assert.equal(merged.info.status.merged, true);

  // The general commit UI stays absent: only the merge flow commits.
  await call('git/commit', { message: 'x' }, 404);

  const removed = await call('chat/worktree/remove', { id: 'wt-api-0001', deleteBranch: true });
  assert.equal(removed.branchDeleted, true); assert.equal(removed.info, null);
  assert.equal(await exists(info.path), false);
  const after = await call('chat/open', { id: 'wt-api-0001', agent: 'claude' });
  assert.equal(after.state.cwd.toLowerCase(), repo.toLowerCase(), 'back in the origin');
  assert.deepEqual(after.events.filter(event => event.kind === 'worktree').map(event => event.phase), ['create', 'enter', 'commit', 'merge', 'exit', 'remove']);
  assert.deepEqual((await call('chat/worktree/list')).items, []);
});

test('conflicts are predicted per chat and between chats, and a forgotten chat leaves an orphan to clean up', { timeout: 120_000 }, async t => {
  const { call, repo } = await boot(t);
  const make = async (id, text) => {
    await call('chat/open', { id, agent: 'codex' });
    const { info } = await call('chat/worktree/enter', { id });
    await writeFile(join(info.path, 'a.txt'), text);
    await call('chat/worktree/commit', { id, message: id });
    return info;
  };
  const one = await make('wt-chk-0001', 'one\n'), two = await make('wt-chk-0002', 'two\n');
  const check = await call('chat/worktree/check', {});
  assert.deepEqual(check.chats.map(row => [row.id, row.ahead, row.ready]).sort(), [['wt-chk-0001', 1, true], ['wt-chk-0002', 1, true]]);
  assert.deepEqual(check.pairs.map(pair => pair.files), [['a.txt']]);
  // Integrating the other branch into the first chat's worktree stops at the conflict and says so in that chat.
  const integrated = await call('chat/worktree/integrate', { id: 'wt-chk-0001', from: ['wt-chk-0002'] });
  assert.equal(integrated.stopped.branch, two.branch); assert.deepEqual(integrated.stopped.conflicts, ['a.txt']);
  assert.equal(integrated.info.status.midMerge, true);
  await git(one.path, 'merge', '--abort');

  await call('chat/close', { id: 'wt-chk-0002', forget: true });
  const listed = (await call('chat/worktree/list')).items;
  const orphan = listed.find(item => item.branch === two.branch);
  assert.equal(orphan.orphan, true);
  await call('chat/worktree/cleanup', { path: one.path }, 409); // its chat is open
  await call('chat/worktree/cleanup', { path: orphan.path, deleteBranch: true, discard: true }, 400); // discarding needs the branch name
  const cleaned = await call('chat/worktree/cleanup', { path: orphan.path, deleteBranch: true, discard: true, confirm: two.branch });
  assert.equal(cleaned.branchDeleted, true);
  await assert.rejects(git(repo, 'rev-parse', '--verify', two.branch));
});

test('only the built-in agent bus reaches the worktree routes through a plugin session, with its own fields', () => {
  assert.deepEqual(builtinWorkspaceRequest('agent-bus', 'chat/worktree/merge', { projectId: 'p', id: 'c', message: 'm', by: 'agent', extra: 1 }), { projectId: 'p', id: 'c', message: 'm', by: 'agent' });
  assert.deepEqual(builtinWorkspaceRequest('agent-bus', 'chat/peers', { projectId: 'p', scope: 'all' }), { projectId: 'p', scope: 'all' });
  assert.equal(builtinWorkspaceRequest('agent-bus', 'chat/worktree/remove', { id: 'c' }), null, 'letting a worktree go stays with the user');
  assert.equal(builtinWorkspaceRequest('someone-else', 'chat/worktree/status', { id: 'c' }), null);
  assert.equal(peerWorktree(null), null);
  assert.deepEqual(peerWorktree({ worktreeInfo: () => ({ branch: 'ade/chat-1', path: '/w', origin: '/r', inside: true, managed: true, status: { ahead: 2, behind: 0, dirty: 1, originBranch: 'main', merged: false } }) }),
    { branch: 'ade/chat-1', path: '/w', origin: '/r', originBranch: 'main', inside: true, managed: true, ahead: 2, behind: 0, dirty: 1, merged: false, conflicted: 0 });
});
