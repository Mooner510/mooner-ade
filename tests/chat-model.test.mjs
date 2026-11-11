import test from 'node:test';
import assert from 'node:assert/strict';
import { contextEnds, contextGauge, contextPercent, contextReported, cursorSettingName, effortLabel, effortLevel, emptyView, fillFormat, fromReplay, cursorModelGroups, isChatSlashCommand, isCursorEffort, isCursorSwitch, modelDisplayName, modelAppearance, modelProvider, modelColor, modelQuickDefaults, modelQuickRows, modelRows, modelValue, parseChatSlashCommand, parseContextSetting, partialToolInput, permissionModeColor, reduce, ro, settingsLine, shortModel, withSettingChange, turnAllowsMessageActions } from '../apps/web/src/chat-model.ts';

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
  assert.equal(view.items.at(-1).kind, 'command'); assert.equal(view.items.at(-1).text, '');
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
  assert.equal(contextPercent({ contextTokens: 263_980, model: 'claude-sonnet-5-5' }), 100);
  assert.equal(contextPercent({ contextTokens: 263_980, model: 'claude-sonnet-5-5', capabilities: { catalog: [{ id: 'claude-sonnet-5-5', window: 1_000_000 }] } }), 26);
  assert.equal(contextPercent({ contextTokens: 263_980, model: 'claude-sonnet-5-5', contextWindow: 1_000_000, capabilities: { catalog: [{ id: 'claude-sonnet-5-5', window: 200_000 }] } }), 26);
  const withAuto = { contextTokens: 175_000, model: 'claude-sonnet-5-5', contextWindow: 1_000_000, autoCompact: { window: 350_000, maxWindow: 1_000_000, auto: false, source: 'modelSettings' } };
  assert.equal(contextPercent(withAuto), 50);
  assert.deepEqual(contextGauge(withAuto), { percent: 50, used: 175_000, basis: 350_000, max: 1_000_000, autoCompact: true, autoEstimated: false });
  assert.equal(fillFormat('{a}/{b}', { a: '1' }), '1/{b}');
});

test('permission mode colors resolve to agent-scoped CSS variables', () => {
  assert.equal(permissionModeColor('default'), 'var(--mode-default, var(--muted))');
  assert.equal(permissionModeColor('acceptEdits'), 'var(--mode-acceptEdits, var(--muted))');
  assert.equal(permissionModeColor('ask'), 'var(--mode-ask, var(--muted))');
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
  assert.match(css, /:root\[data-theme=light\].*--provider-cursor.*background: #292b30/);
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

test("compacting shows while the CLI compacts and leaves a marker that keeps the history", () => {
  let view = reduce(emptyView(), { kind: "user", text: "/compact" });
  view = reduce(view, { kind: "delta", phase: "compacting", active: true });
  assert.equal(view.compacting, true);
  view = reduce(view, { kind: "compact", trigger: "manual", preTokens: 231097, postTokens: 14613 });
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
