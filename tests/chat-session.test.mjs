import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { agentExitBenign, chatFolder, openChatSession, seedChat, probeAgentModels } from '../apps/local-server/src/chat.js';
import { createApiSpend } from '../apps/local-server/src/api-spend.js';
import { listCommands } from '../apps/local-server/src/slash-commands.js';
import { chatCapabilities, codexPermissions, createChatProtocol } from '../apps/local-server/src/chat-rpc.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-chat-rpc.mjs', import.meta.url));
const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('chat did not settle'); };
async function setup(t, agent) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-test-'));
  const events = [], options = { directory, id: 'chat', cwd: directory, agent, executable: process.execPath, executableArgs: [fixture, agent], onEvent: event => events.push(event) };
  let session = await openChatSession(options);
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, events, options, get session() { return session; }, async reopen() { await session.close(); session = await openChatSession(options); return session; } };
}
test('Codex manual compact remains busy until its turn completes', async t => {
  const { session, events } = await setup(t, 'codex');
  await session.send('/compact');
  await until(() => events.some(event => event.kind === 'compact'));
  assert.equal(session.state().status, 'working');
  assert.ok(events.some(event => event.kind === 'delta' && event.phase === 'compacting' && event.active));
  assert.equal(events.filter(event => event.kind === 'result').length, 0);
  await until(() => session.state().status === 'idle');
  assert.equal(events.filter(event => event.kind === 'result').length, 1);
  await session.send('follow-up'); await until(() => session.state().status === 'idle');
  assert.ok(events.some(event => event.kind === 'user' && event.text === 'follow-up'));
});
for (const agent of ['codex', 'cursor']) {
  test(`${agent}: streaming, images, restart and exact session restore`, async t => {
    const ctx = await setup(t, agent), { session } = ctx;
    await session.send('hello', [{ mime: 'image/png', data: 'AAAA' }]);
    await until(() => session.state().status === 'idle');
    assert.ok(ctx.events.some(e => e.kind === 'delta' && e.text === '안녕'));
    assert.ok(ctx.events.some(e => e.kind === 'message' && e.blocks.some(b => b.text === '안녕')));
    assert.equal(session.state().costUsd, null);
    const id = session.state().sessionId;
    const restored = await ctx.reopen();
    assert.equal(restored.state().sessionId, id);
    await restored.send('again'); await until(() => restored.state().status === 'idle');
    assert.equal(restored.state().sessionId, id);
    assert.equal(restored.replay().events.filter(e => e.kind === 'user').length, 2);
    assert.equal(JSON.parse(await readFile(path.join(ctx.directory, 'chat/chat/meta.json'))).agent, agent);
    await assert.rejects(openChatSession({ ...ctx.options, agent: agent === 'codex' ? 'cursor' : 'codex' }), /에이전트가 다릅니다/);
  });
  test(`${agent}: approval, question validation, interrupt, reset and unsupported controls`, async t => {
    const { session, events } = await setup(t, agent);
    await session.send('approval'); await until(() => session.state().status === 'attention');
    const approval = session.replay().approvals[0];
    await session.approve(approval.requestId, { allow: true, always: true }); await until(() => session.state().status === 'idle');
    await assert.rejects(session.approve(approval.requestId, { allow: true }), /이미 처리/);
    await session.send('question'); await until(() => session.state().status === 'attention');
    const question = session.replay().approvals[0];
    assert.equal(question.questions[0].id, 'q1');
    await assert.rejects(session.approve(question.requestId, { allow: true, answers: { q1: ['wrong'] } }), /답변을 확인/);
    await session.approve(question.requestId, { allow: true, answers: { q1: [agent === 'codex' ? 'A' : 'a'] } });
    await until(() => session.state().status === 'idle');
    await session.send('hold');
    await assert.rejects(session.send('busy'), /이전 응답/);
    if (agent === 'codex') { await session.send('steer', [], { steer: true }); assert.ok(events.some(e => e.kind === 'steer' && e.phase === 'applied')); }
    else await assert.rejects(session.send('steer', [], { steer: true }), /추가 지시/);
    await assert.rejects(session.cancelSteer(), /개별 취소/);
    await session.interrupt(); await until(() => session.state().status === 'idle');
    assert.ok(events.some(e => e.kind === 'result' && e.status === 'interrupted'));
    if (agent === 'cursor') { assert.throws(() => session.branchSnapshot('unknown'), /분기 기록/); await assert.rejects(session.set({ addDirs: [] }), /추가 작업 폴더/); }
    if (agent === 'cursor') { await session.send('empty'); await until(() => session.state().status === 'idle'); assert.match(session.state().error, /표시할 응답 없이/); }
    await assert.rejects(session.set({ effort: 'made-up' }), /지원하지 않는 Effort/);
    await session.reset();
    assert.equal(session.state().sessionId, null); assert.equal(session.state().pending, 0);
  });
  test(`${agent}: process failure releases busy state and model probes make no turns`, async t => {
    const { session, options } = await setup(t, agent);
    const info = await probeAgentModels(options);
    assert.ok(info.catalog.length);
    await session.send('crash').catch(() => {}); await until(() => session.state().status === 'idle');
    assert.match(session.state().error, /끊겼|종료/);
    assert.equal(session.state().recoverable, true);
    await session.send('recovered'); await until(() => session.state().status === 'idle');
    assert.equal(session.state().error, null);
  });
  test(`${agent}: retry resumes the same session after a child exit`, async t => {
    const { session, events } = await setup(t, agent);
    await session.send('hello'); await until(() => session.state().status === 'idle');
    assert.ok(session.state().sessionId);
    await session.send('retry-once').catch(() => {});
    await until(() => session.state().status === 'idle' && session.state().error);
    assert.equal(session.state().recoverable, true);
    await session.retry();
    await until(() => session.state().status === 'idle');
    assert.equal(session.state().error, null);
    assert.ok(events.some(event => event.kind === 'message' && event.blocks?.some(block => block.text === '안녕')));
  });
}
test('agent exit 143 is treated like SIGTERM', () => {
  assert.equal(agentExitBenign(143, null), true);
  assert.equal(agentExitBenign(0, null), true);
  assert.equal(agentExitBenign(2, null), false);
  assert.equal(agentExitBenign(null, 'SIGTERM'), true);
});
test('Codex Branch and Rewind fork from the selected native turn and preserve the agent', async t => {
  const { session, directory, options } = await setup(t, 'codex');
  await session.send('first'); await until(() => session.state().status === 'idle');
  const first = session.replay().events.find(e => e.kind === 'message' && e.uuid);
  await session.send('second'); await until(() => session.state().status === 'idle');
  const snapshot = session.branchSnapshot(first.uuid);
  assert.equal(snapshot.meta.resumeAt, first.turnId);
  await seedChat({ directory, id: 'branch', ...snapshot });
  const branch = await openChatSession({ ...options, id: 'branch' });
  await branch.send('branch'); await until(() => branch.state().status === 'idle');
  assert.notEqual(branch.state().sessionId, session.state().sessionId);
  await branch.close();
  const original = session.state().sessionId;
  await session.rewind(first.uuid);
  await assert.rejects(session.handoff(), /되돌린 직후/);
  await session.send('rewound'); await until(() => session.state().status === 'idle');
  assert.notEqual(session.state().sessionId, original);
  const handoff = await session.handoff(); assert.equal(handoff.agent, 'codex');
});
test('Codex permission modes keep approval and sandbox restrictions separate', () => {
  assert.equal(codexPermissions('default', '/repo').approvalPolicy, 'untrusted');
  assert.equal(codexPermissions('plan', '/repo').sandboxPolicy.type, 'readOnly');
  assert.deepEqual(codexPermissions('acceptEdits', '/repo', ['/extra']).sandboxPolicy.writableRoots, ['/repo', '/extra']);
  assert.equal(codexPermissions('bypassPermissions', '/repo').sandboxPolicy.type, 'dangerFullAccess');
});
test('Codex auto uses the auto_review reviewer, and the sandbox is its own choice (plan stays read-only)', () => {
  assert.equal(codexPermissions('auto', '/repo').approvalsReviewer, 'auto_review');
  for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) assert.equal(codexPermissions(mode, '/repo').approvalsReviewer, 'user');
  assert.equal(codexPermissions('default', '/repo', [], 'read-only').sandboxPolicy.type, 'readOnly');
  assert.equal(codexPermissions('bypassPermissions', '/repo', [], 'workspace-write').sandboxPolicy.type, 'workspaceWrite', 'an explicit sandbox beats the mode default');
  assert.equal(codexPermissions('default', '/repo', [], 'danger-full-access').sandboxPolicy.type, 'dangerFullAccess');
  assert.equal(codexPermissions('plan', '/repo', [], 'danger-full-access').sandboxPolicy.type, 'readOnly');
  assert.equal(codexPermissions('acceptEdits', '/repo', [], null, true).sandboxPolicy.networkAccess, true);
  assert.equal(codexPermissions('acceptEdits', '/repo').sandboxPolicy.networkAccess, false);
  assert.deepEqual(chatCapabilities('codex').sandboxes, ['read-only', 'workspace-write', 'danger-full-access']);
  assert.deepEqual(chatCapabilities('claude').sandboxes, []);
});
test('Codex: cache writes survive cumulative usage updates and replay without counting them twice as input', async t => {
  const ctx = await setup(t, 'codex');
  for (let turn = 1; turn <= 2; turn++) {
    await ctx.session.send('hello');
    await until(() => ctx.session.state().status === 'idle');
    assert.deepEqual(ctx.session.state().tokens, { input: turn * 6, output: turn * 2, cacheRead: turn, cacheCreate: turn * 3 });
  }
  const restored = await ctx.reopen();
  assert.deepEqual(restored.state().tokens, { input: 12, output: 4, cacheRead: 2, cacheCreate: 6 });
});

