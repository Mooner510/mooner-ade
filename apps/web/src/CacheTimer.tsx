import { memo, useEffect, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';
import { cacheExpires, cacheTimerState } from './cache-timer-state';
import { cacheReadShare } from './cache-read-share';

// `compactAt`: idle compaction (auto-compact on, long conversation, 1h cache) summarizes the conversation at this time, before the cache would go cold.
// `compacted`: the conversation was summarized after that request (token counts before/after when Claude Code reports them); its old cache is no longer used.
export type ClaudeCache = { at: number; ttl: number; tokens: number; model: string; compactAt?: number; compacted?: { at: number; trigger: 'auto' | 'manual'; before?: number; after?: number } };
const formatTokens = (count: number) => count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1000 ? `${Math.round(count / 1000)}K` : String(count);
const clockTime = (at: number) => new Date(at).toLocaleTimeString('ko-KR', { hour12: false });
// Claude Code's prompt cache for the conversation at hand. Each main-thread request reads it and restarts its TTL from that request's start;
// once the TTL runs out the next request writes the whole conversation again, which costs many times a read. The chip always counts down
// (hot → warm for the last `warn`% → cold); after a compaction it shows the archive icon without a countdown until the next request. `working` stays on the prop so callers need not change; a running turn does not freeze the label.
export const CacheTimer = memo(function CacheTimer({ cache, warn = 20 }: { cache: ClaudeCache; working: boolean; warn?: number }) {
  const expires = cacheExpires(cache), compacts = cache.compactAt !== undefined, done = cache.compacted;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (done || Date.now() >= expires) return; // a compacted chip has no countdown to tick
    const timer = setInterval(() => { const time = Date.now(); setNow(time); if (time >= expires) clearInterval(timer); }, 1000);
    return () => clearInterval(timer);
  }, [expires, !!done]);
  const { state, left, total } = cacheTimerState(cache, now, warn);
  const seconds = Math.ceil(left / 1000), ttl = cache.ttl >= 3600 ? '1시간' : `${Math.round(cache.ttl / 60)}분`;
  const write = cache.ttl >= 3600 ? 2 : 1.25, read = cacheReadShare(cache.model), ratio = Math.round(write / read), tokens = formatTokens(cache.tokens);
  const compactLine = done ? `${done.trigger === 'manual' ? '수동' : '자동'} Compact, ${clockTime(done.at)}${done.before && done.after ? `, ${formatTokens(done.before)} → ${formatTokens(done.after)} 토큰` : ''}` : '';
  const title = (state === 'compacted' ? [compactLine] : state === 'cold' ? [
    `프롬프트 캐시 만료, ${clockTime(expires)}`,
    `다음 요청: ${tokens} 토큰 다시 기록, 비용/사용량 약 ${ratio}배`
  ] : [
    `프롬프트 캐시, 요청마다 ${ttl} 갱신, ${tokens} 토큰`,
    `마지막 요청 ${clockTime(cache.at)}, ${compacts ? '자동 Compact 예정' : '만료 예정'} ${clockTime(expires)}`
  ]).join('\n');
  return <span className={`cache-timer ${state}`} title={title} aria-label={title} style={state === 'compacted' ? undefined : { '--left': left / total } as CSSProperties}>
    {state === 'hot' && <Icon name="flame" size={12} />}
    {state === 'cold' && <Icon name="snowflake" size={12} />}
    {state === 'compacted' && <Icon name="archive" size={12} />}
    {left > 0 && <b>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</b>}
    {state !== 'compacted' && <i />}
  </span>;
});
