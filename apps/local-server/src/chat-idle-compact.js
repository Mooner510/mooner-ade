import { IDLE_LEAD } from './claude-cache.js';

// Idle auto-compact for a chat (opt-in): a long conversation on the 1-hour prompt cache is summarized (/compact) just before the cache goes cold,
// so the next message after a break writes the short summary instead of the whole conversation. A chat's child stops after ~10 idle minutes, so the
// CLI's own idle compaction can never run there; ADE does it from the server. The cost: a summary loses detail, and it spends usage even if the user
// never comes back. 5-minute caches are left out (compacting at every pause would only degrade the conversation).
// Settings: a global { enabled, minK } (ADE settings) and a per-chat override (true / false, undefined = follow the global one).
export { IDLE_LEAD };
export const MIN_K = 100, DEFAULT_K = 200, MAX_K = 1000; // thousands of tokens; the floor is the CLI's CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS floor

export const validMinK = value => Number.isInteger(value) && value >= MIN_K && value <= MAX_K;
export const minTokens = minK => (validMinK(minK) ? minK : DEFAULT_K) * 1000;

// Whether this chat compacts on its own: its own choice wins over the global setting.
export const idleCompactOn = (chat, global) => typeof chat === 'boolean' ? chat : global?.enabled === true;

// When the compact is due (ms since the epoch), or undefined when this cache window gets none: off, not the 1h cache, already compacted, or a small context.
export function idleCompactDue({ on, minK, cache, lead = IDLE_LEAD }) {
  if (!on || !cache || cache.ttl !== 3600 || cache.compacted || !(cache.tokens >= minTokens(minK))) return undefined;
  return cache.at + cache.ttl * 1000 * lead;
}

// Why the compact must not be sent now (null: send it). `tried`: the `at` of the cache window that already had its one chance, taken or not.
// `busy`: the caller's own reason (a turn, an approval, a steer, a limit, the CLI's auto compact being off, the chat closed).
export function idleCompactSkip({ on, minK, cache, lead, now, tried, busy }) {
  if (idleCompactDue({ on, minK, cache, lead }) === undefined) return 'not-due';
  if (tried === cache.at) return 'tried';
  if (now >= cache.at + cache.ttl * 1000) return 'expired';
  return busy ?? null;
}
