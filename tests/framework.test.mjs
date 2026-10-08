import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdeEngine, AllowAllPolicy, DenyAllPolicy } from '../packages/core/src/index.js';
import { envelope, parseEnvelope } from '../packages/protocol/src/index.js';
import { LocalWorkspace, LocalProcesses, createLocalRuntime } from '../packages/runtime-local/src/index.js';
import { JsonlCliAgent, parseJsonLines } from '../packages/agent-core/src/index.js';
import { CodexAgent, buildCodexArgs, normalizeCodex } from '../packages/agent-codex/src/index.js';
import { ClaudeAgent, buildClaudeArgs, normalizeClaude } from '../packages/agent-claude/src/index.js';

async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mooner-ade-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('versioned protocol validates messages', () => {
  const message = envelope('agent', 'text', { text: 'hello' });
  assert.equal(parseEnvelope(message).v, 1);
  assert.throws(() => parseEnvelope({ ...message, v: 2 }), /Unsupported/);
  assert.throws(() => envelope('Bad channel', 'text', {}), /Invalid/);
});

test('engine refuses operations unless policy explicitly permits', async t => {
  const runtime = createLocalRuntime({ root: await temporary(t) });
  const engine = new AdeEngine({ runtime, policy: new DenyAllPolicy() });
  await assert.rejects(engine.listFiles(), /Permission denied/);
  await assert.rejects(engine.execute(process.execPath, ['-v']), /Permission denied/);
});

test('trusted engine writes and reads local files', async t => {
  const root = await temporary(t);
  const engine = new AdeEngine({ runtime: createLocalRuntime({ root }), policy: new AllowAllPolicy() });
  await engine.writeFile('src/demo.txt', 'ADE!');
  assert.equal(await engine.readFile('src/demo.txt'), 'ADE!');
  assert.deepEqual(await engine.listFiles('src'), [{ name: 'demo.txt', kind: 'file' }]);
});

test('root-scoped path rejects directory traversal', async t => {
  const root = await temporary(t);
  const workspace = new LocalWorkspace(root, { scope: 'root' });
  await assert.rejects(workspace.readFile('../outside'), /escape/);
  await assert.rejects(workspace.writeFile(path.join(os.tmpdir(), 'outside.txt'), 'x'), /escape/);
});

test('root-scoped path rejects symlink escapes for reads and writes', async t => {
  const root = await temporary(t);
  const outside = await temporary(t);
  await writeFile(path.join(outside, 'secret'), 'private');
  await symlink(outside, path.join(root, 'escape'));
  const workspace = new LocalWorkspace(root, { scope: 'root' });
  await assert.rejects(workspace.readFile('escape/secret'), /symlink escape/);
  await assert.rejects(workspace.writeFile('escape/new', 'x'), /symlink escape/);
});

test('unrestricted local workspace supports absolute paths', async t => {
  const root = await temporary(t);
  const outside = await temporary(t);
  const workspace = new LocalWorkspace(root);
  await workspace.writeFile(path.join(outside, 'data.txt'), 'ok');
  assert.equal(await readFile(path.join(outside, 'data.txt'), 'utf8'), 'ok');
});

test('process execution uses argv without shell interpolation', async () => {
  const proc = new LocalProcesses();
  const result = await proc.exec(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'hello; echo hacked']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello; echo hacked');
});

test('process timeout and output limits are enforced', async () => {
  const proc = new LocalProcesses();
  await assert.rejects(proc.exec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 }), /timed out/);
  await assert.rejects(proc.exec(process.execPath, ['-e', "process.stdout.write('x'.repeat(200))"], { maxOutputBytes: 20 }), /limit/);
});

test('process supports AbortSignal', async () => {
  const controller = new AbortController();
  const proc = new LocalProcesses();
  const pending = proc.exec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
});

test('JSONL parser handles split UTF-8 bytes and trailing line', async function () {
  const source = Buffer.from('{"text":"무너"}\n{"ok":true}');
  async function* chunks() { for (let i = 0; i < source.length; i += 2) yield source.subarray(i, i + 2); }
  const rows = [];
  for await (const row of parseJsonLines(chunks())) rows.push(row);
  assert.deepEqual(rows, [{ text: '무너' }, { ok: true }]);
});

test('JSONL parser rejects malformed records and oversized lines', async () => {
  await assert.rejects(async () => { for await (const _ of parseJsonLines((async function* () { yield '{oops}\n'; })())) {} }, /malformed/);
  await assert.rejects(async () => { for await (const _ of parseJsonLines((async function* () { yield '{"a":123}\n'; })(), { maxLineBytes: 4 })) {} }, /size limit/);
});