test('Codex: older usage without cache writes still works and input cannot go negative', () => {
  const events = [], protocol = createChatProtocol('codex', { write: async () => {}, emit: event => events.push(event) });
  for (const total of [{ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }, { inputTokens: 10, cachedInputTokens: 4, cacheWriteInputTokens: 8, outputTokens: 2 }]) {
    protocol.handle({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total, last: { totalTokens: 12 }, modelContextWindow: 1000 } } });
  }
  assert.deepEqual(events.map(event => event.tokens), [
    { input: 6, output: 2, cacheRead: 4, cacheCreate: 0 },
    { input: 0, output: 2, cacheRead: 4, cacheCreate: 8 }
  ]);
});

test('Codex: switching to Bypass accepts the requests already waiting and the ones that follow, but never answers a question', async () => {
  const events = [], sent = [];
  let protocol;
  const answers = { initialize: {}, 'model/list': { data: [] }, 'skills/list': { data: [] }, 'thread/start': { thread: { id: 't1' }, model: 'm' } };
  const write = async line => { const message = JSON.parse(line); sent.push(message); if (message.method in answers) queueMicrotask(() => protocol.handle({ id: message.id, result: answers[message.method] })); };
  protocol = createChatProtocol('codex', { write, emit: event => events.push(event) });
  await protocol.initialize({ permissionMode: 'default', addDirs: [] }, '/repo');
  const command = { id: 'c1', method: 'item/commandExecution/requestApproval', params: { threadId: 't1', itemId: 'i1', command: 'ls' } };
  protocol.handle(command);
  protocol.handle({ id: 'q1', method: 'item/tool/requestUserInput', params: { threadId: 't1', questions: [{ id: 'a', question: 'which?' }] } });
  assert.equal(events.filter(event => event.kind === 'approval' && event.phase === 'request').length, 2, 'asked while the mode is default');
  await protocol.setPermissions({ permissionMode: 'bypassPermissions' });
  assert.deepEqual(sent.filter(message => message.id === 'c1').map(message => message.result), [{ decision: 'accept' }]);
  assert.ok(events.some(event => event.phase === 'cancel' && event.requestId === 'c1'), 'the waiting card is withdrawn');
  assert.ok(!sent.some(message => message.id === 'q1'), 'the question still waits for the user');
  protocol.handle({ id: 'c2', method: 'item/fileChange/requestApproval', params: { threadId: 't1', itemId: 'i2' } });
  protocol.handle({ id: 'p1', method: 'item/permissions/requestApproval', params: { threadId: 't1', permissions: { network: { enabled: true } } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.find(message => message.id === 'c2').result, { decision: 'accept' });
  assert.deepEqual(sent.find(message => message.id === 'p1').result, { permissions: { network: { enabled: true } }, scope: 'turn' });
  assert.equal(events.filter(event => event.kind === 'approval' && event.phase === 'request').length, 2, 'later requests never show a card');
  await protocol.setPermissions({ permissionMode: 'default' });
  protocol.handle({ id: 'c3', method: 'item/commandExecution/requestApproval', params: { threadId: 't1', itemId: 'i3', command: 'rm' } });
  assert.ok(!sent.some(message => message.id === 'c3'), 'back to asking once Bypass is off');
});

test('Codex: in Bypass an MCP tool approval (question or elicitation) is allowed once, a server\'s own form still reaches the user', async () => {
  const events = [], sent = [];
  let protocol;
  const answers = { initialize: {}, 'model/list': { data: [] }, 'skills/list': { data: [] }, 'thread/start': { thread: { id: 't1' }, model: 'm' } };
  const write = async line => { const message = JSON.parse(line); sent.push(message); if (message.method in answers) queueMicrotask(() => protocol.handle({ id: message.id, result: answers[message.method] })); };
  protocol = createChatProtocol('codex', { write, emit: event => events.push(event) });
  await protocol.initialize({ permissionMode: 'default', addDirs: [] }, '/repo');
  const question = { id: 'm1', method: 'item/tool/requestUserInput', params: { threadId: 't1', questions: [{ id: 'mcp_tool_call_approval_x', question: 'Allow?', options: [{ label: 'Allow for this session' }, { label: 'Allow' }, { label: 'Cancel' }] }] } };
  const elicitation = { id: 'e1', method: 'mcpServer/elicitation/request', params: { threadId: 't1', mode: 'form', message: 'Allow the tool?', requestedSchema: {}, _meta: { codex_approval_kind: 'mcp_tool_call' } } };
  protocol.handle(question);
  assert.equal(events.filter(event => event.kind === 'approval' && event.phase === 'request').length, 1, 'asked while the mode is default');
  await protocol.setPermissions({ permissionMode: 'bypassPermissions' });
  assert.deepEqual(sent.find(message => message.id === 'm1').result, { answers: { mcp_tool_call_approval_x: { answers: ['Allow'] } } });
  protocol.handle({ ...elicitation });
  protocol.handle({ id: 'f1', method: 'mcpServer/elicitation/request', params: { threadId: 't1', mode: 'form', message: 'Your name?', requestedSchema: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.find(message => message.id === 'e1').result, { action: 'accept', content: null });
  assert.ok(!sent.some(message => message.id === 'f1' && message.result), 'a form the server asks is not an approval');
});

test('Codex reports the effective Effort on start, resume and fork without overriding the CLI default', async t => {
  for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
    for (const [effort, reported] of [[undefined, 'high'], ['low', 'low'], [undefined, undefined]]) {
      await t.test(`${method}: chosen=${effort}, reported=${reported}`, async () => {
        const events = [], sent = [];
        let protocol;
        const answers = { initialize: {}, 'model/list': { data: [] }, 'skills/list': { data: [] }, 'config/read': { config: {} },
          [method]: { thread: { id: 't1' }, reasoningEffort: reported }, 'turn/start': { turn: { id: 'turn1' } } };
        protocol = createChatProtocol('codex', {
          write: async line => {
            const message = JSON.parse(line); sent.push(message);
            if (message.method in answers) queueMicrotask(() => protocol.handle({ id: message.id, result: answers[message.method] }));
          }, emit: event => events.push(event)
        });
        try {
          await protocol.initialize({ permissionMode: 'default', addDirs: [], effort,
            ...(method !== 'thread/start' && { sessionId: 'old' }), ...(method === 'thread/fork' && { resumeAt: 'old-turn' }) }, '/repo');
          assert.deepEqual(events.filter(event => event.kind === 'settings'), reported === undefined ? [] : [{ kind: 'settings', effort: reported }]);
          assert.equal(sent.find(message => message.method === method).params.config.model_reasoning_effort, effort);
          await protocol.send('hello', []);
          assert.equal(sent.find(message => message.method === 'turn/start').params.effort, effort);
        } finally { protocol.dispose(); }
      });
    }
  }
});
test('Codex shows the inherited Effort, and a later explicit pick wins over it when reopened', async t => {
  const ctx = await setup(t, 'codex');
  ctx.options.env = { FAKE_CODEX_EFFORT: 'high' };
  let session = await ctx.reopen();
  await session.send('hello'); await until(() => session.state().status === 'idle');
  assert.equal(session.state().effort, 'high');
  await session.set({ effort: 'low' });
  session = await ctx.reopen();
  assert.equal(session.state().effort, 'low');
  await session.send('again'); await until(() => session.state().status === 'idle');
  assert.equal(session.state().effort, 'low');
});
test('RPC requests time out and pending requests reject on disconnection', async () => {
  const protocol = createChatProtocol('codex', { write: async () => {}, emit() {} });
  await assert.rejects(protocol.request('no-response', {}, 5), /응답 시간이 초과/);
  const pending = protocol.request('disconnected');
  protocol.dispose();
  await assert.rejects(pending, /연결이 종료/);
});

test('Claude permission modes apply immediately on a live child', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-claude-mode-'));
  const options = { directory, id: 'modes', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))] };
  const session = await openChatSession(options);
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });
  await session.send('hello'); await until(() => session.state().status === 'idle');
  assert.deepEqual(session.state().capabilities.permissionModes, ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
  for (const permissionMode of ['acceptEdits', 'auto', 'bypassPermissions', 'plan', 'default']) {
    await session.set({ permissionMode });
    assert.equal(session.state().permissionMode, permissionMode);
  }
});

