import { promises as fs } from 'node:fs';
import path from 'node:path';

// When a running Claude Code's prompt cache goes cold. Every main-thread request reads (and so refreshes) the conversation's cache,
// and the lifetime counts from the start of that request, so the timer runs from the latest `api-request` the transcript records.
// shortcut: reads Claude Code's own transcript format (sessions/<pid>.json, projects/<slug>/<session>.jsonl); update if the CLI changes it.
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TAIL = 2 * 1024 * 1024;
const TTL = { '5m': 300, '1h': 3600 };

async function transcriptOf(configDir, live) {
  const name = `${live.sessionId}.jsonl`, projects = path.join(configDir, 'projects');
  const direct = path.join(projects, String(live.cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-'), name);
  if (await fs.access(direct).then(() => true, () => false)) return direct;
  // Long paths are shortened with a hash, and a resumed session keeps its original folder.
  for (const dir of await fs.readdir(projects).catch(() => [])) {
    const file = path.join(projects, dir, name);
    if (await fs.access(file).then(() => true, () => false)) return file;
  }
  return null;
}

// One transcript line: request start times go into `requests`; a main-thread response returns the new cache reading.
export function cacheFromLine(line, requests) {
  if (line.includes('"type":"api-request"')) {
    try { const entry = JSON.parse(line); if (entry.type === 'api-request' && entry.id) { requests.set(entry.id, Date.parse(entry.timestamp)); if (requests.size > 32) requests.delete(requests.keys().next().value); } } catch { /* partial line */ }
    return;
  }
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) return;
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  const usage = entry?.message?.usage;
  if (entry.type !== 'assistant' || entry.isSidechain || !usage) return;
  const created = usage.cache_creation ?? {};
  // Requested TTL first: server tools add their own 5-minute writes to a 1-hour request.
  const ttl = TTL[entry.promptCacheRequested] ?? (created.ephemeral_1h_input_tokens > 0 ? 3600 : 300);
  const at = requests.get(entry.requestRef) || Date.parse(entry.timestamp);
  if (!at) return;
  const tokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return { at, ttl, tokens, model: String(entry.message.model || '') };
}

// `state` is the previous return value: only bytes appended since then are read.
export async function readClaudeCache(configDir, pid, state = null) {
  let live;
  try { live = JSON.parse(await fs.readFile(path.join(configDir, 'sessions', `${pid}.json`), 'utf8')); } catch { return null; }
  if (live?.pid !== pid || !uuid.test(live.sessionId)) return null;
  const same = state?.sessionId === live.sessionId;
  const file = same ? state.file : await transcriptOf(configDir, live);
  if (!file) return null;
  const size = (await fs.stat(file).catch(() => null))?.size;
  if (size === undefined) return null;
  const resume = same && state.offset <= size && size - state.offset <= TAIL;
  if (resume && state.offset === size) return state;
  const start = resume ? state.offset : Math.max(0, size - TAIL);
  const buffer = Buffer.alloc(size - start), handle = await fs.open(file);
  try { await handle.read(buffer, 0, buffer.length, start); } finally { await handle.close(); }
  // Only whole lines: the tail may start mid-line, and the CLI may be mid-write at the end.
  const from = start > 0 && !resume ? buffer.indexOf(10) + 1 : 0, end = buffer.lastIndexOf(10) + 1;
  const requests = resume ? state.requests : new Map();
  let value = resume ? state.value : null;
  if (end > from) for (const line of buffer.subarray(from, end).toString('utf8').split('\n')) value = cacheFromLine(line, requests) ?? value;
  return { sessionId: live.sessionId, file, offset: start + Math.max(end, from), requests, value };
}
