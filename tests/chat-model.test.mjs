import test from 'node:test';
import assert from 'node:assert/strict';
import { contextEnds, contextPercent, cursorSettingName, effortLabel, effortLevel, emptyView, fillFormat, fromReplay, cursorModelGroups, isCursorEffort, isCursorSwitch, modelDisplayName, modelAppearance, modelProvider, modelColor, modelRows, modelValue, reduce, shortModel } from '../apps/web/src/chat-model.ts';

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
  view = reduce(view, { kind: 'delta', phase: 'text', text: 'partial' });
  view = reduce(view, { kind: 'divider', reason: 'clear' });
  assert.equal(view.stream, null); assert.deepEqual(view.approvals, []); assert.deepEqual(view.steers, []);
});

test('a streamed reply is replaced by the complete message and a replayed seq is ignored', () => {
  let view = reduce(emptyView(), { kind: 'delta', phase: 'start' });
  view = reduce(view, { kind: 'delta', phase: 'text', index: 0, text: 'He' });
  view = reduce(view, { kind: 'delta', phase: 'text', index: 0, text: 'llo' });
  assert.equal(view.stream[0].text, 'Hello');
  view = reduce(view, { seq: 1, kind: 'message', id: 'm', blocks: [{ type: 'text', text: 'Hello' }] });
  assert.equal(view.stream, null); assert.equal(view.items.length, 1);
  assert.equal(reduce(view, { seq: 1, kind: 'message', id: 'm2', blocks: [] }).items.length, 1);
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

test('status numbers and templates', () => {
  assert.equal(contextPercent({ contextTokens: 100_000, model: 'claude-x' }), 50);
  assert.equal(contextPercent({ contextTokens: 100_000, model: 'claude-x[1m]' }), 10);
  assert.equal(fillFormat('{a}/{b}', { a: '1' }), '1/{b}');
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

test('model rows: Fable first, then newest version first, then family, Opus/Sonnet 1M rows right behind their model', () => {
  const catalog = [
    { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', family: 'haiku', window: 200000, main: false },
    { id: 'claude-opus-4-8', name: 'Opus 4.8', family: 'opus', window: 1000000, main: false },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', family: 'sonnet', window: 1000000, main: true },
    { id: 'claude-fable-5-2', name: 'Fable 5.2', family: 'fable', window: 1000000, main: true },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', family: 'opus', window: 1000000, main: true },
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5', family: 'haiku', window: 1000000, main: true },
  ];
  const rows = modelRows(catalog, { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' });
  assert.deepEqual(rows.map(row => row.label), ['Fable 5.2', 'Opus 5.5', 'Opus 5.5 (1M)', 'Sonnet 5.5', 'Sonnet 5.5 (1M)', 'Haiku 5.5', 'Opus 4.8', 'Opus 4.8 (1M)', 'Haiku 4.5']);
  assert.deepEqual(rows.slice(0, 4).map(row => row.value), ['claude-fable-5-2', 'opus', 'opus[1m]', 'sonnet']);
  assert.equal(rows.find(row => row.label === 'Opus 4.8 (1M)').value, 'claude-opus-4-8[1m]');
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
