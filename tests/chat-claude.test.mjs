import test from 'node:test';
import assert from 'node:assert/strict';
import { alwaysSuggestions, ASK_SKIPPED, askUserInput, claudeQuestions, approvalLine, buildClaudeArgs, cliPermissionMode, normalizeClaude, resultContextWindow, transcriptEvents, userLine, wantsArtifact } from '../apps/local-server/src/chat-claude.js';

const askInput = { questions: [
  { question: 'Roufin 웹 서비스 중 만들 프로젝트를 골라 주세요.', header: '웹 서비스', multiSelect: true, options: [{ label: 'Project Manager', description: 'CRDT 문서, 이슈, 일정' }, { label: 'DONGPO', description: '' }] },
  { question: '언어는요?', header: '언어', multiSelect: false, options: [{ label: 'TS' }, { label: 'Go' }] },
] };
const askRequest = { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q', input: askInput } };

test('AskUserQuestion becomes questions with headers, descriptions, multi-select and a free-text row', () => {
  const [event] = normalizeClaude(askRequest);
  assert.equal(event.kind, 'approval');
  assert.equal(event.tool, 'AskUserQuestion');
  assert.deepEqual(event.input, askInput); // the original input stays: it is what the answer is returned inside
  assert.deepEqual(event.questions.map(q => [q.id, q.header, q.allowMultiple, q.allowOther]), [['q0', '웹 서비스', true, true], ['q1', '언어', false, true]]);
  assert.deepEqual(event.questions[0].options, [{ id: 'Project Manager', label: 'Project Manager', description: 'CRDT 문서, 이슈, 일정' }, { id: 'DONGPO', label: 'DONGPO' }]);
  assert.equal(claudeQuestions({ questions: [{ question: '', options: [] }] }), null);
  assert.equal(normalizeClaude({ ...askRequest, request: { ...askRequest.request, tool_name: 'Bash', input: { command: 'ls' } } })[0].questions, undefined);
});

test('a Claude answer goes back inside the tool input keyed by the question text; skipping says so instead of a bare refusal', () => {
  const { questions } = normalizeClaude(askRequest)[0];
  const input = askUserInput(askInput, questions, { q0: ['Project Manager', 'DONGPO'], q1: ['직접 쓴 답'] });
  assert.deepEqual(input.answers, { 'Roufin 웹 서비스 중 만들 프로젝트를 골라 주세요.': 'Project Manager, DONGPO', '언어는요?': '직접 쓴 답' });
  assert.deepEqual(input.questions, askInput.questions);
  const line = JSON.parse(approvalLine('r1', { allow: true, input }));
  assert.equal(line.response.response.behavior, 'allow');
  assert.equal(line.response.response.updatedInput.answers['언어는요?'], '직접 쓴 답');
  assert.match(ASK_SKIPPED, /chose not to answer/);
});

test('argv always asks for host-side permission prompts and resumes by session id', () => {
  const args = buildClaudeArgs({ sessionId: 'abc', model: 'sonnet', permissionMode: 'plan' });
  assert.deepEqual(args.slice(0, 9), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--permission-prompts', 'host']);
  assert.ok(args.join(' ').includes('--resume abc') && args.join(' ').includes('--model sonnet') && args.join(' ').includes('--permission-mode plan'));
  assert.ok(buildClaudeArgs({ permissionMode: 'default' }).join(' ').includes('--permission-mode manual'));
  assert.ok(buildClaudeArgs({ permissionMode: 'auto' }).join(' ').includes('--permission-mode auto'));
  assert.ok(!buildClaudeArgs({}).includes('--permission-mode'), 'no explicit choice: the CLI follows its own settings');
  assert.ok(buildClaudeArgs({}).join(' ').includes('--allow-dangerously-skip-permissions'));
  assert.equal(cliPermissionMode('default'), 'manual');
  assert.equal(cliPermissionMode('bypassPermissions'), 'bypassPermissions');
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
  assert.deepEqual(normalizeClaude({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } } }), [{ kind: 'delta', phase: 'text', index: 0, text: 'a', parentToolUseId: null }]);
  const [message] = normalizeClaude({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 3, output_tokens: 4 } } });
  assert.equal(message.blocks[1].name, 'Bash'); assert.equal(message.usage.output, 4);
  const [result] = normalizeClaude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'out' }] }] } });
  assert.deepEqual([result.toolUseId, result.content, result.isError], ['t', 'out', false]);
  assert.equal(result.parentToolUseId, undefined);
  const [subResult] = normalizeClaude({ type: 'user', parent_tool_use_id: 'toolu_agent', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'done' }] } });
  assert.equal(subResult.parentToolUseId, 'toolu_agent');
  assert.equal(normalizeClaude({ type: 'result', is_error: true, result: 'boom', total_cost_usd: 0.1 })[0].status, 'failed');
});

