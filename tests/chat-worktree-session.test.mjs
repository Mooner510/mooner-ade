import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { openChatSession } from '../apps/local-server/src/chat.js';
import { samePath } from '../apps/local-server/src/chat-worktree.js';
import { fromReplay } from '../apps/web/src/chat-model.ts';

const run = promisify(execFile);
const git = (cwd, ...args) => run('git', args, { cwd }).then(result => result.stdout.trim());
const exists = file => stat(file).then(() => true, () => false);
const until = async predicate => { for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('chat did not settle'); };
const fake = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const SESSION = '0f0f0f0f-1111-4222-8333-444444444444';
const projectFolder = (config, cwd) => path.join(config, 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));

async function world(t, env = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ade-wtchat-')));
  const repo = path.join(root, 'repo'), data = path.join(root, 'data'), config = path.join(root, 'claude');
  await mkdir(repo); await mkdir(data); await mkdir(config);
  await git(repo, 'init', '-q', '-b', 'main'); await git(repo, 'config', 'user.name', 't'); await git(repo, 'config', 'user.email', 't@example.invalid');
  await writeFile(path.join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', '-A'); await git(repo, 'commit', '-q', '-m', 'init');
  const events = [];
  const options = { directory: data, id: 'wtchat01-aaaa-bbbb-cccc-dddddddddddd', cwd: repo, agent: 'claude', executable: process.execPath, executableArgs: [fake], env: { CLAUDE_CONFIG_DIR: config, ADE_TEST_CLAUDE_SESSION: SESSION, ...env }, onEvent: event => events.push(event) };
  let session = await openChatSession(options);
  t.after(async () => { await session.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, repo, data, config, events, options, get session() { return session; }, async reopen() { await session.close(); session = await openChatSession(options); return session; } };
}
const reply = session => fromReplay(session.replay()).items.filter(item => item.kind === 'assistant').at(-1);
const lastText = session => JSON.stringify(reply(session));

test('an idle Claude chat moves into its own worktree and back: the session follows, the agent is told once, the thread keeps both lines', { timeout: 60_000 }, async t => {
  const w = await world(t);
  await w.session.send('hello'); await until(() => w.session.state().status === 'idle');
  assert.equal(w.session.state().sessionId, SESSION);
  // The CLI keeps the transcript under the folder it ran in.
  await mkdir(projectFolder(w.config, w.repo), { recursive: true });
  await writeFile(path.join(projectFolder(w.config, w.repo), `${SESSION}.jsonl`), '{"type":"user"}\n');

  const info = await w.session.enterWorktree();
  assert.equal(info.inside, true); assert.equal(info.managed, true); assert.equal(info.branch, 'ade/chat-wtchat01');
  assert.ok(samePath(info.origin, w.repo)); assert.ok(samePath(path.dirname(info.path), path.join(w.data, 'worktrees')));
  assert.ok(samePath(w.session.cwd, info.path)); assert.ok(samePath(w.session.state().cwd, info.path));
  assert.ok(await exists(path.join(projectFolder(w.config, info.path), `${SESSION}.jsonl`)), 'the transcript is where --resume looks now');
  assert.ok(await exists(path.join(projectFolder(w.config, w.repo), `${SESSION}.jsonl`)), 'the original stays');
  assert.equal(info.status.ahead, 0); assert.equal(info.status.dirty, 0);

  await w.session.send('whereami'); await until(() => w.session.state().status === 'idle');
  const where = lastText(w.session);
  assert.ok(where.replaceAll('\\\\', '\\').toLowerCase().includes(`cwd=${info.path}`.toLowerCase()), where);
  assert.match(where, /note=true/);
  await w.session.send('whereami'); await until(() => w.session.state().status === 'idle');
  assert.match(lastText(w.session), /note=false/, 'the note goes out once');

  // Work in the worktree shows in the status after the turn.
  await writeFile(path.join(info.path, 'b.txt'), 'b\n');
  assert.equal((await w.session.refreshWorktree()).status.dirty, 1);

  const out = await w.session.leaveWorktree();
  assert.equal(out.inside, false); assert.equal(out.managed, true, 'the chat still keeps its worktree');
  assert.ok(samePath(w.session.cwd, w.repo));
  const kinds = w.session.replay().events.filter(event => event.kind === 'worktree').map(event => `${event.phase}:${event.by}`);
  assert.deepEqual(kinds, ['create:user', 'enter:user', 'exit:user']);
  const lines = fromReplay(w.session.replay()).items.filter(item => item.kind === 'note').map(item => item.text);
  assert.ok(lines.some(text => /worktree 진입/.test(text)), lines.join('\n'));
  assert.ok(lines.some(text => /worktree에서 나옴/.test(text)), lines.join('\n'));

  // Reopened: in the origin, the kept worktree still known, the lines still in the thread.
  const again = await w.reopen();
  assert.ok(samePath(again.cwd, w.repo));
  const kept = await again.refreshWorktree();
  assert.equal(kept.inside, false); assert.equal(kept.status.dirty, 1);
  assert.equal(again.replay().events.filter(event => event.kind === 'worktree').length, 3);
  // And back in: the same worktree, not a new one.
  const back = await again.enterWorktree();
  assert.ok(samePath(back.path, info.path));
});

test('a busy chat is not moved, and a chat with nothing said yet changes folder without a session to carry', { timeout: 60_000 }, async t => {
  const w = await world(t);
  const fresh = await w.session.enterWorktree();
  assert.equal(fresh.inside, true);
  await w.session.send('whereami'); await until(() => w.session.state().status === 'idle');
  assert.match(lastText(w.session), /note=false/, 'nothing to tell an agent that never ran elsewhere');
  await w.session.send('slow');
  await assert.rejects(w.session.leaveWorktree(), { code: 'CHAT_BUSY' });
  await w.session.interrupt(); await until(() => w.session.state().status === 'idle');
});

test('a resumed Claude that reports another folder (a worktree it entered itself) gets a line in the thread and is left to the agent', { timeout: 60_000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ade-wtagent-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const repo = path.join(root, 'r'); await mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main'); await git(repo, 'config', 'user.name', 't'); await git(repo, 'config', 'user.email', 't@example.invalid');
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const own = path.join(repo, '.claude', 'worktrees', 'feature');
  await git(repo, 'worktree', 'add', '-q', '-b', 'worktree-feature', own);
  const w = await world(t, { ADE_TEST_REPORT_CWD: own });
  await w.session.send('hello'); await until(() => w.session.state().status === 'idle');
  await until(async () => (await w.session.refreshWorktree())?.inside === true);
  const info = w.session.worktreeInfo();
  assert.equal(info.kind, 'claude'); assert.equal(info.managed, false); assert.equal(info.branch, 'worktree-feature'); assert.ok(samePath(info.origin, repo));
  const line = w.session.replay().events.find(event => event.kind === 'worktree');
  assert.deepEqual([line.phase, line.by, line.branch], ['enter', 'agent', 'worktree-feature']);
  await assert.rejects(w.session.leaveWorktree(), { code: 'AGENT_WORKTREE' });
});