test('Claude streaming usage updates live tokens once and commits on result', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-usage-'));
  const tokenSnapshots = [];
  const options = {
    directory, id: 'usage', cwd: directory, executable: process.execPath,
    executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-usage-stream.mjs', import.meta.url))],
    onState: state => tokenSnapshots.push({ ...state.tokens, costUsd: state.costUsd }),
  };
  const session = await openChatSession(options);
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });
  await session.send('hello');
  await until(() => session.state().status === 'idle');
  assert.ok(tokenSnapshots.some(tokens => tokens.output === 80 && tokens.input === 0), 'thinking estimate shows as provisional output');
  assert.ok(tokenSnapshots.some(tokens => tokens.input === 120 && tokens.output === 0), 'message_start usage');
  assert.ok(tokenSnapshots.some(tokens => tokens.input === 120 && tokens.output === 20), 'streamed text counts as output before message_delta reports it');
  assert.ok(tokenSnapshots.some(tokens => tokens.input === 120 && tokens.output === 35), 'message_delta output');
  assert.deepEqual(session.state().tokens, { input: 120, output: 35, cacheRead: 0, cacheCreate: 0 });
  assert.equal(session.state().costUsd, 0.03);
  const committedOutputs = tokenSnapshots.filter((tokens, index) => index === tokenSnapshots.length - 1 || tokenSnapshots[index + 1]?.output !== tokens.output).map(tokens => tokens.output);
  assert.ok(committedOutputs.includes(35));
});

test('Claude: while a turn runs the cost grows with its tokens (priced like the last turn) and lands on the reported total', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-livecost-'));
  const costs = [];
  const session = await openChatSession({ directory, id: 'livecost', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-usage-stream.mjs', import.meta.url))], onState: state => costs.push(state.costUsd) });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await session.send('one');
  await until(() => session.state().status === 'idle');
  assert.equal(session.state().costUsd, 0.03);
  costs.length = 0;
  await session.send('two');
  await until(() => session.state().turns === 2 && session.state().status === 'idle');
  assert.ok(costs.some(cost => cost > 0.03), 'cost rose before the result');
  assert.equal(session.state().costUsd, 0.03);
});

test('Claude: a turn with several API calls only ever adds to the shown tokens, and ends on the result total', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-multi-'));
  const seen = [];
  const session = await openChatSession({ directory, id: 'multi', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-multi-call-stream.mjs', import.meta.url))], onState: state => seen.push(state.tokens) });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await session.send('hello');
  await until(() => session.state().status === 'idle');
  for (let i = 1; i < seen.length; i++) for (const key of ['input', 'output']) assert.ok(seen[i][key] >= seen[i - 1][key], `${key} went back: ${JSON.stringify(seen[i - 1])} -> ${JSON.stringify(seen[i])}`);
  assert.deepEqual(session.state().tokens, { input: 250, output: 50, cacheRead: 0, cacheCreate: 0 });
});

test('Claude: a setting change that replaces the child does not count the session cost twice (the resumed CLI reports the session total)', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-cost-'));
  const session = await openChatSession({ directory, id: 'cost', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-usage-stream.mjs', import.meta.url))] });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await session.send('one');
  await until(() => session.state().status === 'idle');
  assert.equal(session.state().costUsd, 0.03);
  await session.set({ effort: 'low' }); // a startup flag: the child is replaced
  await session.send('two');
  await until(() => session.state().turns === 2 && session.state().status === 'idle');
  assert.ok(Math.abs(session.state().costUsd - 0.06) < 1e-9, String(session.state().costUsd));
});

test('Claude: ADE never hands an Auto Compact window to the CLI; "auto" shows no window and a window the user set is shown as is', async t => {
  // A test run from inside an ADE chat inherits the window ADE handed to that chat's CLI, which would read as one the user set.
  const saved = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, DISABLE_AUTO_COMPACT: process.env.DISABLE_AUTO_COMPACT };
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW; delete process.env.DISABLE_AUTO_COMPACT;
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const [settings, shown] of [[{}, null], [{ autoCompactWindow: 'auto' }, null], [{ autoCompactWindow: 150000 }, 150000], [{ autoCompactEnabled: false }, null]]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-window-')), configDir = path.join(directory, 'claude-config'), folder = chatFolder(directory, 'window');
    await mkdir(configDir, { recursive: true }); await mkdir(folder, { recursive: true });
    await writeFile(path.join(configDir, 'settings.json'), JSON.stringify(settings));
    await writeFile(path.join(folder, 'meta.json'), JSON.stringify({ configDir, model: 'claude-sonnet-5-5[1m]' }));
    const windows = [];
    const session = await openChatSession({ directory, id: 'window', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))],
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '', DISABLE_AUTO_COMPACT: '' }, spawnProcess: (command, args, options) => { windows.push(options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW); return spawn(command, args, options); } });
    t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
    await session.send('hello'); await until(() => session.state().status === 'idle');
    assert.equal(windows[0] || undefined, undefined, JSON.stringify(settings));
    assert.equal(session.state().autoCompact?.window ?? null, shown, JSON.stringify(settings));
  }
});

test('Claude: the MCP startup wait is capped so a slow MCP server cannot hold the first message for ~30s; the user\'s own value wins', async t => {
  for (const [env, expected] of [[{ CLAUDE_CODE_MCP_STARTUP_WAIT_MS: undefined }, '3000'], [{ CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '9000' }, '9000']]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-mcpwait-'));
    const waits = [];
    const session = await openChatSession({ directory, id: 'mcpwait', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))],
      env, spawnProcess: (command, args, options) => { waits.push(options.env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS); return spawn(command, args, options); } });
    t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
    await session.send('hello'); await until(() => session.state().status === 'idle');
    assert.equal(waits[0], expected);
  }
});

test('legacy Claude chats still resume, and clear stays cleared after reopening', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-claude-'));
  const options = { directory, id: 'legacy', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))] };
  let session = await openChatSession(options);
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });
  await session.send('hello'); await until(() => session.state().status === 'idle');
  assert.equal(session.state().sessionId, 'fake-session');
  await session.reset(); await session.close();
  session = await openChatSession(options);
  assert.equal(session.state().sessionId, null);
  assert.equal(session.agent, 'claude');
});

test('Claude model catalog refresh keeps Effort choices', async t => {
  const { session } = await setup(t, 'claude');
  assert.deepEqual(session.state().capabilities.efforts, chatCapabilities('claude').efforts);
  session.loadCatalog([{ id: 'claude-sonnet-4-5', name: 'Sonnet 4.5', family: 'sonnet', window: 200_000, main: true }], 'claude-sonnet-4-5');
  assert.deepEqual(session.state().capabilities.efforts, chatCapabilities('claude').efforts);
});

test('Claude: sub-agent output after a turn result leaves the main chat idle until the hand-back turn', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-bg-'));
  const statuses = [], events = [];
  const session = await openChatSession({ directory, id: 'bg', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))],
    onEvent: event => events.push(event), onState: state => { if (statuses.at(-1) !== state.status) statuses.push(state.status); } });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await session.send('background');
  await until(() => events.filter(event => event.kind === 'result').length === 1);
  // The sub-agent is still producing output, including a tool result. That is not this conversation's turn.
  await until(() => events.some(event => event.kind === 'tool_result' && event.parentToolUseId === 'toolu_agent'));
  assert.equal(session.state().status, 'idle');
  const at = statuses.length;
  await until(() => events.filter(event => event.kind === 'result').length === 2);
  await until(() => session.state().status === 'idle');
  assert.ok(statuses.slice(at).includes('working'), 'the hand-back is the main agent answering');
});

test('Claude: a running subagent does not take a new message as a steer', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-subrun-'));
  const events = [];
  const session = await openChatSession({ directory, id: 'subrun', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))], onEvent: event => events.push(event) });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await session.send('subrun');
  await until(() => events.some(event => event.parentToolUseId === 'toolu_agent' && event.kind === 'tool_result') && session.state().status === 'idle');
  assert.equal(session.state().status, 'idle');
  // The client would ask to steer because it thought the chat was working. The main turn is not open, so this is an ordinary send.
  await session.send('while-sub', [], { steer: true });
  await until(() => events.some(event => event.kind === 'user' && event.text === 'while-sub') && session.state().status === 'idle');
  assert.equal(events.some(event => event.kind === 'steer'), false);
});

