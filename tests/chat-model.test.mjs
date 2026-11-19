import test from 'node:test';
import assert from 'node:assert/strict';
import { agentsOf, planSections, autoDenial, emptyPick, isResultText, pickOption, pickOther, processGroups, toolRuns, questionAnswers, questionsAnswered, toolSummary, toolLabel, artifactsOf, classifyArtifactUrl, awaitingTools, approvalAgents, keepAgents, enqueueSendNow } from '../apps/web/src/chat-model.ts';
import { contextEnds, contextGauge, contextPercent, contextReported, cursorSettingName, effortLabel, effortLevel, emptyView, fillFormat, fromReplay, cursorModelGroups, isChatSlashCommand, isCursorEffort, isCursorSwitch, modelDisplayName, modelAppearance, modelProvider, modelColor, modelQuickDefaults, modelQuickRows, modelRows, modelValue, parseChatSlashCommand, parseContextSetting, partialToolInput, permissionLabel, permissionModeColor, reduce, ro, settingsLine, shortModel, withSettingChange, turnAllowsMessageActions, turnDoneParts, turnTokenRows } from '../apps/web/src/chat-model.ts';

const tool = id => ({ type: 'tool_use', id, name: 'Bash', input: {} }), say = text => ({ type: 'text', text });
const flow = (...entries) => entries.map(entry => typeof entry === 'string' ? { block: say(entry), sub: false } : entry);
const T = id => ({ block: tool(id), sub: false }), SUB = block => ({ block, sub: true });
const shapeOf = flow => { const { plain, groups } = processGroups(flow); return flow.map((_, at) => { const group = groups.find(item => at >= item.start && at < item.end); return group ? (at === group.start ? 'P' : 'p') : plain[at] ? 'R' : '?'; }).join(''); };

test('process groups: each tool stretch folds, every result stays plain in between', () => {
  const question = ['## 사전 조사 결과', '', '| 프로젝트 | 커밋 |', '|---|---|', '| A | 87 |', '', '어느 페이지를 구현할까요?'].join('\n');
  // tools + short remark, [result and question], tools + short remark, [result]
  const turn = flow(T('t1'), '먼저 저장소를 살펴볼게요.', T('t2'), question, T('t3'), '다음은 확인합니다.', T('t4'), '구현했습니다.');
  assert.equal(shapeOf(turn), 'PppRPppR');
  const { groups } = processGroups(turn);
  assert.deepEqual(groups.map(group => [group.tools, group.answered]), [[2, true], [2, true]]);
});

test('process groups: a closing text is the result even when short; a turn that ends on tools stays unanswered', () => {
  assert.equal(shapeOf(flow(T('t1'), '끝.')), 'PR');
  const open = processGroups(flow(T('t1'), '설명입니다.', T('t2')));
  assert.equal(open.groups.length, 1);
  assert.equal(open.groups[0].answered, false);
});

test('process groups: remarks with no tool or thought stay plain, and sub-agent text is process', () => {
  assert.equal(shapeOf(flow('짧은 말.', '## 결과\n\n본문')), 'RR');
  assert.equal(shapeOf(flow(T('t1'), SUB(say('서브 에이전트의 긴 결과 '.repeat(30))), SUB(tool('t2')), '완료')), 'PppR');
  assert.equal(shapeOf(flow(SUB(say('서브 텍스트뿐')), '완료')), 'PR');
});

test('a text is a result when long, structured, multi-paragraph or a question', () => {
  assert.equal(isResultText('좋아요, 다음은 확인합니다.'), false);
  assert.equal(isResultText('어느 쪽으로 할까요?'), true);
  assert.equal(isResultText('- 하나\n- 둘'), true);
  assert.equal(isResultText('가'.repeat(241)), true);
  assert.equal(isResultText(['가'.repeat(70), '나'.repeat(70)].join('\n\n')), true);
});

test('answering questions: single select replaces, multi select toggles, typed text counts, a text-only question needs text', () => {
  const single = { id: 'a', prompt: '하나', options: [{ id: 'x', label: 'x' }, { id: 'y', label: 'y' }], allowOther: true }, multi = { ...single, id: 'b', allowMultiple: true }, text = { id: 'c', prompt: '이름' };
  let one = pickOption(single, emptyPick(single), 'x'); one = pickOption(single, one, 'y');
  assert.deepEqual(one.options, ['y']);
  one = pickOther(single, one, '내 답'); // typing one's own answer replaces the option in a single-select
  assert.deepEqual(one, { options: [], other: '내 답' });
  assert.deepEqual(pickOption(single, one, 'x'), { options: ['x'], other: null });
  let many = pickOption(multi, emptyPick(multi), 'x'); many = pickOption(multi, many, 'y'); many = pickOption(multi, many, 'x');
  assert.deepEqual(many.options, ['y']);
  many = pickOther(multi, many, '추가'); // in a multi-select it adds to the options
  assert.deepEqual(questionAnswers([multi], { b: many }), { b: ['y', '추가'] });
  assert.deepEqual(emptyPick(text), { options: [], other: '' });
  assert.equal(questionsAnswered([single, text], questionAnswers([single, text], { a: one })), false);
  assert.equal(questionsAnswered([single, text], questionAnswers([single, text], { a: one, c: pickOther(text, emptyPick(text), '  민지 ') })), true);
  assert.deepEqual(questionAnswers([text], { c: { options: [], other: '  민지 ' } }), { c: ['민지'] });
  assert.equal(questionsAnswered([], {}), false);
  assert.equal(toolSummary('AskUserQuestion', { questions: [{ question: '무엇을 할까요?' }, { question: '둘째' }] }), '무엇을 할까요? 외 1개');
});

test('interrupted tools stay interrupted when a later turn starts', () => {
  let view = reduce(emptyView(), { kind: 'message', id: 'm', blocks: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: {} }] });
  view = reduce(view, { kind: 'result', status: 'interrupted' });
  assert.equal(view.results.tool.isError, true);
  view = reduce(view, { kind: 'delta', phase: 'start' });
  assert.equal(view.results.tool.content, '응답을 중단했습니다.');
});

test('clear removes live approvals, steering and partial output', () => {
  let view = reduce(emptyView(), { kind: 'approval', phase: 'request', requestId: 'r', tool: 'Bash', input: {} });
  view = reduce(view, { kind: 'steer', phase: 'queued', uuid: 'u', text: 'next' });
  view = reduce(view, { kind: 'delta', phase: 'text', messageId: 'live-0', index: 0, text: 'partial' });
  view = reduce(view, { kind: 'divider', reason: 'clear' });
  assert.equal(view.items[0].blocks[0].partial, undefined, 'the partial text is settled, not left streaming');
  assert.deepEqual(view.live, {}); assert.deepEqual(view.approvals, []); assert.deepEqual(view.steers, []);
});

test('a streamed reply grows in place and the stored message lands on the same item; a replayed seq is ignored', () => {
  let view = reduce({ ...emptyView(), ready: true }, { kind: 'delta', phase: 'start', messageId: 'm' });
  view = reduce(view, { kind: 'delta', phase: 'text', messageId: 'm', index: 0, text: 'He' });
  view = reduce(view, { kind: 'delta', phase: 'text', messageId: 'm', index: 0, text: 'llo' });
  const live = view.items[0];
  assert.equal(live.blocks[0].text, 'Hello'); assert.equal(live.blocks[0].partial, true); assert.equal(live.fresh, true);
  view = reduce(view, { seq: 1, kind: 'message', id: 'm', blocks: [{ type: 'text', text: 'Hello' }] });
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].key, live.key, 'same item key: nothing remounts');
  assert.equal(view.items[0].blocks[0].key, live.blocks[0].key, 'same block key: the text keeps its reveal');
  assert.equal(view.items[0].blocks[0].partial, undefined);
  assert.equal(reduce(view, { seq: 1, kind: 'message', id: 'm2', blocks: [] }).items.length, 1);
});

test('text, a tool and its streamed input under one Claude message stay one item in order with stable keys', () => {
  let view = reduce({ ...emptyView(), ready: true }, { kind: 'delta', phase: 'start', messageId: 'm' });
  view = reduce(view, { kind: 'delta', phase: 'text', messageId: 'm', index: 0, text: '확인할게요' });
  view = reduce(view, { seq: 1, kind: 'message', id: 'm', uuid: '11111111-1111-4111-8111-111111111111', blocks: [{ type: 'text', text: '확인할게요' }] });
  view = reduce(view, { kind: 'delta', phase: 'tool', messageId: 'm', index: 1, id: 'toolu_1', name: 'Bash' });
  view = reduce(view, { kind: 'delta', phase: 'toolInput', messageId: 'm', index: 1, text: '{"command":"ls -la","descr' });
  const streaming = view.items[0].blocks[1];
  assert.equal(streaming.partial, true); assert.equal(streaming.input.command, 'ls -la', 'the card has its command before the call is complete');
  view = reduce(view, { seq: 2, kind: 'message', id: 'm', uuid: '22222222-2222-4222-8222-222222222222', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la', description: 'List' } }] });
  assert.equal(view.items.length, 1);
  assert.deepEqual(view.items[0].blocks.map(block => block.type), ['text', 'tool_use']);
  assert.equal(view.items[0].blocks[1].key, streaming.key);
  assert.equal(view.items[0].blocks[1].partialJson, undefined);
  assert.equal(view.items[0].uuid, '22222222-2222-4222-8222-222222222222', 'branch and rewind resume at the last event of the message');
});

test('a replayed transcript gives the same items as the live stream did (apart from entrance and keys)', () => {
  const stored = [
    { seq: 1, kind: 'user', text: 'hi' },
    { seq: 2, kind: 'message', id: 'm', blocks: [{ type: 'text', text: 'Hello' }] },
    { seq: 3, kind: 'message', id: 'm', blocks: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'a' } }] },
    { seq: 4, kind: 'tool_result', toolUseId: 't', content: 'ok' },
    { seq: 5, kind: 'result', status: 'success', text: 'Hello' },
  ];
  let live = { ...emptyView(), ready: true };
  live = reduce(live, stored[0]);
  live = reduce(live, { kind: 'delta', phase: 'start', messageId: 'm' });
  live = reduce(live, { kind: 'delta', phase: 'text', messageId: 'm', index: 0, text: 'Hel' });
  live = reduce(live, { kind: 'delta', phase: 'text', messageId: 'm', index: 0, text: 'lo' });
  live = reduce(live, stored[1]);
  live = reduce(live, { kind: 'delta', phase: 'tool', messageId: 'm', index: 1, id: 't', name: 'Read' });
  for (const event of stored.slice(2)) live = reduce(live, event);
  const shape = view => view.items.map(item => item.kind === 'assistant' ? { kind: item.kind, id: item.id, blocks: item.blocks.map(({ key, slot, ...block }) => block) } : { kind: item.kind });
  assert.deepEqual(shape(live), shape(fromReplay({ events: stored, seq: 5 })));
  assert.equal(fromReplay({ events: stored }).items.some(item => item.fresh), false, 'a replay plays no entrance');
});

