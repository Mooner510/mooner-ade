// Tip wording and pacing. No DOM or React here, so node tests can load it; toast.ts draws them.
export type TipHistory = Record<string, { n: number; at: number }>;

// A tip is due when it has not been shown yet, or when `gap` ms have passed since the last time and it has been shown fewer than `max` times.
export const tipDue = (history: TipHistory, id: string, now: number, gap: number, max = Infinity) => {
  const seen = history[id];
  return !seen || seen.n < max && now - seen.at >= gap;
};

// A long conversation makes every following request slower and dearer (and the cache costlier to rebuild); `minK` is in thousands of tokens.
export const contextTip = (tokens: number | undefined, minK: number) => tokens && tokens >= minK * 1000
  ? `💡 컨텍스트 약 ${Math.round(tokens / 1000)}k 토큰 · 새 주제면 /clear, 이어가면 /compact 가 더 빠르고 저렴해요`
  : undefined;

export const queueTip = '💡 작업 중엔 Enter 대신 Tab: 끝나자마자 자동 전송되고 수정·취소도 돼요';
export const splitTip = (keys: (binding: string) => string) => `💡 터미널에서 ${keys('ctrl+d')} 좌우 · ${keys('ctrl+shift+d')} 상하 분할`;
