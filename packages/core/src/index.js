import { randomUUID } from 'node:crypto';

export class AllowAllPolicy {
  async authorize() { return true; }
}

export class DenyAllPolicy {
  async authorize() { return false; }
}

/** Inject platform capabilities here. The core never imports fs, git, node-pty or a container manager. */
export class AdeEngine {
  #runtime;
  #policy;
  #agents = new Map();
  #sessions = new Map();

  constructor({ runtime, policy = new DenyAllPolicy(), agents = [] }) {
    if (!runtime || !runtime.workspace || !runtime.processes || !runtime.git || !runtime.terminal) {
      throw new TypeError('Runtime must provide workspace, processes, git and terminal');
    }
    this.#runtime = runtime;
    this.#policy = policy;
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
  get sessions() { return [...this.#sessions.values()].map(({ controller, ...session }) => ({ ...session })); }

  async #authorize(action, context) {
    const allowed = await this.#policy.authorize(action, context);
    if (allowed !== true) throw new Error(`Permission denied: ${action}`);
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
    await this.#authorize('agent.run', { agentId, cwd: options.cwd });
    const id = randomUUID();
    const controller = new AbortController();
    const session = { id, agentId, status: 'running', startedAt: Date.now(), controller };
    this.#sessions.set(id, session);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      yield { kind: 'lifecycle', phase: 'started', sessionId: id, agent: agentId };
      for await (const event of agent.run({ prompt, ...options, signal: controller.signal })) {
        yield { sessionId: id, agent: agentId, ...event };
      }
      session.status = controller.signal.aborted ? 'cancelled' : 'completed';
      yield { kind: 'lifecycle', phase: session.status, sessionId: id, agent: agentId };
    } catch (error) {
      session.status = controller.signal.aborted ? 'cancelled' : 'failed';
      yield { kind: 'error', message: error.message, sessionId: id, agent: agentId };
      yield { kind: 'lifecycle', phase: session.status, sessionId: id, agent: agentId };
    } finally {
      session.finishedAt = Date.now();
      delete session.controller;
      options.signal?.removeEventListener('abort', abort);
    }
  }

  stopAgent(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session || session.status !== 'running') return false;
    session.controller.abort(new Error('Stopped by user'));
    return true;
  }
}