test('subagent deltas grow their own item and never mix into the main reply', () => {
  let view = reduce(emptyView(), { kind: 'delta', phase: 'start', messageId: 'main' });
  view = reduce(view, { kind: 'delta', phase: 'text', messageId: 'main', index: 0, text: 'Main ' });
  view = reduce(view, { kind: 'delta', phase: 'start', messageId: 'sub', parentToolUseId: 'task' });
  view = reduce(view, { kind: 'delta', phase: 'text', messageId: 'sub', index: 0, text: 'sub text', parentToolUseId: 'task' });
  view = reduce(view, { kind: 'delta', phase: 'text', messageId: 'main', index: 0, text: 'more' });
  assert.deepEqual(view.items.map(item => [item.id, item.sub, item.blocks[0].text]), [['main', false, 'Main more'], ['sub', true, 'sub text']]);
});

test('Codex/Cursor tool messages keep text streamed under other ids', () => {
  let view = reduce(emptyView(), { kind: 'delta', phase: 'start', messageId: 'turn-text-0' });
  view = reduce(view, { kind: 'delta', phase: 'text', messageId: 'turn-text-0', index: 0, text: 'Looking into it' });
  view = reduce(view, { seq: 1, kind: 'message', id: 'turn-text-0', blocks: [{ type: 'text', text: 'Looking into it' }] });
  view = reduce(view, { seq: 2, kind: 'message', id: 'tool-1', blocks: [{ type: 'tool_use', id: 'tool-1', name: 'Grep', input: { pattern: 'foo' } }] });
  view = reduce(view, { kind: 'delta', phase: 'text', messageId: 'turn-text-1', index: 0, text: 'Done' });
  view = reduce(view, { seq: 3, kind: 'message', id: 'turn-text-1', blocks: [{ type: 'text', text: 'Done' }] });
  assert.deepEqual(view.items.map(item => item.blocks.map(block => block.type === 'tool_use' ? block.name : block.text)), [['Looking into it'], ['Grep'], ['Done']]);
});

test('slash command feedback: printed output, result text, or a done line', () => {
  let view = reduce(emptyView(), { seq: 1, kind: 'user', text: '/context' });
  view = reduce(view, { seq: 2, kind: 'command_output', text: 'Context 12k / 200k', isError: false });
  view = reduce(view, { seq: 3, kind: 'result', status: 'success', text: 'Context 12k / 200k' });
  assert.deepEqual(view.items.map(item => [item.kind, item.text]), [['user', '/context'], ['info', 'Context 12k / 200k']], 'output shown once, as a chat message');
  view = reduce(view, { seq: 4, kind: 'user', text: '/release-notes' });
  view = reduce(view, { seq: 5, kind: 'result', status: 'success', text: 'v2.1: notes' });
  assert.deepEqual(view.items.at(-1), { kind: 'command', key: 'e5', text: 'v2.1: notes', isError: false, fresh: false });
  view = reduce(view, { seq: 6, kind: 'user', text: '/mcp' });
  view = reduce(view, { seq: 7, kind: 'result', status: 'success', text: '' });
  assert.equal(view.items.at(-1).kind, 'command'); assert.equal(view.items.at(-1).text, '/mcp 명령을 실행했습니다.', 'no output: only a line saying it ran');
  view = reduce(view, { seq: 8, kind: 'user', text: 'plain question' });
  view = reduce(view, { seq: 9, kind: 'result', status: 'success', text: '' });
  assert.equal(view.items.at(-1).kind, 'user', 'an ordinary empty turn gets no command line');
  view = reduce(view, { seq: 10, kind: 'user', text: '/compact' });
  view = reduce(view, { seq: 11, kind: 'compact', trigger: 'manual', preTokens: 10, postTokens: 2 });
  view = reduce(view, { seq: 12, kind: 'result', status: 'success', text: '' });
  assert.equal(view.items.at(-1).kind, 'compact', 'compact has its own marker');
});

test('partial tool input yields the fields a card summary needs', () => {
  assert.deepEqual(partialToolInput('{"command":"git status","description":"Show'), { command: 'git status', description: 'Show' });
  assert.deepEqual(partialToolInput('{"file_path":"/a/\\u00e9.ts","content":"x'), { file_path: '/a/é.ts' });
  assert.deepEqual(partialToolInput('{"pattern":"a\\'), { pattern: 'a' });
  assert.deepEqual(partialToolInput('{"a":1}'), { a: 1 });
});

test('a later tool on the same message keeps the text said before it', () => {
  let view = reduce(emptyView(), { seq: 1, kind: 'message', id: 'm', blocks: [{ type: 'thinking', text: '' }] });
  view = reduce(view, { seq: 2, kind: 'message', id: 'm', blocks: [{ type: 'thinking', text: '확인할 파일을 고른다.' }] });
  view = reduce(view, { seq: 3, kind: 'message', id: 'm', blocks: [{ type: 'text', text: '파일을 확인합니다.' }] });
  view = reduce(view, { seq: 4, kind: 'message', id: 'm', blocks: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] });
  assert.deepEqual(view.items[0].blocks.map(block => block.type === 'tool_use' ? block.name : block.text), ['확인할 파일을 고른다.', '파일을 확인합니다.', 'Bash']);
});

test('text said before the final answer is kept when the final message is different', () => {
  let view = reduce(emptyView(), { kind: 'delta', phase: 'start', messageId: 'main' });
  view = reduce(view, { kind: 'delta', phase: 'text', messageId: 'main', index: 0, text: '먼저 파일을 볼게' });
  view = reduce(view, { kind: 'message', id: 'main', blocks: [{ type: 'text', text: '수정까지 끝냈어' }] });
  assert.deepEqual(view.items[0].blocks.map(block => block.text), ['먼저 파일을 볼게', '수정까지 끝냈어']);
});

test('streamed thinking survives a final assistant message without thinking', () => {
  let view = reduce(emptyView(), { kind: 'delta', phase: 'start', messageId: 'm' });
  view = reduce(view, { kind: 'delta', phase: 'thinking', messageId: 'm', index: 0, text: 'Plan first' });
  view = reduce(view, { kind: 'message', id: 'm', blocks: [{ type: 'text', text: 'Answer' }] });
  assert.deepEqual(view.items[0].blocks.map(block => block.type), ['thinking', 'text']);
});

test('approvals are added by request and removed when answered', () => {
  let view = reduce(emptyView(), { kind: 'approval', phase: 'request', requestId: 'r', tool: 'Bash', input: {} });
  assert.equal(view.approvals.length, 1);
  view = reduce(view, { kind: 'approval', phase: 'cancel', requestId: 'r' });
  assert.equal(view.approvals.length, 0);
});

test('replay rebuilds items and keeps the server state', () => {
  const view = fromReplay({ events: [{ seq: 1, kind: 'user', text: 'hi' }, { seq: 2, kind: 'divider' }], seq: 2 });
  assert.deepEqual(view.items.map(item => item.kind), ['user', 'divider']); assert.equal(view.ready, true);
});

test('chat slash commands are distinguished from file paths', () => {
  for (const text of ['/clear', '/compact keep plan', '/model opus', '/']) assert.equal(isChatSlashCommand(text), true, text);
  for (const text of ['fix tests', '/usr/bin/env run', 'go to /src/foo']) assert.equal(isChatSlashCommand(text), false, text);
  assert.deepEqual(parseChatSlashCommand('/compact keep plan'), { name: 'compact', args: 'keep plan' });
  assert.deepEqual(parseChatSlashCommand('/clear'), { name: 'clear', args: '' });
  assert.equal(parseChatSlashCommand('/usr/bin/env x'), null);
});

test('slash command replies without inference skip message actions', () => {
  const plain = [{ kind: 'user', key: 'u', text: 'hello', images: 0 }, { kind: 'assistant', key: 'a', id: 'm', uuid: '11111111-1111-4111-8111-111111111111', blocks: [{ type: 'text', text: 'ok' }], sub: false }];
  const slashText = [{ kind: 'user', key: 'u', text: '/cost', images: 0 }, { kind: 'assistant', key: 'a', id: 'm', blocks: [{ type: 'text', text: '$0.01' }], sub: false }];
  const slashTool = [{ kind: 'user', key: 'u', text: '/review main', images: 0 }, { kind: 'assistant', key: 'a', id: 'm', blocks: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], sub: false }];
  assert.equal(turnAllowsMessageActions(plain), true);
  assert.equal(turnAllowsMessageActions(slashText), false);
  assert.equal(turnAllowsMessageActions(slashTool), true);
});

test('contextReported waits for usage on Cursor and Codex', () => {
  assert.equal(contextReported({ agent: 'claude', contextTokens: 0, contextWindow: null }), true);
  assert.equal(contextReported({ agent: 'cursor', contextTokens: 0, contextWindow: null }), false);
  assert.equal(contextReported({ agent: 'cursor', contextTokens: 0, contextWindow: 300_000 }), true);
  assert.equal(contextReported({ agent: 'codex', contextTokens: 900, contextWindow: null }), true);
  assert.equal(parseContextSetting('1m'), 1_000_000);
  assert.equal(parseContextSetting('256k'), 256_000);
});

