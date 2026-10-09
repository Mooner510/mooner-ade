import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdeEngine, AllowAllPolicy } from '../packages/core/src/index.js';
import { parseAgentEvent, AGENT_EVENT_SCHEMA_VERSION, AdeError } from '../packages/protocol/src/index.js';
import { FileSessionStore } from '../packages/session-store/src/index.js';
import { RecordedAgentRunner } from '../packages/session-runner/src/index.js';

const runtime = { workspace: {}, processes: {}, git: {}, terminal: {} };
async function setup(t, agent) {
  const folder = await mkdtemp(join(tmpdir(), 'ade-contract-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const engine = new AdeEngine({ runtime, policy: new AllowAllPolicy(), agents: [agent] });
  const store = new FileSessionStore(folder);
  return { engine, store, runner: new RecordedAgentRunner({ engine, store }), folder };
}

const event = { schemaVersion: 1, kind: 'text', text: '안녕', sessionId: 'session_1', agent: 'codex', sequence: 1, timestamp: 1000 };

test('canonical wire events have stable version and preserve provider extensions', () => {
  assert.equal(AGENT_EVENT_SCHEMA_VERSION, 1);
  assert.deepEqual(parseAgentEvent({ ...event, custom: { provider: 'codex' } }).custom, { provider: 'codex' });
});
test('unknown/future schema versions and malformed lifecycle payloads fail closed', () => {
  for (const broken of [{ ...event, schemaVersion: 2 }, { ...event, schemaVersion: 0 }, { ...event, schemaVersion: null }]) {
    assert.throws(() => parseAgentEvent(broken), e => e instanceof AdeError && e.code === 'UNSUPPORTED_AGENT_EVENT_VERSION');
  }
  assert.throws(() => parseAgentEvent({ ...event, sequence: 0 }), /Invalid ADE agent event/);
  assert.throws(() => parseAgentEvent({ ...event, kind: 'lifecycle', phase: 'success' }), /Malformed/);
  assert.throws(() => parseAgentEvent({ ...event, kind: 'text', text: undefined }), /Malformed/);
  assert.throws(() => parseAgentEvent({ ...event, kind: 'unrecognized' }), /Invalid/);
});
test('legacy events explicitly upgrade to v1 but not silently in strict mode', () => {
  const { schemaVersion, ...legacy } = event;
  assert.throws(() => parseAgentEvent(legacy), /Unsupported/);
  assert.equal(parseAgentEvent(legacy, { allowLegacy: true }).schemaVersion, 1);
  assert.equal(legacy.schemaVersion, undefined);
});
test('engine overrides untrusted provider-controlled schema version and identity', async t => {
  const { runner } = await setup(t, { id: 'spy', async *run() {
    yield { ...event, schemaVersion: 999, sessionId: 'wrong', sequence: 900, timestamp: 2 };
  } });
  const entries = [];
  for await (const entry of runner.runAgent('spy', 'hello')) entries.push(entry);
  assert.deepEqual(entries.map(x => x.sequence), [1,2,3]);
  assert.ok(entries.every(x => x.schemaVersion === 1 && x.sessionId === entries[0].sessionId && x.agent === 'spy'));
  assert.equal((await runner.getSession(entries[0].sessionId)).session.status, 'completed');
});
test('recorded runner replays exact event timestamp and version from new store', async t => {
  const { runner } = await setup(t, { id: 'mock', async *run() { yield { kind: 'text', text: 'Hi' }; } });
  const delivered = [];
  for await (const entry of runner.runAgent('mock', 'hello')) delivered.push(entry);
  assert.deepEqual(await runner.replay(delivered[0].sessionId), delivered);
});
test('recorded runner upgrades previously saved pre-schema events on replay', async t => {
  const { store, runner } = await setup(t, { id: 'mock', async *run() {} });
  await store.create({ id: 'old', agentId: 'mock', status: 'running' });
  await store.append('old', { kind: 'text', text: 'past', sessionId: 'old', agent: 'mock', timestamp: 1234 });
  const replay = await runner.replay('old');
  assert.equal(replay[0].schemaVersion, 1);
  assert.equal(replay[0].timestamp, 1234);
  assert.equal((await store.replay('old'))[0].schemaVersion, undefined);
});
test('early stream disposal is immediately interrupted and cannot be resumed implicitly', async t => {
  const { runner } = await setup(t, { id: 'partial', async *run() { yield { kind: 'text', text: 'unfinished' }; } });
  const stream = runner.runAgent('partial', 'hi');
  const first = await stream.next();
  await stream.return();
  const status = (await runner.getSession(first.value.sessionId)).session.status;
  assert.equal(status, 'interrupted');
  await assert.rejects(runner.getSession(first.value.sessionId).then(s => s && runner.replay(s.session.id, { afterSequence: -2 })), /Invalid cursor/);
});
test('a corrupted record with a gap in event sequencing is refused', async t => {
  const { store, folder } = await setup(t, { id: 'mock', async *run() {} });
  await store.create({ id: 'corrupt', status: 'running' });
  await store.append('corrupt', { kind: 'text', text: 'valid' });
  const json = await store.load('corrupt');
  json.events[0].sequence = 8;
  await writeFile(join(folder,'corrupt.json'), JSON.stringify(json));
  await assert.rejects(store.replay('corrupt'), /malformed session record/);
});
test('terminal session cannot be silently downgraded to running', async t => {
  const { store } = await setup(t, { id: 'mock', async *run() {} });
  await store.create({ id: 'done', status: 'running' });
  await store.setStatus('done', 'completed');
  await assert.rejects(store.setStatus('done', 'running'), /Cannot transition terminal session/);
});

test('shared v1 contract fixture parses (kept byte-identical with other consumers)', async () => {
  const { readFile } = await import('node:fs/promises');
  const lines = (await readFile(new URL('./fixtures/agent-events.v1.jsonl', import.meta.url), 'utf8')).trim().split('\n');
  const kinds = new Set(lines.map(line => parseAgentEvent(JSON.parse(line)).kind));
  assert.deepEqual([...kinds].sort(), ['approval', 'error', 'lifecycle', 'progress', 'raw', 'result', 'session', 'text', 'tool', 'usage']);
});
