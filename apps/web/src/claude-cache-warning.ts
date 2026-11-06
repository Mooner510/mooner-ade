// The part of the pane's ClaudeCache this needs; kept structural so the helper has no React imports and runs in plain node tests.
export type CacheLike = { at: number; ttl: number; tokens?: number; compactAt?: number; compacted?: unknown };
export type CacheSendWarning = { state: 'cold' | 'low'; left: number; tokens: number };

// Idle compaction (compactAt) is what the cache timer counts down to, so the warning uses the same moment; once the context is
// compacted the next message only writes a summary, and during a turn Enter just queues inside Claude, so neither warns.
// A 5-minute cache is always within a few minutes of expiring, so a "time left" warning would fire on every message;
// there it only warns once the cache is actually cold.
export function cacheSendWarning(cache: CacheLike | undefined, now: number, options: { enabled: boolean; minutes: number; working: boolean }): CacheSendWarning | undefined {
  if (!options.enabled || !cache || options.working || cache.compacted) return;
  const left = (cache.compactAt ?? cache.at + cache.ttl * 1000) - now, tokens = cache.tokens ?? 0;
  if (left <= 0) return { state: 'cold', left: 0, tokens };
  if (cache.ttl >= 3600 && left <= options.minutes * 60_000) return { state: 'low', left, tokens };
}

const SLASH_COMMAND = /^\/[^\s/]*(?:\s|$)/, SUGGESTING = /(?:^|\s)[/@]\S*$/;

// Plain Enter in Claude's composer only sends a message when there is text that is not a slash command and the `/` or `@`
// suggestion list is not open (Enter then picks an entry). The empty composer shows a `Try "…"` hint that is not text.
// `typed` is the composer text read back from the screen (claudeComposerText); this module imports nothing so node tests can load it.
export function isClaudeMessageText(typed: string | undefined): boolean {
  if (!typed || /^Try "/.test(typed)) return false;
  return !SLASH_COMMAND.test(typed) && !SUGGESTING.test(typed);
}

const duration = (ms: number) => {
  const total = Math.max(1, Math.round(ms / 1000)), minutes = Math.floor(total / 60), seconds = total % 60;
  return minutes ? `${minutes}분 ${seconds}초` : `${seconds}초`;
};

export function cacheSendWarningText(warning: CacheSendWarning): string {
  const size = warning.tokens >= 1000 ? ` 컨텍스트 약 ${Math.round(warning.tokens / 1000)}k 토큰이 캐시 없이 다시 처리될 수 있습니다.` : '';
  return warning.state === 'cold'
    ? `프롬프트 캐시가 식었습니다.${size}\n지금 메시지를 보낼까요?`
    : `프롬프트 캐시가 ${duration(warning.left)} 뒤 만료됩니다.${size}\n지금 메시지를 보낼까요?`;
}