test('status numbers and templates', () => {
  assert.equal(contextPercent({ contextTokens: 100_000, model: 'claude-x' }), 50);
  assert.equal(contextPercent({ contextTokens: 100_000, model: 'claude-x[1m]' }), 10);
  assert.equal(contextPercent({ contextTokens: 263_980, model: 'claude-sonnet-5-5' }), 132, 'past the window the percent keeps counting instead of sticking at 100');
  assert.equal(contextPercent({ contextTokens: 263_980, model: 'claude-sonnet-5-5', capabilities: { catalog: [{ id: 'claude-sonnet-5-5', window: 1_000_000 }] } }), 26);
  assert.equal(contextPercent({ contextTokens: 263_980, model: 'claude-sonnet-5-5', contextWindow: 1_000_000, capabilities: { catalog: [{ id: 'claude-sonnet-5-5', window: 200_000 }] } }), 26);
  // An alias has no catalog row of its own: the family's row sizes it.
  assert.equal(contextPercent({ contextTokens: 345_000, model: 'opus', contextWindow: null, autoCompact: null, capabilities: { catalog: [{ id: 'claude-opus-5-5', family: 'opus', window: 1_000_000 }, { id: 'claude-haiku-4-5', family: 'haiku', window: 200_000 }] } }), 35);
  const withAuto = { contextTokens: 175_000, model: 'claude-sonnet-5-5', contextWindow: 1_000_000, autoCompact: { window: 350_000, maxWindow: 1_000_000, auto: false, source: 'modelSettings' } };
  assert.equal(contextPercent(withAuto), 50);
  assert.deepEqual(contextGauge(withAuto), { percent: 50, used: 175_000, basis: 350_000, max: 1_000_000, autoCompact: true });
  assert.equal(fillFormat('{a}/{b}', { a: '1' }), '1/{b}');
});

test('permission mode colors resolve to agent-scoped CSS variables', () => {
  assert.equal(permissionModeColor('default'), 'var(--mode-default, var(--muted))');
  assert.equal(permissionModeColor('acceptEdits'), 'var(--mode-acceptEdits, var(--muted))');
  assert.equal(permissionModeColor('ask'), 'var(--mode-ask, var(--muted))');
});

test('cursor names its modes 에이전트, 계획, 질문; other agents keep 기본', () => {
  assert.equal(permissionLabel('default', 'cursor'), '에이전트');
  assert.equal(permissionLabel('plan', 'cursor'), '계획');
  assert.equal(permissionLabel('ask', 'cursor'), '질문');
  assert.equal(permissionLabel('default', 'claude'), '기본');
  assert.equal(permissionLabel('default'), '기본');
});

test('every model family has its own color and unknown models have none', () => {
  const families = ['fable', 'opus', 'sonnet', 'haiku', 'astra', 'sol', 'terra', 'luna'];
  assert.equal(new Set(families.map(name => modelColor(`claude-${name}-5-1`))).size, families.length);
  assert.equal(modelColor('sonnet[1m]'), 'var(--model-sonnet)');
  assert.equal(modelColor('claude-console-1'), undefined);
  assert.equal(modelColor(null), undefined);
});

