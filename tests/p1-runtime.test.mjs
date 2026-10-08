import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { AdeEngine, AllowAllPolicy, DenyAllPolicy, ApprovalBroker } from '../packages/core/src/index.js';
import { LocalProcesses, createLocalRuntime } from '../packages/runtime-local/src/index.js';
import { CodexAgent } from '../packages/agent-codex/src/index.js';
import { ClaudeAgent } from '../packages/agent-claude/src/index.js';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ade-p1-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

async function git(root, ...args) {
  const result = await new LocalProcesses({ cwd: root }).exec('git', args, { cwd: root });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}

test('P1: Git stage/diff/unstage/commit uses policy-gated argv operations', async t => {
  const root = await workspace(t);
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.name', 'Test Agent');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(root, 'notes.txt'), 'v1');
  const engine = new AdeEngine({ runtime: createLocalRuntime({ root }), policy: new AllowAllPolicy() });
  await engine.gitStage(['notes.txt']);
  const commit = await engine.gitCommit('initial');
  assert.match(commit, /^[a-f0-9]{40}$/);
  await writeFile(path.join(root, 'notes.txt'), 'v2');
  assert.match(await engine.gitDiff(), /\+v2/);
  await engine.gitStage(['notes.txt']);
  assert.match(await engine.gitDiff('.', { staged: true }), /\+v2/);
  await engine.gitUnstage(['notes.txt']);
  assert.equal(await engine.gitDiff('.', { staged: true }), '');
  assert.equal((await engine.gitStatus()).clean, false);
});

test('P1: Git mutations fail closed with DenyAllPolicy', async t => {
  const root = await workspace(t);
  const engine = new AdeEngine({ runtime: createLocalRuntime({ root }), policy: new DenyAllPolicy() });
  await assert.rejects(engine.gitStage(['a']), /Permission denied: git.stage/);
  await assert.rejects(engine.gitCommit('x'), /Permission denied: git.commit/);
  await assert.rejects(engine.gitDiff(), /Permission denied: git.diff/);
});

test('P1: Git argv validates file lists and does not allow option injection', async t => {
  const root = await workspace(t);
  await git(root, 'init', '-q');
  const engine = new AdeEngine({ runtime: createLocalRuntime({ root }), policy: new AllowAllPolicy() });
  await assert.rejects(engine.gitStage([]), /valid file path/);
  await writeFile(path.join(root, '--hard'), 'text');
  await engine.gitStage(['--hard']);
  assert.match((await engine.gitStatus()).changes.join('\n'), /--hard/);
});

test('P1: terminal PTY port forwards keyboard, resize and lifecycle events', async t => {
  const root = await workspace(t);
  const writes = [], resizes = [], outputs = [], exits = [];
  let killed = false;
  const ptyFactory = { spawn(shell, argv, options) {
    assert.equal(shell, '/bin/sh');
    assert.equal(options.cwd, root);
    assert.equal(options.cols, 80);
    return {
      pid: 241, onData(fn) { fn('안녕'); return { dispose() {} }; },
      onExit(fn) { fn({ exitCode: 0 }); return { dispose() {} }; },
      write(data) { writes.push(data); }, resize(c, r) { resizes.push([c,r]); }, kill() { killed = true; }
    };
  } };
  const engine = new AdeEngine({ runtime: createLocalRuntime({ root, shell: '/bin/sh', ptyFactory }), policy: new AllowAllPolicy() });
  const pty = await engine.openTerminal({ cwd: root, cols: 80, rows: 24 });
  pty.onData(text => outputs.push(text));
  pty.onExit(event => exits.push(event.exitCode));
  pty.write('pwd\r');
  pty.resize(120, 40);
  assert.throws(() => pty.resize(0, 20), /Invalid terminal resize/);
  pty.close();
  assert.deepEqual([pty.pid, writes, resizes, outputs, exits, killed], [241, ['pwd\r'], [[120,40]], ['안녕'], [0], true]);
});

test('P1: approval broker denies by default and clears expired requests', async () => {
  const broker = new ApprovalBroker({ timeoutMs: 25 });
  const notified = [];
  const rejected = broker.request({ sessionId: 'a', tool: 'shell', summary: 'rm file', onRequest: x => notified.push(x) });
  await assert.rejects(rejected, /timed out/);
  assert.equal(notified.length, 1);
  assert.deepEqual(broker.pending, []);
  assert.equal(broker.decide(notified[0].id, true), false);
});

test('P1: unsupported interactive CLI approvals fail before running a subprocess', async t => {
  const root = await workspace(t);
  const engine = new AdeEngine({ runtime: createLocalRuntime({ root }), policy: new AllowAllPolicy(), agents: [new CodexAgent(), new ClaudeAgent()] });
  await assert.rejects(engine.runAgent('codex', 'task', { approvalMode: 'interactive' }).next(), /does not support interactive approvals/);
  await assert.rejects(engine.runAgent('claude', 'task', { approvalMode: 'interactive' }).next(), /does not support interactive approvals/);
});