test('approval request and its answers', () => {
  const [request] = normalizeClaude({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't' } });
  assert.deepEqual([request.kind, request.requestId, request.tool], ['approval', 'r1', 'Bash']);
  assert.equal(JSON.parse(approvalLine('r1', { allow: true, input: { a: 1 } })).response.response.behavior, 'allow');
  assert.equal(JSON.parse(approvalLine('r1', { allow: false })).response.response.behavior, 'deny');
});

test('"always allow" falls back to a session allow rule for an MCP tool that came without suggestions', () => {
  const rule = [{ type: 'addRules', rules: [{ toolName: 'mcp__mooner_server__server_exec' }], behavior: 'allow', destination: 'session' }];
  assert.deepEqual(alwaysSuggestions('mcp__mooner_server__server_exec', []), rule);
  assert.deepEqual(alwaysSuggestions('mcp__mooner_server__server_exec', undefined), rule);
  const own = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'session' }];
  assert.equal(alwaysSuggestions('mcp__x__y', own), own, 'the CLI\'s own suggestions win');
  assert.deepEqual(alwaysSuggestions('Bash', []), [], 'a built-in tool without suggestions stays a one-time answer');
  assert.deepEqual(alwaysSuggestions('mcp__', []), []);
  const line = JSON.parse(approvalLine('r1', { allow: true, input: {}, suggestions: alwaysSuggestions('mcp__a__b', []) }));
  assert.deepEqual(line.response.response.updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'mcp__a__b' }], behavior: 'allow', destination: 'session' }]);
});

test('unknown types pass through as raw instead of being dropped', () => {
  assert.deepEqual(normalizeClaude({ type: 'custom-title', customTitle: '내 이름' }), [{ kind: 'title', source: 'custom', text: '내 이름' }]);
  assert.deepEqual(normalizeClaude({ type: 'ai-title', aiTitle: 'AI 제목' }), [{ kind: 'title', source: 'ai', text: 'AI 제목' }]);
  assert.deepEqual(normalizeClaude({ type: 'mystery' }), [{ kind: 'raw', original: 'mystery' }]);
});

test('an interrupted turn is not reported as a failure', () => {
  assert.equal(normalizeClaude({ type: 'result', is_error: true, terminal_reason: 'aborted_streaming', subtype: 'error_during_execution' })[0].status, 'interrupted');
});

test('the thinking token estimate becomes a live-only delta', () => {
  assert.deepEqual(normalizeClaude({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 220 }), [{ kind: 'delta', phase: 'thinkingTokens', tokens: 220 }]);
});

test('message_start and message_delta usage become live-only usage deltas', () => {
  assert.deepEqual(normalizeClaude({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 9, output_tokens: 0 } } } }), [
    { kind: 'delta', phase: 'start', messageId: 'm1', parentToolUseId: null },
    { kind: 'delta', phase: 'usage', usage: { input: 9, output: 0, cacheRead: 0, cacheCreate: 0 }, parentToolUseId: null },
  ]);
  assert.deepEqual(normalizeClaude({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 12 } } }), [
    { kind: 'delta', phase: 'usage', usage: { input: 0, output: 12, cacheRead: 0, cacheCreate: 0 }, parentToolUseId: null, final: true },
  ]);
});

