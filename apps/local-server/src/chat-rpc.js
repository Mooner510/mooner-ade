import { fault } from './files.js';
import { cursorMcp, isTrusted } from './mcp-trust.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cleanChatTitle } from './chat-title.js';
import { mergeCursorCommands } from './slash-commands.js';
import { askMcpTitle, askMcpTools } from './terminal-sessions.js';

const mcpFilter = fileURLToPath(new URL('./mcp-filter.js', import.meta.url));
// ACP session/new takes a whole server. A server with tools turned off is started through mcp-filter.js, which hides those names.
export function cursorMcpServers(servers) {
  return servers.map(server => {
    const env = Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value: String(value) }));
    if (!server.disabledTools?.length) return { name: server.name, command: server.command, args: server.args, env };
    return { name: server.name, command: process.execPath, args: [mcpFilter, server.command, ...server.args], env: [...env, { name: 'ADE_MCP_HIDE', value: server.disabledTools.join('\n') }] };
  });
}
const finiteCount = value => Number.isFinite(value) && value >= 0 ? value : null;

export const chatAgents = ['claude', 'codex', 'cursor'];
export function chatCapabilities(agent) {
  const cursor = agent === 'cursor';
  return { images: true, steer: !cursor, cancelSteer: agent === 'claude', branch: !cursor, rewind: !cursor, worktree: true, addDirs: !cursor,
    terminal: true, terminalToChat: true, cost: agent === 'claude', tokens: !cursor, context: true,
    permissionModes: cursor ? ['default', 'plan', 'ask'] : ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
    sandboxes: agent === 'codex' ? SANDBOXES : cursor ? CURSOR_SANDBOXES : [], runEverything: cursor, efforts: agent === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : [], catalog: [], configOptions: [],
    limitations: { branch: '완료된 응답의 분기 기록을 저장한 뒤 사용할 수 있습니다.', rewind: '완료된 응답의 복원 기록을 저장한 뒤 사용할 수 있습니다.',
      steer: 'Cursor ACP는 실행 중 추가 지시를 제공하지 않습니다. 응답 후 순서대로 전송합니다.', cancelSteer: 'CLI가 받은 지시는 개별 취소할 수 없습니다.',
      addDirs: 'Cursor ACP는 추가 작업 폴더를 제공하지 않습니다.', terminalToChat: '세션과 완전한 대기 상태를 확인할 수 없어 전환할 수 없습니다.' } };
}

const usage = value => ({ input: Math.max(0, (value?.inputTokens ?? 0) - (value?.cachedInputTokens ?? 0) - (value?.cacheWriteInputTokens ?? 0)), output: value?.outputTokens ?? 0,
  cacheRead: value?.cachedInputTokens ?? 0, cacheCreate: value?.cacheWriteInputTokens ?? 0 });
const contextWindowOf = value => { const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(String(value ?? '').trim()); return match ? Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000) : 0; };
const cursorContextWindow = (options = []) => contextWindowOf(options.find(option => option.id === 'context')?.currentValue);
const agentTitle = value => { const text = cleanChatTitle(value); return text ? { kind: 'title', source: 'agent', text } : null; };
// `--sandbox enabled|disabled` is a Cursor launch switch (not an ACP mode). "Run Everything" is not passed as `--force`: this client accepts Cursor's
// permission requests itself, so it can be switched at any time.
export const CURSOR_SANDBOXES = ['enabled', 'disabled'];
const modeOf = mode => mode === 'default' ? 'agent' : mode;
// cursor-agent appends this and ends the turn (stopReason end_turn) when the backend drops the stream.
// `[unavailable] HTTP 503` is the server form; `Stream ended without turnEnded — connection likely dropped mid-stream` is the client form when the stream closes before turnEnded. The useful answer is whatever came before it.
export const CURSOR_TRANSPORT_DROP = /(?:^|\n{1,2})Error: RetriableError: ([^\n]*)\s*$/;
export const CURSOR_TRANSPORT_RESUME = '연결이 잠깐 끊겼습니다. 끊긴 지점부터 이어서 진행하고, 이미 끝낸 작업은 반복하지 마세요.';
const CURSOR_TRANSPORT_HINT = /(?:\[unavailable\]|HTTP\s*503|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|turnEnded|connection likely dropped)/i;
const MAX_CURSOR_TRANSPORT_RESUMES = 48;
const defaultTransportResumeDelay = n => Math.min(30_000, 500 * 2 ** Math.min(Math.max(0, n - 1), 6));
export function isCursorTransportMessage(message) {
  const text = String(message ?? '');
  return /RetriableError:/.test(text) && (CURSOR_TRANSPORT_HINT.test(text) || CURSOR_TRANSPORT_DROP.test(text));
}
// Cursor sends boolean parameters and select groups. Thinking shares the thought_level category with Effort, so Effort is identified by id.
export function normalizeCursorOptions(options = []) {
  return options.flatMap(option => {
    if (!option || typeof option !== 'object') return [];
    if (option.type === 'boolean') return [{ id: option.id, name: option.name, description: option.description, category: option.category, type: 'select', currentValue: option.currentValue === true || option.currentValue === 'true' ? 'true' : 'false', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'On' }] }];
    if (option.type !== 'select' || !Array.isArray(option.options)) return [];
    return [{ ...option, options: option.options.flatMap(item => Array.isArray(item?.options) ? item.options : [item]) }];
  });
}
export const cursorEffortOption = (options = []) => options.find(option => /^(effort|reasoning|reasoning_effort)$/i.test(option.id ?? ''));
// What a Codex turn runs with. The permission mode picks the approval behaviour, and the sandbox (read-only / workspace-write / danger-full-access, plus
// network access for workspace-write) is a separate choice: `sandbox` null follows the mode. Plan is always read-only. `auto` asks Codex's own reviewer
// (approvalsReviewer "auto_review") to decide instead of the user; bypassPermissions never asks.
export const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
export const codexPermissions = (mode, cwd, addDirs = [], sandbox = null, network = false) => {
  const level = mode === 'plan' ? 'read-only' : SANDBOXES.includes(sandbox) ? sandbox : mode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write';
  return {
    approvalPolicy: mode === 'bypassPermissions' ? 'never' : mode === 'default' ? 'untrusted' : 'on-request',
    approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
    sandboxMode: level,
    sandboxPolicy: level === 'danger-full-access' ? { type: 'dangerFullAccess' } : level === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [cwd, ...addDirs], networkAccess: network === true, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  };
};

