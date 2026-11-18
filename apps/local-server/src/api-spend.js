import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

// What each API key has cost across every chat of the app: real money, so the API Usage figure of any chat on a key shows the key's total, not the chat's own.
// Kept in <data>/api-key-spend.json as { "<agent>:<sha256 prefix of the key>": usd }; the key itself is never written here.
const idOf = (agent, key) => `${agent}:${createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}`;

export function createApiSpend({ file }) {
  let totals = {};
  const listeners = new Set();
  let writing = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify({ version: 1, totals });
    writing = writing.then(async () => {
      const tmp = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(tmp, snapshot, { flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
      finally { await fs.unlink(tmp).catch(() => {}); }
    }).catch(error => console.error('api-key-spend.json을 저장하지 못했습니다:', error.message));
    return writing;
  };
  return {
    async load() {
      try {
        const raw = JSON.parse(await fs.readFile(file, 'utf8'))?.totals ?? {};
        totals = Object.fromEntries(Object.entries(raw).filter(([, usd]) => Number.isFinite(usd) && usd > 0));
      } catch (error) { if (error.code !== 'ENOENT') console.error('api-key-spend.json을 읽지 못했습니다:', error.message); }
    },
    total: (agent, key) => key ? totals[idOf(agent, key)] ?? 0 : 0,
    // Adds one turn's cost to the key and tells every listener (the open chats on that key), so each repaints its figure.
    add(agent, key, usd) {
      if (!key || !Number.isFinite(usd) || usd <= 0) return this.total(agent, key);
      const id = idOf(agent, key);
      totals[id] = (totals[id] ?? 0) + usd;
      void save();
      for (const listener of listeners) listener(id);
      return totals[id];
    },
    idOf,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    flush: () => writing
  };
}
