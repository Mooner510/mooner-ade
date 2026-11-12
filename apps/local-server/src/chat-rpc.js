import { fault } from './files.js';
import { cleanChatTitle } from './chat-title.js';
import { mergeCursorCommands } from './slash-commands.js';

export const chatAgents = ['claude', 'codex', 'cursor'];
export function chatCapabilities(agent) {
  const cursor = agent === 'cursor';
  return { images: true, steer: !cursor, cancelSteer: agent === 'claude', branch: !cursor, rewind: !cursor, worktree: true, addDirs: !cursor,
    terminal: true, terminalToChat: agent === 'claude', cost: agent === 'claude', tokens: !cursor, context: true,
    permissionModes: cursor ? ['default', 'plan', 'ask'] : ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
    sandboxes: agent === 'codex' ? SANDBOXES : cursor ? CURSOR_SANDBOXES : [], runEverything: cursor, efforts: agent === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : [], catalog: [], configOptions: [],
    limitations: { branch: 'Cursor ACP는 과거 지점 분기를 제공하지 않습니다.', rewind: 'Cursor ACP는 과거 지점 복원을 제공하지 않습니다.',
      steer: 'Cursor ACP는 실행 중 추가 지시를 제공하지 않습니다. 응답 후 순서대로 전송합니다.', cancelSteer: 'CLI가 받은 지시는 개별 취소할 수 없습니다.',
      addDirs: 'Cursor ACP는 추가 작업 폴더를 제공하지 않습니다.', terminalToChat: '세션과 완전한 대기 상태를 확인할 수 없어 전환할 수 없습니다.' } };
}

const usage = value => ({ input: Math.max(0, (value?.inputTokens ?? 0) - (value?.cachedInputTokens ?? 0)), output: value?.outputTokens ?? 0,
  cacheRead: value?.cachedInputTokens ?? 0, cacheCreate: value?.cacheWriteInputTokens ?? 0 });
const contextWindowOf = value => { const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(String(value ?? '').trim()); return match ? Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000) : 0; };
const cursorContextWindow = (options = []) => contextWindowOf(options.find(option => option.id === 'context')?.currentValue);
const agentTitle = value => { const text = cleanChatTitle(value); return text ? { kind: 'title', source: 'agent', text } : null; };
// `--sandbox enabled|disabled` is a Cursor launch switch (not an ACP mode). "Run Everything" is not passed as `--force`: this client accepts Cursor's
// permission requests itself, so it can be switched at any time.
export const CURSOR_SANDBOXES = ['enabled', 'disabled'];
const modeOf = mode => mode === 'default' ? 'agent' : mode;
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