test('compacting: the CLI status becomes a live delta and the boundary a stored compact event with both sizes', () => {
  assert.deepEqual(normalizeClaude({ type: 'system', subtype: 'status', status: 'compacting' }), [{ kind: 'delta', phase: 'compacting', active: true }]);
  assert.deepEqual(normalizeClaude({ type: 'system', subtype: 'status', status: null, compact_result: 'success' }), [{ kind: 'delta', phase: 'compacting', active: false }]);
  assert.deepEqual(normalizeClaude({ type: 'system', subtype: 'status', status: 'requesting' }), [{ kind: 'raw', original: 'system' }]);
  assert.deepEqual(normalizeClaude({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 231097, post_tokens: 14613 } }), [{ kind: 'compact', trigger: 'manual', preTokens: 231097, postTokens: 14613 }]);
  assert.equal(normalizeClaude({ type: 'system', subtype: 'compact_boundary' })[0].postTokens, null, 'a boundary without sizes still marks the compaction');
});

test('probeInit reads the default model and the slash commands from one init event and stops the child', async () => {
  const { EventEmitter } = await import('node:events');
  const { probeInit } = await import('../apps/local-server/src/slash-commands.js');
  const calls = [];
  const spawnProcess = (_exe, args) => {
    const proc = new EventEmitter(); proc.stdout = Object.assign(new EventEmitter(), { setEncoding() {} }); proc.kill = () => { proc.killed = true; };
    calls.push({ args, proc });
    setImmediate(() => proc.stdout.emit('data', '{"type":"system","subtype":"hook"}\n{"type":"system","subtype":"init","model":"claude-sonnet-5-5","slash_commands":["compact","cost"]}\n'));
    return proc;
  };
  assert.deepEqual(await probeInit({ spawnProcess }), { model: 'claude-sonnet-5-5', slashCommands: ['compact', 'cost'] });
  assert.equal(calls.length, 1, 'one child answers both');
  assert.ok(calls[0].args.includes('/cost') && calls[0].args.includes('--no-session-persistence') && calls[0].proc.killed);
  const silent = () => { const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.kill = () => {}; setImmediate(() => proc.emit('close')); return proc; };
  assert.equal(await probeInit({ spawnProcess: silent }), null, 'no answer is null, never an empty list taken for an answer');
});