test('Claude: an empty result that answered nothing resends the message once instead of leaving the chat silent', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-swallow-'));
  const events = [];
  const session = await openChatSession({ directory, id: 'swallow', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))], onEvent: event => events.push(event) });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await session.send('swallow');
  await until(() => events.some(event => event.kind === 'message'));
  await until(() => session.state().status === 'idle');
  assert.equal(events.filter(event => event.kind === 'user').length, 1); // the resend is not a second user bubble
  assert.equal(events.filter(event => event.kind === 'message').length, 1);
});

test('Claude: Esc with a waiting steering message stops the turn and sends that message right away', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-steer-esc-'));
  const events = [];
  const session = await openChatSession({ directory, id: 'steeresc', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url))], onEvent: event => events.push(event) });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await session.send('slow'); await until(() => session.state().status === 'working');
  await session.send('나중에 할 말', [], { steer: true });
  assert.ok(events.some(event => event.kind === 'steer' && event.phase === 'queued'));
  await session.interrupt({ sendSteers: true });
  await until(() => events.some(event => event.kind === 'message') && session.state().status === 'idle');
  const cancelled = events.find(event => event.kind === 'steer' && event.phase === 'cancelled');
  assert.equal(cancelled.resent, true); // the screen must not hand the text back to the input box
  assert.deepEqual(events.filter(event => event.kind === 'user').map(event => event.text), ['slow', '나중에 할 말']);
});

test('Claude: a running background subagent blocks /clear and handoff unless forced; stop_task ends it, and a forced end leaves no stale task', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-bg-'));
  const session = await openChatSession({ directory, id: 'bgtask', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url))], onEvent: () => {} });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const running = async () => { await session.send('bgtask'); await until(() => session.state().status === 'idle' && session.state().liveTasks.length === 1); };
  await running();
  await assert.rejects(session.reset(), /백그라운드 작업이 실행 중/);
  await assert.rejects(session.handoff(), /백그라운드 작업이 실행 중/);
  await session.stopTask('toolu_bg'); await until(() => session.state().liveTasks.length === 0);
  // The killed child's close handler skips a child already dropped: without clearing there, the task stayed "running" (no idle kill, chip kept spinning).
  await running(); await session.handoff({ force: true }); assert.deepEqual(session.state().liveTasks, []);
  await running(); await session.reset({ force: true }); assert.deepEqual(session.state().liveTasks, []);
});

test('Claude: a turn that ends with its own text but without the echo of our message resends it once', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-swallowtext-'));
  const events = [];
  const session = await openChatSession({ directory, id: 'swallowtext', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))], onEvent: event => events.push(event) });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await session.send('hello'); await until(() => session.state().status === 'idle'); // an echo has been seen: a missing one now means something
  await session.send('swallowtext');
  await until(() => events.filter(event => event.kind === 'message').length >= 3 && session.state().status === 'idle');
  const said = events.filter(event => event.kind === 'message').map(event => event.blocks.map(block => block.text ?? '').join(''));
  assert.deepEqual(said, ['ok', 'old task notice', 'ok']);
  assert.equal(events.filter(event => event.kind === 'user').length, 2);
});

test('Claude: a question is answered through the tool input; skipping it is not the generic refusal', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-ask-'));
  const events = [];
  const session = await openChatSession({ directory, id: 'ask', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))], onEvent: event => events.push(event) });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const said = () => events.filter(event => event.kind === 'message').map(event => event.blocks.map(block => block.text ?? '').join('')).join('|');
  await session.send('ask'); await until(() => session.state().status === 'attention');
  const approval = session.replay().approvals[0];
  assert.equal(approval.questions.length, 1);
  await assert.rejects(session.approve(approval.requestId, { allow: true, answers: {} }), /질문/);
  await session.approve(approval.requestId, { allow: true, answers: { q0: ['직접 쓴 답'] } }); // free text is allowed (the question has an Other row)
  await until(() => session.state().status === 'idle');
  assert.match(said(), /answers=\{"고르세요":"직접 쓴 답"\}/);
  await session.send('ask'); await until(() => session.state().status === 'attention');
  await session.approve(session.replay().approvals[0].requestId, { allow: false }); await until(() => session.state().status === 'idle');
  assert.match(said(), /chose not to answer/);
});

test('Claude: a silent reopened turn falls back to idle, and the next output reopens it', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-quiet-'));
  const events = [];
  const session = await openChatSession({ directory, id: 'quiet', cwd: directory, quietMs: 60, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))], onEvent: event => events.push(event) });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await session.send('reopen');
  await until(() => events.some(event => event.kind === 'message' && event.id === 'later1'));
  assert.equal(session.state().status, 'working'); // the main agent's hand-back, not a subagent
  await until(() => session.state().status === 'idle'); // no output for quietMs (the next main-thread line is 300 ms away)
  await until(() => events.some(event => event.kind === 'message' && event.id === 'later2'));
  assert.equal(session.state().status, 'working');
  await until(() => events.filter(event => event.kind === 'result').length === 2 && session.state().status === 'idle');
});

test('worktree cwd survives restart and is retained when the chat is forgotten', async t => {
  const { session, directory, reopen } = await setup(t, 'codex');
  const git = (...args) => promisify(execFile)('git', args, { cwd: directory });
  await git('init', '-q', '-b', 'main');
  await git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
  await session.set({ worktree: true });
  await session.send('first'); await until(() => session.state().status === 'idle');
  assert.notEqual(session.cwd, directory);
  assert.ok((await git('worktree', 'list', '--porcelain')).stdout.includes(session.cwd));
  const cwd = session.cwd, restored = await reopen();
  assert.equal(restored.cwd, cwd);
  await restored.send('restored'); await until(() => restored.state().status === 'idle');
  await restored.close({ forget: true });
  assert.ok((await git('worktree', 'list', '--porcelain')).stdout.includes(cwd));
});


test('Cursor advertised options apply without a turn, persist, restore and refresh on model changes', async t => {
  const ctx = await setup(t, 'cursor');
  const session = ctx.session;
  const info = await probeAgentModels(ctx.options);
  session.loadCatalog(info.catalog, info.models[''], info.configOptions);
  assert.deepEqual(session.state().capabilities.efforts, ['low', 'high', 'max']);
  assert.equal(session.state().effort, 'high');
  assert.equal(session.state().capabilities.configOptions.find(option => option.id === 'max_mode').currentValue, 'false');
  for (const [configId, value] of [['fast', 'true'], ['context', '1m'], ['effort', 'max'], ['thinking', 'false'], ['max_mode', 'true'], ['future_option', 'b']]) {
    await session.set({ configOption: { configId, value } });
    assert.equal(session.state().capabilities.configOptions.find(option => option.id === configId).currentValue, value);
  }
  assert.equal(session.state().turns, 0);
  assert.equal(session.state().effort, 'max');
  await assert.rejects(session.set({ configOption: { configId: 'fast', value: 'invalid' } }), /지원하지 않는 모델 옵션/);
  await assert.rejects(session.set({ configOption: { configId: 'unknown', value: 'true' } }), /지원하지 않는 모델 옵션/);
  await assert.rejects(session.set({ configOption: { configId: 'model', value: info.catalog[0].id } }), /지원하지 않는 모델 옵션/);
  const restored = await ctx.reopen();
  await restored.send('restored'); await until(() => restored.state().status === 'idle');
  for (const [id, value] of [['fast', 'true'], ['context', '1m'], ['effort', 'max'], ['thinking', 'false'], ['max_mode', 'true'], ['future_option', 'b']]) assert.equal(restored.state().capabilities.configOptions.find(option => option.id === id).currentValue, value);
  await restored.send('hold');
  // Settings are applied through the ACP session even while a turn runs.
  await restored.set({ configOption: { configId: 'fast', value: 'false' } });
  assert.equal(restored.state().status, 'working');
  assert.equal(restored.state().capabilities.configOptions.find(option => option.id === 'fast').currentValue, 'false');
  await restored.interrupt(); await until(() => restored.state().status === 'idle');
  const sessionId = restored.state().sessionId;
  await restored.set({ model: 'composer-test' });
  assert.equal(restored.state().sessionId, sessionId);
  assert.equal(restored.state().model, 'composer-test');
  assert.deepEqual(restored.state().capabilities.configOptions.map(option => option.id), ['model', 'fast']);
  assert.deepEqual(restored.state().capabilities.efforts, []);
  assert.equal(restored.state().effort, null);
  assert.deepEqual(JSON.parse(await readFile(path.join(ctx.directory, 'chat/chat/meta.json'))).configValues, {});
});