// JSON-RPC transport is shared; the agents retain ownership of authentication, tools and model calls.
export function createChatProtocol(agent, { write, emit, fail }) {
  let nextId = 0, sessionId, turnId, startedAt = 0, textSerial = 0, said = false, config, capabilities = chatCapabilities(agent), compacting = false, disposed = false, runEverything = false, autoServers = [];
  const pending = new Map(), approvals = new Map(), chunks = new Map(), skills = new Map();
  const send = value => write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const request = (method, params = {}, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(fault('AGENT_TIMEOUT', `${agent}: ${method} 응답 시간이 초과되었습니다.`, 504)); }, timeoutMs) : null;
    pending.set(id, { resolve, reject, timer });
    void send({ id, method, params }).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
  });
  const publishCapabilities = () => emit({ kind: 'capabilities', capabilities });
  const result = (status = 'success', text = '') => {
    if (disposed) return;
    for (const id of approvals.keys()) emit({ kind: 'approval', phase: 'cancel', requestId: id });
    approvals.clear(); turnId = null;
    emit({ kind: 'result', status, text, costUsd: null, durationMs: Date.now() - startedAt });
  };
  const message = (id, blocks, extra = {}) => emit({ kind: 'message', id, blocks, ...extra });
  const approval = (raw, tool, input, extra = {}) => {
    const id = String(raw.id); approvals.set(id, raw);
    emit({ kind: 'approval', phase: 'request', requestId: id, tool, input, suggestions: [], ...extra });
  };
  function cursorInfo(info) {
    if (info.models) {
      capabilities.catalog = (info.models.availableModels ?? []).map(item => ({ id: item.modelId, name: item.name, family: '', window: 0, main: true }));
      if (info.models.currentModelId) emit({ kind: 'session', sessionId, model: info.models.currentModelId });
    }
    if (info.modes) {
      capabilities.permissionModes = (info.modes.availableModes ?? []).map(item => item.id === 'agent' ? 'default' : item.id);
      if (info.modes.currentModeId) emit({ kind: 'settings', permissionMode: info.modes.currentModeId === 'agent' ? 'default' : info.modes.currentModeId });
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
    if (item.type === 'agentMessage' || item.type === 'plan') { if (completed) message(item.id, [{ type: 'text', text: item.text ?? '' }], extra); }
    else if (item.type === 'reasoning') { if (completed) message(item.id, [{ type: 'thinking', text: [...(item.summary ?? []), ...(item.content ?? [])].join('\n') }]); }
    else if (item.type === 'contextCompaction') { if (completed) { emit({ kind: 'compact', trigger: compacting ? 'manual' : 'auto', preTokens: null, postTokens: null }); if (compacting) { compacting = false; result(); } } }
    else if (item.type !== 'userMessage') {
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
  const cursorTextId = phase => `${turnId}-${phase}-${textSerial}`;
  function cursorFlush() {
    let stored = false;
    for (const phase of ['thinking', 'text']) {
      const id = cursorTextId(phase), content = chunks.get(id);
      if (typeof content === 'string' && content.trim()) { message(id, [{ type: phase, text: content }]); stored = true; if (phase === 'text') said = true; }
      chunks.delete(id);
    }
    return stored;
  }
  function notification(method, params) {
    if (agent === 'codex') {
      if (params.threadId && params.threadId !== sessionId) return;
      if (method === 'thread/name/updated') { const event = agentTitle(params.threadName ?? params.thread_name ?? params.name); if (event) emit(event); return; }
      if (method === 'turn/started') { turnId = params.turn.id; startedAt = Date.now(); }
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
      } else if (method === 'turn/completed') { chunks.clear(); result(params.turn.status === 'interrupted' ? 'interrupted' : params.turn.status === 'failed' ? 'failed' : 'success', params.turn.error?.message ?? ''); }
      else if (method === 'error' && !params.willRetry) emit({ kind: 'error', message: params.error?.message ?? 'Codex 오류' });
      else if (method === 'serverRequest/resolved') { const id = String(params.requestId); approvals.delete(id); emit({ kind: 'approval', phase: 'cancel', requestId: id }); }
      return;
    }
    if (method !== 'session/update' || params.sessionId !== sessionId) return;
    const update = params.update ?? {}, type = update.sessionUpdate;
    if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
      const phase = type === 'agent_thought_chunk' ? 'thinking' : 'text', messageId = cursorTextId(phase);
      const text = update.content?.text ?? '';
      const old = chunks.get(messageId) ?? ''; chunks.set(messageId, old + text);
      emit({ kind: 'delta', phase, index: 0, messageId, text });
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      // Text and thoughts said before this tool are stored under the id they streamed with (so the screen keeps the same item) and later text starts a new one.
      if (cursorFlush()) textSerial += 1;
      const old = chunks.get(update.toolCallId) ?? {}, item = { ...old, ...update };
      const name = item.kind === 'execute' ? 'Bash' : item.kind === 'edit' ? 'Patch' : item.title ?? item.kind ?? 'Tool';
      const block = { type: 'tool_use', id: update.toolCallId, name, input: { ...(item.rawInput ?? {}), description: item.title, content: item.content, locations: item.locations } };
      // Updates repeat the call many times over; only a change is stored (status-only updates change nothing that is drawn).
      const shown = JSON.stringify(block);
      if (shown !== old.shown) message(update.toolCallId, [block]);
      const finished = item.status === 'completed' || item.status === 'failed';
      if (finished && !old.finished) emit({ kind: 'tool_result', toolUseId: update.toolCallId, isError: item.status === 'failed',
        content: (item.content ?? []).map(part => part.type === 'content' ? part.content?.text ?? `[${part.content?.type}]` : part.type === 'diff' ? `${part.path}\n${part.newText}` : JSON.stringify(part)).join('\n') });
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
    else if (type === 'current_mode_update') emit({ kind: 'settings', permissionMode: update.currentModeId === 'agent' ? 'default' : update.currentModeId });
    else if (type === 'usage_update') emit({ kind: 'usage', contextTokens: update.used, contextWindow: update.size, contextSource: 'acp' });
    else if (type === 'session_info_update') { const event = agentTitle(update.title); if (event) emit(event); }
  }
  // Bypass answers command, file-change and permission requests itself. Questions (requestUserInput) are never answered for the user.
  const autoAcceptable = raw => agent === 'codex' && config?.permissionMode === 'bypassPermissions' && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(raw.method);
  async function autoAccept(id, announced = true) {
    const raw = approvals.get(id); if (!raw || !autoAcceptable(raw)) return;
    const p = raw.params ?? {};
    const response = raw.method === 'item/permissions/requestApproval' ? { permissions: p.permissions, scope: 'turn' } : { decision: 'accept' };
    approvals.delete(id); if (announced) emit({ kind: 'approval', phase: 'cancel', requestId: id });
    await send({ id: raw.id, result: response });
  }
  // A built-in plugin's MCP tool (the agent bus) needs no prompt. Cursor names an MCP tool in the request's title; shell, file and fetch kinds never match.
  const autoApprovedTool = toolCall => autoServers.length > 0 && [undefined, 'other'].includes(toolCall?.kind) && typeof toolCall?.title === 'string' && autoServers.some(name => toolCall.title.includes(name));
  // Run Everything: accept the request once (never "always", so turning it off takes effect on the next request).
  function autoAllowCursor(raw) {
    const option = raw.params?.options?.find(o => o.kind === 'allow_once'); if (!option) return false;
    void send({ id: raw.id, result: { outcome: { outcome: 'selected', optionId: option.optionId } } }); return true;
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
      else void send({ id: raw.id, error: { code: -32601, message: `Unsupported client request: ${raw.method}` } });
    } else if (p.sessionId && p.sessionId !== sessionId) void send({ id: raw.id, error: { code: -32602, message: 'Unknown session' } });
    else if (raw.method === 'session/request_permission' && runEverything && autoAllowCursor(raw)) return;
    else if (raw.method === 'session/request_permission' && autoApprovedTool(p.toolCall) && autoAllowCursor(raw)) return;
    else if (raw.method === 'session/request_permission') approval(raw, p.toolCall?.title ?? '도구 실행', p.toolCall?.rawInput ?? {}, { suggestions: p.options?.some(o => o.kind === 'allow_always') ? ['session'] : [] });
    else if (raw.method === 'cursor/ask_question') approval(raw, p.title ?? '질문', {}, { questions: p.questions });
    else if (raw.method === 'cursor/create_plan') approval(raw, '계획 승인', { description: p.overview, plan: p.plan });
    else void send({ id: raw.id, error: { code: -32601, message: `Unsupported client request: ${raw.method}` } });
  }
  return {
    request,
    handle(raw) {
      if (raw.method) { if (raw.id !== undefined) serverRequest(raw); else notification(raw.method, raw.params ?? {}); }
      else if (raw.id !== undefined) {
        const item = pending.get(raw.id); if (!item) return;
        pending.delete(raw.id); clearTimeout(item.timer);
        raw.error ? item.reject(fault('AGENT_PROTOCOL', raw.error.message, 502)) : item.resolve(raw.result);
      }
    },
    dispose() { disposed = true; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(fault('AGENT_UNAVAILABLE', '에이전트 연결이 종료되었습니다.', 503)); } pending.clear(); approvals.clear(); },
    async initialize(meta, cwd, servers = [], instructions) {
      config = { ...meta, cwd };
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
            ...Object.fromEntries(servers.map(s => [`mcp_servers.${s.name}`, { command: s.command, args: s.args, ...(s.env && { env: s.env }), ...(s.autoApprove && { default_tools_approval_mode: 'approve' }), ...(s.disabledTools?.length && { disabled_tools: s.disabledTools }) }])) } };
        // A thread keeps the provider it was started with and resumes with it, so switching between the login and an API key (Settings > AI 툴) would not
        // reach an existing chat, and a chat started with the key could not resume once its provider is gone. Resume with the provider configured now.
        const provider = meta.resumeAt || meta.sessionId ? await request('config/read', { includeLayers: false }).then(result => result?.config?.model_provider || 'openai', () => null) : null;
        const response = await request(meta.resumeAt ? 'thread/fork' : meta.sessionId ? 'thread/resume' : 'thread/start', {
          ...params, ...(provider && { modelProvider: provider }), ...(instructions && { developerInstructions: instructions }), ...(meta.sessionId && { threadId: meta.sessionId }), ...(meta.resumeAt && { lastTurnId: meta.resumeAt }), ...(meta.sessionId && { excludeTurns: true }) });
        sessionId = response.thread.id;
        const resumed = agentTitle(response.thread?.name);
        if (resumed) emit(resumed);
        const commands = [{ name: 'compact', description: '대화 컨텍스트를 압축합니다', hint: '[지침]' }, ...[...skills.values()].flatMap(skill => typeof skill?.name === 'string' ? [{ name: skill.name, description: typeof skill.description === 'string' ? skill.description : '' }] : [])];
        const named = agentTitle(response.thread?.name);
        if (named) emit(named);
        emit({ kind: 'session', sessionId, model: response.model ?? meta.model, slashCommands: commands.map(item => item.name), commands });
      } else {
        const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { parameterizedModelPicker: true } }, clientInfo: { name: 'mooner_ade', version: '0.5.1' } });
        capabilities.images = init.agentCapabilities?.promptCapabilities?.image === true;
        capabilities.resume = init.agentCapabilities?.loadSession === true;
        if (meta.sessionId && !capabilities.resume) throw fault('CHAT_UNSUPPORTED', '이 Cursor 버전은 세션 복원을 지원하지 않습니다.', 409);
        await request('authenticate', { methodId: 'cursor_login' });
        const response = await request(meta.sessionId ? 'session/load' : 'session/new', { cwd, ...(meta.sessionId && { sessionId: meta.sessionId }),
          // ACP cannot leave single tools out, so a plugin server with tools turned off is not given to Cursor at all.
          mcpServers: servers.filter(s => !s.disabledTools?.length).map(s => ({ name: s.name, command: s.command, args: s.args, env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })) })) });
        autoServers = servers.filter(s => s.autoApprove && !s.disabledTools?.length).map(s => s.name);
        sessionId = meta.sessionId ?? response.sessionId; cursorInfo(response); runEverything = meta.runEverything === true;
        if (meta.model) await this.configure({ model: meta.model });
        if (meta.permissionMode !== 'default') await request('session/set_mode', { sessionId, modeId: modeOf(meta.permissionMode) });
        for (const [configId, value] of Object.entries(meta.configValues ?? {})) {
          const option = capabilities.configOptions.find(item => item.id === configId);
          if (option?.options.some(item => item.value === value)) await this.configure({ configOption: { configId, value } });
        }
        const effortOption = cursorEffortOption(capabilities.configOptions);
        if (meta.effort && effortOption?.options.some(item => item.value === meta.effort)) await this.configure({ configOption: { configId: effortOption.id, value: meta.effort } });
        const commands = mergeCursorCommands([]);
        emit({ kind: 'session', sessionId, slashCommands: commands.map(item => item.name), commands }); publishCapabilities();
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
      if (runEverything) for (const [id, raw] of [...approvals]) if (raw.method === 'session/request_permission' && autoAllowCursor(raw)) { approvals.delete(id); emit({ kind: 'approval', phase: 'cancel', requestId: id }); }
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
      if (permissionMode !== undefined) { cursorInfo(await request('session/set_mode', { sessionId, modeId: modeOf(permissionMode) })); emit({ kind: 'settings', permissionMode }); }
    },
    async send(text, images, { steer = false } = {}) {
      if (images.length && !capabilities.images) throw fault('CHAT_UNSUPPORTED', '선택한 모델은 이미지 입력을 지원하지 않습니다.', 409);
      if (agent === 'codex') {
        if (/^\/compact\s*$/.test(text)) { startedAt = Date.now(); compacting = true; await request('thread/compact/start', { threadId: sessionId }); return; }
        const command = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text), skill = command && skills.get(command[1]);
        if (command && !skill) throw fault('CHAT_UNSUPPORTED', '이 Codex 명령은 터미널에서 사용하세요. 채팅에서는 /compact, 스킬과 ADE 명령을 지원합니다.', 409);
        const input = [...images.map(image => ({ type: 'image', url: `data:${image.mime};base64,${image.data}` })), { type: 'text', text }];
        if (skill) input.push({ type: 'skill', name: skill.name, path: skill.path });
        if (steer) { if (!turnId) throw fault('CHAT_BUSY', '실행 중인 턴이 없습니다.', 409); await request('turn/steer', { threadId: sessionId, expectedTurnId: turnId, input }); }
        else { startedAt = Date.now(); const response = await request('turn/start', { threadId: sessionId, input, ...codexPermissions(config.permissionMode, config.cwd, config.addDirs, config.sandbox, config.network), ...(config.model && { model: config.model }), ...(config.effort && { effort: config.effort }) }); turnId = response.turn.id; }
      } else {
        if (steer) throw fault('CHAT_UNSUPPORTED', capabilities.limitations.steer, 409);
        startedAt = Date.now(); turnId = `cursor-${startedAt}`; textSerial = 0; said = false; chunks.clear(); emit({ kind: 'delta', phase: 'start', messageId: cursorTextId('text') });
        void request('session/prompt', { sessionId, prompt: [...images.map(image => ({ type: 'image', mimeType: image.mime, data: image.data })), { type: 'text', text }] }, 0).then(response => {
          if (disposed) return;
          cursorFlush();
          const hasOutput = said || [...chunks.values()].some(value => typeof value === 'object');
          const status = response.stopReason === 'cancelled' ? 'interrupted' : response.stopReason === 'end_turn' && hasOutput ? 'success' : 'failed';
          result(status, status === 'failed' ? `${hasOutput ? 'Cursor 응답이 완료되지 않았습니다' : 'Cursor가 표시할 응답 없이 종료되었습니다'} (${response.stopReason}). 다시 시도하세요.` : '');
        }, error => { result('failed', error.message); fail?.(error); });
      }
    },
    async approve(id, answer) {
      const raw = approvals.get(id); if (!raw) throw fault('NOT_FOUND', '이미 처리된 승인입니다.', 404);
      const p = raw.params ?? {}; let response;
      if (agent === 'codex') {
        if (raw.method === 'item/tool/requestUserInput') response = { answers: Object.fromEntries(p.questions.map(q => [q.id, { answers: answer.allow ? answer.answers?.[q.id] ?? [] : [] }])) };
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
      await send({ id: raw.id, result: response }); approvals.delete(id);
    },
    async interrupt() {
      if (agent === 'codex') { if (turnId) await request('turn/interrupt', { threadId: sessionId, turnId }); }
      else await send({ method: 'session/cancel', params: { sessionId } });
    }
  };
}