// An approval-tagged elicitation is a permission prompt. A server's own form is a question the user answers.
export const mcpApprovalElicitation = raw => raw.method === 'mcpServer/elicitation/request' && Object.keys(raw.params?._meta ?? {}).some(key => /approval/i.test(key));
const elicitationSchema = params => params?.requestedSchema ?? params?.request?.requestedSchema ?? {};
export function elicitationQuestions(params) {
  const schema = elicitationSchema(params);
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const message = typeof params?.message === 'string' ? params.message : typeof params?.request?.message === 'string' ? params.request.message : '';
  const questions = [];
  for (const [id, spec] of Object.entries(properties)) {
    if (!spec || typeof spec !== 'object' || spec.type === 'object' || spec.type === 'array') continue;
    const prompt = [spec.title || id, spec.description].filter(value => typeof value === 'string' && value).join('\n');
    if (spec.type === 'boolean') questions.push({ id, prompt, options: [{ id: 'true', label: '예' }, { id: 'false', label: '아니오' }] });
    else if (Array.isArray(spec.enum) && spec.enum.every(item => ['string', 'number', 'boolean'].includes(typeof item))) questions.push({ id, prompt, options: spec.enum.map(item => ({ id: String(item), label: String(item) })) });
    else if (spec.type === 'number' || spec.type === 'integer' || spec.type === 'string' || spec.type === undefined) questions.push({ id, prompt, allowOther: true, ...(spec.format === 'password' && { secret: true }) });
  }
  if (!questions.length && message) questions.push({ id: 'answer', prompt: message, allowOther: true });
  else if (message && questions.length && !questions[0].prompt.startsWith(message)) questions[0] = { ...questions[0], prompt: `${message}\n\n${questions[0].prompt}` };
  return questions;
}
export function elicitationContent(params, answers) {
  const properties = elicitationSchema(params).properties;
  if (!properties || typeof properties !== 'object' || !Object.keys(properties).length) {
    const text = answers?.answer?.[0] ?? '';
    return text ? { answer: text } : {};
  }
  const content = {};
  for (const [id, spec] of Object.entries(properties)) {
    const raw = answers?.[id]?.[0];
    if (raw == null || raw === '') continue;
    if (spec?.type === 'boolean') content[id] = raw === 'true';
    else if (spec?.type === 'number' || spec?.type === 'integer') { const number = Number(raw); content[id] = Number.isFinite(number) ? number : raw; }
    else if (Array.isArray(spec?.enum)) { const match = spec.enum.find(item => String(item) === raw); content[id] = match === undefined ? raw : match; }
    else content[id] = raw;
  }
  return content;
}

