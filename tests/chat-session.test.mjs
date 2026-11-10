import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { openChatSession, seedChat, probeAgentModels } from '../apps/local-server/src/chat.js';
import { codexPermissions, createChatProtocol } from '../apps/local-server/src/chat-rpc.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-chat-rpc.mjs', import.meta.url));
const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('chat did not settle'); };
async function setup(t, agent) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-test-'));
  const events = [], options = { directory, id: 'chat', cwd: directory, agent, executable: process.execPath, executableArgs: [fixture, agent], onEvent: event => events.push(event) };
  let session = await openChatSession(options);
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, events, options, get session() { return session; }, async reopen() { await session.close(); session = await openChatSession(options); return session; } };
}
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
    if (agent === 'cursor') { assert.throws(() => session.branchSnapshot('unknown'), /분기를 제공/); await assert.rejects(session.set({ addDirs: [] }), /추가 작업 폴더/); }
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
    assert.match(session.state().error, /종료/);
    await session.send('recovered'); await until(() => session.state().status === 'idle');
    assert.equal(session.state().error, null);
  });
}
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

test('RPC requests time out and pending requests reject on disconnection', async () => {
  const protocol = createChatProtocol('codex', { write: async () => {}, emit() {} });
  await assert.rejects(protocol.request('no-response', {}, 5), /응답 시간이 초과/);
  const pending = protocol.request('disconnected');
  protocol.dispose();
  await assert.rejects(pending, /연결이 종료/);
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
  await assert.rejects(restored.set({ configOption: { configId: 'fast', value: 'false' } }), /응답이 끝난 뒤/);
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

test('Cursor advertises agent/plan/ask and switches between them', async t => {
  const ctx = await setup(t, 'cursor'), session = ctx.session;
  const info = await probeAgentModels(ctx.options);
  session.loadCatalog(info.catalog, info.models[''], info.configOptions);
  assert.deepEqual(session.state().capabilities.permissionModes, ['default', 'plan', 'ask']);
  for (const permissionMode of ['plan', 'ask', 'default']) { await session.set({ permissionMode }); assert.equal(session.state().permissionMode, permissionMode); }
});
