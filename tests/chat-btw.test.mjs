import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { BTW_DEFAULTS, buildBtwCommand, btwPrompt, conversationDigest, parseBtwOutput, runBtw } from '../apps/local-server/src/chat-btw.js';

// A fake child: records what was written to stdin, then answers like the real CLI would.
function fakeSpawn({ stdout = '', stderr = '', code = 0, hang = false } = {}) {
  const calls = [];
  const spawnProcess = (file, args, options) => {
    const proc = new EventEmitter(); let input = '';
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.killed = false; proc.kill = () => { proc.killed = true; };
    proc.stdin = Object.assign(new EventEmitter(), { end(text) { input = text ?? ''; if (hang) return; setImmediate(() => { if (stdout) proc.stdout.emit('data', stdout); if (stderr) proc.stderr.emit('data', stderr); proc.emit('close', code); }); } });
    calls.push({ file, args, options, get input() { return input; } });
    return proc;
  };
  return { spawnProcess, calls };
}

test('defaults: Haiku 5.5 low, GPT-6 Luna low, Composer 2.5 without Fast', () => {
  assert.deepEqual(BTW_DEFAULTS.claude, { model: 'claude-haiku-5-5', effort: 'low' });
  assert.deepEqual(BTW_DEFAULTS.codex, { model: 'gpt-6-luna', effort: 'low' });
  assert.equal(BTW_DEFAULTS.cursor.model, 'composer-2.5[fast=false]');
});

test('claude: forks the session on Haiku low with no tools, never persisting; the question goes in on stdin', () => {
  const { args, input } = buildBtwCommand({ agent: 'claude', sessionId: 's-1', prompt: 'Q' });
  assert.deepEqual(args.slice(0, 3), ['--resume', 's-1', '--fork-session']);
  assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(input, 'Q');
  assert.ok(!buildBtwCommand({ agent: 'claude', prompt: 'Q' }).args.includes('--resume')); // a chat with no session yet
});

test('codex: exec fork, ephemeral and read-only, GPT-6 Luna low, prompt from stdin', () => {
  const { args, input } = buildBtwCommand({ agent: 'codex', sessionId: 'thread-1', prompt: 'Q' });
  assert.deepEqual(args.slice(0, 3), ['exec', 'fork', 'thread-1']);
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-luna');
  assert.ok(args.includes('model_reasoning_effort="low"') && args.includes('sandbox_mode="read-only"') && args.includes('--ephemeral'));
  assert.equal(args.at(-1), '-'); assert.equal(input, 'Q');
});

test('cursor: ask mode on Composer 2.5 (no Fast), a fresh session, prompt after `--`', () => {
  const { args, input } = buildBtwCommand({ agent: 'cursor', sessionId: 'c-1', prompt: '--force rm' });
  assert.ok(!args.includes('--resume') && !args.includes('c-1')); // resuming would write into the real chat
  assert.equal(args[args.indexOf('--mode') + 1], 'ask');
  assert.equal(args[args.indexOf('--model') + 1], 'composer-2.5[fast=false]');
  assert.deepEqual(args.slice(-2), ['--', '--force rm']); assert.equal(input, null);
});