test('Cursor: the picked model shows before the CLI answers, and the next message is not held behind that answer', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-cursor-model-'));
  const events = [];
  const session = await openChatSession({ directory, id: 'chat', cwd: directory, agent: 'cursor', executable: process.execPath, executableArgs: [fixture, 'cursor'], env: { HOLD_CONFIG: '1' }, onEvent: event => events.push(event) });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });
  await session.send('hello'); await until(() => session.state().status === 'idle');
  const hold = path.join(directory, '.hold-config'), go = path.join(directory, '.hold-config-go');
  const switching = session.set({ model: 'composer-test' });
  await until(() => existsSync(hold) && session.state().model === 'composer-test');
  const sent = session.send('next');
  await until(() => events.some(event => event.kind === 'user' && event.text === 'next'));
  assert.equal(existsSync(go), false);
  assert.equal(session.state().status, 'working');
  assert.equal(session.state().model, 'composer-test');
  await writeFile(go, '1');
  await switching;
  await sent; await until(() => session.state().status === 'idle');
  assert.equal(session.state().model, 'composer-test');
  assert.deepEqual(session.state().capabilities.configOptions.map(option => option.id), ['model', 'fast']);
});

test('Cursor advertises agent/plan/ask and switches between them', async t => {
  const ctx = await setup(t, 'cursor'), session = ctx.session;
  const info = await probeAgentModels(ctx.options);
  session.loadCatalog(info.catalog, info.models[''], info.configOptions);
  assert.deepEqual(session.state().capabilities.permissionModes, ['default', 'plan', 'ask']);
  for (const permissionMode of ['plan', 'ask', 'default']) { await session.set({ permissionMode }); assert.equal(session.state().permissionMode, permissionMode); }
});

test('Cursor Run Everything applies at once (permission requests are accepted by the app); Sandbox is a launch flag applied by a restart', async t => {
  const ctx = await setup(t, 'cursor'), session = ctx.session, replies = () => ctx.events.filter(e => e.kind === 'message').flatMap(e => e.blocks.map(b => b.text));
  const turn = async text => { await session.send(text); await until(() => session.state().status === 'idle'); return replies().at(-1); };
  assert.equal(session.state().capabilities.runEverything, true);
  assert.deepEqual(session.state().capabilities.sandboxes, ['enabled', 'disabled']);
  assert.equal(await turn('one'), '안녕');
  await session.set({ runEverything: true });
  assert.equal(session.state().runEverything, true);
  assert.equal(await turn('two'), '안녕', 'no --force: the app answers the requests');
  await session.send('approval'); await until(() => session.state().status === 'idle');
  assert.equal(session.state().pending, 0, 'the permission request was accepted without asking');
  await session.set({ runEverything: false });
  await session.send('approval'); await until(() => session.state().status === 'attention');
  assert.equal(session.state().pending, 1, 'turned off again: asks');
  await session.set({ runEverything: true });
  await until(() => session.state().pending === 0, 'a request already waiting is accepted when it is switched on');
  await until(() => session.state().status === 'idle');
  await session.set({ sandbox: 'disabled' });
  assert.equal(session.state().sandbox, 'disabled');
  assert.equal(await turn('three'), '안녕 [sandbox:disabled]');
  await session.set({ runEverything: false, sandbox: null });
  assert.equal(await turn('four'), '안녕', 'the flag is gone again');
  const meta = JSON.parse(await readFile(path.join(ctx.directory, 'chat/chat/meta.json')));
  assert.ok(!meta.runEverything); assert.equal(meta.sandbox ?? null, null);
  await assert.rejects(session.set({ sandbox: 'read-only' }), /지원하지 않는 샌드박스/);
  await assert.rejects(session.set({ runEverything: 'yes' }), /Run Everything/);
  // Sandbox changed mid-turn: stored now, the process is replaced after the turn.
  await session.send('hold'); await session.set({ sandbox: 'enabled' });
  assert.equal(session.state().restartPending, true);
  await session.interrupt(); await until(() => session.state().status === 'idle');
  assert.ok(!session.state().restartPending);
});

test('Run Everything is Cursor-only', async t => {
  const ctx = await setup(t, 'codex');
  await assert.rejects(ctx.session.set({ runEverything: true }), /Cursor에서만/);
});

test('Claude: a permission mode picked after the first message survives /clear and reopening', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-mode-'));
  const options = { directory, id: 'mode', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))] };
  let session = await openChatSession(options);
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });
  await session.send('hello'); await until(() => session.state().status === 'idle');
  await session.set({ permissionMode: 'auto' });
  await session.close();
  session = await openChatSession(options);
  assert.equal(session.state().permissionMode, 'auto');
});

test('new chat defaults apply only to modes and efforts the agent supports', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-defaults-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const open = (id, agent, defaults) => openChatSession({ directory, id, cwd: directory, agent, executable: process.execPath, executableArgs: [fixture, agent], defaults, onEvent() {} });
  const codex = await open('codex', 'codex', { permissionMode: 'plan', effort: 'medium' });
  assert.equal(codex.state().permissionMode, 'plan');
  assert.equal(codex.state().effort, 'medium');
  await codex.send('hello'); await until(() => codex.state().status === 'idle');
  assert.equal(codex.state().permissionMode, 'plan');
  assert.equal(codex.state().effort, null);
  const skipped = await open('cursor-skip', 'cursor', { permissionMode: 'acceptEdits' });
  assert.equal(skipped.state().permissionMode, 'default');
  const cursor = await open('cursor', 'cursor', { permissionMode: 'plan', effort: 'max' });
  assert.equal(cursor.state().permissionMode, 'plan');
  await cursor.send('hello'); await until(() => cursor.state().status === 'idle');
  assert.equal(cursor.state().effort, 'max');
  assert.equal(cursor.state().permissionMode, 'plan');
  await codex.close();
  await skipped.close();
  await cursor.close();
});

test('Cursor exposes context capability, window from config, and usage_update after a turn', async t => {
  const ctx = await setup(t, 'cursor'), session = ctx.session;
  assert.equal(session.state().capabilities.context, true);
  await session.send('hello');
  await until(() => session.state().status === 'idle');
  assert.equal(session.state().contextTokens, 14_000);
  assert.equal(session.state().contextWindow, 300_000);
});

test('Cursor reported token totals survive a child restart and a zero USD cost is available', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-cursor-tokens-'));
  const options = { directory, id: 'chat', cwd: directory, agent: 'cursor', executable: process.execPath, executableArgs: [fixture, 'cursor'],
    env: { CURSOR_CONFIG_DIR: path.join(directory, 'cursor'), CURSOR_API_KEY: '', FAKE_CURSOR_USAGE: '1' } };
  let session = await openChatSession(options);
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });
  await session.send('first'); await until(() => session.state().status === 'idle');
  assert.deepEqual(session.state().tokens, { input: 10, output: 2, cacheRead: 100, cacheCreate: 5 });
  assert.equal(session.state().costUsd, 0); assert.equal(session.state().capabilities.cost, true);
  await session.close(); session = await openChatSession(options);
  await session.send('second'); await until(() => session.state().status === 'idle');
  assert.deepEqual(session.state().tokens, { input: 20, output: 4, cacheRead: 200, cacheCreate: 10 });
  assert.equal(session.stats().tokens.input, 20);
});

test('listCommands reads argument-hint from project slash commands', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-cmds-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-cmds-home-'));
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const dir = path.join(cwd, '.claude', 'commands');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'review.md'), `---
description: Review a pull request
argument-hint: [pr-number]
---

Review PR $ARGUMENTS`);
  const list = await listCommands(cwd, home, { probe: false });
  const review = list.find(item => item.name === 'review');
  assert.equal(review?.description, 'Review a pull request');
  assert.equal(review?.hint, '[pr-number]');
});

test('Claude /compact ignores a startup result and drops the context gauge when its own turn finishes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-compact-'));
  const events = [];
  const session = await openChatSession({
    directory, id: 'compact', cwd: directory, executable: process.execPath,
    executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-compact-stream.mjs', import.meta.url))], onEvent: event => events.push(event),
  });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });
  await session.send('hello');
  await until(() => session.state().status === 'idle');
  assert.equal(session.state().contextTokens, 231097);
  await session.send('/compact');
  await until(() => events.some(event => event.kind === 'compact') && session.state().status === 'idle');
  const compact = events.find(event => event.kind === 'compact');
  const results = events.filter(event => event.kind === 'result' && event.turns === 0);
  assert.equal(results.length, 1, 'the unrelated result must not finish /compact');
  assert.ok(compact.seq < results[0].seq);
  assert.equal(session.state().contextTokens, 14613);
  await session.send('follow-up');
  await until(() => session.state().status === 'idle');
  assert.ok(results[0].seq < events.find(event => event.kind === 'user' && event.text === 'follow-up').seq);
  assert.equal(events.filter(event => event.kind === 'compact').length, 1);
  assert.deepEqual([compact.trigger, compact.preTokens, compact.postTokens], ['manual', 231097, 14613]);
  assert.ok(events.some(event => event.kind === 'delta' && event.phase === 'compacting' && event.active === true));
  assert.ok(events.some(event => event.kind === 'delta' && event.phase === 'compacting' && event.active === false));
  assert.ok(!events.some(event => event.kind === 'divider'), 'compacting keeps the history; only /clear starts over');
  assert.deepEqual(events.filter(event => event.kind === 'command_output').map(event => event.text), ['Compacted'], "the CLI's own output is shown once");
});