test('Codex adapter maps thread, tool, text, usage events', () => {
  assert.deepEqual(normalizeCodex({ type: 'thread.started', thread_id: 'c1' }), [{ kind: 'session', threadId: 'c1' }]);
  assert.equal(normalizeCodex({ type: 'item.completed', item: { type: 'agent_message', text: '안녕' } })[0].text, '안녕');
  assert.equal(normalizeCodex({ type: 'item.started', item: { type: 'command_execution', command: 'pwd' } })[0].kind, 'tool');
  assert.equal(normalizeCodex({ type: 'turn.completed', usage: { input_tokens: 10 } })[0].kind, 'usage');
  assert.ok(buildCodexArgs({ fullAccess: true }).includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(buildCodexArgs({ threadId: 'abc' }).includes('resume'));
});

test('Claude adapter maps streaming text and result', () => {
  const delta = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } } };
  assert.equal(normalizeClaude(delta)[0].text, 'hello');
  assert.equal(normalizeClaude({ type: 'result', session_id: 's1', is_error: false, result: 'done' }).at(-1).status, 'success');
  assert.deepEqual(buildClaudeArgs({ threadId: 's1', maxTurns: 3 }).slice(-4), ['--resume', 's1', '--max-turns', '3']);
  assert.ok(buildClaudeArgs({ fullAccess: true }).includes('--dangerously-skip-permissions'));
});

test('JSONL CLI backend streams from a real subprocess', async () => {
  const agent = new JsonlCliAgent({ id: 'mock', executable: process.execPath,
    buildArgs: () => ['-e', "process.stdout.write(JSON.stringify({type:'text',text:'works'})+'\\n')"],
    normalize: raw => [{ kind: raw.type, text: raw.text }] });
  const events = [];
  for await (const event of agent.run({ prompt: 'hello' })) events.push(event);
  assert.deepEqual(events, [{ kind: 'text', text: 'works' }]);
});

test('CLI errors surface nonzero exit and stderr', async () => {
  const agent = new JsonlCliAgent({ id: 'mock', executable: process.execPath,
    buildArgs: () => ['-e', "process.stderr.write('no auth');process.exit(3)"], normalize: () => [] });
  await assert.rejects(async () => { for await (const _ of agent.run({ prompt: 'hello' })) {} }, /no auth/);
});

test('engine tracks successful agent lifecycle and session', async t => {
  const agent = { id: 'mock', async *run() { yield { kind: 'text', text: 'ready' }; } };
  const engine = new AdeEngine({ runtime: createLocalRuntime({ root: await temporary(t) }), policy: new AllowAllPolicy(), agents: [agent] });
  const events = [];
  for await (const event of engine.runAgent('mock', 'say hello')) events.push(event);
  assert.deepEqual(events.map(event => event.phase).filter(Boolean), ['started', 'completed']);
  assert.equal(engine.sessions[0].status, 'completed');
  assert.equal(engine.sessions[0].controller, undefined);
});

test('engine handles agent failure deterministically', async t => {
  const agent = { id: 'broken', async *run() { throw new Error('no auth'); } };
  const engine = new AdeEngine({ runtime: createLocalRuntime({ root: await temporary(t) }), policy: new AllowAllPolicy(), agents: [agent] });
  const events = [];
  for await (const event of engine.runAgent('broken', 'hello')) events.push(event);
  assert.equal(events.at(-1).phase, 'failed');
  assert.ok(events.some(event => event.kind === 'error' && event.message === 'no auth'));
});

test('engine cancellation transitions session to cancelled', async t => {
  const agent = { id: 'pending', async *run({ signal }) {
    yield { kind: 'progress' };
    await new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } };
  const engine = new AdeEngine({ runtime: createLocalRuntime({ root: await temporary(t) }), policy: new AllowAllPolicy(), agents: [agent] });
  const stream = engine.runAgent('pending', 'hello');
  await stream.next();
  await stream.next();
  const id = engine.sessions[0].id;
  assert.equal(engine.stopAgent(id), true);
  const remaining = [];
  for await (const event of stream) remaining.push(event);
  assert.equal(remaining.at(-1).phase, 'cancelled');
  assert.equal(engine.stopAgent(id), false);
});

test('Git status reports clean initialized repository', async t => {
  const root = await temporary(t);
  const proc = new LocalProcesses({ cwd: root });
  let result = await proc.exec('git', ['init', '-q', root]);
  assert.equal(result.exitCode, 0);
  const engine = new AdeEngine({ runtime: createLocalRuntime({ root }), policy: new AllowAllPolicy() });
  const status = await engine.gitStatus();
  assert.equal(status.clean, true);
});

test('CLI adapter constructors expose the expected IDs', () => {
  assert.equal(new CodexAgent().id, 'codex');
  assert.equal(new ClaudeAgent().id, 'claude');
});
