import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalLine, buildClaudeArgs, normalizeClaude, transcriptEvents, userLine } from '../apps/local-server/src/chat-claude.js';

test('argv always asks for host-side permission prompts and resumes by session id', () => {
  const args = buildClaudeArgs({ sessionId: 'abc', model: 'sonnet', permissionMode: 'plan' });
  assert.deepEqual(args.slice(0, 9), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--permission-prompts', 'host']);
  assert.ok(args.join(' ').includes('--resume abc') && args.join(' ').includes('--model sonnet') && args.join(' ').includes('--permission-mode plan'));
  assert.ok(buildClaudeArgs({ permissionMode: 'default' }).join(' ').includes('--permission-mode manual'));
  assert.ok(buildClaudeArgs({ effort: 'high' }).join(' ').includes('--effort high'));
  assert.ok(!buildClaudeArgs({}).includes('--effort'));
  assert.ok(buildClaudeArgs({ worktree: true }).includes('--worktree'));
  assert.ok(!buildClaudeArgs({ worktree: true, sessionId: 'abc' }).includes('--worktree'), 'a worktree is chosen only before the conversation starts');
  assert.ok(buildClaudeArgs({ addDirs: ['/a', '/b'] }).join(' ').includes('--add-dir /a /b'));
});

test('a user line carries images before the text', () => {
  const line = JSON.parse(userLine('hi', [{ mime: 'image/png', data: 'AAAA' }]));
  assert.equal(line.message.content[0].type, 'image');
  assert.deepEqual(line.message.content[1], { type: 'text', text: 'hi' });
  assert.equal(JSON.parse(userLine('hi', [], 'abc')).uuid, 'abc');
  assert.ok(buildClaudeArgs({}).includes('--replay-user-messages'));
});

test('init, text delta, assistant message, tool result and result normalize', () => {
  assert.equal(normalizeClaude({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', slash_commands: ['compact'] })[0].slashCommands[0], 'compact');
  assert.deepEqual(normalizeClaude({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } } }), [{ kind: 'delta', phase: 'text', index: 0, text: 'a' }]);
  const [message] = normalizeClaude({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 3, output_tokens: 4 } } });
  assert.equal(message.blocks[1].name, 'Bash'); assert.equal(message.usage.output, 4);
  const [result] = normalizeClaude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'out' }] }] } });
  assert.deepEqual([result.toolUseId, result.content, result.isError], ['t', 'out', false]);
  assert.equal(normalizeClaude({ type: 'result', is_error: true, result: 'boom', total_cost_usd: 0.1 })[0].status, 'failed');
});

test('approval request and its answers', () => {
  const [request] = normalizeClaude({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't' } });
  assert.deepEqual([request.kind, request.requestId, request.tool], ['approval', 'r1', 'Bash']);
  assert.equal(JSON.parse(approvalLine('r1', { allow: true, input: { a: 1 } })).response.response.behavior, 'allow');
  assert.equal(JSON.parse(approvalLine('r1', { allow: false })).response.response.behavior, 'deny');
});

test('unknown types pass through as raw instead of being dropped', () => {
  assert.deepEqual(normalizeClaude({ type: 'mystery' }), [{ kind: 'raw', original: 'mystery' }]);
});

test('an interrupted turn is not reported as a failure', () => {
  assert.equal(normalizeClaude({ type: 'result', is_error: true, terminal_reason: 'aborted_streaming', subtype: 'error_during_execution' })[0].status, 'interrupted');
});

test('the thinking token estimate becomes a live-only delta', () => {
  assert.deepEqual(normalizeClaude({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 220 }), [{ kind: 'delta', phase: 'thinkingTokens', tokens: 220 }]);
});

test('probeModels reads each alias\'s concrete model from the init event and stops the child', async () => {
  const { EventEmitter } = await import('node:events');
  const { probeModels } = await import('../apps/local-server/src/chat.js');
  const calls = [];
  const spawnProcess = (_exe, args) => {
    const proc = new EventEmitter(); proc.stdout = Object.assign(new EventEmitter(), { setEncoding() {} }); proc.kill = () => { proc.killed = true; };
    const alias = args.includes('--model') ? args[args.indexOf('--model') + 1] : '';
    calls.push(args);
    setImmediate(() => alias === 'broken' ? proc.emit('close') : proc.stdout.emit('data', `{"type":"system","subtype":"init","model":"claude-${alias || 'sonnet'}-5-5"}\n`));
    return proc;
  };
  const models = await probeModels({ spawnProcess, aliases: ['', 'opus', 'broken'] });
  assert.deepEqual(models, { '': 'claude-sonnet-5-5', opus: 'claude-opus-5-5' });
  assert.ok(calls.every(args => args.includes('/cost') && args.includes('--no-session-persistence')));
});

test('a terminal transcript becomes chat events: text, tool result, commands; noise and subagents are dropped', () => {
  const line = value => JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', ...value });
  const events = transcriptEvents([
    line({ type: 'user', message: { content: '안녕' } }),
    line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
    line({ type: 'user', message: { content: '<local-command-stdout>x</local-command-stdout>' } }),
    line({ type: 'user', message: { content: '<command-name>/review</command-name><command-args>main</command-args>' } }),
    line({ type: 'assistant', uuid: 'u1', message: { id: 'm1', model: 'claude-x', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }),
    line({ type: 'assistant', isSidechain: true, message: { id: 'm2', content: [{ type: 'text', text: 'sub' }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }),
    line({ type: 'system', subtype: 'compact_boundary' }),
    line({ type: 'api-request', id: 'r' }),
    '{"torn":'
  ].join('\n'));
  assert.deepEqual(events.map(event => event.kind), ['user', 'user', 'message', 'tool_result', 'divider']);
  assert.equal(events[0].text, '안녕'); assert.equal(events[1].text, '/review main'); assert.equal(events[2].uuid, 'u1');
});
