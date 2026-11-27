import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChatSession } from '../apps/local-server/src/chat.js';

// The CLI's total_cost_usd is its process's running total. It carries the session's earlier total only when the CLI restored its cost state, which it
// does not for a fork (Rewind) or for a resume in another folder (worktree enter/leave): those processes count from 0, and the turn must still be counted.
const fake = fileURLToPath(new URL('./fixtures/fake-claude-cost-process.mjs', import.meta.url));
const SESSION = '0f0f0f0f-2222-4222-8333-555555555555';
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} != ${expected}`);
const until = async (predicate, what = 'condition') => { for (let i = 0; i < 600; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } assert.fail(`timed out waiting for ${what}`); };

async function world(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ade-cost-')));
  const repo = path.join(root, 'repo'), data = path.join(root, 'data'), config = path.join(root, 'claude');
  for (const dir of [repo, data, config]) await mkdir(dir);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 't'); git('config', 'user.email', 't@example.invalid');
  await writeFile(path.join(repo, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  const options = { directory: data, id: 'cost0001-aaaa-bbbb-cccc-dddddddddddd', cwd: repo, executable: process.execPath, executableArgs: [fake],
    env: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'sk-ant-test-12345678901234567890' }, keyAvailable: () => true, defaults: { auth: 'key' } };
  const session = await openChatSession(options);
  t.after(async () => { await session.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const turn = async text => { const before = session.replay().events.filter(event => event.kind === 'result').length; await session.send(text); await until(() => session.state().status === 'idle' && session.replay().events.filter(event => event.kind === 'result').length > before, `answer to ${text}`); };
  const lastTurnCost = () => session.replay().events.filter(event => event.kind === 'result').at(-1).turnCostUsd ?? 0;
  return { repo, config, session, turn, lastTurnCost };
}

test('Claude: the first turn after a Rewind is counted although the forked CLI counts its cost from 0', { timeout: 60_000 }, async t => {
  const w = await world(t);
  await w.turn('one'); await w.turn('two');
  near(w.session.state().costUsd, 0.2, 'two turns in one process');
  const first = w.session.replay().events.find(event => event.kind === 'message' && event.role !== 'user' && event.uuid);
  await w.session.rewind(first.uuid);
  await w.turn('three'); // a new process resuming a fork: its total is 0.10
  near(w.lastTurnCost(), 0.1, 'the turn after the Rewind');
  near(w.session.state().costUsd, 0.3, 'the chat total');
  near(w.session.state().apiCostUsd, 0.3, 'the API key total');
  await w.turn('four'); // the same process again: 0.20 - 0.10
  near(w.lastTurnCost(), 0.1, 'the next turn of that process');
  near(w.session.state().costUsd, 0.4, 'the chat total after it');
});

test('Claude: turns after moving into the chat worktree and back are counted although each moved CLI counts its cost from 0', { timeout: 60_000 }, async t => {
  const w = await world(t);
  await w.turn('one'); await w.turn('two'); await w.turn('three');
  near(w.session.state().costUsd, 0.3, 'three turns in the folder');
  const transcript = cwd => path.join(w.config, 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(transcript(w.repo), { recursive: true }); await writeFile(path.join(transcript(w.repo), `${SESSION}.jsonl`), '{"type":"user"}\n');
  await w.session.enterWorktree();
  await w.turn('in the worktree'); // 0.10 in a fresh process, less than the 0.30 so far
  near(w.lastTurnCost(), 0.1, 'the first turn in the worktree');
  near(w.session.state().costUsd, 0.4, 'the chat total in the worktree');
  await w.session.leaveWorktree();
  await w.turn('back home');
  near(w.lastTurnCost(), 0.1, 'the first turn after leaving');
  near(w.session.state().costUsd, 0.5, 'the chat total after leaving');
  near(w.session.state().apiCostUsd, 0.5, 'the API key total');
});

test('Claude: a resumed CLI that did not restore its cost state (another chat ran in the folder since) still adds its turn', { timeout: 60_000 }, async t => {
  const w = await world(t);
  await w.turn('one'); await w.turn('two');
  await w.session.set({ effort: 'high' }); // the child is replaced: --resume in the same folder, but this CLI starts its count from 0
  await w.turn('three');
  near(w.lastTurnCost(), 0.1, 'the turn of the replaced process');
  near(w.session.state().costUsd, 0.3, 'the chat total');
});
