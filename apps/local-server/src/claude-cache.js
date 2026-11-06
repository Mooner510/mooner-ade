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

// Idle compaction: a long conversation on the 1h cache is summarized just before the cache would expire, so the next request writes only the summary.
// It needs auto-compact on and a context of at least CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS (default 200K, floor 100K); `idleCompaction: false` or DISABLE_AUTO_COMPACT turn it off.
// ponytail: the docs only say "about an hour"; 0.9 × TTL (54 min) comes from a third-party reading of the binary. Calibrate IDLE_LEAD if Claude's notice shows another time.
// Settings are read when new transcript lines arrive, not on every tick; managed settings are not read.
const IDLE_LEAD = 0.9;
async function idleCompactAt(configDir, cwd, value) {
  if (value.ttl !== 3600) return undefined;
  const settings = {}, env = {};
  for (const file of [path.join(configDir, 'settings.json'), ...cwd ? [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')] : []]) {
    try { const parsed = JSON.parse(await fs.readFile(file, 'utf8')); Object.assign(settings, parsed); Object.assign(env, parsed.env); } catch { /* missing or broken file */ }
  }
  const get = key => env[key] ?? process.env[key];
  if (settings.autoCompactEnabled === false || settings.idleCompaction === false || ['1', 'true'].includes(String(get('DISABLE_AUTO_COMPACT')).toLowerCase())) return undefined;
  const asked = Number.parseInt(get('CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS'), 10), min = asked > 0 ? Math.max(asked, 100000) : 200000;
  return value.tokens >= min ? value.at + value.ttl * 1000 * IDLE_LEAD : undefined;
}

// A finished compaction (manual /compact, auto-compact or idle compaction) leaves a `compact_boundary` line. The old conversation's cache is of no use
// after it and Claude's own summary request is not recorded as a request, so without this the timer would sit on a stale countdown.
// ponytail: idle compaction's `trigger` value is unconfirmed (the transcripts seen only hold "auto" and "manual"), so anything but "manual" counts as automatic.
export function compactionFromLine(line) {
  if (!line.includes('"subtype":"compact_boundary"')) return;
  try {
    const entry = JSON.parse(line), meta = entry.compactMetadata ?? {}, at = Date.parse(entry.timestamp);
    if (entry.type === 'system' && entry.subtype === 'compact_boundary' && !entry.isSidechain && at) return { at, trigger: meta.trigger === 'manual' ? 'manual' : 'auto', before: meta.preTokens, after: meta.postTokens };
  } catch { /* partial line */ }
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
  const before = resume ? state.value : null;
  let value = before;
  if (end > from) for (const line of buffer.subarray(from, end).toString('utf8').split('\n')) {
    // A boundary belongs to the request before it; the next request starts a fresh cache and drops the mark.
    const compacted = compactionFromLine(line);
    if (compacted) { if (value) value = { ...value, compacted }; } else value = cacheFromLine(line, requests) ?? value;
  }
  if (value && value !== before && !value.compacted) { const compactAt = await idleCompactAt(configDir, live.cwd, value); if (compactAt) value = { ...value, compactAt }; }
  return { sessionId: live.sessionId, file, offset: start + Math.max(end, from), requests, value };
}
