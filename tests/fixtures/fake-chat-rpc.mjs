import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const cursor = process.argv.includes('cursor'), send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
let sessionId = randomUUID(), turnId, promptId, requestId, count = 0;
const queuedSteers = [];
function userMessage(input, clientId) {
  const item = { type: 'userMessage', id: randomUUID(), clientId, content: input };
  notify('item/started', { threadId: sessionId, turnId, item });
  notify('item/completed', { threadId: sessionId, turnId, item });
}
const catalog = [{ modelId: 'cursor-test[effort=high,fast=false]', name: 'Cursor test' }];
let currentModel = catalog[0].modelId, values = {};
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: currentModel, options: [...catalog, { modelId: 'composer-test', name: 'Composer test' }].map(item => ({ value: item.modelId, name: item.name })) },
  ...(currentModel === 'composer-test' ? [] : [
    { id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: values.thinking ?? 'true', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'On' }] },
    { id: 'context', name: 'Context', category: 'model_config', type: 'select', currentValue: values.context ?? '300k', options: [{ value: '300k', name: '300K' }, { value: '1m', name: '1M' }] },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: values.effort ?? 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' }] },
    { id: 'max_mode', name: 'Max Mode', category: 'model_config', type: 'boolean', currentValue: values.max_mode === 'true' },
    { id: 'future_option', name: 'Future Option', category: 'model_config', type: 'select', currentValue: values.future_option ?? 'a', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] },
  ]),
  { id: 'fast', name: 'Fast', category: 'model_config', type: 'select', currentValue: values.fast ?? 'false', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }] },
];
const cursorInfo = () => ({ sessionId, models: { currentModelId: currentModel, availableModels: catalog }, configOptions: configOptions(), modes: { availableModes: [{ id: 'agent' }, { id: 'plan' }, { id: 'ask' }] } });
function finish(status = 'completed') {
  const steers = queuedSteers.splice(0);
  requestId = undefined;
  if (cursor) {
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '안녕' + (process.argv.includes('--force') ? ' [force]' : '') + (process.argv.includes('--sandbox') ? ` [sandbox:${process.argv[process.argv.indexOf('--sandbox') + 1]}]` : '') } } });
    const size = values.context === '1m' ? 1_000_000 : 300_000;
    notify('session/update', { sessionId, update: { sessionUpdate: 'usage_update', used: 12_000 + count * 2_000, size, ...(process.env.FAKE_CURSOR_USAGE === '1' && { cost: { amount: 0, currency: 'USD' } }) } });
    notify('session/update', { sessionId, update: { sessionUpdate: 'session_info_update', title: `Cursor 테스트 ${count}` } });
    reply(promptId, { stopReason: status === 'interrupted' ? 'cancelled' : 'end_turn', ...(process.env.FAKE_CURSOR_USAGE === '1' && { usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 100, cachedWriteTokens: 5 } }) });
  } else {
    if (status === 'completed') for (const steer of steers) userMessage(steer.input, steer.clientUserMessageId);
    notify('item/agentMessage/delta', { threadId: sessionId, turnId, itemId: `m${count}`, delta: '안녕' });
    notify('item/completed', { threadId: sessionId, turnId, item: { id: `m${count}`, type: 'agentMessage', text: '안녕' } });
    notify('thread/tokenUsage/updated', { threadId: sessionId, turnId, tokenUsage: { total: { inputTokens: count * 10, cachedInputTokens: count, cacheWriteInputTokens: count * 3, outputTokens: count * 2 }, last: { totalTokens: 12 }, modelContextWindow: 1000 } });
    notify('thread/name/updated', { threadId: sessionId, threadName: `Codex 테스트 ${count}` });
    notify('turn/completed', { threadId: sessionId, turn: { id: turnId, status } });
  }
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const raw = JSON.parse(line), p = raw.params ?? {};
  if (process.env.HISTORY_ONLY === '1' && !['initialize', 'initialized', 'thread/read', 'thread/turns/list'].includes(raw.method)) throw new Error('history must not start or resume a writer');
  if (!raw.method) { if (raw.id === requestId) { if (process.env.EXPECT_REJECT === '1' && raw.result?.decision !== 'decline' && raw.result?.outcome?.optionId !== 'deny') throw new Error('approval was not rejected'); finish(); } return; }
  if (cursor && raw.method === 'initialize' && p.clientCapabilities?._meta?.parameterizedModelPicker !== true) throw new Error('parameterized model picker must be advertised');
  if (cursor && raw.method === 'initialize' && p.clientCapabilities?._meta?.subagents !== true) throw new Error('subagents must be advertised');
  if (raw.method === 'initialize') reply(raw.id, cursor ? { agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } } : {});
  else if (raw.method === 'initialized') {}
  else if (raw.method === 'thread/read') reply(raw.id, { thread: { id: p.threadId, cwd: process.cwd(), createdAt: 1, updatedAt: 2, turns: [] } });
  else if (raw.method === 'thread/turns/list') reply(raw.id, { data: [{ id: 'history-turn', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'history question' }] }, { type: 'agentMessage', id: 'history-answer', text: 'history answer' }] }], nextCursor: null });
  else if (raw.method === 'session/set_config_option') {
    const option = configOptions().find(item => item.id === p.configId);
    const choices = option?.type === 'boolean' ? ['false', 'true'] : option?.options?.map(item => item.value);
    if (!choices?.includes(p.value)) { send({ id: raw.id, error: { code: -32602, message: 'Unsupported config value' } }); return; }
    if (process.env.HOLD_CONFIG === '1' && p.configId === 'model') {
      fs.writeFileSync(path.join(process.cwd(), '.hold-config'), '1');
      notify('session/update', { sessionId, update: { sessionUpdate: 'current_model_update', currentModelId: catalog[0].modelId } });
      while (!fs.existsSync(path.join(process.cwd(), '.hold-config-go'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
    if (p.configId === 'model') { currentModel = p.value; values = {}; } else values[p.configId] = p.value;
    reply(raw.id, { configOptions: configOptions() });
  }
  else if (raw.method === 'authenticate' || raw.method.startsWith('session/set_')) reply(raw.id, {});
  else if (raw.method === 'model/list') reply(raw.id, { data: [{ model: 'codex-test', displayName: 'Codex test', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] });
  else if (raw.method === 'config/read') reply(raw.id, { config: { model_provider: process.env.FAKE_PROVIDER ?? null } });
  else if (raw.method === 'thread/start' || raw.method === 'thread/resume' || raw.method === 'thread/fork') {
    if (process.env.EXPECT_PROVIDER !== undefined && raw.method !== 'thread/start' && p.modelProvider !== process.env.EXPECT_PROVIDER) throw new Error(`resume must use provider ${process.env.EXPECT_PROVIDER}, got ${p.modelProvider}`);
    if (raw.method === 'thread/fork' && !p.lastTurnId) throw new Error('fork must include the exact turn');
    sessionId = raw.method === 'thread/resume' ? p.threadId : randomUUID(); reply(raw.id, { thread: { id: sessionId }, model: p.model ?? 'codex-test', ...(process.env.FAKE_CODEX_EFFORT && { reasoningEffort: p.config?.model_reasoning_effort ?? process.env.FAKE_CODEX_EFFORT }) });
  } else if (raw.method === 'session/new' || raw.method === 'session/load') { sessionId = p.sessionId ?? sessionId; reply(raw.id, cursorInfo()); }
  else if (raw.method === 'turn/start' || raw.method === 'session/prompt') {
    turnId = `turn-${++count}`; promptId = raw.id;
    const text = (p.input ?? p.prompt).find(item => item.type === 'text').text;
    if (process.env.FAKE_CHAT_PROMPT_LOG) fs.writeFileSync(process.env.FAKE_CHAT_PROMPT_LOG, text);
    if (!cursor) {
      reply(raw.id, { turn: { id: turnId } });
      notify('turn/started', { threadId: sessionId, turn: { id: turnId } });
      userMessage(p.input, null);
    }
    if (text === 'hold') return;
    if (!cursor && text === 'async-question') {
      const title = '어느 쪽에서 검증할까요?', options = ['실기기', '에뮬레이터'];
      const text = [title, ...options.map(option => `- ${option}`)].join('\n');
      const id = 'async-q1';
      notify('item/agentMessage/delta', { threadId: sessionId, turnId, itemId: id, delta: text });
      notify('item/completed', { threadId: sessionId, turnId, item: { id, type: 'agentMessage', delivery: 'async', text, questions: [{ title, options }] } });
      return;
    }
    if (cursor && text === 'empty') { reply(promptId, { stopReason: 'end_turn' }); return; }
    if (text === 'crash') { process.exit(2); return; }
    if (text === 'retry-once') {
      const flag = path.join(process.cwd(), '.ade-retry-once');
      if (!fs.existsSync(flag)) { fs.writeFileSync(flag, '1'); process.exit(2); }
      finish();
      return;
    }
    if (text === 'approval' || text === 'question') {
      requestId = `approval-${count}`;
      if (text === 'question') send({ id: requestId, method: cursor ? 'cursor/ask_question' : 'item/tool/requestUserInput', params: { threadId: sessionId, questions: cursor ? [{ id: 'q1', prompt: '선택', options: [{ id: 'a', label: 'A' }] }] : [{ id: 'q1', question: '선택', options: [{ label: 'A' }] }] } });
      else send({ id: requestId, method: cursor ? 'session/request_permission' : 'item/commandExecution/requestApproval', params: cursor ? { sessionId, toolCall: { title: 'Bash', rawInput: { command: 'pwd' } }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'deny', kind: 'reject_once' }] } : { threadId: sessionId, itemId: 'tool-1', command: 'pwd', availableDecisions: ['accept', 'acceptForSession', 'decline'] } });
    } else finish();
  } else if (raw.method === 'thread/compact/start') {
    turnId = `compact-${++count}`; reply(raw.id, {}); notify('turn/started', { threadId: sessionId, turn: { id: turnId } });
    notify('item/started', { threadId: sessionId, turnId, item: { id: 'compact', type: 'contextCompaction' } });
    setTimeout(() => { notify('item/completed', { threadId: sessionId, turnId, item: { id: 'compact', type: 'contextCompaction' } }); setTimeout(() => notify('turn/completed', { threadId: sessionId, turn: { id: turnId, status: 'completed' } }), 100); }, 100);
  } else if (raw.method === 'turn/steer') {
    if (p.threadId !== sessionId || p.expectedTurnId !== turnId) throw new Error('steer must target the running turn');
    reply(raw.id, { turnId });
    if (requestId) queuedSteers.push(p);
    else userMessage(p.input, p.clientUserMessageId);
  }
  else if (raw.method === 'turn/interrupt') { reply(raw.id, {}); finish('interrupted'); }
  else if (raw.method === 'session/cancel') finish('interrupted');
  else reply(raw.id, {});
});
