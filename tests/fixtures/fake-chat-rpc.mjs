import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const cursor = process.argv.includes('cursor'), send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
let sessionId = randomUUID(), turnId, promptId, requestId, count = 0;
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
  if (cursor) {
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '안녕' } } });
    reply(promptId, { stopReason: status === 'interrupted' ? 'cancelled' : 'end_turn' });
  } else {
    notify('item/agentMessage/delta', { threadId: sessionId, turnId, itemId: `m${count}`, delta: '안녕' });
    notify('item/completed', { threadId: sessionId, turnId, item: { id: `m${count}`, type: 'agentMessage', text: '안녕' } });
    notify('thread/tokenUsage/updated', { threadId: sessionId, turnId, tokenUsage: { total: { inputTokens: count * 10, cachedInputTokens: count, outputTokens: count * 2 }, last: { totalTokens: 12 }, modelContextWindow: 1000 } });
    notify('turn/completed', { threadId: sessionId, turn: { id: turnId, status } });
  }
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const raw = JSON.parse(line), p = raw.params ?? {};
  if (!raw.method) { if (raw.id === requestId) { if (process.env.EXPECT_REJECT === '1' && raw.result?.decision !== 'decline' && raw.result?.outcome?.optionId !== 'deny') throw new Error('approval was not rejected'); finish(); } return; }
  if (cursor && raw.method === 'initialize' && p.clientCapabilities?._meta?.parameterizedModelPicker !== true) throw new Error('parameterized model picker must be advertised');
  if (raw.method === 'initialize') reply(raw.id, cursor ? { agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } } : {});
  else if (raw.method === 'initialized') {}
  else if (raw.method === 'session/set_config_option') {
    const option = configOptions().find(item => item.id === p.configId);
    const choices = option?.type === 'boolean' ? ['false', 'true'] : option?.options?.map(item => item.value);
    if (!choices?.includes(p.value)) { send({ id: raw.id, error: { code: -32602, message: 'Unsupported config value' } }); return; }
    if (p.configId === 'model') { currentModel = p.value; values = {}; } else values[p.configId] = p.value;
    reply(raw.id, { configOptions: configOptions() });
  }
  else if (raw.method === 'authenticate' || raw.method.startsWith('session/set_')) reply(raw.id, {});
  else if (raw.method === 'model/list') reply(raw.id, { data: [{ model: 'codex-test', displayName: 'Codex test', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] });
  else if (raw.method === 'thread/start' || raw.method === 'thread/resume' || raw.method === 'thread/fork') {
    if (raw.method === 'thread/fork' && !p.lastTurnId) throw new Error('fork must include the exact turn');
    sessionId = raw.method === 'thread/resume' ? p.threadId : randomUUID(); reply(raw.id, { thread: { id: sessionId }, model: p.model ?? 'codex-test' });
  } else if (raw.method === 'session/new' || raw.method === 'session/load') { sessionId = p.sessionId ?? sessionId; reply(raw.id, cursorInfo()); }
  else if (raw.method === 'turn/start' || raw.method === 'session/prompt') {
    turnId = `turn-${++count}`; promptId = raw.id;
    if (!cursor) { reply(raw.id, { turn: { id: turnId } }); notify('turn/started', { threadId: sessionId, turn: { id: turnId } }); }
    const text = (p.input ?? p.prompt).find(item => item.type === 'text').text;
    if (text === 'hold') return;
    if (cursor && text === 'empty') { reply(promptId, { stopReason: 'end_turn' }); return; }
    if (text === 'crash') { process.exit(2); return; }
    if (text === 'approval' || text === 'question') {
      requestId = `approval-${count}`;
      if (text === 'question') send({ id: requestId, method: cursor ? 'cursor/ask_question' : 'item/tool/requestUserInput', params: { threadId: sessionId, questions: cursor ? [{ id: 'q1', prompt: '선택', options: [{ id: 'a', label: 'A' }] }] : [{ id: 'q1', question: '선택', options: [{ label: 'A' }] }] } });
      else send({ id: requestId, method: cursor ? 'session/request_permission' : 'item/commandExecution/requestApproval', params: cursor ? { sessionId, toolCall: { title: 'Bash', rawInput: { command: 'pwd' } }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'deny', kind: 'reject_once' }] } : { threadId: sessionId, itemId: 'tool-1', command: 'pwd', availableDecisions: ['accept', 'acceptForSession', 'decline'] } });
    } else finish();
  } else if (raw.method === 'turn/steer') reply(raw.id, { turnId });
  else if (raw.method === 'turn/interrupt') { reply(raw.id, {}); finish('interrupted'); }
  else if (raw.method === 'session/cancel') finish('interrupted');
  else reply(raw.id, {});
});
