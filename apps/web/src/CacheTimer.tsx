import { memo, useEffect, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';

// `compactAt`: idle compaction (auto-compact on, long conversation, 1h cache) summarizes the conversation at this time, before the cache would go cold.
// `compacted`: the conversation was summarized after that request (token counts before/after when Claude Code reports them); its old cache is no longer used.
export type ClaudeCache = { at: number; ttl: number; tokens: number; model: string; compactAt?: number; compacted?: { at: number; trigger: 'auto' | 'manual'; before?: number; after?: number } };
// ponytail: cache-read price as a share of base input from Anthropic pricing (2026-10); other models read at 0.1×. Update when prices move.
const cacheReadShare = (model: string) => /fable-5-1|mythos-5-1/.test(model) ? 0.025 : /opus-5-5/.test(model) ? 0.05 : 0.1;
const formatTokens = (count: number) => count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1000 ? `${Math.round(count / 1000)}K` : String(count);
const clockTime = (at: number) => new Date(at).toLocaleTimeString('ko-KR', { hour12: false });
// Claude Code's prompt cache for the conversation at hand. Each request reads it and restarts its TTL; once the TTL runs out the next
// request writes the whole conversation again, which costs many times a read. Hot → warm (last 20%) → cold; while Claude works,
// each request restarts the TTL, so it shows as in use instead of a countdown.
export const CacheTimer = memo(function CacheTimer({ cache, working, warn = 20 }: { cache: ClaudeCache; working: boolean; warn?: number }) {
  const expires = cache.compactAt ?? cache.at + cache.ttl * 1000, total = expires - cache.at, compacts = cache.compactAt !== undefined;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (Date.now() >= expires) return;
    const timer = setInterval(() => { const time = Date.now(); setNow(time); if (time >= expires) clearInterval(timer); }, 1000);
    return () => clearInterval(timer);
  }, [expires]);
  const left = Math.max(0, expires - now), state = working ? 'using' : cache.compacted ? 'compacted' : !left ? 'cold' : left <= total * warn / 100 ? 'warm' : 'hot';
  const seconds = Math.ceil(left / 1000), ttl = cache.ttl >= 3600 ? '1시간' : `${Math.round(cache.ttl / 60)}분`;
  const write = cache.ttl >= 3600 ? 2 : 1.25, read = cacheReadShare(cache.model), ratio = Math.round(write / read), tokens = formatTokens(cache.tokens);
  const done = cache.compacted, title = (state === 'compacted' && done ? [
    `Claude Code가 ${clockTime(done.at)}에 대화를 compact했습니다 (${done.trigger === 'manual' ? '수동' : '자동'})${done.before && done.after ? ` · ${formatTokens(done.before)} → ${formatTokens(done.after)} 토큰` : ''}`,
    '이전 대화의 캐시는 더 쓰지 않습니다. 다음 요청은 긴 대화 대신 요약본만 캐시에 기록하므로 비용이 작습니다.'
  ] : state === 'cold' ? [
    `Claude Code 프롬프트 캐시가 식었습니다 · ${clockTime(expires)} 만료 (${ttl} 유지)`,
    `다음 요청은 대화 ${tokens} 토큰을 캐시에 다시 기록합니다. 입력 단가의 ${write}배로, 캐시가 살아 있을 때보다 약 ${ratio}배의 비용·사용량이 듭니다.`,
    '이전 맥락이 필요 없다면 /clear로 새 대화를 시작하는 편이 저렴합니다.'
  ] : state === 'using' ? [
    `Claude Code 프롬프트 캐시 사용중 · 작업 중에는 요청마다 캐시를 읽고 ${ttl} 유지 시간을 다시 시작합니다.`,
    `마지막 응답 ${clockTime(cache.at)} · 대화 ${tokens} 토큰`
  ] : [
    `Claude Code 프롬프트 캐시 · ${ttl} 유지${state === 'warm' ? compacts ? ' · 곧 자동 compact' : ' · 곧 식음' : ''}`,
    compacts ? `마지막 요청 ${clockTime(cache.at)} → ${clockTime(expires)}경 자동 compact(idle compaction)` : `마지막 요청 ${clockTime(cache.at)} → ${clockTime(expires)}에 식음`,
    `지금 보내면 대화 ${tokens} 토큰을 캐시에서 읽습니다 (입력 단가의 ${read}배).`,
    compacts ? '그 전에 보내지 않으면 대화를 요약한 뒤 식으며, 다음 요청은 요약본만 기록해 비용이 작습니다.' : `식은 뒤에 보내면 다시 기록하느라 약 ${ratio}배의 비용·사용량이 듭니다.`
  ]).join('\n');
  return <span className={`cache-timer ${state}`} title={title} aria-label={title} style={{ '--left': working ? 1 : left / total } as CSSProperties}>
    {(state === 'hot' || state === 'using') && <Icon name="flame" size={12} />}
    {state === 'cold' && <Icon name="snowflake" size={12} />}
    {state === 'compacted' && <Icon name="archive" size={12} />}
    {state === 'using' ? '캐시 사용중' : state === 'cold' || state === 'compacted' ? null : <b>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</b>}
    <i />
  </span>;
});
