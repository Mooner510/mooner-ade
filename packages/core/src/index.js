import { randomUUID } from 'node:crypto';
import { AGENT_EVENT_SCHEMA_VERSION } from '@mooner/ade-protocol';

export class AllowAllPolicy {
  async authorize() { return true; }
}

export class DenyAllPolicy {
  async authorize() { return false; }
}

/** Approval requests are denied by default. A trusted UI must explicitly decide each request. */
export class ApprovalBroker {
  #requests = new Map();
  constructor({ timeoutMs = 120_000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid approval timeout');
    this.timeoutMs = timeoutMs;
  }

  get pending() { return [...this.#requests.values()].map(({ settle, cleanup, ...metadata }) => ({ ...metadata })); }

  request({ sessionId, tool, summary, signal, onRequest }) {
    if (typeof sessionId !== 'string' || typeof tool !== 'string' || typeof onRequest !== 'function') {
      throw new TypeError('Approval requires session, tool, and onRequest handler');
    }
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('Approval cancelled'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => settle(false, signal.reason || new Error('Approval cancelled'));
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.#requests.delete(id); };
      const settle = (allowed, error) => { cleanup(); if (allowed) resolve(true); else reject(error || new Error('Approval denied')); };
      const timer = setTimeout(() => settle(false, new Error('Approval timed out')), this.timeoutMs);
      this.#requests.set(id, { id, sessionId, tool, summary: summary ?? '', requestedAt: Date.now(), settle, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });
      try { onRequest({ id, sessionId, tool, summary: summary ?? '' }); }
      catch (error) { settle(false, error); }
    });
  }

  decide(id, approved = false) {
    const pending = this.#requests.get(id);
    if (!pending) return false;
    pending.settle(approved === true);
    return true;
  }
}

/** A host-agnostic engine. A policy gate is not an OS/container isolation boundary. */
export class AdeEngine {
  #runtime;
  #policy;
  #agents = new Map();
  #sessions = new Map();
  #approvals;

  constructor({ runtime, policy = new DenyAllPolicy(), agents = [], approvalBroker = new ApprovalBroker() }) {
    if (!runtime?.workspace || !runtime?.processes || !runtime?.git || !runtime?.terminal) {
      throw new TypeError('Runtime must provide workspace, processes, git and terminal');
    }
    this.#runtime = runtime;
    this.#policy = policy;
    this.#approvals = approvalBroker;
    for (const agent of agents) this.registerAgent(agent);
  }

  registerAgent(agent) {
    if (!agent || typeof agent.id !== 'string' || typeof agent.run !== 'function') {
      throw new TypeError('Agent must have id and run(request)');
    }
    if (this.#agents.has(agent.id)) throw new Error(`Duplicate agent: ${agent.id}`);
    this.#agents.set(agent.id, agent);
  }

  get agents() { return [...this.#agents.keys()]; }
  get approvalRequests() { return this.#approvals.pending; }

  async decideApproval(id, approved = false) {
    await this.#authorize('agent.approval.decide', { approvalId: id, approved });
    return this.#approvals.decide(id, approved);
  }

  /** Detached snapshots: callers cannot mutate the engine's sessions. */
  get sessions() { return [...this.#sessions.values()].map(({ controller, ...session }) => ({ ...session })); }

  async #authorize(action, context) {
    if (await this.#policy.authorize(action, context) !== true) throw new Error(`Permission denied: ${action}`);
  }

  async readFile(path) {
    await this.#authorize('file.read', { path });
    return this.#runtime.workspace.readFile(path);
  }

  async writeFile(path, content) {
    await this.#authorize('file.write', { path });
    return this.#runtime.workspace.writeFile(path, content);
  }

  async listFiles(path = '.') {
    await this.#authorize('file.list', { path });
    return this.#runtime.workspace.listFiles(path);
  }

  async gitStatus(path = '.') {
    await this.#authorize('git.status', { path });
    return this.#runtime.git.status(path);
  }

  async gitDiff(path = '.', options = {}) {
    await this.#authorize('git.diff', { path, ...options });
    return this.#runtime.git.diff(path, options);
  }

  async gitStage(files, path = '.') {
    await this.#authorize('git.stage', { path, files });
    return this.#runtime.git.stage(files, path);
  }

  async gitUnstage(files, path = '.') {
    await this.#authorize('git.unstage', { path, files });
    return this.#runtime.git.unstage(files, path);
  }

  async gitCommit(message, path = '.') {
    await this.#authorize('git.commit', { path, message });
    return this.#runtime.git.commit(message, path);
  }

  async execute(file, args = [], options = {}) {
    await this.#authorize('process.exec', { file, args });
    return this.#runtime.processes.exec(file, args, options);
  }

  async openTerminal(options = {}) {
    await this.#authorize('terminal.open', options);
    return this.#runtime.terminal.open(options);
  }

  async *runAgent(agentId, prompt, options = {}) {
    const agent = this.#agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('Prompt must be non-empty');
    if (options.approvalMode === 'interactive' && agent.capabilities?.interactiveApprovals !== true) {
      throw new Error(`${agentId} does not support interactive approvals; use an approval-capable transport`);
    }
    await this.#authorize('agent.run', { agentId, cwd: options.cwd, approvalMode: options.approvalMode });
    const id = randomUUID();
    const controller = new AbortController();
    const session = { id, agentId, status: 'running', startedAt: Date.now(), eventCount: 0, nativeThreadId: null, controller };
    this.#sessions.set(id, session);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const emit = (event) => {
      // Canonical identity always wins over untrusted adapter metadata.
      const { sessionId: ignoredSession, agent: ignoredAgent, schemaVersion: ignoredVersion, sequence: ignoredSequence, timestamp: ignoredTimestamp, ...rest } = event;
      return { ...rest, schemaVersion: AGENT_EVENT_SCHEMA_VERSION, sessionId: id, agent: agentId, sequence: ++session.eventCount, timestamp: Date.now() };
    };
    try {
      yield emit({ kind: 'lifecycle', phase: 'started' });
      const requestApproval = (request) => {
        if (options.approvalMode !== 'interactive' || agent.capabilities?.interactiveApprovals !== true) {
          return Promise.reject(new Error('Interactive approval transport is unavailable'));
        }
        return this.#approvals.request({
          sessionId: id, tool: request?.tool, summary: request?.summary,
          signal: request?.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal,
          onRequest: approval => { options.onApprovalRequest?.(approval); request?.onRequest?.(approval); }
        });
      };
      for await (const event of agent.run({ prompt, ...options, signal: controller.signal, requestApproval })) {
        if (!event || typeof event !== 'object' || typeof event.kind !== 'string') throw new TypeError('Invalid agent event');
        if (event.kind === 'session' && typeof event.threadId === 'string' && event.threadId) session.nativeThreadId = event.threadId;
        yield emit(event);
      }
      session.status = controller.signal.aborted ? 'cancelled' : 'completed';
      yield emit({ kind: 'lifecycle', phase: session.status });
    } catch (error) {
      session.status = controller.signal.aborted ? 'cancelled' : 'failed';
      yield emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      yield emit({ kind: 'lifecycle', phase: session.status });
    } finally {
      if (session.status === 'running') {
        controller.abort(new Error('Agent stream closed by consumer'));
        session.status = 'cancelled';
      }
      session.finishedAt = Date.now();
      controller.abort(new Error('Agent run finished'));
      delete session.controller;
      options.signal?.removeEventListener('abort', abort);
    }
  }

  stopAgent(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session || session.status !== 'running' || !session.controller) return false;
    session.controller.abort(new Error('Stopped by user'));
    return true;
  }
}