test('overrides win over the defaults; an unknown agent is refused', () => {
  assert.equal(buildBtwCommand({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', prompt: 'Q' }).args.join(' ').includes('--model claude-sonnet-5-5 --effort medium'), true);
  assert.throws(() => buildBtwCommand({ agent: 'nope', prompt: 'Q' }), /지원하지 않습니다/);
});

test('digest: user and agent text only, restarts at /clear, keeps the newest end', () => {
  const events = [
    { kind: 'user', text: 'old' }, { kind: 'divider' },
    { kind: 'user', text: '함수 이름 바꿔줘' }, { kind: 'user', text: '/cost' },
    { kind: 'message', blocks: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: '바꿨습니다' }, { type: 'tool_use', name: 'Edit' }] },
    { kind: 'message', parentToolUseId: 'x', blocks: [{ type: 'text', text: 'subagent chatter' }] }
  ];
  assert.equal(conversationDigest(events), '사용자: 함수 이름 바꿔줘\n\n에이전트: 바꿨습니다');
  const long = conversationDigest([{ kind: 'user', text: 'a'.repeat(100) }], 20);
  assert.ok(long.startsWith('…(앞부분 생략)') && long.length < 50);
  assert.ok(btwPrompt('왜?', 'D').includes('"""\nD\n"""') && btwPrompt('왜?').endsWith('질문:\n왜?'));
});

test('claude answer: parsed from the JSON as soon as it is complete, with its cost', async () => {
  const { spawnProcess, calls } = fakeSpawn({ stdout: JSON.stringify({ result: ' 네, 비동기입니다. ', total_cost_usd: 0.0123, is_error: false }), hang: false });
  const result = await runBtw({ agent: 'claude', sessionId: 's', question: '왜 async?', spawnProcess });
  assert.deepEqual(result, { answer: '네, 비동기입니다.', costUsd: 0.0123 });
  assert.match(calls[0].input, /왜 async\?$/);
});

test('codex and cursor answers: plain stdout, ANSI stripped', async () => {
  const codex = await runBtw({ agent: 'codex', sessionId: 't', question: 'Q', spawnProcess: fakeSpawn({ stdout: 'answer\n' }).spawnProcess });
  assert.equal(codex.answer, 'answer');
  const cursor = await runBtw({ agent: 'cursor', question: 'Q', digest: '사용자: hi', spawnProcess: fakeSpawn({ stdout: '\x1b[32mfine\x1b[0m\n' }).spawnProcess });
  assert.equal(cursor.answer, 'fine');
  const sent = fakeSpawn({ stdout: 'x' }); await runBtw({ agent: 'cursor', question: 'Q', digest: '사용자: hi', spawnProcess: sent.spawnProcess });
  assert.match(sent.calls[0].args.at(-1), /사용자: hi/);
});

test('failures: login, missing session, too long, empty answer, missing CLI, timeout, cancel', async () => {
  const fail = (options, spawnOptions) => runBtw({ question: 'Q', ...options, spawnProcess: fakeSpawn(spawnOptions).spawnProcess });
  await assert.rejects(fail({ agent: 'claude' }, { stdout: JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }), code: 1 }), { code: 'AGENT_LOGIN' });
  await assert.rejects(fail({ agent: 'codex' }, { stderr: 'No rollout found for thread id', code: 1 }), /기록을 찾지 못해/);
  await assert.rejects(fail({ agent: 'claude' }, { stdout: JSON.stringify({ is_error: true, result: 'Prompt is too long' }), code: 1 }), /\/compact/);
  await assert.rejects(fail({ agent: 'cursor' }, { stdout: '   ' }), /빈 답/);
  const missing = () => { const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {}; proc.stdin = { on() {}, end() { setImmediate(() => proc.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))); } }; return proc; };
  await assert.rejects(runBtw({ agent: 'codex', question: 'Q', spawnProcess: missing }), { code: 'AGENT_UNAVAILABLE' });
  await assert.rejects(runBtw({ agent: 'codex', question: 'Q', timeoutMs: 20, spawnProcess: fakeSpawn({ hang: true }).spawnProcess }), { code: 'AGENT_TIMEOUT' });
  const controller = new AbortController(), hung = fakeSpawn({ hang: true });
  const pending = runBtw({ agent: 'codex', question: 'Q', signal: controller.signal, spawnProcess: hung.spawnProcess });
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
});

test('output parsing: a non-JSON claude reply is not an answer', () => {
  assert.equal(parseBtwOutput('claude', 'garbage'), null);
  assert.equal(parseBtwOutput('claude', JSON.stringify({ is_error: true, result: 'x' })).ok, false);
});