test('P1: approval-aware agent is permitted only after explicit trusted decision', async t => {
  const root = await workspace(t);
  const agent = { id: 'approval-aware', capabilities: { interactiveApprovals: true }, async *run({ requestApproval }) {
    await requestApproval({ tool: 'git.commit', summary: 'Commit staged files' });
    yield { kind: 'tool', tool: 'git.commit', status: 'approved' };
  } };
  const engine = new AdeEngine({ runtime: createLocalRuntime({ root }), policy: new AllowAllPolicy(), agents: [agent] });
  let captured;
  const stream = engine.runAgent('approval-aware', 'commit', { approvalMode: 'interactive', onApprovalRequest: r => captured = r });
  assert.equal((await stream.next()).value.phase, 'started');
  const pending = stream.next();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.approvalRequests.length, 1);
  assert.equal(engine.approvalRequests[0].id, captured.id);
  assert.equal(await engine.decideApproval(captured.id, true), true);
  assert.equal((await pending).value.status, 'approved');
  assert.equal((await stream.next()).value.phase, 'completed');
  assert.equal(engine.approvalRequests.length, 0);
});

test('P1: event identity, sequence and native provider thread ID are authoritative', async t => {
  const root = await workspace(t);
  const agent = { id: 'spy', async *run() {
    yield { kind: 'session', threadId: 'native-123', sessionId: 'injected', agent: 'wrong', sequence: -100, timestamp: 0 };
    yield { kind: 'text', text: 'ok' };
  } };
  const engine = new AdeEngine({ runtime: createLocalRuntime({ root }), policy: new AllowAllPolicy(), agents: [agent] });
  const events = [];
  for await (const event of engine.runAgent('spy', 'hello')) events.push(event);
  assert.deepEqual(events.map(e=>e.sequence), [1,2,3,4]);
  assert.ok(events.every(e=>e.sessionId === events[0].sessionId && e.agent === 'spy' && e.timestamp > 0));
  assert.equal(engine.sessions[0].nativeThreadId, 'native-123');
  assert.equal(engine.sessions[0].eventCount, 4);
});

test('P1: Codex CLI adapter consumes actual spawned JSONL stream without credentials', async t => {
  const root = await workspace(t);
  const argv = [];
  const source = `let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'cx1'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:input}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2}}));});`;
  const agent = new CodexAgent({ spawnProcess(executable,args,opts) { argv.push(...args); return spawn(process.execPath,['-e',source],opts); } });
  const events = [];
  for await(const event of agent.run({ prompt: '안녕하세요', cwd: root, threadId: 'old-thread' })) events.push(event);
  assert.equal(events.find(x=>x.kind==='session').threadId,'cx1');
  assert.equal(events.find(x=>x.kind==='text').text,'안녕하세요');
  assert.ok(argv.includes('resume') && argv.includes('old-thread'));
});

test('P1: Claude CLI adapter consumes actual spawned JSONL stream without credentials', async t => {
  const root = await workspace(t);
  const argv = [];
  const source = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',session_id:'claude1'}));console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:input}}}));console.log(JSON.stringify({type:'result',session_id:'claude1',is_error:false,result:input,usage:{output_tokens:5}}));});`;
  const agent = new ClaudeAgent({ spawnProcess(executable,args,opts) { argv.push(...args); return spawn(process.execPath,['-e',source],opts); } });
  const events = [];
  for await(const event of agent.run({ prompt: '설명해줘', cwd: root, threadId: 'old-thread' })) events.push(event);
  assert.equal(events.find(x=>x.kind==='session').threadId,'claude1');
  assert.equal(events.find(x=>x.kind==='text').text,'설명해줘');
  assert.ok(argv.includes('--resume') && argv.includes('old-thread'));
});

test('P1: stopping consumption early marks agent cancelled and closes its controller', async t => {
  const root = await workspace(t);
  let stopped = false;
  const agent = { id: 'stream', async *run({ signal }) {
    try { yield { kind: 'text', text: 'partial' }; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
    finally { stopped = true; }
  } };
  const engine = new AdeEngine({ runtime: createLocalRuntime({ root }), policy: new AllowAllPolicy(), agents: [agent] });
  const iterator = engine.runAgent('stream', 'hello');
  await iterator.next();
  await iterator.next();
  await iterator.return();
  assert.equal(engine.sessions[0].status, 'cancelled');
  assert.equal(engine.sessions[0].controller, undefined);
  assert.equal(stopped, true);
});
