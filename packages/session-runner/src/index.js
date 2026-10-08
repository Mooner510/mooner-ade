/**
 * Persist each event before delivery, including lifecycle completion.
 * This orchestrates an existing AdeEngine without changing its provider adapters.
 */
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
    // Never accept a client-controlled session id. AdeEngine owns it.
    for await (const event of this.#engine.runAgent(agentId, prompt, options)) {
      if (id === null) {
        if (event.kind !== 'lifecycle' || event.phase !== 'started' || typeof event.sessionId !== 'string') {
          throw new Error('Agent stream must begin with a session started event');
        }
        id = event.sessionId;
        await this.#store.create({ id, agentId, status: 'running', startedAt: event.timestamp });
      }
      if (event.sessionId !== id) throw new Error('Session identity changed during stream');
      const stored = await this.#store.append(id, event);
      if (stored.sequence !== event.sequence) throw new Error('Persisted event sequence diverged');
      if (event.kind === 'lifecycle' && ['completed', 'failed', 'cancelled'].includes(event.phase)) {
        await this.#store.setStatus(id, event.phase);
        terminal = true;
      }
      yield stored;
    }
    if (id && !terminal) await this.#store.setStatus(id, 'interrupted');
  }

  async replay(sessionId, options) { return this.#store.replay(sessionId, options); }
  async getSession(sessionId) { return this.#store.load(sessionId); }
  async recover(sessionId) { return this.#store.recover(sessionId); }
  stopAgent(id) { return this.#engine.stopAgent(id); }
}