test('resolveModels needs no child for aliases: override, then the provider\'s catalog entry, then the default; only an unset model asks init once', async () => {
  const { promises: fs } = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { resolveModels } = await import('../apps/local-server/src/chat.js');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-models-'));
  const configDir = path.join(home, '.claude');
  await fs.mkdir(path.join(configDir, 'cache', 'model-catalog'), { recursive: true });
  const targets = {
    opus: { default: 'claude-opus-5-5', per_provider: { foundry: 'claude-opus-4-6' } },
    sonnet: { default: 'claude-sonnet-5-5' }, haiku: { default: 'claude-haiku-5-5' }, fable: { default: 'claude-fable-5-2' } };
  await fs.writeFile(path.join(configDir, 'cache', 'model-catalog', 'x-cc.json'), JSON.stringify({ fetchedAt: 1, catalog: { config: { models: [], provider_alias_targets: targets } } }));
  const setting = model => fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify(model ? { model } : {}));
  let asked = 0;
  const init = async () => { asked += 1; return { model: 'claude-opus-5-5' }; };
  const run = env => resolveModels({ home, cwd: home, env: { CLAUDE_CONFIG_DIR: configDir, ...env }, init });

  await setting('sonnet');
  assert.deepEqual(await run(), { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', '': 'claude-sonnet-5-5' });
  await setting('fable');
  assert.equal((await run())[''], 'claude-fable-5-2');
  await setting('claude-opus-4-8');
  assert.equal((await run())[''], 'claude-opus-4-8');
  assert.equal(asked, 0, 'a model setting answers without starting the CLI');

  assert.equal((await run({ CLAUDE_CODE_USE_FOUNDRY: '1' })).opus, 'claude-opus-4-6', 'the provider in use picks its catalog entry');
  assert.equal((await run({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'my-sonnet' })).sonnet, 'my-sonnet', 'an override wins');
  assert.equal(asked, 0);

  await setting();
  assert.equal((await run())[''], 'claude-opus-5-5');
  assert.equal(asked, 1, 'no model setting: the account default comes from init');
});

test('a terminal transcript becomes chat events: text, tool result, commands and their output; noise and subagents are dropped', () => {
  const line = value => JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', ...value });
  const events = transcriptEvents([
    line({ type: 'user', message: { content: '안녕' } }),
    line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
    line({ type: 'user', message: { content: '<local-command-stdout>x</local-command-stdout>' } }),
    line({ type: 'user', message: { content: '<command-name>/review</command-name><command-args>main</command-args>' } }),
    line({ type: 'assistant', uuid: 'u1', message: { id: 'm1', model: 'claude-x', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }),
    line({ type: 'assistant', isSidechain: true, message: { id: 'm2', content: [{ type: 'text', text: 'sub' }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }),
    line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 900, postTokens: 40 } }),
    line({ type: 'api-request', id: 'r' }),
    '{"torn":'
  ].join('\n'));
  assert.deepEqual(events.map(event => event.kind), ['user', 'command_output', 'user', 'message', 'tool_result', 'compact']);
  assert.deepEqual(events[5], { kind: 'compact', trigger: 'auto', preTokens: 900, postTokens: 40, at: Date.parse('2026-01-01T00:00:00Z') });
  assert.equal(events[0].text, '안녕'); assert.equal(events[1].text, 'x'); assert.equal(events[2].text, '/review main'); assert.equal(events[3].uuid, 'u1');
});

test('streamed tool input, subagent deltas and local command output are normalized', () => {
  assert.deepEqual(normalizeClaude({ type: 'stream_event', parent_tool_use_id: 'task-1', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls' } } }),
    [{ kind: 'delta', phase: 'toolInput', index: 1, text: '{"command":"ls', parentToolUseId: 'task-1' }]);
  assert.deepEqual(normalizeClaude({ type: 'user', isReplay: true, message: { role: 'user', content: '<local-command-stdout>\x1b[1mContext\x1b[0m 12k</local-command-stdout>' } }),
    [{ kind: 'command_output', text: 'Context 12k', isError: false }]);
  assert.deepEqual(normalizeClaude({ type: 'user', message: { content: [{ type: 'text', text: '<local-command-stderr>nope</local-command-stderr>' }] } }), [{ kind: 'command_output', text: 'nope', isError: true }]);
  assert.deepEqual(normalizeClaude({ type: 'user', message: { content: 'plain echo' } }), []);
});

test('the interactive-UI instructions are passed as an appended system prompt file', () => {
  const args = buildClaudeArgs({ promptFile: '/tmp/ade-ui-prompt.md' });
  assert.equal(args[args.indexOf('--append-system-prompt-file') + 1], '/tmp/ade-ui-prompt.md');
  assert.ok(!buildClaudeArgs({}).includes('--append-system-prompt-file'));
});
test('subagent task events normalize by their Agent call id (fields as recorded from claude 2.1.322)', () => {
  const base = { type: 'system', task_id: 'a1', run_id: 'r', tool_use_id: 'toolu_A', subagent_type: 'Explore', session_id: 's', uuid: 'u' };
  assert.deepEqual(normalizeClaude({ ...base, subtype: 'task_started', description: 'count files', is_backgrounded: true, task_type: 'local_agent', prompt: 'p' }),
    [{ kind: 'task', phase: 'start', toolUseId: 'toolu_A', taskId: 'a1', description: 'count files', agentType: 'Explore', background: true }]); // taskId: what stop_task names
  assert.deepEqual(normalizeClaude({ ...base, subtype: 'task_progress', description: 'Running List files', usage: { total_tokens: 18509, tool_uses: 2, duration_ms: 9905 }, last_tool_name: 'Bash' }),
    [{ kind: 'task', phase: 'progress', toolUseId: 'toolu_A', activity: 'Running List files', lastTool: 'Bash', tokens: 18509, toolUses: 2, durationMs: 9905 }]);
  assert.deepEqual(normalizeClaude({ ...base, subtype: 'task_notification', status: 'completed', summary: 'see hand-back', handback_report: { text: 'Count: 28' }, usage: { total_tokens: 21194, tool_uses: 3, duration_ms: 14803 } }),
    [{ kind: 'task', phase: 'end', toolUseId: 'toolu_A', status: 'completed', report: 'Count: 28', tokens: 21194, toolUses: 3, durationMs: 14803 }]);
  // task_updated names no Agent call; it stays a raw, live-only event.
  assert.deepEqual(normalizeClaude({ type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'completed' } }), [{ kind: 'raw', original: 'system' }]);
});

test('wantsArtifact matches an explicit Artifact request only', () => {
  assert.equal(wantsArtifact('이거 Artifact로 만들어줘'), true);
  assert.equal(wantsArtifact('아티팩트 올려줘'), true);
  assert.equal(wantsArtifact('build artifacts are in dist'), true); // ponytail: any mention counts; a false hit only costs ~12.9k tokens for that chat
  assert.equal(wantsArtifact('일반 질문입니다'), false);
});

test('a mode the CLI changed itself (EnterPlanMode, "allow all edits"...) becomes a settings event; compacting stays a delta', () => {
  const status = permissionMode => ({ type: 'system', subtype: 'status', status: null, permissionMode });
  assert.deepEqual(normalizeClaude(status('plan')), [{ kind: 'settings', permissionMode: 'plan', by: 'agent' }]);
  assert.deepEqual(normalizeClaude(status('acceptEdits')), [{ kind: 'settings', permissionMode: 'acceptEdits', by: 'agent' }]);
  assert.deepEqual(normalizeClaude(status('manual')), [{ kind: 'settings', permissionMode: 'default', by: 'agent' }]);
  assert.deepEqual(normalizeClaude(status('somethingNew')), []);
  assert.deepEqual(normalizeClaude({ type: 'system', subtype: 'status', status: 'compacting' }), [{ kind: 'delta', phase: 'compacting', active: true }]);
});

test('plan limit: only a warning or a hit is kept; worktree moves and picked models are read from what the CLI reports', async () => {
  const { worktreeMove, isPickedModel } = await import('../apps/local-server/src/chat-claude.js');
  const info = status => ({ type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: 'five_hour', utilization: 0.99, surpassedThreshold: 0.9, resetsAt: 1794808800 } });
  assert.deepEqual(normalizeClaude(info('allowed')), []);
  assert.deepEqual(normalizeClaude(info('allowed_warning')), [{ kind: 'limit', status: 'allowed_warning', limit: 'five_hour', utilization: 0.99, threshold: 0.9, resetsAt: 1794808800, overage: false }]);
  assert.equal(normalizeClaude(info('rejected'))[0].status, 'rejected');
  assert.deepEqual(worktreeMove({ name: 'EnterWorktree' }, 'Created worktree at “/p/.claude/worktrees/a” on branch “worktree-a”. The session is now working in the worktree.'), { phase: 'enter', path: '/p/.claude/worktrees/a', branch: 'worktree-a' });
  assert.deepEqual(worktreeMove({ name: 'ExitWorktree', input: { action: 'remove' } }, 'Exited worktree. Session is now back in “/p”.'), { phase: 'exit', path: '/p', removed: true });
  assert.equal(worktreeMove({ name: 'ExitWorktree', input: {} }, 'No active worktree session to exit.'), null);
  assert.equal(isPickedModel('haiku', 'claude-haiku-5-5'), true);
  assert.equal(isPickedModel('opus[1m]', 'claude-opus-5-5'), true);
  assert.equal(isPickedModel('haiku', 'claude-sonnet-5-5'), false);
  assert.equal(isPickedModel(undefined, 'claude-sonnet-5-5'), false);
});

test('a result\'s context window is the chat\'s own model, not a helper model listed first', () => {
  const usage = { 'claude-haiku-4-5-20251001': { contextWindow: 200_000 }, 'claude-opus-5-5': { contextWindow: 1_000_000 } };
  assert.equal(resultContextWindow(usage, 'claude-opus-5-5'), 1_000_000);
  assert.equal(resultContextWindow(usage, 'opus'), 1_000_000);
  assert.equal(resultContextWindow(usage, 'claude-opus-5-5[1m]'), 1_000_000);
  assert.equal(resultContextWindow(usage, null), 1_000_000);
  assert.equal(resultContextWindow(usage, 'claude-haiku-4-5-20251001'), 200_000);
  assert.equal(resultContextWindow({}, 'opus'), null);
  const [result] = normalizeClaude({ type: 'result', subtype: 'success', modelUsage: usage }, 'claude-opus-5-5');
  assert.equal(result.contextWindow, 1_000_000);
});
