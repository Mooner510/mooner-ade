import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function requireId(value, kind) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError(`Invalid ${kind} identifier`);
  }
  return value;
}

function serialize(session, events) {
  return JSON.stringify({ version: 1, session, events });
}

export class FileSessionStore {
  #dir;
  #queues = new Map();
  constructor(directory) {
    if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('Session directory required');
    this.#dir = resolve(directory);
  }

  #file(id) {
    return join(this.#dir, `${requireId(id, 'session')}.json`);
  }

  async #atomicSave(file, contents) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(contents, { encoding: 'utf8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async load(id) {
    const file = this.#file(id);
    let contents;
    try { contents = await readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const record = JSON.parse(contents);
    if (record.version !== 1 || !record.session || !Array.isArray(record.events) ||
        record.session.id !== id ||
        record.events.some((event, index) => !event || event.sessionId !== id || event.sequence !== index + 1)) {
      throw new Error('Unsupported or malformed session record');
    }
    return record;
  }

  async create(session) {
    if (!session || typeof session !== 'object') throw new TypeError('Session object required');
    const id = requireId(session.id, 'session');
    return this.#enqueue(id, async () => {
      if (await this.load(id)) throw new Error('Session already exists');
      const state = { ...session, id, status: session.status || 'created' };
      await this.#atomicSave(this.#file(id), serialize(state, []));
      return { version: 1, session: state, events: [] };
    });
  }

  async append(id, event) {
    return this.#enqueue(requireId(id, 'session'), async () => {
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('Event object required');
      const record = await this.load(id);
      if (!record) throw new Error('Session does not exist');
      if (TERMINAL.has(record.session.status)) throw new Error('Session is terminal');
      const sequence = record.events.length ? record.events.at(-1).sequence + 1 : 1;
      const timestamp = Number.isSafeInteger(event.timestamp) && event.timestamp > 0 ? event.timestamp : Date.now();
      const normalized = { ...event, sessionId: id, sequence, timestamp };
      record.events.push(normalized);
      await this.#atomicSave(this.#file(id), serialize(record.session, record.events));
      return normalized;
    });
  }

  async setStatus(id, status) {
    if (!['created', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(status)) {
      throw new TypeError('Invalid session status');
    }
    return this.#enqueue(requireId(id, 'session'), async () => {
      const record = await this.load(id);
      if (!record) throw new Error('Session does not exist');
      if (TERMINAL.has(record.session.status) && record.session.status !== status) {
        throw new Error('Cannot transition terminal session');
      }
      record.session = { ...record.session, status, updatedAt: Date.now() };
      await this.#atomicSave(this.#file(id), serialize(record.session, record.events));
      return record.session;
    });
  }

  async replay(id, { afterSequence = 0 } = {}) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new TypeError('Invalid cursor');
    const record = await this.load(id);
    if (!record) throw new Error('Session does not exist');
    return record.events.filter(event => event.sequence > afterSequence);
  }

  async recover(id) {
    return this.#enqueue(requireId(id, 'session'), async () => {
      const record = await this.load(id);
      if (!record) throw new Error('Session does not exist');
      if (record.session.status === 'running') {
        record.session = { ...record.session, status: 'interrupted', updatedAt: Date.now() };
        await this.#atomicSave(this.#file(id), serialize(record.session, record.events));
      }
      return record;
    });
  }

  #enqueue(id, operation) {
    const previous = this.#queues.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tail = current.catch(() => {});
    this.#queues.set(id, tail);
    void tail.finally(() => { if (this.#queues.get(id) === tail) this.#queues.delete(id); });
    return current;
  }
}