async function controlSession(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-control-'));
  const events = [], session = await openChatSession({ directory, id: 'control', cwd: directory, executable: process.execPath,
    executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url))], onEvent: event => events.push(event) });
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { session, events };
}

test('Claude Bypass: tool requests (MCP included) are allowed without a card, a question still waits for the user', async t => {
  const { session, events } = await controlSession(t);
  const cards = () => events.filter(event => event.kind === 'approval' && event.phase === 'request').map(event => event.tool);
  await session.send('mcpask'); await until(() => cards().length === 1);
  assert.deepEqual(cards(), ['mcp__srv__tool'], 'asked while the mode is not bypass');
  await session.approve('req-mcp', { allow: false }); await until(() => session.state().status === 'idle');
  await session.send('bypass'); await until(() => session.state().permissionMode === 'bypassPermissions' && session.state().status === 'idle');
  await session.send('mcpask');
  await until(() => events.some(event => event.kind === 'message' && JSON.stringify(event).includes('req-mcp=allow')));
  assert.deepEqual(cards(), ['mcp__srv__tool'], 'no new card in bypass');
  await until(() => session.state().status === 'idle');
  await session.send('plainask'); await until(() => cards().length === 2);
  assert.equal(cards()[1], 'AskUserQuestion', 'a question is never answered for the user');
});

test('an interrupted Claude turn stays open until its own result, so that result cannot end the next turn', async t => {
  const { session, events } = await controlSession(t);
  await session.send('slow');
  await session.interrupt();
  assert.equal(session.state().status, 'working', 'the interrupt answer alone does not close the turn');
  await until(() => session.state().status === 'idle');
  assert.equal(events.filter(event => event.kind === 'result').at(-1).status, 'interrupted');
  await session.send('hello');
  await until(() => session.state().status === 'idle');
  assert.equal(events.filter(event => event.kind === 'result').at(-1).status, 'success');
});

test('an approval left open when the child dies is withdrawn on the screen, and an answered request is not retried', async t => {
  const { session, events } = await controlSession(t);
  await session.send('hello');
  await until(() => session.state().status === 'idle');
  assert.equal(session.state().recoverable, false, 'a request with a successful result is answered');
  await assert.rejects(session.retry(), /다시 시도할 메시지가 없습니다/);
  await session.send('approve');
  await until(() => session.state().status === 'attention');
  await until(() => events.some(event => event.kind === 'approval' && event.phase === 'cancel' && event.requestId === 'req-1'));
  await until(() => session.state().status === 'idle');
  assert.equal(session.state().pending, 0);
  assert.equal(session.state().recoverable, true, 'the crashed request can be sent again');
});

test('Cursor: text before a tool keeps the id it streamed with, later text gets a new one, and repeated tool updates are stored only when they change', () => {
  const events = [], protocol = createChatProtocol('cursor', { write: async () => {}, emit: event => events.push(event) });
  const update = value => protocol.handle({ jsonrpc: '2.0', method: 'session/update', params: { update: value } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking' } });
  update({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'execute', title: 'ls', rawInput: { command: 'ls' }, status: 'pending' });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' });
  assert.equal(events.filter(event => event.kind === 'message' && event.id === 'c1').length, 1, 'a status-only update stores nothing');
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }] });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } });
  const textIds = [...new Set(events.filter(event => event.kind === 'delta' && event.phase === 'text').map(event => event.messageId))];
  assert.equal(textIds.length, 2);
  assert.deepEqual(events.find(event => event.kind === 'message' && event.id === textIds[0]).blocks, [{ type: 'text', text: 'Looking' }], 'stored under its streaming id');
  assert.ok(!events.some(event => event.kind === 'delta' && event.phase === 'reset'));
  assert.equal(events.filter(event => event.kind === 'tool_result').length, 1);
});

test('Cursor: a Task call and its subagent session become one agent with its own steps', () => {
  const events = [], protocol = createChatProtocol('cursor', { write: async () => {}, emit: event => events.push(event) });
  protocol.replayCursor('parent', []);
  const update = (sessionId, value) => protocol.handle({ jsonrpc: '2.0', method: 'session/update', params: { ...(sessionId ? { sessionId } : {}), update: value } });
  update(null, { sessionUpdate: 'tool_call', toolCallId: 'task-1', kind: 'other', title: 'Task: 파일 찾기', status: 'in_progress', rawInput: { _toolName: 'task', description: '파일 찾기', prompt: 'src를 봐', subagentType: 'explore' } });
  update(null, { sessionUpdate: 'subagent_spawned', subagentSessionId: 'sub-1', name: 'explore', task: 'src를 봐', _meta: { cursor: { toolCallId: 'task-1' } } });
  update('sub-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '찾는 중' } });
  update('sub-1', { sessionUpdate: 'tool_call', toolCallId: 'grep-1', kind: 'search', title: 'grep src', status: 'completed', rawInput: { pattern: 'src' } });
  update(null, { sessionUpdate: 'subagent_state_update', subagentSessionId: 'sub-1', state: 'completed', _meta: { cursor: { toolCallId: 'task-1' } } });
  const task = events.find(event => event.kind === 'message' && event.blocks?.[0]?.name === 'Task');
  assert.equal(task.blocks[0].input.description, '파일 찾기');
  assert.equal(task.blocks[0].input.subagent_type, 'explore');
  assert.equal(task.blocks[0].input.prompt, 'src를 봐');
  assert.ok(events.some(event => event.kind === 'task' && event.phase === 'start' && event.toolUseId === 'task-1' && event.agentType === 'explore'));
  assert.ok(events.some(event => event.kind === 'delta' && event.parentToolUseId === 'task-1' && event.text === '찾는 중'));
  const step = events.find(event => event.kind === 'message' && event.id === 'grep-1');
  assert.equal(step.parentToolUseId, 'task-1');
  assert.equal(step.blocks[0].name, 'grep src');
  assert.ok(events.some(event => event.kind === 'task' && event.phase === 'end' && event.toolUseId === 'task-1' && event.status === 'completed'));
  update('other-session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '무시' } });
  assert.ok(!events.some(event => event.text === '무시'));
});

test('Cursor: subagent history, a running state, a child permission, and a restarted session stay on that agent', () => {
  const lines = [], events = [];
  const protocol = createChatProtocol('cursor', { write: async line => { lines.push(JSON.parse(line)); }, emit: event => events.push(event) });
  protocol.replayCursor('parent', [
    { sessionId: 'sub-1', update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'sub-1', name: 'explore', task: '찾기', _meta: { cursor: { toolCallId: 'task-1' } } } },
    { sessionId: 'sub-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '기록' } } },
    { sessionId: 'sub-1', update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'sub-1', state: 'running', _meta: { cursor: { toolCallId: 'task-1' } } } },
  ]);
  assert.ok(events.some(event => event.kind === 'task' && event.phase === 'start' && event.toolUseId === 'task-1'));
  assert.ok(events.some(event => event.kind === 'delta' && event.text === '기록' && event.parentToolUseId === 'task-1'));
  assert.equal(events.filter(event => event.kind === 'task' && event.phase === 'end').length, 0);
  assert.ok(events.some(event => event.kind === 'message' && event.parentToolUseId === 'task-1' && event.blocks?.[0]?.text === '기록'));
  protocol.handle({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { sessionId: 'sub-1', toolCall: { title: 'Bash', rawInput: { command: 'ls' } }, options: [{ kind: 'allow_once', optionId: 'once' }] } });
  assert.ok(events.some(event => event.kind === 'approval' && event.phase === 'request' && event.requestId === '7'));
  protocol.handle({ jsonrpc: '2.0', id: 8, method: 'session/request_permission', params: { sessionId: 'other', toolCall: { title: 'Bash' }, options: [] } });
  assert.equal(lines.at(-1).error.code, -32602);
  const later = [];
  const next = createChatProtocol('cursor', { write: async () => {}, emit: event => later.push(event) });
  next.restore(protocol.snapshot());
  next.handle({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sub-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '이어짐' } } } });
  assert.ok(later.some(event => event.text === '이어짐' && event.parentToolUseId === 'task-1'));
});


