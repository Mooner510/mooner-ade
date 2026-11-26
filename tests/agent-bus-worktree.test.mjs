import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBus } from '../apps/desktop/builtin-plugins/agent-bus/bus.mjs';
import { chatLaunchFiles } from '../apps/local-server/src/chat-launch-files.js';
import { ASK_MCP_TOOLS, askMcpTitle, askMcpTools, setAgentMcpServers } from '../apps/local-server/src/terminal-sessions.js';

const chat = (id, agent, extra = {}) => ({ id, projectId: 'p1', project: 'proj', agent, title: '', status: 'idle', cwd: 'C:\\w', ...extra });
const me = (id, agent = 'claude') => ({ chatId: id, projectId: 'p1', agent });
function world(chats, answers = {}) {
  const calls = [];
  const bus = createBus({ autoPump: false, now: () => 1_000_000, api: async (action, input) => {
    calls.push({ action, input });
    if (action === 'chat/peers') return chats;
    if (action === 'chat/send') return {};
    if (answers[action]) return answers[action](input);
    throw new Error(`unexpected ${action}`);
  } });
  return { bus, calls };
}
const worktree = { branch: 'ade/chat-aaaa', path: '/d/worktrees/chat-aaaa', origin: '/repo', originBranch: 'main', inside: true, managed: true, ahead: 2, behind: 0, dirty: 1, merged: false, conflicted: 0 };

test('list_peers shows each chat\'s worktree', async () => {
  const { bus } = world([chat('claude-1', 'claude', { worktree }), chat('codex-1', 'codex')]);
  const listed = await bus.peers(me('codex-1', 'codex'));
  assert.deepEqual(listed.peers[0].worktree, worktree);
  assert.equal('worktree' in listed.self, false);
});

test('reading another chat\'s worktree goes to that chat; changing goes only to the caller\'s own', async () => {
  const status = { info: { branch: 'ade/chat-aaaa', path: '/w', origin: '/repo', inside: true, managed: true, status: {} }, preview: { status: { originBranch: 'main', ahead: 1, behind: 0, files: [{ status: '??', path: 'n.txt' }], originDirty: 0 }, commits: [{ short: 'abc1234', subject: 'work' }], changes: [{ path: 'a.txt', added: 3, deleted: 1 }], conflicts: [] } };
  const { bus, calls } = world([chat('claude-1', 'claude', { title: '로그인' }), chat('codex-1', 'codex')], {
    'chat/worktree/status': () => status,
    'chat/worktree/diff': () => ({ base: 'b', untracked: [], text: '+x' }),
    'chat/worktree/check': input => ({ chats: [], pairs: [], order: [], asked: input.ids }),
    'chat/worktree/merge': () => ({ merged: false, blocked: { code: 'MERGE_CONFLICT', message: 'conflict', files: ['a.txt'] } }),
    'chat/worktree/integrate': input => ({ done: [{ branch: 'ade/chat-bbbb', commit: 'c' }], stopped: null, skipped: [], asked: input })
  });
  const read = await bus.worktreeStatus(me('codex-1', 'codex'), { chat: '로그인' });
  assert.deepEqual(calls.at(-1), { action: 'chat/worktree/status', input: { projectId: 'p1', id: 'claude-1', detail: true } });
  assert.deepEqual([read.worktree.branch, read.ahead, read.uncommitted, read.commits, read.changedFiles], ['ade/chat-aaaa', 1, ['?? n.txt'], ['abc1234 work'], ['a.txt +3 -1']]);
  await bus.worktreeStatus(me('codex-1', 'codex'));
  assert.equal(calls.at(-1).input.id, 'codex-1', 'no chat named: your own');
  assert.equal((await bus.worktreeDiff(me('codex-1', 'codex'), { chat: 'claude', file: 'a.txt' })).diff, '+x');
  assert.deepEqual(calls.at(-1).input, { projectId: 'p1', id: 'claude-1', file: 'a.txt' });
  assert.deepEqual((await bus.mergeCheck(me('codex-1', 'codex'), { chats: ['me', 'claude'] })).asked, ['codex-1', 'claude-1']);

  const merged = await bus.mergeMine(me('codex-1', 'codex'), { commitMessage: ' 작업 ' });
  assert.deepEqual(calls.at(-1).input, { projectId: 'p1', id: 'codex-1', by: 'agent', message: '작업' });
  assert.equal(merged.merged, false); assert.equal(merged.blocked.code, 'MERGE_CONFLICT'); assert.match(merged.next, /git merge/);
  assert.match(merged.next, /no rebase, no squash/);

  await bus.integrate(me('codex-1', 'codex'), { from: ['claude'] });
  assert.deepEqual(calls.at(-1).input, { projectId: 'p1', id: 'codex-1', from: ['claude-1'], by: 'agent' });
  await assert.rejects(bus.integrate(me('codex-1', 'codex'), { from: [] }), { code: 'INVALID_INPUT' });
  const history = bus.snapshot().history.map(entry => entry.status);
  assert.deepEqual(history, ['blocked', 'integrated']);
});

test('a worktree request is an ordinary bus message with the standard wording', async () => {
  const { bus, calls } = world([chat('claude-1', 'claude'), chat('codex-1', 'codex')]);
  const { results } = await bus.requestPeer(me('codex-1', 'codex'), { to: 'claude', request: 'sync', note: 'main moved' });
  assert.equal(results[0].status, 'delivered');
  const text = calls.find(call => call.action === 'chat/send').input.text;
  assert.match(text, /^\[ADE agent bus\]/); assert.match(text, /ADE verified/);
  assert.match(text, /\[worktree request: sync\].*git merge <origin branch>; no rebase, no squash/s); assert.match(text, /main moved$/);
  await assert.rejects(bus.requestPeer(me('codex-1', 'codex'), { to: 'claude', request: 'delete' }), { code: 'INVALID_INPUT' });
});

test('the bus tools that change a repository are never auto-approved, whatever the bus setting', async t => {
  assert.deepEqual([...ASK_MCP_TOOLS.agent_bus], ['merge_my_worktree', 'integrate_worktrees']);
  assert.deepEqual(askMcpTools({ name: 'agent_bus', autoApprove: true }), ['merge_my_worktree', 'integrate_worktrees']);
  assert.deepEqual(askMcpTools({ name: 'agent_bus' }), [], 'not auto-approved at all: nothing to except');
  assert.equal(askMcpTitle('agent_bus: merge_my_worktree'), true); assert.equal(askMcpTitle('agent_bus: list_peers'), false);
  // Claude: the shared settings file keeps the server allowed and asks for these two (an ask rule beats an allow rule).
  const root = await mkdtemp(path.join(os.tmpdir(), 'ade-bus-ask-'));
  t.after(async () => { setAgentMcpServers([]); await rm(root, { recursive: true, force: true }); });
  setAgentMcpServers([{ name: 'agent_bus', command: 'node', args: ['mcp.mjs'], chatOnly: true, autoApprove: true }]);
  await mkdir(path.join(root, 'chat'));
  const launch = await chatLaunchFiles(root)(path.join(root, 'chat'), { chatId: 'c', projectId: 'p', agent: 'claude' });
  const settings = JSON.parse(await readFile(launch.settingsFile, 'utf8'));
  assert.deepEqual(settings.permissions.allow, ['mcp__agent_bus']);
  assert.deepEqual(settings.permissions.ask, ['mcp__agent_bus__merge_my_worktree', 'mcp__agent_bus__integrate_worktrees']);
});
