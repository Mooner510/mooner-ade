import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexAppAgent, ClaudeSdkAgent, CodexConnection } from '../apps/local-server/src/agents.js';

const fake = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const codex = (...args) => new CodexAppAgent({ command: [process.execPath, fake, ...args] });
const collect = async iterator => { const events = []; for await (const event of iterator) events.push(event); return events; };
const request = (allow, extra = {}) => ({
  prompt: 'hi', cwd: process.cwd(), signal: new AbortController().signal, ...extra,
  requestApproval: async ({ onRequest }) => { onRequest({ id: 'a1' }); return allow; }
});
const params = events => events.find(e => e.kind === 'raw' && e.data.method === 'test/params').data.params;

test('codex: approval accepted, runs in workspace-write with untrusted policy', async () => {
  const events = await collect(codex().run(request(true)));
  assert.deepEqual(events.filter(e => e.kind === 'approval').map(e => e.phase), ['requested', 'approved']);
  assert.equal(events.find(e => e.kind === 'text').text, 'decision=accept');
  assert.equal(events.at(-1).kind, 'result');
  assert.equal(events.find(e => e.kind === 'session').threadId, 't1');
  assert.deepEqual([params(events).approvalPolicy, params(events).sandbox], ['untrusted', 'workspace-write']);
});

test('codex: denied approval declines the command', async () => {
  const events = await collect(codex().run(request(false)));
  assert.equal(events.find(e => e.kind === 'text').text, 'decision=decline');
  assert.equal(events.filter(e => e.kind === 'approval').at(-1).phase, 'denied');
});

test('codex: resume uses the saved thread, fullAccess disables approval and sandbox', async () => {
  const events = await collect(codex().run(request(true, { threadId: 't9', fullAccess: true })));
  assert.equal(params(events).method, 'thread/resume');
  assert.equal(events.find(e => e.kind === 'session').threadId, 't9');
  assert.deepEqual([params(events).approvalPolicy, params(events).sandbox], ['never', 'danger-full-access']);
});

test('codex: missing login fails with an actionable message', async () => {
  await assert.rejects(collect(codex('nologin').run(request(true))), /codex login/);
});

function fakeQuery(seen) {
  return ({ prompt, options }) => (async function* () {
    seen.options = options;
    yield { type: 'system', subtype: 'init', session_id: 's1' };
    seen.permission = await options.canUseTool('Bash', { command: 'ls' }, {});
    yield { type: 'result', is_error: false, result: 'ok', session_id: 's1' };
  })();
}

test('claude: canUseTool goes through approval and maps allow/deny', async () => {
  for (const allow of [true, false]) {
    const seen = {};
    const events = await collect(new ClaudeSdkAgent({ query: fakeQuery(seen) }).run(request(allow)));
    assert.equal(seen.permission.behavior, allow ? 'allow' : 'deny');
    assert.deepEqual(events.filter(e => e.kind === 'approval').map(e => e.phase), ['requested', allow ? 'approved' : 'denied']);
    assert.equal(events.find(e => e.kind === 'session').threadId, 's1');
    assert.equal(seen.options.permissionMode, 'default');
  }
});

test('claude: fullAccess bypasses permissions and resume is forwarded', async () => {
  const seen = {};
  await collect(new ClaudeSdkAgent({ query: fakeQuery(seen) }).run(request(true, { fullAccess: true, threadId: 's7' })));
  assert.equal(seen.options.permissionMode, 'bypassPermissions');
  assert.equal(seen.options.resume, 's7');
});

test('codex: model/list reads paginated data and hides hidden models', async () => {
  const connection = new CodexConnection(process.cwd(), [process.execPath, fake]);
  try {
    await connection.initialize();
    assert.deepEqual((await connection.listModels()).map(m => [m.id, m.efforts]), [['a', ['low']], ['b', []]]);
  } finally { connection.close(); }
});