for (const [label, dropped] of [
  ['unavailable', '\n\nError: RetriableError: [unavailable] HTTP 503'],
  ['stream closed before turnEnded', '\n\nError: RetriableError: Stream ended without turnEnded — connection likely dropped mid-stream'],
  ['dns', '\n\nError: RetriableError: [unavailable] getaddrinfo ENOTFOUND api2.cursor.sh'],
]) {
  test(`Cursor keeps the same turn open across repeated retriable backend drops (${label})`, async () => {
    const lines = [], events = [];
    const protocol = createChatProtocol('cursor', { write: line => { lines.push(line); return Promise.resolve(); }, emit: event => events.push(event), transportResumeDelay: () => 0 });
    const update = text => protocol.handle({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    const finish = async () => { protocol.handle({ jsonrpc: '2.0', id: JSON.parse(lines.at(-1)).id, result: { stopReason: 'end_turn' } }); await new Promise(resolve => setImmediate(resolve)); };
    await protocol.send('hello', []);
    update('작업 중');
    update(dropped);
    await finish();
    const prompts = lines.filter(line => line.includes('session/prompt'));
    assert.equal(prompts.length, 2, 'the dropped turn is resumed');
    assert.equal(events.filter(event => event.kind === 'result').length, 0, 'the turn stays open across the resume');
    assert.ok(!events.some(event => JSON.stringify(event).includes('RetriableError')), 'the raw error is not stored');
    assert.ok(events.some(event => event.kind === 'message' && event.blocks?.[0]?.text === '작업 중'));
    assert.ok(events.some(event => event.kind === 'delta' && event.phase === 'reconnecting' && event.active === true));
    update('이어서 끝');
    await finish();
    assert.equal(events.filter(event => event.kind === 'result').at(-1).status, 'success');
    await protocol.send('again', []);
    update(dropped);
    await finish();
    update(dropped);
    await finish();
    assert.equal(events.filter(event => event.kind === 'result').length, 1, 'repeated drops still keep the turn open');
    assert.ok(lines.filter(line => line.includes('session/prompt')).length >= 4);
    update('끝');
    await finish();
    assert.equal(events.filter(event => event.kind === 'result').at(-1).status, 'success');
  });
}

test('Claude: the picked model and Effort survive a reopen, and a chat keeps the model it ran with when the global default changes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-pin-')), configDir = path.join(directory, 'claude-config'), folder = chatFolder(directory, 'pin'), launches = [];
  await mkdir(configDir, { recursive: true }); await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'meta.json'), JSON.stringify({ configDir })); // an empty settings folder: no default model or Effort to read
  const options = { directory, id: 'pin', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))],
    spawnProcess: (command, args, spawnOptions) => { launches.push(args); return spawn(command, args, spawnOptions); } };
  let session = await openChatSession(options);
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await session.send('one'); await until(() => session.state().status === 'idle');
  assert.equal(session.state().model, 'fake-model');
  await session.set({ effort: 'low' }); // replaces the child; the next start must carry the model it ran with
  await session.send('two'); await until(() => session.state().turns === 2 && session.state().status === 'idle');
  assert.deepEqual(launches[1].slice(launches[1].indexOf('--model'), launches[1].indexOf('--model') + 2), ['--model', 'fake-model']);
  await session.set({ model: 'opus', effort: 'high' });
  await session.close(); session = await openChatSession(options); // the stored init event still says fake-model
  assert.equal(session.state().model, 'opus');
  assert.equal(session.state().effort, 'high');
});