test('model ids are shown by family and version', () => {
  assert.equal(shortModel('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(shortModel('claude-opus-4-1-20250805'), 'Opus 4.1');
  assert.equal(shortModel('claude-sonnet-4-20250514'), 'Sonnet 4');
  assert.equal(shortModel('opus[1m]'), 'Opus (1M)');
  assert.equal(shortModel('haiku'), 'Haiku');
  assert.equal(shortModel('gpt-6-luna'), 'GPT 6 Luna');
  assert.equal(shortModel('gpt-6.1-luna'), 'GPT 6.1 Luna');
  assert.equal(shortModel('some-custom-model'), 'some-custom-model');
  assert.equal(shortModel(null), '모델 미정');
});

test('thinking tokens follow the message', () => {
  let view = reduce(emptyView(), { kind: 'delta', phase: 'start' });
  view = reduce(view, { kind: 'delta', phase: 'thinkingTokens', tokens: 170 });
  assert.equal(view.thinkingTokens, 170);
  assert.equal(reduce(view, { kind: 'delta', phase: 'start' }).thinkingTokens, 0);
});

test('a finished or new turn does not show the previous turn\'s thinking tokens', () => {
  let view = reduce(emptyView(), { kind: 'delta', phase: 'thinkingTokens', tokens: 170 });
  assert.equal(reduce(view, { kind: 'result', status: 'success' }).thinkingTokens, 0);
  assert.equal(reduce(view, { kind: 'user', text: '다음' }).thinkingTokens, 0);
});

test('a steering message waits, then becomes an ordinary user message or disappears', () => {
  let view = reduce(emptyView(), { kind: 'steer', phase: 'queued', uuid: 'u1', text: '멈춰', images: 0 });
  assert.deepEqual(view.steers.map(item => item.text), ['멈춰']);
  assert.equal(view.items.length, 0);
  const applied = reduce(view, { seq: 1, kind: 'steer', phase: 'applied', uuid: 'u1', text: '멈춰', images: 0 });
  assert.equal(applied.steers.length, 0);
  assert.deepEqual(applied.items.map(item => [item.kind, item.text]), [['user', '멈춰']]);
  assert.equal(reduce(view, { kind: 'steer', phase: 'cancelled', uuid: 'u1' }).steers.length, 0);
});

test('quick model menu: one top model per provider, all Cursor provider models, and pins', () => {
  const codex = ['gpt-6.1-astra', 'gpt-5.4-astra', 'gpt-6.1-sol', 'gpt-5.4-sol'].map(id => ({ id, name: id.replace(/-/g, ' '), family: '', window: 0, main: true }));
  const codexRows = modelRows(codex, {});
  assert.deepEqual(modelQuickDefaults(codexRows, 'codex').map(row => row.id).sort(), ['gpt-6.1-astra', 'gpt-6.1-sol']);
  assert.deepEqual(modelQuickRows(codexRows, 'codex', ['gpt-5.4-sol']).map(row => row.id), ['gpt-6.1-astra', 'gpt-6.1-sol', 'gpt-5.4-sol']);
  const cursorRows = modelRows([
    { id: 'composer-2.5', name: 'Composer 2.5', family: '', window: 0, main: true },
    { id: 'auto-smart', name: 'Auto Smart', family: '', window: 0, main: true },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', family: '', window: 0, main: true },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', family: '', window: 0, main: true },
    { id: 'gpt-6.1-astra', name: 'GPT 6.1 Astra', family: '', window: 0, main: true },
  ], {});
  const cursorDefault = modelQuickDefaults(cursorRows, 'cursor').map(row => row.id).sort();
  assert.deepEqual(cursorDefault, ['auto-smart', 'claude-opus-4-8', 'composer-2.5', 'gpt-6.1-astra']);
  assert.deepEqual(modelQuickRows(cursorRows, 'cursor', ['claude-opus-4-6']).map(row => row.id).sort(), [...cursorDefault, 'claude-opus-4-6'].sort());
});

test('model rows: Fable first, then newest version first; (1M) only for Opus 4.6 / Sonnet before 5', () => {
  const catalog = [
    { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', family: 'haiku', window: 200000, main: false },
    { id: 'claude-opus-4-8', name: 'Opus 4.8', family: 'opus', window: 1000000, main: false },
    { id: 'claude-opus-4-6', name: 'Opus 4.6', family: 'opus', window: 200000, main: false },
    { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', family: 'sonnet', window: 200000, main: false },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', family: 'sonnet', window: 1000000, main: true },
    { id: 'claude-fable-5-2', name: 'Fable 5.2', family: 'fable', window: 1000000, main: true },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', family: 'opus', window: 1000000, main: true },
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5', family: 'haiku', window: 1000000, main: true },
  ];
  const rows = modelRows(catalog, { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' });
  assert.deepEqual(rows.map(row => row.label), [
    'Fable 5.2', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'Opus 4.8', 'Opus 4.6', 'Opus 4.6 (1M)', 'Sonnet 4.6', 'Sonnet 4.6 (1M)', 'Haiku 4.5',
  ]);
  assert.deepEqual(rows.slice(0, 4).map(row => row.value), ['claude-fable-5-2', 'opus', 'sonnet', 'haiku']);
  assert.equal(rows.find(row => row.label === 'Opus 4.6 (1M)').value, 'claude-opus-4-6[1m]');
  assert.equal(rows.find(row => row.label === 'Sonnet 4.6 (1M)').value, 'claude-sonnet-4-6[1m]');
  assert.equal(modelValue('claude-opus-5-5', { opus: 'claude-opus-5-5' }), 'opus');
  assert.equal(modelValue('claude-opus-4-8', { opus: 'claude-opus-5-5' }), 'claude-opus-4-8');
  assert.equal(modelValue(null, {}), '');
});

test('chat shortcuts: combos come from event.code, overrides win, bare keys are refused', async () => {
  const { comboOf, chatKey, validCombo } = await import('../apps/web/src/chat-model.ts');
  assert.equal(comboOf({ code: 'KeyP', key: 'π', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }), 'alt+p');
  assert.equal(comboOf({ code: 'ArrowUp', key: 'ArrowUp', altKey: false, ctrlKey: false, metaKey: false, shiftKey: true }), 'shift+arrowup');
  assert.equal(comboOf({ code: 'ShiftLeft', key: 'Shift', altKey: false, ctrlKey: false, metaKey: false, shiftKey: true }), '');
  assert.equal(chatKey({ stash: 'ctrl+k' }, 'stash'), 'ctrl+k'); assert.equal(chatKey({}, 'stash'), 'ctrl+s');
  assert.ok(validCombo('shift+arrowup') && validCombo('alt+p')); assert.ok(!validCombo('p') && !validCombo('shift+p'));
});


test('Codex catalog rows with an empty family retain model colors from their IDs', () => {
  const catalog = ['astra', 'sol', 'terra', 'luna'].map(family => ({ id: `gpt-6.1-${family}`, name: `GPT-6.1 ${family}`, family: '', window: 0, main: true }));
  for (const row of modelRows(catalog, {})) {
    assert.equal(modelAppearance(`${row.family} ${row.id} ${row.label}`, 'codex').color, modelColor(row.id));
    assert.ok(modelAppearance(row.id, 'codex').color);
  }
});

test('Cursor distinguishes own models from external providers and colors by provider', () => {
  const models = [
    ['composer-2', 'cursor', 'Cursor'], ['claude-opus-4-6', 'anthropic', 'Anthropic'],
    ['gpt-6.1-astra', 'openai', 'OpenAI'], ['gemini-3-pro', 'google', 'Google'],
    ['grok-code-fast-1', 'xai', 'xAI'], ['glm-5p3', 'zai', 'Z.ai'], ['muse-wonder-1.0', 'meta', 'Meta'], ['deepseek-v3', 'deepseek', 'DeepSeek'],
    ['kimi-k2', 'moonshot', 'Moonshot'], ['qwen3-coder', 'alibaba', 'Alibaba'], ['minimax-m2', 'minimax', 'MiniMax'],
  ];
  for (const [model, id, name] of models) {
    const party = ['cursor', 'xai'].includes(id) ? 'First Party' : 'Third Party';
    assert.deepEqual(modelProvider(model), { id, name, party });
    assert.deepEqual(modelAppearance(model, 'cursor'), { color: `var(--provider-${party === 'First Party' ? 'cursor' : id})`, hint: `${party} · ${name}` });
  }
  assert.equal(modelAppearance('claude-sonnet-5-5', 'cursor').color, modelAppearance('claude-opus-5-5', 'cursor').color);
  assert.equal(modelAppearance('claude-opus-5-5', 'claude').color, 'var(--model-opus)');
  assert.deepEqual(modelAppearance('auto-smart', 'cursor'), { color: 'var(--provider-cursor)', hint: 'First Party · Cursor' });
  for (const model of [null, 'unknown-model', 'console', 'solaris']) assert.equal(modelProvider(model), undefined);
});


test('Cursor First Party stays white and has a readable background in the light theme', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../apps/web/src/style.css', import.meta.url), 'utf8');
  assert.match(css, /--provider-cursor: #fff/);
  assert.match(css, /:root\[data-scheme=light\].*--provider-cursor.*background: #292b30/);
});


test('markdown columns stay at the message width, so a long id or URL breaks inside it instead of being cut at the right edge', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../apps/web/src/style.css', import.meta.url), 'utf8');
  // A grid's implicit `auto` column grows to its widest unbreakable token; the .md grid and the list grids need a bounded column.
  const rule = css.match(/^\.md, \.md ul, \.md ol \{[^}]*\}/m);
  assert.ok(rule && /grid-template-columns: minmax\(0, 1fr\)/.test(rule[0]));
});

test('Cursor labels preserve model versions and group models by provider inside each party', () => {
  for (const [id, name] of [['claude-sonnet-4', 'Claude Sonnet 4'], ['glm-5p3', 'GLM 5p3'], ['claude-opus-5-5', 'Claude Opus 5.5'], ['muse-spark-1.3', 'Muse Spark 1.3'], ['gpt-5.6-sol[fast=true]', 'GPT 5.6 Sol'], ['GPT-6-Luna', 'GPT 6 Luna']]) assert.equal(modelDisplayName(id), name);
  assert.equal(modelRows([{ id: 'gpt-6-luna', name: 'GPT-6-Luna', family: '', window: 0, main: true }], {})[0].label, 'GPT 6 Luna');
  const ids = ['claude-sonnet-4', 'grok-4.7', 'glm-5p3', 'muse-wonder-1.0', 'claude-opus-5-5', 'composer-2.5', 'auto-smart'];
  const rows = modelRows(ids.map(id => ({ id, name: id, family: '', main: true, window: 0 })), {});
  assert.deepEqual(cursorModelGroups(rows, 'First Party').map(group => group.provider), ['Cursor', 'xAI']);
  const third = cursorModelGroups(rows, 'Third Party');
  assert.deepEqual(third.map(group => group.provider), ['Anthropic', 'Meta', 'Z.ai']);
  assert.equal(third[0].models.length, 2);
  assert.equal(third[2].models[0].label, 'GLM 5p3');
  assert.deepEqual(cursorModelGroups(rows, 'First Party').flatMap(group => group.models).map(row => row.id).sort(), ['auto-smart', 'composer-2.5', 'grok-4.7']);
});


test('Cursor search matches providers and model names and keeps versions ordered within a family', () => {
  const ids = ['claude-opus-4-6', 'claude-sonnet-5-5', 'claude-opus-4-8', 'claude-opus-4-7', 'glm-5p3'];
  const rows = modelRows(ids.map(id => ({ id, name: id, family: '', main: true, window: 0 })), {});
  const groups = cursorModelGroups(rows, 'Third Party', ' ANTHROPIC ');
  assert.deepEqual(groups.map(group => group.provider), ['Anthropic']);
  assert.deepEqual(groups[0].models.map(row => row.id), ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5']);
  assert.deepEqual(cursorModelGroups(rows, 'Third Party', 'GLM')[0].models.map(row => row.label), ['GLM 5p3']);
  assert.equal(cursorModelGroups(rows, 'Third Party', 'Claude Opus')[0].models.length, 3);
  assert.deepEqual(cursorModelGroups(rows, 'Third Party', 'missing-model'), []);
});

test('Cursor effort, fast and max context stay distinct settings', () => {
  assert.equal(isCursorEffort({ id: 'thinking' }), false);
  assert.equal(isCursorEffort({ id: 'reasoning_effort' }), true);
  assert.equal(isCursorSwitch({ id: 'fast', options: [{ value: 'false' }, { value: 'true' }] }), true);
  assert.equal(isCursorSwitch({ id: 'max_mode', options: [{ value: 'false' }, { value: 'true' }] }), false);
  assert.equal(effortLevel('extra-high'), 'xhigh');
  assert.equal(effortLabel('extra-high'), '매우 높음');
  assert.equal(effortLabel('max'), '최대');
  assert.deepEqual(contextEnds({ options: [{ value: '500k' }, { value: '256k' }] }), { off: '256k', on: '500k' });
  assert.equal(contextEnds({ options: [{ value: 'true' }, { value: 'false' }] }), null);
  assert.equal(cursorSettingName({ id: 'context', name: 'Context' }), '컨텍스트');
});

test('reconnecting shows while Cursor transport resumes and clears on result', () => {
  let view = reduce(emptyView(), { kind: 'user', text: 'hello' });
  view = reduce(view, { kind: 'delta', phase: 'reconnecting', active: true });
  assert.equal(view.reconnecting, true);
  view = reduce(view, { kind: 'delta', phase: 'reconnecting', active: false });
  assert.equal(view.reconnecting, false);
  view = reduce(reduce(view, { kind: 'delta', phase: 'reconnecting', active: true }), { kind: 'result', status: 'success' });
  assert.equal(view.reconnecting, false);
});

test("compacting shows while the CLI compacts and leaves a marker that keeps the history", () => {
  let view = reduce(emptyView(), { kind: "user", text: "/compact" });
  view = reduce(view, { kind: "delta", phase: "compacting", active: true });
  assert.equal(view.compacting, true);
  view = reduce(view, { kind: "compact", trigger: "manual", preTokens: 231097, postTokens: 14613 });
  assert.equal(view.compacting, true, 'the compact item can precede turn completion');
  view = reduce(view, { kind: "result", status: "success" });
  assert.equal(view.compacting, false);
  assert.deepEqual(view.items.map(item => item.kind), ["user", "compact"]);
  assert.deepEqual([view.items[1].preTokens, view.items[1].postTokens], [231097, 14613]);
  view = reduce(reduce(view, { kind: "delta", phase: "compacting", active: true }), { kind: "result", status: "interrupted" });
  assert.equal(view.compacting, false, "an interrupted compaction does not leave the spinner on");
});

test('stored reasoning replaces the streamed reasoning even when its parts are joined differently', () => {
  let view = reduce(emptyView(), { kind: 'delta', phase: 'thinking', messageId: 'r', index: 0, text: 'Plan' });
  view = reduce(view, { kind: 'delta', phase: 'thinking', messageId: 'r', index: 0, text: '\n\nCheck' });
  view = reduce(view, { seq: 1, kind: 'message', id: 'r', blocks: [{ type: 'thinking', text: 'Plan\nCheck' }] });
  assert.deepEqual(view.items[0].blocks.map(block => block.text), ['Plan\nCheck']);
});

test('a /compact result without a boundary or output does not claim the command ran', () => {
  const view = reduce(emptyView(), { seq: 1, kind: 'user', text: '/compact' });
  const done = reduce(view, { seq: 2, kind: 'result', status: 'success', text: '' });
  assert.equal(done.items.at(-1).text, '컨텍스트 압축 완료를 확인하지 못했습니다.');
});

test('a synthetic message the CLI re-sends after /compact (same uuid, new id) is not shown twice', () => {
  const output = { kind: 'message', role: 'assistant', uuid: 'u1', blocks: [{ type: 'text', text: '## Context Usage' }] };
  let view = reduce(emptyView(), { seq: 1, ...output, id: 'first' });
  view = reduce(view, { seq: 2, kind: 'compact', trigger: 'manual', preTokens: 100, postTokens: 10 });
  view = reduce(view, { seq: 3, ...output, id: 'second' });
  assert.deepEqual(view.items.map(item => item.kind), ['assistant', 'compact'], 'the repeat leaves no second reply');
  assert.equal(view.seq, 3, 'but the sequence still advances');
  view = reduce(view, { seq: 4, kind: 'message', role: 'assistant', uuid: 'u2', id: 'third', blocks: [{ type: 'text', text: 'a new reply' }] });
  assert.equal(view.items.filter(item => item.kind === 'assistant').length, 2, 'a different uuid is a new reply');
});

test('the particle -(으)로 follows the last sound of the word', () => {
  assert.equal(ro('계획'), '으로');
  assert.equal(ro('기본'), '으로');
  assert.equal(ro('낮음'), '으로');
  assert.equal(ro('모드'), '로');
  assert.equal(ro('서울'), '로', 'ㄹ takes 로');
  assert.equal(ro('Haiku 5.5'), '로', '5 is read "오"');
  assert.equal(ro('Opus 4.1'), '로', '1 is read "일", ending in ㄹ');
  assert.equal(ro('Model 3'), '으로', '3 is read "삼"');
  assert.equal(ro('Haiku'), '(으)로', 'unknown pronunciation stays neutral');
});

test('report commands answer as chat messages; other short output stays a system line; the CLI model echo is dropped', () => {
  for (const name of ['cost', 'context', 'status', 'usage']) {
    let view = reduce(emptyView(), { seq: 1, kind: 'user', text: `/${name}` });
    view = reduce(view, { seq: 2, kind: 'command_output', text: `${name} report`, isError: false });
    assert.deepEqual(view.items.map(item => item.kind), ['user', 'info'], `/${name} is a chat message`);
    view = reduce(view, { seq: 3, kind: 'result', status: 'success', text: `${name} report` });
    assert.equal(view.items.length, 2, `/${name} output is not repeated from the result`);
  }
  let view = reduce(emptyView(), { seq: 1, kind: 'user', text: '/cost' });
  view = reduce(view, { seq: 2, kind: 'command_output', text: 'boom', isError: true });
  assert.equal(view.items.at(-1).kind, 'command', 'an error keeps the command line');
  view = reduce(emptyView(), { seq: 1, kind: 'user', text: '/compact' });
  view = reduce(view, { seq: 2, kind: 'command_output', text: 'Compacted', isError: false });
  assert.equal(view.items.at(-1).kind, 'command', 'other output is unchanged');
  view = reduce(emptyView(), { seq: 1, kind: 'command_output', text: 'Set model to `opus (claude-opus-5-5)`', isError: false });
  assert.equal(view.items.length, 0, 'the echo of a model switch is not shown');
});

test('switching settings edits the line above when it is the same kind, otherwise adds one', () => {
  const model = value => ({ model: { value, color: 'red' } }), effort = value => ({ effort: { value, color: 'blue' } }), mode = value => ({ mode: { value: `${value} 모드`, color: 'green' } });
  let items = [{ kind: 'assistant', key: 'a', id: 'a', blocks: [], sub: false, fresh: false }];
  let n = 0;
  const go = change => { items = withSettingChange(items, change, `n${++n}`); return items.filter(item => item.kind === 'note').map(item => item.text); };
  assert.deepEqual(go(model('Sonnet 5.5')), ['이제부터 Sonnet 5.5 모델로 작업합니다.']);
  assert.deepEqual(go(model('Haiku 5.5')), ['이제부터 Haiku 5.5 모델로 작업합니다.'], 'a second model replaces the first');
  assert.deepEqual(go(mode('계획')), ['이제부터 Haiku 5.5 모델로 작업합니다.', '계획 모드로 변경했습니다.'], 'a mode is a line of its own');
  assert.deepEqual(go(effort('중간')), ['이제부터 Haiku 5.5 모델로 작업합니다.', '계획 모드로 변경했습니다.', '이제부터 중간 추론 강도로 작업합니다.'], 'the line above is a mode, so an Effort starts a new line');
  assert.deepEqual(go(effort('높음')).at(-1), '이제부터 높음 추론 강도로 작업합니다.', 'an Effort right after an Effort edits it');
  assert.deepEqual(go(model('Sonnet 5.5')), ['이제부터 Haiku 5.5 모델로 작업합니다.', '계획 모드로 변경했습니다.', '이제부터 Sonnet 5.5, 높음으로 작업합니다.'], 'a model joins the Effort line above, not the older model line');
  assert.deepEqual(go(mode('편집 허용')).at(-1), '편집 허용 모드로 변경했습니다.');
  assert.deepEqual(go(mode('자동')).slice(-2), ['이제부터 Sonnet 5.5, 높음으로 작업합니다.', '자동 모드로 변경했습니다.'], 'consecutive modes edit the same mode line');
  assert.deepEqual(go(mode('기본')).slice(-1), ['기본 모드로 변경했습니다.']);
  assert.equal(items.filter(item => item.kind === 'note').length, 4);
  assert.deepEqual(go(model('Opus 5.5')).slice(-2), ['기본 모드로 변경했습니다.', '이제부터 Opus 5.5 모델로 작업합니다.'], 'a model after a mode line is a new line');
  assert.deepEqual(go(effort('낮음')).slice(-1), ['이제부터 Opus 5.5, 낮음으로 작업합니다.']);
  const edited = items.at(-1);
  assert.equal(edited.key, 'n10', 'the edited line keeps its key, so it does not remount');
  assert.equal(edited.fresh, false);
  assert.equal(edited.rev, 1, 'each edit bumps the revision');
  assert.deepEqual(edited.tones.map(tone => tone.color), ['red', 'blue'], 'every value keeps its own colour');
  items = [...items, { kind: 'user', key: 'u', text: 'more', images: 0, fresh: false }];
  assert.equal(go(effort('높음')).length, 6, 'after another message a new line starts');
  assert.equal(settingsLine({}).text, '');
  assert.equal(settingsLine({ model: { value: 'M', color: 'x' }, effort: { value: '최대', color: 'x' } }).text, '이제부터 M, 최대로 작업합니다.', 'the particle follows the Effort');
});

test('tool runs: 3+ consecutive tools bundle, thoughts between tools stay inside, any text ends the run', () => {
  const think = { block: { type: 'thinking', text: 'hm' }, sub: false };
  const runsOf = turn => { const { groups } = processGroups(turn); return toolRuns(turn, groups).map(run => [run.start, run.end, run.tools]); };
  assert.deepEqual(runsOf(flow(T('a'), T('b'), '다음으로 볼게요.', '끝.')), [], 'two tools are not worth a bundle');
  assert.deepEqual(runsOf(flow(T('a'), T('b'), T('c'), '끝.')), [[0, 3, 3]]);
  // a thought between tools belongs to the run; one at either edge does not
  assert.deepEqual(runsOf(flow(think, T('a'), think, T('b'), T('c'), think, '끝.')), [[1, 5, 3]]);
  // a remark splits the tools: 2 + 2 is two small stretches, 3 + 1 is one bundle
  assert.deepEqual(runsOf(flow(T('a'), T('b'), '잠깐 확인.', T('c'), T('d'), '끝.')), []);
  assert.deepEqual(runsOf(flow(T('a'), T('b'), T('c'), '잠깐 확인.', T('d'), '끝.')), [[0, 3, 3]]);
  // a thought shown as plain text has content: it splits the tools like a remark (3 + 1 bundles, 2 + 2 does not)
  const plainRuns = turn => toolRuns(turn, processGroups(turn).groups, 3, true).map(run => [run.start, run.end, run.tools]);
  assert.deepEqual(plainRuns(flow(T('a'), T('b'), T('c'), think, T('d'), '끝.')), [[0, 3, 3]]);
  assert.deepEqual(plainRuns(flow(T('a'), T('b'), think, T('c'), T('d'), '끝.')), []);
  assert.deepEqual(toolRuns(flow(T('a'), T('b'), '끝.'), processGroups(flow(T('a'), T('b'), '끝.')).groups, 2).map(run => run.tools), [2], 'the threshold is a parameter');
});

test('autoDenial: only the auto-mode classifier refusal is a denial, and it carries the reason', () => {
  const text = 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Create Unsafe Agents]. If you have other tasks...';
  assert.deepEqual(autoDenial(text), { reason: 'Create Unsafe Agents' });
  assert.deepEqual(autoDenial('Permission for this action was denied by the Claude Code auto mode classifier.'), { reason: '' });
  assert.equal(autoDenial('Error: ENOENT'), null);
});

test('an Agent call stays a visible card: it splits the process around it instead of folding into it', () => {
  const agent = { block: { type: 'tool_use', id: 'A', name: 'Agent', input: {} }, sub: false };
  assert.equal(shapeOf([T('1'), T('2'), agent, T('3'), ...flow('끝')]), 'PpRPR');
});

test('subagents: the end report wins; a background one runs while its child lives; a foreground one ends with its result', () => {
  const call = (id, input) => ({ type: 'tool_use', id, name: 'Agent', input });
  let view = reduce(emptyView(), { seq: 1, kind: 'message', id: 'm', blocks: [call('bg', { description: 'scan', subagent_type: 'Explore', run_in_background: true }), call('fg', { description: 'read', prompt: 'go' })] });
  view = reduce(view, { seq: 2, kind: 'task', phase: 'start', toolUseId: 'bg', description: 'scan', agentType: 'Explore', background: true, at: 1000 });
  view = reduce(view, { seq: 3, kind: 'tool_result', toolUseId: 'bg', content: 'Async agent launched', isError: false });
  view = reduce(view, { seq: 4, kind: 'message', id: 's1', parentToolUseId: 'bg', blocks: [{ type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'x' } }] });
  view = reduce(view, { kind: 'task', phase: 'progress', toolUseId: 'bg', activity: 'Running grep', toolUses: 1 });
  let [bg, fg] = agentsOf(view.items, view.results, view.tasks, false, ['bg']);
  assert.equal(bg.status, 'running'); assert.equal(bg.now, 'Running grep'); assert.equal(bg.toolCount, 1); assert.equal(bg.items.length, 1); assert.equal(bg.startedAt, 1000);
  assert.equal(fg.status, 'stopped', 'idle chat, no result: it never finished');
  assert.equal(agentsOf(view.items, view.results, view.tasks, true, ['bg'])[1].status, 'running');
  assert.equal(agentsOf(view.items, view.results, view.tasks, false, [])[0].status, 'stopped', 'its child is gone');
  view = reduce(view, { seq: 5, kind: 'tool_result', toolUseId: 'fg', content: 'found it', isError: false });
  view = reduce(view, { seq: 6, kind: 'task', phase: 'end', toolUseId: 'bg', status: 'completed', report: 'Count: 28', durationMs: 14803, at: 16000 });
  [bg, fg] = agentsOf(view.items, view.results, view.tasks, false, []);
  assert.equal(bg.status, 'done'); assert.equal(bg.report, 'Count: 28'); assert.equal(bg.now, ''); assert.equal(bg.durationMs, 14803);
  assert.equal(fg.status, 'done'); assert.equal(fg.report, 'found it'); assert.equal(fg.prompt, 'go');
  assert.deepEqual(view.items.filter(item => item.kind === 'agent_end').map(item => item.toolUseId), ['bg'], 'only the background one marks its end in the thread');
  view = reduce(view, { seq: 7, kind: 'task', phase: 'end', toolUseId: 'bg', status: 'failed' });
  assert.equal(agentsOf(view.items, view.results, view.tasks, false)[0].status, 'error');
  assert.equal(view.items.filter(item => item.kind === 'agent_end').length, 1, 'a repeated end report adds no second marker');
});

test('a background shell ends quietly: its end leaves no divider in the thread, and it is a job (not a subagent)', () => {
  let view = reduce(emptyView(), { seq: 1, kind: 'message', id: 'm', blocks: [{ type: 'tool_use', id: 'sh', name: 'Bash', input: { command: 'sleep 99', run_in_background: true } }] });
  view = reduce(view, { seq: 2, kind: 'task', phase: 'start', toolUseId: 'sh', taskId: 'babc12345', description: 'sleep', background: true, at: 1000 });
  assert.equal(agentsOf(view.items, view.results, view.tasks, false, ['sh'])[0].status, 'running');
  view = reduce(view, { seq: 3, kind: 'task', phase: 'end', toolUseId: 'sh', status: 'stopped', at: 2000 });
  assert.equal(agentsOf(view.items, view.results, view.tasks, false, [])[0].status, 'stopped');
  assert.equal(view.items.filter(item => item.kind === 'agent_end').length, 0);
  assert.equal(view.items.filter(item => item.kind === 'note').length, 0, 'a job the user stopped stays quiet');
});

test('a background job that ends by itself leaves one 알림 rule, since the CLI answers it with a turn of its own', () => {
  let view = reduce(emptyView(), { seq: 1, kind: 'message', id: 'm', blocks: [{ type: 'tool_use', id: 'mon', name: 'Monitor', input: { command: 'watch' } }] });
  view = reduce(view, { seq: 2, kind: 'task', phase: 'start', toolUseId: 'mon', description: 'Watch hub', background: true, at: 1000 });
  view = reduce(view, { seq: 3, kind: 'task', phase: 'end', toolUseId: 'mon', status: 'completed', at: 2000 });
  view = reduce(view, { seq: 4, kind: 'task', phase: 'end', toolUseId: 'mon', status: 'completed', at: 2000 });
  assert.deepEqual(view.items.filter(item => item.kind === 'note').map(item => item.text), ['알림 · Watch hub 끝남']);
  assert.deepEqual(view.items.find(item => item.kind === 'note').tones, [{ value: '알림', color: 'var(--accent)', icon: 'notifications' }, { value: 'Watch hub 끝남', color: 'var(--fg)' }]);
});

test('agent list and pending maps keep their identity while nothing about them changed (pane contexts read by every tool card)', () => {
  let view = reduce(emptyView(), { seq: 1, kind: 'message', id: 'm', blocks: [{ type: 'tool_use', id: 'a', name: 'Agent', input: { description: 'scan' } }] });
  const first = agentsOf(view.items, view.results, view.tasks, true);
  assert.equal(keepAgents(first, agentsOf(view.items, view.results, view.tasks, true)), first, 'rebuilt but equal: the old list');
  const empty = keepAgents([], []); assert.equal(keepAgents(empty, []), empty);
  view = reduce(view, { kind: 'delta', phase: 'text', messageId: 'other', text: 'unrelated text' });
  assert.equal(keepAgents(first, agentsOf(view.items, view.results, view.tasks, true)), first, 'text elsewhere streamed: still the old list');
  view = reduce(view, { seq: 2, kind: 'message', id: 's', parentToolUseId: 'a', blocks: [{ type: 'tool_use', id: 'g', name: 'Grep', input: {} }] });
  assert.notEqual(keepAgents(first, agentsOf(view.items, view.results, view.tasks, true)), first, 'the subagent took a step');
  assert.notEqual(keepAgents(first, agentsOf(view.items, view.results, view.tasks, false)), first, 'its status changed');
  assert.equal(awaitingTools(view.items, [], view.results), awaitingTools([], [], {}), 'nothing pending: one shared empty set');
  assert.equal(approvalAgents(view.items, []), approvalAgents([], []));
});

test('a plan splits into its ## sections; the # line is its title and fenced code is never cut', () => {
  const plan = ['# 계획', '', '머리말', '', '## Context', '- a', '- b', '', '## 코드', '```md', '## not a section', '```', '1. step'].join('\n');
  const { title, sections } = planSections(plan);
  assert.equal(title, '계획');
  assert.deepEqual(sections.map(section => [section.title, section.items]), [['', 0], ['Context', 2], ['코드', 1]]);
  assert.match(sections[2].body, /## not a section/);
  assert.deepEqual(planSections('just text').sections, [{ title: '', body: 'just text', items: 0 }]);
});

test('MCP tools: readable label and summary instead of raw JSON', () => {
  assert.equal(toolLabel('mcp__claude_ai_Claude_Docs__update'), 'Claude Docs · update');
  assert.equal(toolLabel('Bash'), 'Bash');
  assert.equal(toolSummary('mcp__claude_ai_Claude_Docs__guide', { items: ['topic.index', 'topic.editing'] }), 'topic.index, topic.editing');
  assert.equal(toolSummary('mcp__claude_ai_Claude_Docs__batch', { container: { kind: 'project', create: { name: '작업 내용' } } }), '작업 내용');
  assert.equal(toolSummary('mcp__x__update', { ref: { id: 'a' }, payload: { ops: [{ with: { from: { content: '## 개요\n본문' } } }] } }), '개요 본문');
  assert.equal(toolSummary('mcp__x__ping', { flag: true, n: 2 }), 'flag: true · n: 2');
});

test('artifacts: a created doc is found by the claude.ai link in its result', () => {
  const url = 'https://claude.ai/artifact/1wrqK8ndBdUqv356KQ2syF';
  const blocks = [
    { type: 'tool_use', id: 'g', name: 'mcp__claude_ai_Claude_Docs__guide', input: {} },
    { type: 'tool_use', id: 'b', name: 'mcp__claude_ai_Claude_Docs__batch', input: { container: { create: { name: '작업 내용' } } } },
    { type: 'tool_use', id: 'u', name: 'mcp__claude_ai_Claude_Docs__update', input: {} }
  ];
  const results = { g: { content: `see ${url}`, isError: false }, b: { content: `{"frame":{"url":"${url}"}}`, isError: false }, u: { content: `{"url":"${url}"}`, isError: false } };
  assert.deepEqual(artifactsOf(blocks, results), [{ url, title: '작업 내용', toolUseId: 'b' }]);
  assert.deepEqual(artifactsOf(blocks, { b: { content: url, isError: true } }), []);
});

test('artifacts: a temporary or wrong url is not a durable link, and an expired result can be explained', () => {
  const real = 'https://claude.ai/artifact/1wrqK8ndBdUqv356KQ2syF';
  const doubled = 'https://claude.ai/artifact/artifact/1wrqK8ndBdUqv356KQ2syF';
  const localhost = 'http://localhost:3000/artifact/1wrqK8ndBdUqv356KQ2syF';
  const code = 'https://claude.ai/code/artifact/1wrqK8ndBdUqv356KQ2syF';
  assert.equal(classifyArtifactUrl(real), 'durable');
  assert.equal(classifyArtifactUrl('https://claude.ai/artifact//1wrqK8ndBdUqv356KQ2syF'), 'durable');
  assert.equal(classifyArtifactUrl(localhost), 'temporary');
  assert.equal(classifyArtifactUrl(code), 'temporary');
  assert.equal(classifyArtifactUrl('https://preview.claude.ai/artifact/1wrqK8ndBdUqv356KQ2syF'), 'temporary');
  assert.equal(classifyArtifactUrl('/artifact/1wrqK8ndBdUqv356KQ2syF'), 'temporary');
  assert.equal(classifyArtifactUrl('https://claude.ai/artifact/preview'), 'temporary');
  assert.equal(classifyArtifactUrl('https://claude.ai/artifact/artifact'), 'temporary');
  assert.equal(classifyArtifactUrl(doubled), 'temporary', 'a doubled segment is not itself a durable link');
  assert.equal(classifyArtifactUrl('https://claude.ai/1wrqK8ndBdUqv356KQ2syF'), 'temporary', 'a dropped /artifact segment is not durable');
  const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const html = '<p>본문 <script>alert(1)</script><b>안녕</b></p>';
  const temp = artifactsOf([call('a', 'Artifact', { title: '초안' })], { a: { content: JSON.stringify({ url: localhost, title: '결과 제목', html }), isError: false } });
  assert.deepEqual(temp, [{ url: localhost, title: '초안', toolUseId: 'a', problem: 'temporary', preview: '본문 안녕' }]);
  assert.doesNotMatch(temp[0].preview, /[<>]|alert/);
  const coded = artifactsOf([call('c', 'Artifact', {})], { c: { content: code, isError: false } });
  assert.equal(coded[0].problem, 'temporary');
  assert.equal(classifyArtifactUrl(coded[0].url), 'temporary');
  const fixed = artifactsOf([call('d', 'Artifact', { title: '문서' })], { d: { content: doubled, isError: false } });
  assert.deepEqual(fixed, [{ url: real, title: '문서', toolUseId: 'd' }], 'the extra artifact segment is dropped and the real id is kept');
  const slashes = artifactsOf([call('s', 'Artifact', {})], { s: { content: 'https://claude.ai/artifact//1wrqK8ndBdUqv356KQ2syF', isError: false } });
  assert.equal(slashes[0].url, real);
  assert.equal(slashes[0].problem, undefined);
  const mixed = artifactsOf([call('m', 'Artifact', { title: '문서' })], { m: { content: `preview http://127.0.0.1:9/artifact/nope\n${real}`, isError: false } });
  assert.deepEqual(mixed, [{ url: real, title: '문서', toolUseId: 'm' }]);
  const shown = artifactsOf([call('p', 'Artifact', {})], { p: { content: JSON.stringify({ url: real, title: '결과 제목', body: '짧은 본문' }), isError: false } });
  assert.deepEqual(shown, [{ url: real, title: '결과 제목', toolUseId: 'p', preview: '짧은 본문' }]);
  const long = artifactsOf([call('l', 'mcp__x__publish', { title: '긴 글' })], { l: { content: JSON.stringify({ url: real, html: `<div>${'가'.repeat(500)}</div>` }), isError: false } });
  assert.ok(long[0].preview.length <= 200);
  assert.equal(long[0].preview.endsWith('…'), true);
  assert.doesNotMatch(long[0].preview, /[<>]/);
  const expired = artifactsOf([call('e', 'Artifact', { title: '지난 문서' })], { e: { content: 'This artifact link has expired', isError: true } });
  assert.deepEqual(expired, [{ url: '', title: '지난 문서', toolUseId: 'e', problem: 'expired' }]);
  const invalid = artifactsOf([call('i', 'mcp__x__publish', {})], { i: { content: JSON.stringify({ error: 'invalid url', html: '<b>남은 본문</b>' }), isError: false } });
  assert.deepEqual(invalid, [{ url: '', title: '', toolUseId: 'i', problem: 'invalid', preview: '남은 본문' }]);
  const dead = artifactsOf([call('x', 'Artifact', { title: '문서' })], { x: { content: JSON.stringify({ url: real, error: 'expired' }), isError: false } });
  assert.equal(dead[0].problem, 'expired');
  assert.equal(dead[0].url, '');
});

test('repeating /autocompact or /rename edits the line above instead of adding another', () => {
  let items = [];
  const go = change => { items = withSettingChange(items, change, `k${items.length}`); return items.filter(item => item.kind === 'note').map(item => item.text); };
  assert.deepEqual(go({ compact: { value: '350k 토큰', color: 'x' } }), ['Auto Compact 창을 350k 토큰으로 설정했습니다.']);
  assert.deepEqual(go({ compact: { value: 'auto', color: 'x' } }).length, 1);
  assert.equal(go({ title: { value: '작업', color: 'x' } }).length, 2);
  assert.equal(go({ title: { value: '작업2', color: 'x' } }).length, 2);
  assert.equal(go({ mode: { value: '계획 모드', color: 'x' } }).length, 3);
  assert.equal(go({ compact: { value: '400k 토큰', color: 'x' } }).length, 4);
});

test('a tool held at an approval prompt is awaiting, by its id or (without one) as the newest unanswered call of that tool', () => {
  const items = [{ kind: 'assistant', key: 'a', blocks: [
    { type: 'tool_use', id: 't1', name: 'Bash', input: {} }, { type: 'tool_use', id: 't2', name: 'Bash', input: {} }, { type: 'tool_use', id: 't3', name: 'Edit', input: {} }] }];
  const results = { t1: { content: 'ok', isError: false } };
  assert.deepEqual([...awaitingTools(items, [], results)], []);
  assert.deepEqual([...awaitingTools(items, [{ requestId: 'r', tool: 'Edit', input: {}, toolUseId: 't3', suggestions: [] }], results)], ['t3']);
  assert.deepEqual([...awaitingTools(items, [{ requestId: 'r', tool: 'Bash', input: {}, suggestions: [] }], results)], ['t2']);
});

test('an approval asked inside a subagent is traced back to that subagent', () => {
  const items = [
    { kind: 'assistant', key: 'a', id: 'a', sub: false, blocks: [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: {} }] },
    { kind: 'assistant', key: 'b', id: 'b', sub: true, parent: 'agent1', blocks: [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: {} }] },
    { kind: 'assistant', key: 'c', id: 'c', sub: false, blocks: [{ type: 'tool_use', id: 'bash2', name: 'Bash', input: {} }] },
  ];
  const approvals = [{ requestId: 'r1', tool: 'Bash', input: {}, toolUseId: 'bash1', suggestions: [] }, { requestId: 'r2', tool: 'Bash', input: {}, toolUseId: 'bash2', suggestions: [] }];
  assert.deepEqual([...approvalAgents(items, approvals)], [['r1', 'agent1']], 'the main conversation\'s own approval has no subagent');
});

test('a failure the CLI also says as a synthetic reply shows once, as the error card', () => {
  const events = [
    { seq: 1, kind: 'user', text: 'hi' },
    { seq: 2, kind: 'message', id: 'syn', model: '<synthetic>', blocks: [{ type: 'text', text: 'Invalid API key · Fix external API key' }] },
    { seq: 3, kind: 'result', status: 'failed', text: 'Invalid API key · Fix external API key' },
  ];
  assert.deepEqual(fromReplay({ events, seq: 3 }).items.map(item => item.kind), ['user', 'error']);
  const kept = fromReplay({ events: [events[0], { ...events[1], blocks: [{ type: 'text', text: '다른 답' }] }, events[2]], seq: 3 });
  assert.deepEqual(kept.items.map(item => item.kind), ['user', 'assistant', 'error'], 'a real reply before the failure stays');
});

test('a Monitor or background shell is tracked as a job until the CLI reports its end', () => {
  const items = [{ kind: 'assistant', key: 'a', id: 'a', sub: false, blocks: [
    { type: 'tool_use', id: 'm1', name: 'Monitor', input: { command: 'ping -n 3 127.0.0.1', description: 'ping three times' } },
    { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test', run_in_background: true } },
    { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'ls' } },
  ] }];
  const results = { m1: { content: 'Monitor started', isError: false }, b1: { content: 'running in background', isError: false }, b2: { content: 'a', isError: false } };
  const running = agentsOf(items, results, { m1: { description: 'ping three times' }, b1: {} }, true);
  assert.deepEqual(running.map(job => [job.id, job.type, job.status, job.job]), [['m1', 'Monitor', 'running', true], ['b1', '백그라운드 셸', 'running', true]], 'a plain shell call is no job');
  const ended = agentsOf(items, results, { m1: { status: 'completed', report: 'stream ended' }, b1: { status: 'failed' } }, false);
  assert.deepEqual(ended.map(job => job.status), ['done', 'error']);
  assert.match(ended[0].prompt, /ping -n 3/);
});

test('a tool call refused at its approval card is remembered as refused, not failed', () => {
  let view = { ...emptyView(), ready: true };
  view = reduce(view, { kind: 'approval', phase: 'request', requestId: 'r1', tool: 'Write', input: {}, toolUseId: 't1' });
  view = reduce(view, { kind: 'approval', phase: 'answer', requestId: 'r1', tool: 'Write', allow: false });
  view = reduce(view, { kind: 'approval', phase: 'request', requestId: 'r2', tool: 'Bash', input: {}, toolUseId: 't2' });
  view = reduce(view, { kind: 'approval', phase: 'answer', requestId: 'r2', tool: 'Bash', allow: true });
  assert.deepEqual(view.denied, { t1: true });
});

test('a finished turn keeps its end time, duration and tokens on the last answer', () => {
  let view = reduce(emptyView(), { kind: 'user', text: 'hi' });
  view = reduce(view, { kind: 'message', id: 'm1', blocks: [{ type: 'text', text: 'ok' }] });
  view = reduce(view, { kind: 'result', status: 'success', at: 1_700_000_000_000, durationMs: 65_000, usage: { input: 10, output: 2000, cacheRead: 500, cacheCreate: 30 } });
  const done = view.items.find(item => item.kind === 'assistant')?.done;
  assert.deepEqual(done?.ms, 65_000);
  const noon = new Date(2026, 10, 15, 11, 40).getTime(), pm = new Date(2026, 10, 15, 15, 0).getTime(), mid = new Date(2026, 10, 15, 0, 5).getTime();
  assert.deepEqual(turnDoneParts({ at: noon, ms: 65_000 }, noon), ['1분 5초 소요', '오전 11시 40분']);
  assert.deepEqual(turnDoneParts({ at: pm, ms: null }, pm), ['오후 3시']);
  assert.deepEqual(turnDoneParts({ at: mid, ms: 0 }, mid + 3 * 86_400_000), ['0초 소요', '11월 15일 오전 12시 5분']);
  assert.deepEqual(turnTokenRows(done), [
    { icon: 'token', label: '토큰', up: { label: '입력', value: '10' }, down: { label: '출력', value: '2k' } },
    { icon: 'database', label: '캐시', up: { label: '쓰기', value: '30' }, down: { label: '읽기', value: '500' } }]);
  assert.deepEqual(turnTokenRows({ at: 1, ms: null, tokens: { input: 1, output: 2, cacheRead: 0, cacheCreate: 0 } }).map(row => row.icon), ['token']);
  assert.deepEqual(turnTokenRows({ at: 1, ms: null }), []);
});

test('a subagent shows the model its messages report and the effort it was given, else the session\'s', () => {
  const call = (id, input) => ({ kind: 'assistant', key: id, id, sub: false, blocks: [{ type: 'tool_use', id, name: 'Agent', input }] });
  const kid = { kind: 'assistant', key: 'k', id: 'k', sub: true, parent: 'a1', model: 'claude-haiku-5-5', blocks: [] };
  const [a, b] = agentsOf([call('a1', { prompt: 'x' }), kid, call('a2', { prompt: 'y', effort: 'low', model: 'opus' })], {}, {}, false, undefined, 'high');
  assert.deepEqual([a.model, a.effort, b.model, b.effort], ['claude-haiku-5-5', 'high', 'opus', 'low']);
});

test('a mode the agent changed on its own gets a line in the thread; a settings event without that (cursor, own switch) does not', () => {
  const view = reduce(emptyView(), { kind: 'settings', permissionMode: 'plan', by: 'agent' });
  const [note] = view.items;
  assert.equal(note.kind, 'note');
  assert.equal(note.text, 'AI가 계획 모드로 변경했습니다.');
  assert.deepEqual(note.tones.map(tone => tone.value), ['계획 모드']);
  assert.equal(reduce(emptyView(), { kind: 'settings', permissionMode: 'plan' }).items.length, 0);
});

test('the thread says when the agent moved into or out of a worktree, a plan limit was warned or hit, and the model switched by itself', () => {
  const line = event => reduce(emptyView(), event).items[0];
  assert.equal(line({ kind: 'worktree', phase: 'enter', path: '/p/.claude/worktrees/a', branch: 'worktree-a' }).text, 'AI가 워크트리로 이동했습니다 · a (worktree-a)');
  assert.equal(line({ kind: 'worktree', phase: 'exit', path: '/p', from: '/p/.claude/worktrees/a', removed: false }).text, 'AI가 워크트리에서 나왔습니다 · a 유지됨');
  assert.match(line({ kind: 'limit', status: 'allowed_warning', limit: 'five_hour', utilization: 0.99, resetsAt: 1794808800 }).text, /^5시간 한도의 99%를 사용했습니다 · .*초기화$/);
  assert.match(line({ kind: 'limit', status: 'rejected', limit: 'seven_day', resetsAt: null }).text, /^주간 한도에 도달했습니다$/);
  assert.match(line({ kind: 'limit', status: 'rejected', limit: 'five_hour', overage: true, resetsAt: null }).text, /추가 사용량으로 이어서 진행합니다$/);
  const limit = { kind: 'limit', status: 'allowed_warning', limit: 'five_hour', threshold: 0.9, resetsAt: 1794808800 };
  assert.equal(reduce(reduce(emptyView(), limit), limit).items.length, 1, 'the same warning is said once');
  assert.match(line({ kind: 'settings', model: 'claude-sonnet-5-5', by: 'agent' }).text, /모델로 자동 전환되었습니다\.$/);
  assert.match(line({ kind: 'settings', model: 'gpt-5.5', by: 'agent', reason: 'highRiskCyberActivity' }).text, /보안 정책$/);
});

test('a plan-limit line follows the CLI\'s latest reading instead of freezing on the first one, and never passes a warning line off as the usage', () => {
  const warn = (extra = {}) => ({ kind: 'limit', status: 'allowed_warning', limit: 'five_hour', threshold: 0.9, resetsAt: 1794808800, ...extra });
  let view = reduce(emptyView(), { ...warn({ utilization: 0.91 }), seq: 1, at: Date.now() });
  assert.match(view.items[0].text, /^5시간 한도의 91%를 사용했습니다 · .*기준 · .*에 초기화$/);
  const key = view.items[0].key;
  view = reduce(view, { kind: 'user', text: '계속', seq: 2 });
  view = reduce(view, { ...warn({ utilization: 0.96 }), seq: 3, at: Date.now() });
  assert.equal(view.items.length, 2, 'the same window keeps one line');
  assert.match(view.items[0].text, /^5시간 한도의 96%를 사용했습니다/);
  assert.equal(view.items[0].key, key, 'the line keeps its place and key');
  const same = reduce(view, { ...warn({ utilization: 0.96 }), seq: 4, at: Date.now() });
  assert.equal(same.items, view.items, 'an identical reading changes nothing');
  assert.equal(reduce(view, { ...warn({ utilization: 0.97, threshold: 0.9, resetsAt: 1794812400 }), seq: 5 }).items.length, 3, 'the next window is a new line');
  assert.equal(reduce(view, { kind: 'limit', status: 'rejected', limit: 'five_hour', resetsAt: 1794808800, seq: 5 }).items.length, 3, 'reaching the limit is its own line');
  // Without a reading, the warning line is only a lower bound.
  assert.match(reduce(emptyView(), warn()).items[0].text, /^5시간 한도의 90% 이상 사용했습니다 · /);
  assert.match(reduce(emptyView(), warn({ threshold: null })).items[0].text, /^5시간 한도의 대부분을 사용했습니다 · /);
  assert.match(reduce(emptyView(), warn({ limit: 'seven_day_overage_included', utilization: 0.5 })).items[0].text, /^주간 한도의 50%를/);
  assert.match(reduce(emptyView(), warn({ limit: 'unheard_of', utilization: 0.5 })).items[0].text, /^사용 한도의 50%를/);
});

test('Cursor send-now waits behind earlier send-now lines and ahead of follow-ups', () => {
  const queued = enqueueSendNow([{ text: '나중', now: false }, { text: '더 나중' }], { text: '지금', now: true });
  assert.deepEqual(queued.map(item => item.text), ['지금', '나중', '더 나중']);
  const again = enqueueSendNow(queued, { text: '바로', now: true });
  assert.deepEqual(again.map(item => item.text), ['지금', '바로', '나중', '더 나중']);
});

test('blocked actions: shown from the server record, kept when only allowed, dropped when retried or once the user speaks', () => {
  const denied = (seq, id) => ({ seq, kind: 'auto_denied', toolUseId: id, tool: 'Bash', input: { command: 'git push' }, reason: 'Git Destructive', rule: 'Bash(git push)' });
  let view = reduce(reduce(emptyView(), denied(1, 'a')), denied(2, 'b'));
  assert.deepEqual(Object.keys(view.blocked), ['a', 'b']);
  assert.equal(view.blocked.a.rule, 'Bash(git push)');
  view = reduce(view, { seq: 3, kind: 'denial_allow', toolUseIds: ['a'], retry: false, rules: ['Bash(git push)'] });
  assert.equal(view.blocked.a.allowed, true, 'allowed alone stays open for a retry');
  view = reduce(view, { seq: 4, kind: 'denial_allow', toolUseIds: ['a', 'b'], retry: true, rules: [] });
  assert.deepEqual(view.blocked, {});
  assert.deepEqual(Object.keys(reduce(emptyView(), denied(1, 'c')).blocked), ['c']);
  assert.deepEqual(reduce(reduce(emptyView(), denied(1, 'c')), { seq: 2, kind: 'user', text: 'hi', images: 0 }).blocked, {});
  assert.equal(reduce(emptyView(), { seq: 1, kind: 'auto_denied' }).blocked, undefined, 'a record without a call is ignored');
});

test('a chat log written by 0.5.12 replays: every event kind it stored, a plan-limit report without the newer fields, an approval and a subagent', () => {
  // Real 0.5.12 events (kept from the update e2e). Newer builds only add fields; none of these may throw, and the replay must keep the same items.
  const stored = [
    { kind: 'user', text: '안녕하세요 첫 대화입니다', images: 0, previews: [], seq: 1, at: 1795110078013 },
    { kind: 'session', sessionId: 'fake-session-27024', model: 'Model 1.0', permissionMode: 'default', tools: ['Bash', 'Agent'], slashCommands: ['compact', 'context'], seq: 2, at: 1795110078119 },
    { kind: 'message', role: 'assistant', id: 'm1', parentToolUseId: null, blocks: [{ type: 'text', text: 'ok' }], usage: { input: 10, output: 5, cacheRead: 0, cacheCreate: 0 }, seq: 3, at: 1795110078122 },
    { kind: 'title', source: 'ai', text: 'AI가 붙인 제목', seq: 4, at: 1795110078122 },
    { kind: 'result', status: 'success', text: 'ok', sessionId: 'fake-session-27024', costUsd: 0.01, usage: { input: 10, output: 5, cacheRead: 500, cacheCreate: 30 }, contextWindow: null, durationMs: 5, turns: 1, turnCostUsd: 0.01, auth: 'login', seq: 5, at: 1795110078122 },
    { kind: 'message', role: 'assistant', id: 'm2', parentToolUseId: null, blocks: [{ type: 'tool_use', id: 'toolu_m1', name: 'mcp__claude_ai_Claude_Docs__update', input: { title: '문서 제목', container: { kind: 'doc' } } }], usage: { input: 10, output: 5, cacheRead: 0, cacheCreate: 0 }, seq: 13, at: 1795110151786 },
    { kind: 'tool_result', toolUseId: 'toolu_m1', isError: false, content: '{"ok":true,"url":"https://claude.ai/artifact/abc123-def"}', seq: 14, at: 1795110151786 },
    // Before the usage reading and the "as of" clock existed, a report carried only the passed threshold (and an even older one lacked `utilization` altogether).
    { kind: 'limit', status: 'allowed_warning', limit: 'five_hour', threshold: 0.9, resetsAt: 1795115574, overage: false, seq: 21, at: 1795110174000 },
    { kind: 'limit', status: 'allowed_warning', limit: 'five_hour', utilization: 0.91, threshold: 0.9, resetsAt: 1795115574, overage: false, seq: 22, at: 1795110174828 },
    { kind: 'approval', phase: 'request', requestId: 'perm-1', tool: 'Bash', input: { command: 'npm test', description: '테스트 실행' }, toolUseId: 'toolu_perm', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }], seq: 38, at: 1795110318637 },
    { kind: 'approval', phase: 'answer', requestId: 'perm-1', tool: 'Bash', allow: true, seq: 39, at: 1795110371340 },
    { kind: 'task', phase: 'start', toolUseId: 'toolu_a1', description: '조사 A', agentType: 'general-purpose', background: false, seq: 44, at: 1795110391836 },
    { kind: 'task', phase: 'end', toolUseId: 'toolu_a1', status: 'completed', report: 'A 결과 보고', tokens: 2400, toolUses: 4, durationMs: 1500, seq: 46, at: 1795110392459 }
  ];
  const view = fromReplay({ events: stored, seq: 46 });
  assert.equal(view.items.some(item => item.fresh), false, 'a replay plays no entrance');
  assert.equal(view.approvals.length, 0, 'the answered approval is not pending');
  const limits = view.items.filter(item => item.kind === 'note' && /한도/.test(item.text));
  assert.equal(limits.length, 1, 'the two readings of one window are one line');
  assert.match(limits[0].text, /5시간 한도의 91%를 사용했습니다/, 'it follows the latest reading');
  // A report that never had a reading says "at least" instead of passing the threshold off as the usage.
  assert.match(fromReplay({ events: [stored[7]] }).items.find(item => item.kind === 'note').text, /90% 이상 사용했습니다/);
});