// JSON-RPC transport is shared; the agents retain ownership of authentication, tools and model calls.
export function createChatProtocol(agent, { write, emit, fail, transportResumeDelay = defaultTransportResumeDelay, trusted = () => [] } = {}) {
  let cursorTokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let nextId = 0, sessionId, turnId, startedAt = 0, textSerial = 0, said = false, config, capabilities = chatCapabilities(agent), compacting = false, disposed = false, runEverything = false, autoServers = [];
  let promptId = null; // Cursor: the session/prompt request whose answer ends the running turn
  let cursorPlan = null;
  // cursor-agent prints `Error: RetriableError: ...` and ends the turn when the backend drops the stream (HTTP 503, DNS blips, or the stream closing before turnEnded). It does not retry (enableAgentRetries stays off). ADE keeps the same user turn open and re-prompts until the link is back.
  let transportResumes = 0, transportDropped = false, dropDetail = '', transportResumeTimer = null;
  const pending = new Map(), approvals = new Map(), chunks = new Map(), skills = new Map();
  const send = value => write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  // cursor-agent reports a missing session as -32602 "Invalid params"; the useful text is data.message ("Session … not found").
  const agentFault = error => {
    const detail = typeof error?.data?.message === 'string' ? error.data.message : '';
    const message = typeof error?.message === 'string' && error.message ? error.message : '에이전트 요청이 실패했습니다.';
    return Object.assign(fault('AGENT_PROTOCOL', detail && !message.includes(detail) ? `${message}: ${detail}` : message, 502), { data: error?.data });
  };
  const request = (method, params = {}, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(fault('AGENT_TIMEOUT', `${agent}: ${method} 응답 시간이 초과되었습니다.`, 504)); }, timeoutMs) : null;
    pending.set(id, { resolve, reject, timer });
    void send({ id, method, params }).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
  });
  const publishCapabilities = () => emit({ kind: 'capabilities', capabilities });
  const result = (status = 'success', text = '') => {
    if (disposed) return;
    cursorPlan = null;
    for (const id of approvals.keys()) emit({ kind: 'approval', phase: 'cancel', requestId: id });
    approvals.clear(); turnId = null;
    emit({ kind: 'result', status, text, costUsd: null, durationMs: Date.now() - startedAt });
  };
  const message = (id, blocks, extra = {}) => emit({ kind: 'message', id, blocks, ...extra });
  const approval = (raw, tool, input, extra = {}) => {
    const id = String(raw.id); approvals.set(id, raw);
    emit({ kind: 'approval', phase: 'request', requestId: id, tool, input, suggestions: [], ...extra });
  };
  function cursorModeUpdate(modeId) {
    const permissionMode = modeId === 'agent' ? 'default' : modeId;
    if (config) config.permissionMode = permissionMode;
    emit({ kind: 'settings', permissionMode });
  }
  function cursorInfo(info) {
    if (info.models) {
      capabilities.catalog = (info.models.availableModels ?? []).map(item => ({ id: item.modelId, name: item.name, family: '', window: 0, main: true }));
      if (info.models.currentModelId) emit({ kind: 'session', sessionId, model: info.models.currentModelId });
    }
    if (info.modes) {
      capabilities.permissionModes = (info.modes.availableModes ?? []).map(item => item.id === 'agent' ? 'default' : item.id);
      if (info.modes.currentModeId) cursorModeUpdate(info.modes.currentModeId);
    }
    if (info.configOptions) {
      capabilities.configOptions = normalizeCursorOptions(info.configOptions);
      const model = capabilities.configOptions.find(option => option.id === 'model' || option.category === 'model');
      if (model) {
        capabilities.modelConfigId = model.id;
        capabilities.catalog = model.options.map(item => ({ id: item.value, name: item.name, family: '', window: 0, main: true }));
        emit({ kind: 'session', sessionId, model: model.currentValue });
      }
      const effort = cursorEffortOption(capabilities.configOptions);
      capabilities.efforts = effort?.options.map(item => item.value) ?? [];
      capabilities.effortConfigId = effort?.id;
      emit({ kind: 'settings', effort: effort?.currentValue ?? null });
    }
    const window = cursorContextWindow(capabilities.configOptions);
    if (window > 0) emit({ kind: 'usage', contextWindow: window });
    publishCapabilities();
  }
  // An item is stored once, when it completes. A started tool is shown live (it may wait for an approval meanwhile); started text and reasoning
  // arrive as deltas. Storing both phases wrote every item twice.
  function codexItem(item, completed, atTurn) {
    const extra = completed && item.type === 'agentMessage' ? { uuid: item.id, turnId: atTurn } : {};
    if (item.type === 'agentMessage' || item.type === 'plan') {
      // Async questions arrive as assistant messages, and their answers go through normal chat input.
      const questions = item.type === 'agentMessage' && item.delivery === 'async' && Array.isArray(item.questions) ? item.questions : null;
      if (completed) message(item.id, [{ type: 'text', text: item.text ?? '', ...(questions?.length && { questions }) }], extra);
    }
    else if (item.type === 'reasoning') { if (completed) message(item.id, [{ type: 'thinking', text: [...(item.summary ?? []), ...(item.content ?? [])].join('\n') }]); }
    else if (item.type === 'contextCompaction') { if (completed) emit({ kind: 'compact', trigger: compacting ? 'manual' : 'auto', preTokens: finiteCount(item.preTokens), postTokens: finiteCount(item.postTokens) }); }
    else if (item.type === 'userMessage') {
      if (completed) emit({ kind: 'codex_user_echo', clientId: item.clientId,
        text: (item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'),
        images: (item.content ?? []).filter(part => /image/i.test(part.type)).length });
    } else {
      const name = item.type === 'commandExecution' ? 'Bash' : item.type === 'fileChange' ? 'Patch' : item.tool ?? item.type;
      const input = item.type === 'commandExecution' ? { command: item.command, cwd: item.cwd } : item.type === 'fileChange' ? { changes: item.changes }
        : item.arguments ?? { query: item.query, path: item.path, description: item.prompt ?? item.review };
      if (!completed) { emit({ kind: 'delta', phase: 'tool', messageId: item.id, index: 0, id: item.id, name, input }); return; }
      message(item.id, [{ type: 'tool_use', id: item.id, name, input }]);
      if (completed) emit({ kind: 'tool_result', toolUseId: item.id, isError: item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0),
        content: item.aggregatedOutput ?? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? item.error ?? item.changes ?? item.results ?? '완료')) });
    }
  }
  // Cursor streams a turn's text as one run per stretch between tools: `<turn>-text-<n>` (and `-thinking-<n>`).
  // A subagent's text uses its own serial so it is not glued onto the parent turn.
  const cursorChildren = new Map(); // subagent session id -> { toolUseId, serial }
  const cursorTextId = (phase, child) => child ? `${child.toolUseId}-${phase}-${child.serial}` : `${turnId}-${phase}-${textSerial}`;
  function cursorFlush(child) {
    let stored = false;
    for (const phase of ['thinking', 'text']) {
      const id = cursorTextId(phase, child), content = chunks.get(id);
      if (typeof content === 'string' && content.trim()) { message(id, [{ type: phase, text: content }], { ...(phase === 'text' && { uuid: id }), ...(child && { parentToolUseId: child.toolUseId }) }); stored = true; if (phase === 'text' && !child) said = true; }
      chunks.delete(id);
    }
    return stored;
  }
  // Parent text and every subagent's buffered text. A turn can end while a child still holds a chunk.
  function flushCursorOutput() {
    let stored = cursorFlush();
    if (stored) textSerial += 1;
    for (const child of cursorChildren.values()) if (cursorFlush(child)) { child.serial += 1; stored = true; }
    return stored;
  }
  const cursorTaskStatus = state => state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'stopped';
  const cursorSubagentDone = state => /^(completed|failed|cancelled|canceled|stopped|error)$/i.test(String(state ?? ''));
  function cursorToolShape(item) {
    const raw = item.rawInput && typeof item.rawInput === 'object' ? item.rawInput : {};
    const task = raw._toolName === 'task' || /^Task:/.test(item.title ?? '');
    const name = item.kind === 'execute' ? 'Bash' : item.kind === 'edit' ? 'Patch' : task ? 'Task' : item.title ?? item.kind ?? 'Tool';
    if (name !== 'Task') return { name, input: { ...raw, description: item.title, content: item.content, locations: item.locations } };
    const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : String(item.title ?? '').replace(/^Task:\s*/, '').trim() || '서브에이전트';
    return { name, input: { description, prompt: typeof raw.prompt === 'string' ? raw.prompt : '', subagent_type: typeof raw.subagentType === 'string' && raw.subagentType ? raw.subagentType : 'subagent', ...(typeof raw.model === 'string' && raw.model && { model: raw.model }) } };
  }
  function notification(method, params) {
    if (agent === 'codex') {
      if (params.threadId && params.threadId !== sessionId) return;
      if (method === 'thread/name/updated') { const event = agentTitle(params.threadName ?? params.thread_name ?? params.name); if (event) emit(event); return; }
      if (method === 'turn/started') { turnId = params.turn.id; startedAt = Date.now(); }
      else if (method === 'model/rerouted') emit({ kind: 'settings', model: params.toModel, from: params.fromModel, reason: params.reason, by: 'agent' });
      else if (method === 'item/started' || method === 'item/completed') codexItem(params.item, method === 'item/completed', params.turnId);
      else if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta' || method === 'item/plan/delta') {
        const key = params.itemId, phase = method.includes('reasoning') ? 'thinking' : 'text';
        if (!chunks.has(key)) { chunks.set(key, method); emit({ kind: 'delta', phase: 'start', messageId: key }); }
        // Reasoning summary and reasoning text share one thinking block; a switch between them starts a new paragraph instead of gluing words together.
        const switched = chunks.get(key) !== method; chunks.set(key, method);
        emit({ kind: 'delta', phase, index: 0, messageId: key, text: (switched ? '\n\n' : '') + (params.delta ?? '') });
      } else if (method === 'thread/tokenUsage/updated') {
        const value = params.tokenUsage;
        emit({ kind: 'usage', tokens: usage(value.total), contextTokens: value.last.totalTokens, contextWindow: value.modelContextWindow });
      } else if (method === 'turn/completed') { chunks.clear(); compacting = false; result(params.turn.status === 'interrupted' ? 'interrupted' : params.turn.status === 'failed' ? 'failed' : 'success', params.turn.error?.message ?? ''); }
      else if (method === 'error' && !params.willRetry) emit({ kind: 'error', message: params.error?.message ?? 'Codex 오류' });
      else if (method === 'serverRequest/resolved') { const id = String(params.requestId); approvals.delete(id); emit({ kind: 'approval', phase: 'cancel', requestId: id }); }
      return;
    }
    if (method !== 'session/update') return;
    const update = params.update ?? {}, type = update.sessionUpdate;
    if (type === 'user_message_chunk' && (!params.sessionId || params.sessionId === sessionId)) {
      if ((update.content?.text ?? '').trim() === CURSOR_TRANSPORT_RESUME) return;
    }
    // Subagent steps arrive on their own session id. Anything else for a session we do not know is not this chat.
    const child = params.sessionId && params.sessionId !== sessionId ? cursorChildren.get(params.sessionId) : null;
    // Spawn and the terminal state name the child session themselves, so they are accepted before that session is known.
    const subagentNotice = type === 'subagent_spawned' || type === 'subagent_state_update';
    if (params.sessionId && sessionId && params.sessionId !== sessionId && !child && !subagentNotice) return;
    const parent = child ? { parentToolUseId: child.toolUseId } : {};
    if (type === 'subagent_spawned') {
      const toolUseId = update._meta?.cursor?.toolCallId || update.subagentSessionId;
      if (update.subagentSessionId && toolUseId) cursorChildren.set(update.subagentSessionId, { toolUseId, serial: 0 });
      if (!toolUseId) return;
      const description = typeof update.task === 'string' && update.task.trim() ? update.task.trim() : (typeof update.name === 'string' && update.name.trim() ? update.name.trim() : '서브에이전트');
      const agentType = typeof update.name === 'string' && update.name.trim() ? update.name.trim() : 'subagent';
      emit({ kind: 'task', phase: 'start', toolUseId, description, agentType, background: false });
      if (!chunks.has(toolUseId)) message(toolUseId, [{ type: 'tool_use', id: toolUseId, name: 'Task', input: { description, prompt: typeof update.task === 'string' ? update.task : '', subagent_type: agentType } }]);
      chunks.set(toolUseId, { ...(chunks.get(toolUseId) ?? {}), spawned: true });
      return;
    }
    if (type === 'subagent_state_update') {
      if (!cursorSubagentDone(update.state)) return;
      const known = cursorChildren.get(update.subagentSessionId);
      if (known) cursorFlush(known);
      const toolUseId = known?.toolUseId || update._meta?.cursor?.toolCallId || update.subagentSessionId;
      if (toolUseId) emit({ kind: 'task', phase: 'end', toolUseId, status: cursorTaskStatus(update.state), report: '' });
      return;
    }
    if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
      const phase = type === 'agent_thought_chunk' ? 'thinking' : 'text', messageId = cursorTextId(phase, child);
      const text = update.content?.text ?? '';
      const old = chunks.get(messageId) ?? '';
      const combined = old + text;
      const drop = !child && phase === 'text' ? combined.match(CURSOR_TRANSPORT_DROP) : null;
      if (drop) {
        transportDropped = true; dropDetail = (drop[1] ?? '').trim();
        const cleaned = combined.replace(CURSOR_TRANSPORT_DROP, '');
        if (cleaned) chunks.set(messageId, cleaned); else chunks.delete(messageId);
        const keep = text.slice(0, Math.max(0, cleaned.length - old.length));
        if (keep) emit({ kind: 'delta', phase, index: 0, messageId, text: keep, ...parent });
      } else {
        chunks.set(messageId, combined);
        emit({ kind: 'delta', phase, index: 0, messageId, text, ...parent });
      }
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      // Text and thoughts said before this tool are stored under the id they streamed with (so the screen keeps the same item) and later text starts a new one.
      if (child) { if (cursorFlush(child)) child.serial += 1; }
      else if (cursorFlush()) textSerial += 1;
      const old = chunks.get(update.toolCallId) ?? {}, item = { ...old, ...update };
      const shape = cursorToolShape(item);
      const block = { type: 'tool_use', id: update.toolCallId, name: shape.name, input: shape.input };
      // Updates repeat the call many times over; only a change is stored (status-only updates change nothing that is drawn).
      const shown = JSON.stringify(block);
      if (shown !== old.shown) message(update.toolCallId, [block], parent);
      const finished = item.status === 'completed' || item.status === 'failed';
      if (finished && !old.finished) {
        const parts = Array.isArray(item.content) ? item.content : [];
        emit({ kind: 'tool_result', toolUseId: update.toolCallId, isError: item.status === 'failed', ...parent,
          content: typeof item.content === 'string' ? item.content : parts.map(part => part.type === 'content' ? part.content?.text ?? `[${part.content?.type}]` : part.type === 'diff' ? `${part.path}\n${part.newText}` : JSON.stringify(part)).join('\n') });
      }
      chunks.set(update.toolCallId, { ...item, shown, finished: finished || old.finished });
    } else if (type === 'available_commands_update') {
      const commands = mergeCursorCommands((update.availableCommands ?? []).flatMap(item => {
        if (!item || typeof item.name !== 'string') return [];
        const hint = typeof item.input?.hint === 'string' ? item.input.hint : '';
        return [{ name: item.name, description: typeof item.description === 'string' ? item.description : '', ...(hint ? { hint } : {}) }];
      }));
      emit({ kind: 'session', sessionId, slashCommands: commands.map(item => item.name), commands });
    }
    else if (type === 'config_option_update') cursorInfo({ configOptions: update.configOptions });
    else if (type === 'current_model_update') emit({ kind: 'session', sessionId, model: update.currentModelId });
    else if (type === 'current_mode_update' && !child) cursorModeUpdate(update.currentModeId);
    else if (type === 'usage_update') emit({ kind: 'usage', contextTokens: update.used, contextWindow: update.size, contextSource: 'acp',
      ...(update.cost?.currency === 'USD' && Number.isFinite(update.cost.amount) && update.cost.amount >= 0 && { costUsd: update.cost.amount }) });
    else if (type === 'session_info_update') { const event = agentTitle(update.title); if (event) emit(event); }
  }
  // Bypass answers command, file-change and permission requests itself. Questions (requestUserInput) are never answered for the user.
  // An MCP tool's approval comes either as a question whose ids are `mcp_tool_call_approval_*` or as an elicitation tagged with an approval kind in _meta;
  // both are permission prompts, not questions for the user. A server's own form (an elicitation without that tag) still reaches the user.
  const mcpApprovalQuestions = raw => raw.method === 'item/tool/requestUserInput' && Array.isArray(raw.params?.questions) && raw.params.questions.length > 0 && raw.params.questions.every(q => /^mcp_tool_call_approval/i.test(String(q.id)));
  const mcpApprovalElicitation = raw => raw.method === 'mcpServer/elicitation/request' && Object.keys(raw.params?._meta ?? {}).some(key => /approval/i.test(key));
  const autoAcceptable = raw => agent === 'codex' && config?.permissionMode === 'bypassPermissions' && (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(raw.method) || mcpApprovalQuestions(raw) || mcpApprovalElicitation(raw));
  // The plain "allow" choice (once), not "always"/"session" ones: bypass decides again for each request.
  const allowOption = options => (options ?? []).find(o => /^(allow|accept|yes|approve)\b/i.test(o.label) && !/always|session|forever/i.test(o.label)) ?? (options ?? []).find(o => /allow|accept|approve/i.test(o.label) && !/always|deny|decline|cancel/i.test(o.label)) ?? options?.[0];
  async function autoAccept(id, announced = true) {
    const raw = approvals.get(id); if (!raw || !autoAcceptable(raw)) return;
    const p = raw.params ?? {};
    const response = raw.method === 'item/permissions/requestApproval' ? { permissions: p.permissions, scope: 'turn' }
      : raw.method === 'item/tool/requestUserInput' ? { answers: Object.fromEntries(p.questions.map(q => [q.id, { answers: [allowOption(q.options)?.label].filter(Boolean) }])) }
      : raw.method === 'mcpServer/elicitation/request' ? { action: 'accept', content: null }
      : { decision: 'accept' };
    approvals.delete(id); if (announced) emit({ kind: 'approval', phase: 'cancel', requestId: id });
    await send({ id: raw.id, result: response });
  }
  // A built-in plugin's MCP tool (the agent bus) needs no prompt. Cursor names an MCP tool in the request's title; shell, file and fetch kinds never match.
  const autoApprovedTool = toolCall => autoServers.length > 0 && [undefined, 'other'].includes(toolCall?.kind) && typeof toolCall?.title === 'string' && autoServers.some(name => toolCall.title.includes(name)) && !askMcpTitle(toolCall.title);
  // Run Everything: accept once (never "always", so turning it off takes effect on the next request). Newer cursor-agent builds sometimes label the once choice `allow` instead of `allow_once`.
  const cursorAllowOnceOption = options => {
    const list = options ?? [];
    return list.find(o => o.kind === 'allow_once')
      ?? list.find(o => o.kind === 'allow')
      ?? list.find(o => typeof o.kind === 'string' && o.kind.startsWith('allow') && o.kind !== 'allow_always')
      ?? list.find(o => o.kind !== 'reject_once' && o.kind !== 'allow_always');
  };
  function autoAllowCursor(raw, { required = false } = {}) {
    const option = cursorAllowOnceOption(raw.params?.options);
    if (!option) {
      if (!required) return false;
      void send({ id: raw.id, error: { code: -32602, message: '허용 선택지가 없습니다.' } });
      return true;
    }
    void send({ id: raw.id, result: { outcome: { outcome: 'selected', optionId: option.optionId } } });
    return true;
  }
  function clearTransportResumeTimer() {
    if (transportResumeTimer) { clearTimeout(transportResumeTimer); transportResumeTimer = null; }
  }
  function cursorPrompt(prompt) {
    promptId = nextId + 1;
    void request('session/prompt', { sessionId, prompt }, 0).then(promptDone, promptFailed);
  }
  function resumeCursorTurn() {
    emit({ kind: 'delta', phase: 'reconnecting', active: false });
    cursorPrompt([{ type: 'text', text: CURSOR_TRANSPORT_RESUME }]);
  }
  async function setCursorMode(permissionMode) {
    const info = await request('session/set_mode', { sessionId, modeId: modeOf(permissionMode) });
    config.permissionMode = permissionMode;
    return info;
  }
  async function buildCursorPlan(plan) {
    plan.starting = true;
    try {
      await setCursorMode('default');
      if (disposed) return;
      emit({ kind: 'session', sessionId, permissionMode: 'default' });
      if (cursorPlan !== plan) { result('interrupted'); return; }
      cursorPlan = null;
      turnId = `cursor-${randomUUID()}`; textSerial = 0; said = false; chunks.clear();
      emit({ kind: 'delta', phase: 'start', messageId: cursorTextId('text') });
      cursorPrompt([{ type: 'text', text: `사용자가 아래 계획을 승인했습니다. 이 계획대로 구현을 시작하세요.\n\n${plan.text}` }]);
    } catch (error) {
      if (cursorPlan !== plan) result('interrupted');
      else result('failed', `Cursor 계획 실행을 시작하지 못했습니다. ${error.message}`);
    }
  }
  function scheduleTransportResume(detail) {
    clearTransportResumeTimer();
    if (detail) dropDetail = detail;
    if (transportResumes >= MAX_CURSOR_TRANSPORT_RESUMES) {
      emit({ kind: 'delta', phase: 'reconnecting', active: false });
      result('failed', `Cursor 연결이 잠깐 끊겼습니다 (${dropDetail || 'unavailable'}). 잠시 뒤 같은 내용을 다시 보내면 이어서 진행됩니다.`);
      return;
    }
    transportResumes += 1;
    emit({ kind: 'delta', phase: 'reconnecting', active: true, detail: dropDetail || detail || 'unavailable' });
    const delay = transportResumeDelay(transportResumes);
    if (delay <= 0) resumeCursorTurn();
    else { transportResumeTimer = setTimeout(() => { transportResumeTimer = null; resumeCursorTurn(); }, delay); transportResumeTimer.unref?.(); }
  }
  function promptDone(response) {
    if (disposed) return;
    const dropped = agent === 'cursor' && response.stopReason !== 'cancelled' && (transportDropped || CURSOR_TRANSPORT_DROP.test(chunks.get(cursorTextId('text')) ?? ''));
    const detail = dropDetail || (String(chunks.get(cursorTextId('text')) ?? '').match(CURSOR_TRANSPORT_DROP)?.[1] ?? '').trim();
    if (dropped) {
      const id = cursorTextId('text'), content = chunks.get(id);
      if (typeof content === 'string') {
        const cleaned = content.replace(CURSOR_TRANSPORT_DROP, '');
        if (cleaned) chunks.set(id, cleaned); else chunks.delete(id);
      }
    }
    transportDropped = false; dropDetail = '';
    promptId = null;
    const flushed = flushCursorOutput();
    if (dropped) { scheduleTransportResume(detail); return; }
    emit({ kind: 'delta', phase: 'reconnecting', active: false });
    transportResumes = 0;
    const hasOutput = said || flushed || [...chunks.values()].some(value => typeof value === 'object');
    const status = response.stopReason === 'cancelled' ? 'interrupted' : response.stopReason === 'end_turn' && hasOutput ? 'success' : 'failed';
    const u = response.usage;
    if (u && ['inputTokens', 'outputTokens'].every(key => Number.isSafeInteger(u[key]) && u[key] >= 0)
      && ['cachedReadTokens', 'cachedWriteTokens'].every(key => Number.isSafeInteger(u[key] ?? 0) && (u[key] ?? 0) >= 0)) {
      const tokens = { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cachedReadTokens ?? 0, cacheCreate: u.cachedWriteTokens ?? 0 };
      for (const key of Object.keys(tokens)) cursorTokens[key] += Math.max(0, tokens[key]);
      emit({ kind: 'usage', tokens: { ...cursorTokens } });
    }
    // The approval only completes Cursor's plan tool. Start implementation after the planning prompt returns.
    if (cursorPlan && response.stopReason === 'end_turn') { void buildCursorPlan(cursorPlan); return; }
    result(status, status === 'failed' ? `${hasOutput ? 'Cursor 응답이 완료되지 않았습니다' : 'Cursor가 표시할 응답 없이 종료되었습니다'} (${response.stopReason}). 다시 시도하세요.` : '');
  }
  function promptFailed(error) {
    if (disposed) return;
    promptId = null;
    const message = error?.message ?? '';
    const drop = agent === 'cursor' ? message.match(/RetriableError: ([^\n]*)/) : null;
    if (drop && isCursorTransportMessage(message)) { dropDetail = ''; flushCursorOutput(); scheduleTransportResume((drop[1] ?? '').trim()); return; }
    result('failed', message); fail?.(error);
  }
  function serverRequest(raw) {
    const p = raw.params ?? {};
    if (agent === 'codex') {
      if (p.threadId && p.threadId !== sessionId) { void send({ id: raw.id, error: { code: -32602, message: 'Unknown thread' } }); return; }
      if (autoAcceptable(raw)) { approvals.set(String(raw.id), raw); void autoAccept(String(raw.id), false); return; }
      if (raw.method === 'item/commandExecution/requestApproval' || raw.method === 'item/fileChange/requestApproval') {
        const choices = p.availableDecisions;
        approval(raw, raw.method.includes('commandExecution') ? 'Bash' : 'Patch', { command: p.command, description: p.reason, changes: p.changes },
          { suggestions: !choices || choices.includes('acceptForSession') ? ['session'] : [], toolUseId: p.itemId });
      } else if (raw.method === 'item/tool/requestUserInput') approval(raw, '질문', {}, { questions: p.questions.map(q => ({ id: q.id, prompt: q.question, ...(q.header && { header: q.header }), allowOther: q.isOther === true, secret: q.isSecret, options: (q.options ?? []).map(o => ({ id: o.label, label: o.label, description: o.description })) })) });
      else if (raw.method === 'item/permissions/requestApproval') approval(raw, '추가 권한', p.permissions, { suggestions: ['session'] });
      else if (raw.method === 'mcpServer/elicitation/request' && !mcpApprovalElicitation(raw)) {
        const questions = elicitationQuestions(p);
        if (questions.length) approval(raw, '질문', {}, { questions });
        else void send({ id: raw.id, error: { code: -32602, message: '이 입력 요청은 채팅에서 답할 수 없습니다.' } });
      } else void send({ id: raw.id, error: { code: -32601, message: `Unsupported client request: ${raw.method}` } });
    } else if (p.sessionId && p.sessionId !== sessionId && !cursorChildren.has(p.sessionId)) void send({ id: raw.id, error: { code: -32602, message: 'Unknown session' } });
    else if (raw.method === 'session/request_permission' && runEverything) { autoAllowCursor(raw, { required: true }); return; }
    else if (raw.method === 'session/request_permission' && autoApprovedTool(p.toolCall) && autoAllowCursor(raw)) return;
    // An MCP tool the user trusted in the settings is allowed once per request; every other request waits on the card, which offers to trust an MCP tool.
    else if (raw.method === 'session/request_permission' && isTrusted(trusted(), cursorMcp(p.toolCall)) && autoAllowCursor(raw)) return;
    else if (raw.method === 'session/request_permission') approval(raw, p.toolCall?.title ?? '도구 실행', p.toolCall?.rawInput ?? {}, { suggestions: p.options?.some(o => o.kind === 'allow_always') ? ['session'] : [], ...(cursorMcp(p.toolCall) && { mcp: cursorMcp(p.toolCall) }) });
    else if (raw.method === 'cursor/ask_question') approval(raw, p.title ?? '질문', {}, { questions: p.questions });
    else if (raw.method === 'cursor/create_plan') {
      cursorPlan = null;
      approval(raw, '계획 승인', { description: p.overview, plan: p.plan });
    }
    else if (raw.method === 'cursor/task' || raw.method === 'cursor/update_todos' || raw.method === 'cursor/generate_image') void send({ id: raw.id, result: {} });
    else void send({ id: raw.id, error: { code: -32601, message: `Unsupported client request: ${raw.method}` } });
  }
  return {
    request,
    replayCodex(thread) {
      emit({ kind: 'session', sessionId: thread.id, model: thread.model });
      for (const turn of thread.turns ?? []) {
        for (const item of turn.items ?? []) {
          if (item.type === 'userMessage') emit({ kind: 'user', text: (item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'), images: (item.content ?? []).filter(part => /image/i.test(part.type)).length });
          else codexItem(item, true, turn.id);
        }
        if (turn.status !== 'inProgress') emit({ kind: 'result', status: turn.status === 'completed' ? 'success' : turn.status === 'interrupted' ? 'interrupted' : 'failed', costUsd: null, durationMs: turn.durationMs ?? 0 });
      }
    },
    replayCursor(id, updates) {
      sessionId = id; turnId = `history-${id}`; textSerial = 0;
      for (const params of updates) {
        const own = !params.sessionId || params.sessionId === id;
        if (own && params.update?.sessionUpdate === 'user_message_chunk') {
          const text = params.update.content?.text ?? '';
          if (text.trim() !== CURSOR_TRANSPORT_RESUME) {
            flushCursorOutput();
            emit({ kind: 'user', text, images: params.update.content?.type === 'image' ? 1 : 0 });
          }
        } else notification('session/update', params);
      }
      flushCursorOutput();
    },
    handle(raw) {
      if (raw.method) { if (raw.id !== undefined) serverRequest(raw); else notification(raw.method, raw.params ?? {}); }
      else if (raw.id !== undefined) {
        const item = pending.get(raw.id); if (!item) return;
        pending.delete(raw.id); clearTimeout(item.timer);
        raw.error ? item.reject(agentFault(raw.error)) : item.resolve(raw.result);
      }
    },
    // What a server that stops hands to the next one, which goes on with the same running agent (chat.js `detach`). Answers to our own
    // requests other than the running Cursor prompt are dropped: the next server never waits for them.
    snapshot: () => ({ nextId, sessionId, turnId, startedAt, textSerial, said, config, capabilities, compacting, runEverything, autoServers,
      transportResumes, transportDropped, dropDetail, cursorPlan,
      approvals: [...approvals], chunks: [...chunks], skills: [...skills], cursorChildren: [...cursorChildren], cursorTokens, promptId: promptId !== null && pending.has(promptId) ? promptId : null }),
    restore(saved) {
      ({ nextId, sessionId, turnId, startedAt, textSerial, said, config, capabilities, compacting, runEverything, autoServers, transportResumes = 0, transportDropped = false, dropDetail = '' } = saved);
      cursorTokens = saved.cursorTokens ?? cursorTokens;
      cursorPlan = saved.cursorPlan ?? null;
      for (const [map, entries] of [[approvals, saved.approvals], [chunks, saved.chunks], [skills, saved.skills], [cursorChildren, saved.cursorChildren]]) { map.clear(); for (const [key, value] of entries ?? []) map.set(key, value); }
      promptId = saved.promptId ?? null;
      if (promptId !== null) pending.set(promptId, { resolve: promptDone, reject: promptFailed, timer: null });
      // The new server attaches the process immediately after restore; reapply the mode once it can write.
      else if (cursorPlan?.starting) queueMicrotask(() => { if (cursorPlan?.starting && !disposed) void buildCursorPlan(cursorPlan); });
    },
    dispose() { disposed = true; clearTransportResumeTimer(); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(fault('AGENT_UNAVAILABLE', '에이전트 연결이 종료되었습니다.', 503)); } pending.clear(); approvals.clear(); },
    async initialize(meta, cwd, servers = [], instructions) {
      config = { ...meta, cwd };
      if (agent === 'cursor' && meta.tokens) cursorTokens = { ...cursorTokens, ...meta.tokens };
      if (agent === 'codex') {
        await request('initialize', { clientInfo: { name: 'mooner_ade', title: 'Mooner ADE', version: '0.5.1' }, capabilities: { experimentalApi: true } });
        await send({ method: 'initialized' });
        const models = await request('model/list', { limit: 100 });
        capabilities.catalog = (models.data ?? []).map(item => ({ id: item.model, name: item.displayName, family: '', window: 0, main: true,
          efforts: (item.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort), images: !item.inputModalities || item.inputModalities.includes('image') }));
        const selected = capabilities.catalog.find(item => item.id === meta.model) ?? capabilities.catalog.find(item => item.id === models.data?.find(m => m.isDefault)?.model);
        capabilities.efforts = selected?.efforts ?? []; capabilities.images = selected?.images !== false;
        if (config.effort && capabilities.efforts.length && !capabilities.efforts.includes(config.effort)) { config.effort = undefined; emit({ kind: 'settings', effort: null }); }
        publishCapabilities();
        if (meta.discoverOnly) { emit({ kind: 'session', model: selected?.id }); return; }
        const availableSkills = await request('skills/list', { cwds: [cwd], forceReload: false }).catch(() => ({ data: [] }));
        for (const group of availableSkills.data ?? []) for (const skill of group.skills ?? []) if (skill.enabled !== false) skills.set(skill.name, skill);
        const permissions = codexPermissions(meta.permissionMode, cwd, meta.addDirs, meta.sandbox, meta.network);
        const params = { cwd, model: meta.model ?? null, approvalPolicy: permissions.approvalPolicy, approvalsReviewer: permissions.approvalsReviewer, sandbox: permissions.sandboxMode,
          config: { ...(config.effort && { model_reasoning_effort: config.effort }), 'sandbox_workspace_write.writable_roots': [cwd, ...meta.addDirs], 'sandbox_workspace_write.network_access': meta.network === true,
            ...Object.fromEntries(servers.map(s => [`mcp_servers.${s.name}`, { command: s.command, args: s.args, ...(s.env && { env: s.env }), ...(s.autoApprove && { default_tools_approval_mode: 'approve' }), ...(askMcpTools(s).length && { tools: Object.fromEntries(askMcpTools(s).map(tool => [tool, { approval_mode: 'prompt' }])) }), ...(s.disabledTools?.length && { disabled_tools: s.disabledTools }) }])) } };
        // A thread keeps the provider it was started with and resumes with it, so switching between the login and an API key (Settings > AI 툴) would not
        // reach an existing chat, and a chat started with the key could not resume once its provider is gone. Resume with the provider configured now.
        const provider = meta.resumeAt || meta.sessionId ? await request('config/read', { includeLayers: false }).then(result => result?.config?.model_provider || 'openai', () => null) : null;
        const response = await request(meta.resumeAt ? 'thread/fork' : meta.sessionId ? 'thread/resume' : 'thread/start', {
          ...params, ...(provider && { modelProvider: provider }), ...(instructions && { developerInstructions: instructions }), ...(meta.sessionId && { threadId: meta.sessionId }), ...(meta.resumeAt && { lastTurnId: meta.resumeAt }), ...(meta.sessionId && { excludeTurns: true }) });
        sessionId = response.thread.id;
        if (response.reasoningEffort !== undefined) emit({ kind: 'settings', effort: response.reasoningEffort });
        const resumed = agentTitle(response.thread?.name);
        if (resumed) emit(resumed);
        const commands = [{ name: 'compact', description: '대화 컨텍스트를 압축합니다' }, ...[...skills.values()].flatMap(skill => typeof skill?.name === 'string' ? [{ name: skill.name, description: typeof skill.description === 'string' ? skill.description : '' }] : [])];
        const named = agentTitle(response.thread?.name);
        if (named) emit(named);
        emit({ kind: 'session', sessionId, model: response.model ?? meta.model, slashCommands: commands.map(item => item.name), commands });
      } else {
        // `_meta.subagents` is what cursor-agent reads to publish subagent_spawned / subagent_state_update. Without it the task still runs, but ADE never hears about it.
        const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { parameterizedModelPicker: true, subagents: true } }, clientInfo: { name: 'mooner_ade', version: '0.5.1' } });
        capabilities.images = init.agentCapabilities?.promptCapabilities?.image === true;
        capabilities.resume = init.agentCapabilities?.loadSession === true;
        if (meta.sessionId && !capabilities.resume) throw fault('CHAT_UNSUPPORTED', '이 Cursor 버전은 세션 복원을 지원하지 않습니다.', 409);
        await request('authenticate', { methodId: 'cursor_login' });
        const mcpServers = cursorMcpServers(servers);
        const opened = method => request(method, { cwd, ...(method === 'session/load' && { sessionId: meta.sessionId }), mcpServers });
        let response;
        try { response = await opened(meta.sessionId ? 'session/load' : 'session/new'); }
        catch (error) {
          // The id is saved as soon as session/new returns, but cursor-agent writes no store until a turn runs. A process that exits before that
          // answers the next load with -32602 Invalid params ("Session … not found"), and every later message dies the same way.
          if (!meta.sessionId || !/not found/i.test(String(error.data?.message ?? ''))) throw error;
          response = await opened('session/new');
        }
        autoServers = servers.filter(s => s.autoApprove).map(s => s.name);
        sessionId = response.sessionId ?? meta.sessionId; cursorInfo(response); runEverything = meta.runEverything === true;
        let modelApplied = null, modelRejected = false;
        if (meta.model) {
          try { modelApplied = meta.model; await this.configure({ model: modelApplied }); }
          catch (error) {
            if (error?.code === 'AGENT_UNAVAILABLE' || error?.code === 'AGENT_TIMEOUT') throw error;
            modelApplied = null; modelRejected = true;
          }
        }
        if (meta.permissionMode !== 'default') await setCursorMode(meta.permissionMode);
        for (const [configId, value] of Object.entries(meta.configValues ?? {})) {
          const option = capabilities.configOptions.find(item => item.id === configId);
          if (option?.options.some(item => item.value === value)) await this.configure({ configOption: { configId, value } });
        }
        const effortOption = cursorEffortOption(capabilities.configOptions);
        if (!modelRejected && meta.effort && effortOption?.options.some(item => item.value === meta.effort)) await this.configure({ configOption: { configId: effortOption.id, value: meta.effort } });
        const commands = mergeCursorCommands([]);
        emit({ kind: 'session', sessionId, slashCommands: commands.map(item => item.name), commands }); publishCapabilities();
        return { modelApplied, modelRejected };
      }
    },
    // Codex takes the approval policy, reviewer and sandbox with every turn/start, so changing them needs no restart. A bypass switch also settles what is
    // already waiting: the running turn keeps the policy it started with (and would keep asking), so its requests are accepted here instead.
    async setPermissions({ permissionMode, sandbox, network }) {
      if (agent !== 'codex' || !config) return;
      if (permissionMode !== undefined) config.permissionMode = permissionMode;
      if (sandbox !== undefined) config.sandbox = sandbox;
      if (network !== undefined) config.network = network;
      if (config.permissionMode === 'bypassPermissions') for (const id of [...approvals.keys()]) await autoAccept(id);
    },
    async setRunEverything(on) {
      if (agent !== 'cursor') return;
      runEverything = on === true;
      if (runEverything) for (const [id, raw] of [...approvals]) if (raw.method === 'session/request_permission') { autoAllowCursor(raw, { required: true }); approvals.delete(id); emit({ kind: 'approval', phase: 'cancel', requestId: id }); }
    },
    async configure({ model, configOption, permissionMode }) {
      if (agent !== 'cursor') throw fault('CHAT_UNSUPPORTED', 'Cursor 설정만 지원합니다.', 409);
      if (model !== undefined) {
        const selected = model ?? capabilities.catalog[0]?.id;
        if (!selected) throw fault('INVALID_INPUT', '선택할 모델이 없습니다.');
        if (capabilities.modelConfigId) cursorInfo(await request('session/set_config_option', { sessionId, configId: capabilities.modelConfigId, value: selected }));
        else { cursorInfo(await request('session/set_model', { sessionId, modelId: selected })); emit({ kind: 'session', sessionId, model: selected }); }
      }
      if (configOption) {
        const option = capabilities.configOptions.find(item => item.id === configOption.configId);
        if (!option || ['model', 'mode'].includes(option.category) || !option.options.some(item => item.value === configOption.value)) throw fault('INVALID_INPUT', '지원하지 않는 모델 옵션입니다.');
        cursorInfo(await request('session/set_config_option', { sessionId, configId: option.id, value: configOption.value }));
      }
      if (permissionMode !== undefined) { cursorInfo(await setCursorMode(permissionMode)); emit({ kind: 'settings', permissionMode }); }
    },
    async send(text, images, { steer = false, clientUserMessageId } = {}) {
      if (images.length && !capabilities.images) throw fault('CHAT_UNSUPPORTED', '선택한 모델은 이미지 입력을 지원하지 않습니다.', 409);
      if (agent === 'codex') {
        if (/^\/compact\s*$/.test(text)) { startedAt = Date.now(); compacting = true; await request('thread/compact/start', { threadId: sessionId }); return; }
        const command = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text), skill = command && skills.get(command[1]);
        if (command && !skill) throw fault('CHAT_UNSUPPORTED', '이 Codex 명령은 터미널에서 사용하세요. 채팅에서는 /compact, 스킬과 ADE 명령을 지원합니다.', 409);
        const input = [...images.map(image => ({ type: 'image', url: `data:${image.mime};base64,${image.data}` })), { type: 'text', text }];
        if (skill) input.push({ type: 'skill', name: skill.name, path: skill.path });
        if (steer) { if (!turnId) throw fault('CHAT_BUSY', '실행 중인 턴이 없습니다.', 409); await request('turn/steer', { threadId: sessionId, expectedTurnId: turnId, input, clientUserMessageId }); }
        else { startedAt = Date.now(); const response = await request('turn/start', { threadId: sessionId, input, ...codexPermissions(config.permissionMode, config.cwd, config.addDirs, config.sandbox, config.network), ...(config.model && { model: config.model }), ...(config.effort && { effort: config.effort }) }); turnId = response.turn.id; }
      } else {
        if (steer) throw fault('CHAT_UNSUPPORTED', capabilities.limitations.steer, 409);
        clearTransportResumeTimer(); transportResumes = 0; transportDropped = false; dropDetail = '';
        startedAt = Date.now(); turnId = `cursor-${randomUUID()}`; textSerial = 0; said = false; chunks.clear(); emit({ kind: 'delta', phase: 'start', messageId: cursorTextId('text') });
        cursorPrompt([...images.map(image => ({ type: 'image', mimeType: image.mime, data: image.data })), { type: 'text', text }]);
      }
    },
    async approve(id, answer) {
      const raw = approvals.get(id); if (!raw) throw fault('NOT_FOUND', '이미 처리된 승인입니다.', 404);
      const p = raw.params ?? {}; let response;
      if (agent === 'codex') {
        if (raw.method === 'mcpServer/elicitation/request') response = answer.allow ? { action: 'accept', content: elicitationContent(p, answer.answers) } : { action: 'decline', content: null };
        else if (raw.method === 'item/tool/requestUserInput') response = { answers: Object.fromEntries(p.questions.map(q => [q.id, { answers: answer.allow ? answer.answers?.[q.id] ?? [] : [] }])) };
        else if (raw.method === 'item/permissions/requestApproval') response = { permissions: answer.allow ? p.permissions : {}, scope: answer.always ? 'session' : 'turn' };
        else { const decision = answer.allow ? answer.always ? 'acceptForSession' : 'accept' : 'decline'; if (p.availableDecisions && !p.availableDecisions.includes(decision)) throw fault('INVALID_INPUT', '이 요청은 해당 승인 선택지를 지원하지 않습니다.'); response = { decision }; }
      } else if (p.sessionId && p.sessionId !== sessionId) {
        // A request for another session gets one error answer, not that and then an empty result as well.
        approvals.delete(id); await send({ id: raw.id, error: { code: -32602, message: 'Unknown session' } }); return;
      } else if (raw.method === 'session/request_permission') {
        const kind = answer.allow ? answer.always ? 'allow_always' : 'allow_once' : 'reject_once', option = p.options?.find(o => o.kind === kind);
        if (answer.allow && !option) throw fault('INVALID_INPUT', '이 요청은 해당 승인 선택지를 지원하지 않습니다.');
        response = { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
      } else if (raw.method === 'cursor/ask_question') response = { outcome: answer.allow ? { outcome: 'answered', answers: p.questions.map(q => ({ questionId: q.id, selectedOptionIds: answer.answers?.[q.id] ?? [] })) } : { outcome: 'skipped' } };
      else response = { outcome: { outcome: answer.allow ? 'accepted' : 'rejected' } };
      const plan = raw.method === 'cursor/create_plan' && answer.allow && config?.permissionMode === 'plan' && typeof p.plan === 'string' && p.plan.trim() ? { text: p.plan } : null;
      if (plan) cursorPlan = plan;
      try { await send({ id: raw.id, result: response }); }
      catch (error) { if (plan && cursorPlan === plan) cursorPlan = null; throw error; }
      approvals.delete(id);
    },
    async interrupt() {
      clearTransportResumeTimer(); emit({ kind: 'delta', phase: 'reconnecting', active: false });
      if (agent === 'codex') { if (turnId) await request('turn/interrupt', { threadId: sessionId, turnId }); }
      else { cursorPlan = null; await send({ method: 'session/cancel', params: { sessionId } }); }
    }
  };
}
