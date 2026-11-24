// The cache timer chip's state, kept apart from CacheTimer.tsx so node tests can load it (no React imports).
export type CacheTimerInput = { at: number; ttl: number; compactAt?: number; compacted?: unknown };
export type CacheTimerState = 'hot' | 'warm' | 'cold' | 'compacted';

// The moment the chip counts down to: the idle compaction when one is expected, else the cache's TTL.
export const cacheExpires = (cache: CacheTimerInput) => cache.compactAt ?? cache.at + cache.ttl * 1000;

// A compaction ends the old cache whatever time it had left (manual /compact, CLI auto-compact, idle compaction), so `compacted`
// decides first and the chip shows no countdown (left 0). The next main-thread request arrives without `compacted` and counts down again.
export function cacheTimerState(cache: CacheTimerInput, now: number, warn: number): { state: CacheTimerState; left: number; total: number } {
  const expires = cacheExpires(cache), total = expires - cache.at;
  if (cache.compacted) return { state: 'compacted', left: 0, total };
  const left = Math.max(0, expires - now);
  return { state: !left ? 'cold' : left <= total * warn / 100 ? 'warm' : 'hot', left, total };
}