// Chats in the pty-host: a server that stops (update, dev reload, background) leaves the agent running, and the next server goes on with the
// same turn. These run the real host; the agents are the fakes above.
async function startPtyHost(t) {
  const { newEndpoint } = await import('../apps/desktop/src/pty-host-files.js');
  const { connectPtyHost, helloPtyHost } = await import('../apps/local-server/src/pty-client.js');
  const endpoint = newEndpoint(), token = 'a'.repeat(32);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../apps/local-server/src/pty-host.js', import.meta.url))], { env: { ...process.env, ADE_PTY_ENDPOINT: endpoint, ADE_PTY_TOKEN: token }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let attempt = 0; ; attempt++) {
    try { const { socket } = await helloPtyHost({ endpoint, token, role: 'control', timeoutMs: 1000 }); socket.destroy(); break; }
    catch (error) { if (attempt > 50) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  return () => connectPtyHost({ endpoint, token });
}
// One "server": a host connection and the chat opened through it. `restart` detaches the chat, drops the connection and opens it again on a new one.
async function hostedChat(t, options) {
  const connect = await startPtyHost(t), directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-hosted-'));
  const events = [];
  let owner = await connect(), session = await openChatSession({ directory, id: 'hosted', cwd: directory, onEvent: event => events.push(event), procHost: owner, ...options });
  t.after(async () => { await session.close(); owner.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return {
    events, directory, get session() { return session; },
    async restart() { await session.detach(); owner.close(); owner = await connect(); session = await openChatSession({ directory, id: 'hosted', cwd: directory, onEvent: event => events.push(event), procHost: owner, ...options }); return session; }
  };
}
const claudeFake = { executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-stream.mjs', import.meta.url))] };

test('Claude in the pty-host: an approval open while the server is replaced is still there, and answering it reaches the same agent', { timeout: 30_000 }, async t => {
  const ctx = await hostedChat(t, claudeFake);
  await ctx.session.send('ask'); await until(() => ctx.session.state().status === 'attention');
  const pid = ctx.session.state().pending;
  const next = await ctx.restart();
  assert.equal(next.state().status, 'attention');
  const [approval] = next.replay().approvals;
  assert.equal(approval?.tool, 'AskUserQuestion', 'the card is still open');
  assert.equal(pid, 1);
  await next.approve(approval.requestId, { allow: true, answers: { [approval.questions[0].id]: ['A'] } });
  await until(() => next.state().status === 'idle');
  assert.ok(ctx.events.some(event => event.kind === 'message' && event.blocks?.some(block => /answers=/.test(block.text ?? ''))), 'the same agent got the answer');
  assert.equal(ctx.events.filter(event => event.kind === 'approval' && event.phase === 'request').length, 1, 'nothing was read twice');
});

test('Claude in the pty-host: a background subagent keeps running through the replacement and its hand-back turn ends the chat as usual', { timeout: 30_000 }, async t => {
  const ctx = await hostedChat(t, claudeFake);
  await ctx.session.send('background');
  await until(() => ctx.events.some(event => event.kind === 'result'));
  const next = await ctx.restart();
  await until(() => ctx.events.filter(event => event.kind === 'result').length === 2 && next.state().status === 'idle');
  const stored = next.replay().events;
  assert.equal(stored.filter(event => event.kind === 'message' && event.id === 'main2').length, 1);
  assert.equal(stored.filter(event => event.kind === 'message' && event.id === 'sub1').length, 1, 'output made while no server read it arrives once');
});

for (const agent of ['codex', 'cursor']) {
  test(`${agent} in the pty-host: a running turn survives the replacement and can still be interrupted`, { timeout: 30_000 }, async t => {
    const ctx = await hostedChat(t, { agent, executable: process.execPath, executableArgs: [fixture, agent] });
    await ctx.session.send('hold'); await until(() => ctx.session.state().status === 'working');
    const id = ctx.session.state().sessionId;
    const next = await ctx.restart();
    assert.equal(next.state().status, 'working');
    assert.equal(next.state().sessionId, id);
    await next.interrupt(); await until(() => next.state().status === 'idle');
    assert.ok(ctx.events.some(event => event.kind === 'result' && event.status === 'interrupted'));
    await next.send('again'); await until(() => next.state().status === 'idle');
    assert.equal(next.replay().events.filter(event => event.kind === 'result').length, 2);
  });
}

test('a chat whose agent is gone when the next server opens it says the turn was cut off, as a crash would', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-lost-'));
  let session = null;
  t.after(async () => { await session?.close(); await rm(directory, { recursive: true, force: true }); });
  const options = { directory, id: 'lost', cwd: directory, ...claudeFake };
  await (await openChatSession(options)).close();
  await writeFile(path.join(chatFolder(directory, 'lost'), 'live.json'), JSON.stringify({ v: 1, procKey: 'gone', ack: 0, turnOpen: true, approvals: [] }));
  session = await openChatSession({ ...options, procHost: { attachProc: async () => { throw new Error('pty-host request failed'); } } });
  assert.match(session.state().error, /이어받지 못했습니다/);
  assert.equal(session.state().status, 'idle');
  await assert.rejects(readFile(path.join(chatFolder(directory, 'lost'), 'live.json')), /ENOENT/, 'never taken over twice');
});

test('Claude: a chat switches between the CLI login and an API key; only the turns that ran on the key add to its API cost', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-auth-'));
  const costFile = path.join(directory, 'turns');
  let hasKey = true;
  const options = {
    directory, id: 'auth', cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-cost-stream.mjs', import.meta.url))],
    env: auth => ({ FAKE_COST_FILE: costFile, ...(auth === 'key' && { ANTHROPIC_API_KEY: 'sk-ant-test-12345678901234567890' }) }),
    keyAvailable: () => hasKey, defaults: { auth: 'login' }
  };
  const session = await openChatSession(options);
  let reopened;
  t.after(async () => { await reopened?.close(); await session.close(); await rm(directory, { recursive: true, force: true }); });
  const turn = async text => { await session.send(text); await until(() => session.state().status === 'idle'); };
  assert.deepEqual([session.state().auth, session.state().apiKey, session.state().lastAuth, session.state().apiCostUsd], ['login', false, null, 0]);
  await turn('one'); // a plan turn: it is not API money
  assert.deepEqual([session.state().lastAuth, session.state().apiCostUsd, session.state().costUsd], ['login', 0, 0.1]);
  await session.set({ auth: 'key' }); // nothing is asked or sent by switching
  assert.deepEqual([session.state().auth, session.state().apiKey, session.state().lastAuth], ['key', true, 'login']);
  await turn('two'); // on the key: 0.20 - 0.10 of the total is this turn's
  assert.deepEqual([session.state().lastAuth, session.state().costUsd], ['key', 0.2]);
  assert.ok(Math.abs(session.state().apiCostUsd - 0.1) < 1e-9);
  await session.reset(); // /clear keeps the login and the money already spent
  assert.deepEqual([session.state().auth, session.state().apiKey], ['key', true]);
  assert.ok(Math.abs(session.state().apiCostUsd - 0.1) < 1e-9);
  await session.close();
  reopened = await openChatSession({ ...options, defaults: { auth: 'login' } }); // a saved chat keeps its own, not the new default
  assert.deepEqual([reopened.state().auth, reopened.state().lastAuth, Math.round(reopened.state().apiCostUsd * 100)], ['key', 'key', 10]);
  await reopened.set({ auth: 'login' });
  assert.equal(reopened.state().apiKey, false);
  hasKey = false;
  await assert.rejects(reopened.set({ auth: 'key' }), /API 키가 등록되어 있지 않습니다/);
  await assert.rejects(reopened.set({ auth: 'nope' }), /잘못된 로그인 방식/);
  await assert.rejects(reopened.set({ auth: 'login', model: 'haiku' }), /다른 설정과 함께/);
});

test('Claude: the API Usage figure is what the key cost across every chat, and a chat on the key repaints when another one spends', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-keyspend-'));
  const spend = createApiSpend({ file: path.join(directory, 'api-key-spend.json') });
  const sessions = [], seenB = [];
  const open = async (id, key, onState) => {
    const session = await openChatSession({
      directory, id, cwd: directory, executable: process.execPath, executableArgs: [fileURLToPath(new URL('./fixtures/fake-claude-cost-stream.mjs', import.meta.url))],
      env: () => ({ FAKE_COST_FILE: path.join(directory, `turns-${id}`), ANTHROPIC_API_KEY: key }), keyAvailable: () => true, defaults: { auth: 'key' }, spend, onState
    });
    sessions.push(session); return session;
  };
  t.after(async () => { for (const session of sessions) await session.close(); await rm(directory, { recursive: true, force: true }); });
  const turn = async (session, text) => { await session.send(text); await until(() => session.state().status === 'idle'); };
  const a = await open('a', 'sk-ant-shared-12345678901234567890'), b = await open('b', 'sk-ant-shared-12345678901234567890', state => seenB.push(state.apiCostUsd));
  const other = await open('c', 'sk-ant-other-12345678901234567890');
  await turn(a, 'one');
  assert.ok(Math.abs(a.state().apiCostUsd - 0.1) < 1e-9);
  assert.ok(Math.abs(b.state().apiCostUsd - 0.1) < 1e-9, 'b never ran a turn but shows what the key cost');
  await until(() => seenB.some(value => Math.abs(value - 0.1) < 1e-9)); // b was told, not only able to be asked
  await turn(b, 'two');
  assert.ok(Math.abs(a.state().apiCostUsd - 0.2) < 1e-9);
  assert.ok(Math.abs(b.state().costUsd - 0.1) < 1e-9, 'the own cost of the chat stays its own');
  assert.equal(other.state().apiCostUsd, 0, 'another key keeps its own total');
  await spend.flush();
  const again = createApiSpend({ file: path.join(directory, 'api-key-spend.json') }); await again.load();
  assert.ok(Math.abs(again.total('claude', 'sk-ant-shared-12345678901234567890') - 0.2) < 1e-9, 'the total survives a restart');
});

test('Claude: an action auto mode blocked is recorded with its call, can be allowed for the chat, and retried by message', async t => {
  const { session, events } = await controlSession(t);
  await session.send('blocked'); await until(() => session.state().status === 'idle');
  const denied = events.find(event => event.kind === 'auto_denied');
  assert.deepEqual({ kind: denied.kind, toolUseId: denied.toolUseId, tool: denied.tool, input: denied.input, reason: denied.reason, rule: denied.rule },
    { kind: 'auto_denied', toolUseId: 'toolu_blk', tool: 'Bash', input: { command: 'git push origin main' }, reason: 'Merge Without Review', rule: 'Bash(git push origin main)' });
  await assert.rejects(session.allowBlocked(['toolu_nope']), /찾을 수 없는 차단 기록/);
  await session.allowBlocked(['toolu_blk'], { retry: true });
  await until(() => session.state().status === 'idle' && events.some(event => event.kind === 'message' && event.blocks.some(block => /^allow=/.test(block.text ?? ''))));
  const said = events.filter(event => event.kind === 'message').flatMap(event => event.blocks.map(block => block.text ?? '')).at(-1);
  assert.equal(said, 'allow=["Bash(git push origin main)"]', 'the CLI got the exact rule before the retry message');
  assert.equal(events.find(event => event.kind === 'denial_allow').retry, true);
  assert.match(events.filter(event => event.kind === 'user').at(-1).text, /직접 승인합니다[\s\S]*Bash: `git push origin main`/);
  await assert.rejects(session.allowBlocked(['toolu_blk']), /찾을 수 없는 차단 기록/, 'a retried refusal is settled');
});

test('Claude: allowing without a retry keeps the refusal open, and a command that cannot be one exact rule is only retried by message', async t => {
  const { session, events } = await controlSession(t);
  await session.send('blocked'); await until(() => session.state().status === 'idle');
  await session.allowBlocked(['toolu_blk'], { retry: false });
  assert.equal(events.filter(event => event.kind === 'user').length, 1, 'no message was sent');
  await session.allowBlocked(['toolu_blk'], { retry: true }); // still open: allowing alone is not an answer
  await until(() => session.state().status === 'idle');
  await session.send('blockedcompound'); await until(() => session.state().status === 'idle');
  assert.equal(events.filter(event => event.kind === 'auto_denied').at(-1).rule, null, 'a compound command has no exact rule');
  await assert.rejects(session.allowBlocked(['toolu_blk'], { retry: false }), /다시 시도"로만/);
});

test('Claude: "allow this tool always" is a rule for the whole tool that the chat keeps for every later child', async t => {
  const { session, events } = await controlSession(t), said = () => events.filter(event => event.kind === 'message').flatMap(event => event.blocks.map(block => block.text ?? '')).at(-1);
  await session.send('askmcp'); await until(() => session.state().status === 'attention');
  const [first] = session.replay().approvals;
  await session.approve(first.requestId, { allow: true, allowTool: true });
  await until(() => session.state().status === 'idle');
  assert.equal(said(), 'grants=[{"type":"addRules","rules":[{"toolName":"mcp__srv__run"}],"behavior":"allow","destination":"session"}]');
  // The CLI asks again (an `ask` rule in the user's settings beats any allow rule): the chat answers it itself, so no card appears.
  await session.send('askmcp'); await until(() => said() === 'grants=[]');
  await until(() => session.state().status === 'idle');
  assert.equal(session.replay().approvals.length, 0, 'no card for a tool allowed for this chat');
  assert.equal(events.filter(event => event.kind === 'approval' && event.phase === 'request').length, 1, 'only the first request ever became a card');
  await session.send('이걸 다시 실행해 줘'); await until(() => session.state().status === 'idle');
  assert.equal(said(), 'allow=["mcp__srv__run"]', 'the running child got the rule as flag settings too');
  await session.set({ effort: 'high' }); // a launch flag: the child is replaced and has forgotten its own session rules
  await session.send('다시 실행해'); await until(() => session.state().status === 'idle');
  assert.equal(said(), 'allow=["mcp__srv__run"]', 'the new child got the rule again');
});

test('Claude: denying a request grants nothing, even when the tool button was meant', async t => {
  const { session, events } = await controlSession(t);
  await session.send('askmcp'); await until(() => session.state().status === 'attention');
  const [ask] = session.replay().approvals;
  await session.approve(ask.requestId, { allow: false, allowTool: true });
  await until(() => session.state().status === 'idle');
  assert.equal(events.filter(event => event.kind === 'message').flatMap(event => event.blocks.map(block => block.text ?? '')).at(-1), 'grants=[]');
});
