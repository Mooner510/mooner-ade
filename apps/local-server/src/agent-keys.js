import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fault } from './files.js';

// API keys the chat mode can run Claude, Codex and Cursor with instead of the CLI's own login.
// Kept only on the server, in <data>/agent-keys.json (0600); the browser only ever gets the last four characters back.
export const KEY_AGENTS = ['claude', 'codex', 'cursor'];
// Codex app-server ignores CODEX_API_KEY/OPENAI_API_KEY and `codex login --with-api-key` would replace the user's ChatGPT login in auth.json,
// so the key goes in through a provider that reads it from the environment, added only to the chats ADE starts (`-c` overrides, nothing written).
export const CODEX_PROVIDER = 'ade-openai-key';
export const CODEX_KEY_ENV = 'ADE_CODEX_OPENAI_API_KEY';
const codexArgs = ['-c', `model_provider="${CODEX_PROVIDER}"`, '-c', `model_providers.${CODEX_PROVIDER}={name="OpenAI (API key)",base_url="https://api.openai.com/v1",env_key="${CODEX_KEY_ENV}",wire_api="responses"}`];

export const maskAgentKey = key => key ? `${'•'.repeat(8)}${key.slice(-4)}` : '';
const validKey = key => typeof key === 'string' && key.length >= 8 && key.length <= 512 && /^[\x21-\x7e]+$/.test(key);

function clean(raw) {
  const data = {};
  for (const agent of KEY_AGENTS) {
    const entry = raw?.[agent], key = validKey(entry?.key) ? entry.key : '';
    data[agent] = { key, use: key !== '' && entry?.use === true };
  }
  return data;
}

// `launch(agent)` is synchronous (it runs inside the chat's spawn), so `load()` must have finished once before the first chat starts.
export function createAgentKeys({ file }) {
  let data = clean(null);
  const save = async () => {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(tmp, JSON.stringify({ version: 1, ...data }), { flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
    finally { await fs.unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  };
  return {
    async load() {
      try { data = clean(JSON.parse(await fs.readFile(file, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') console.error('agent-keys.json를 읽지 못했습니다:', error.message); }
    },
    status() { return Object.fromEntries(KEY_AGENTS.map(agent => [agent, { use: data[agent].use, key: maskAgentKey(data[agent].key) }])); },
    // { agent, key?: string (set; '' removes it), use?: boolean }. A new key is used right away; removing the key goes back to the login.
    async write({ agent, key, use } = {}) {
      if (!KEY_AGENTS.includes(agent)) throw fault('INVALID_INPUT', '잘못된 에이전트입니다.');
      const next = { ...data[agent] };
      if (key !== undefined) {
        if (typeof key !== 'string') throw fault('INVALID_INPUT', 'API 키 형식이 올바르지 않습니다.');
        const trimmed = key.trim();
        if (trimmed && !validKey(trimmed)) throw fault('INVALID_INPUT', 'API 키 형식이 올바르지 않습니다. 공백 없이 8–512자여야 합니다.');
        next.key = trimmed; next.use = trimmed !== '';
      }
      if (use !== undefined) {
        if (typeof use !== 'boolean') throw fault('INVALID_INPUT', '잘못된 값입니다.');
        if (use && !next.key) throw fault('INVALID_INPUT', '먼저 API 키를 저장하세요.');
        next.use = use;
      }
      data = { ...data, [agent]: next };
      await save();
      return this.status();
    },
    // What a chat of `agent` adds to its launch: { env, args } (args go before the subcommand). Empty when the login is used.
    launch(agent) {
      const entry = data[agent];
      if (!entry?.use) return { env: {}, args: [] };
      if (agent === 'claude') return { env: { ANTHROPIC_API_KEY: entry.key }, args: [] };
      if (agent === 'codex') return { env: { [CODEX_KEY_ENV]: entry.key }, args: codexArgs };
      return { env: { CURSOR_API_KEY: entry.key }, args: [] };
    },
    // Changes whenever what `launch` returns would change, without carrying the key itself (for cache keys).
    signature(agent) { return data[agent]?.use ? `key:${createHash('sha256').update(data[agent].key).digest('hex').slice(0, 12)}` : 'login'; },
  };
}
