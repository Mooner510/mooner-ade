import { parseAgentEvent } from '@mooner/ade-protocol';

/** Persist canonical events before delivery, never representing abandoned work as success. */
export class RecordedAgentRunner {
  #engine;
  #store;
  constructor({ engine, store }) {
    if (!engine?.runAgent || !store?.create || !store?.append || !store?.setStatus || !store?.replay) {
      throw new TypeError('RecordedAgentRunner requires an ADE engine and session store');
    }
    this.#engine = engine;
    this.#store = store;
  }

  async *runAgent(agentId, prompt, options = {}) {
    let id = null;
    let terminal = false;
    try {
      for await (const event of this.#engine.runAgent(agentId, prompt, options)) {
        const validated = parseAgentEvent(event);
        if (id === null) {
          if (validated.kind !== 'lifecycle' || validated.phase !== 'started') {
            throw new Error('Agent stream must begin with a session started event');
          }
          id = validated.sessionId;
          await this.#store.create({ id, agentId, status: 'running', startedAt: validated.timestamp,
            prompt, cwd: options.cwd, conversationId: options.conversationId, projectId: options.projectId,
            model: options.model || null, effort: options.effort || null });
        }
        if (validated.sessionId !== id || validated.agent !== agentId) {
          throw new Error('Session identity changed during stream');
        }
        const stored = await this.#store.append(id, validated);
        if (stored.sequence !== validated.sequence || stored.timestamp !== validated.timestamp) {
          throw new Error('Persisted event metadata diverged');
        }
        if (validated.kind === 'lifecycle' && ['completed', 'failed', 'cancelled'].includes(validated.phase)) {
          await this.#store.setStatus(id, validated.phase);
          terminal = true;
        }
        yield stored;
      }
    } finally {
      // Also runs on consumer break/return, adapter errors, or persistence errors.
      if (id !== null && !terminal) await this.#store.setStatus(id, 'interrupted');
    }
  }

  async replay(sessionId, options) {
    const events = await this.#store.replay(sessionId, options);
    return events.map(event => parseAgentEvent(event, { allowLegacy: true }));
  }
  async getSession(sessionId) { return this.#store.load(sessionId); }
  async recover(sessionId) { return this.#store.recover(sessionId); }
  stopAgent(id) { return this.#engine.stopAgent(id); }
}
