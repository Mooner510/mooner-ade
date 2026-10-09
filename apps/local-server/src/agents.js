import { spawn } from 'node:child_process';
import { normalizeClaude } from '@mooner/ade-agent-claude';

function channel() {
  const values = [];
  let wake, done = false, failure;
  return {
    push(value) { if (!done) { values.push(value); wake?.(); } },
    end(error) { done = true; failure = error; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!done || values.length) {
        if (values.length) yield values.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
      if (failure) throw failure;
    }
  };
}

async function approve(request, events, tool, data, signal) {
  const summary = JSON.stringify({ cwd: request.cwd, ...data }, null, 2);
  let allowed = false, approvalId;
  try { allowed = await request.requestApproval({ tool, summary, signal, onRequest: approval => {
    approvalId = approval.id;
    events.push({ kind: 'approval', phase: 'requested', approvalId, tool, summary });
  } }); }
  catch { /* denial, expiry and cancellation all fail closed */ }
  events.push({ kind: 'approval', phase: allowed ? 'approved' : 'denied', approvalId, tool, summary });
  return allowed;
}

export class CodexConnection {
  constructor(cwd) {
    this.pending = new Map();
    this.next = 0;
    this.events = channel();
    this.child = spawn('codex', ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdin.on('error', error => this.fail(error));
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', data => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { this.fail(new Error('Codex message limit exceeded')); this.close(); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.method) this.events.push(message);
          else {
            const pending = this.pending.get(message.id);
            if (pending) { this.pending.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); }
          }
        } catch (error) { this.fail(error); this.close(); }
      }
    });
    // Drain stderr without persisting provider diagnostics that may contain credentials.
    this.child.stderr.resume();
    this.child.once('error', error => this.fail(error));
    this.child.once('exit', () => this.fail(new Error('Codex App Server connection closed')));
  }
  send(message) { this.child.stdin.write(JSON.stringify(message) + '\n'); }
  call(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.call('initialize', { clientInfo: { name: 'mooner_ade', title: 'Mooner ADE', version: '0.1.0' } });
    this.send({ method: 'initialized' });
  }
  async listModels() {
    const result = await this.call('model/list');
    return (result.models || []).map(model => ({
      id: model.id,
      label: model.displayName || model.name || model.id,
      efforts: (model.supportedReasoningEfforts || []).map(item => typeof item === 'string' ? item : item.reasoningEffort),
      defaultEffort: model.defaultReasoningEffort || null,
      isDefault: model.isDefault === true
    })).filter(model => model.id);
  }
  fail(error) {
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.events.end(error);
  }
  close() {
    this.child.kill();
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL'); }, 2000);
    timer.unref();
  }
}

export class CodexAppAgent {
  id = 'codex';
  capabilities = { interactiveApprovals: true };
  async *run(request) {
    const rpc = new CodexConnection(request.cwd);
    const output = channel();
    const items = new Map();
    const approvals = new Map();
    const abort = () => { rpc.close(); output.end(request.signal.reason || new Error('Cancelled')); };
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const producer = (async () => {
      try {
        await rpc.initialize();
        const account = await rpc.call('account/read');
        if (!account.account) throw new Error('Codex 로그인이 필요합니다. 터미널에서 codex login을 실행하세요.');
        const { thread } = await rpc.call(request.threadId ? 'thread/resume' : 'thread/start', {
          ...(request.threadId ? { threadId: request.threadId } : {}), cwd: request.cwd,
          ...(request.model ? { model: request.model } : {}),
          approvalPolicy: 'untrusted', sandbox: 'workspaceWrite'
        });
        output.push({ kind: 'session', threadId: thread.id });
        await rpc.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: request.prompt }],
          ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}) });
        for await (const message of rpc.events) {
          const p = message.params || {};
          if (message.id !== undefined) {
            if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
              // Do not block notification consumption while awaiting the user's decision.
              const controller = new AbortController(); approvals.set(message.id, controller);
              void approve(request, output, message.method, { ...p, item: items.get(p.itemId) }, controller.signal).then(allowed => {
                approvals.delete(message.id);
                if (!request.signal.aborted && !controller.signal.aborted) rpc.send({ id: message.id, result: { decision: allowed ? 'accept' : 'decline' } });
              }).catch(error => output.end(error));
            } else rpc.send({ id: message.id, error: { code: -32601, message: 'Unsupported request; denied by ADE' } });
          } else if (message.method === 'serverRequest/resolved') approvals.get(p.requestId)?.abort();
          else if (message.method === 'item/agentMessage/delta') output.push({ kind: 'text', mode: 'append', itemId: p.itemId, text: p.delta });
          else if (message.method === 'item/started' || message.method === 'item/completed') {
            items.set(p.item.id, p.item);
            if (p.item.type === 'agentMessage') {
              if (message.method === 'item/completed') output.push({ kind: 'text', mode: 'replace', itemId: p.item.id, text: p.item.text });
            } else output.push({ kind: 'tool', phase: message.method, tool: p.item.type, data: p.item });
          } else if (message.method === 'turn/completed') {
            if (p.turn.status !== 'completed') throw new Error(p.turn.error?.message || `Codex turn ${p.turn.status}`);
            output.push({ kind: 'result', status: 'success' }); break;
          } else output.push({ kind: 'raw', data: message });
        }
        output.end();
      } catch (error) { output.end(error); }
    })();
    try { yield* output; }
    finally { for (const controller of approvals.values()) controller.abort(); request.signal.removeEventListener('abort', abort); rpc.close(); await producer; }
  }
}

export class ClaudeSdkAgent {
  id = 'claude';
  capabilities = { interactiveApprovals: true };
  async *run(request) {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const output = channel();
    const producer = (async () => {
      try {
        for await (const message of query({ prompt: request.prompt, options: {
          cwd: request.cwd, resume: request.threadId || undefined,
          ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}),
          abortController: controller, permissionMode: 'default', includePartialMessages: true,
          canUseTool: async (tool, input, context) => await approve(request, output, tool, { input }, context?.signal)
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: '사용자가 거절했거나 승인 요청이 만료되었습니다.' }
        } })) {
          for (const event of normalizeClaude(message)) output.push(event.kind === 'text' ? { ...event, mode: 'append' } : event);
          if (message.type === 'result' && message.is_error) throw new Error(message.result || message.errors?.join('\n') || 'Claude failed');
        }
        output.end();
      } catch (error) { output.end(error); }
    })();
    try { yield* output; }
    finally { controller.abort(); request.signal.removeEventListener('abort', abort); await producer; }
  }
}

export async function listClaudeModels(cwd) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const client = query({ prompt: '', options: { cwd } });
  try {
    if (typeof client.supportedModels !== 'function') throw new Error('Claude SDK model catalog is unavailable');
    const models = await client.supportedModels();
    return models.map(model => ({ id: model.value, label: model.displayName || model.value,
      efforts: model.supportsEffort ? (model.supportedEffortLevels || []) : [], isDefault: model.isDefault === true })).filter(model => model.id);
  } finally { await client.close?.(); }
}
