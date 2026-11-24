// No React imports: node tests load this file as it is.
export type Auth = 'login' | 'key';
export type AuthLike = { agent?: string; turns?: number; auth?: Auth; lastAuth?: Auth | null; contextTokens?: number | null };
export type AuthSendWarning = { from: Auth; to: Auth; tokens: number };

export const authWords: Record<Auth, string> = { login: 'CLI 플랜으로', key: 'API 키로' };

// Switching the login is silent. The question comes when a message is about to go out on another login than the chat's last turn ran on, and only
// when a turn has been run (an empty or just-cleared chat has no prompt cache to lose). The two logins are separate for the prompt cache, so the whole
// conversation is read again; an API key also starts costing money, a plan starts using its limits.
export function authSendWarning(state: AuthLike, options: { working: boolean }): AuthSendWarning | undefined {
  if (state.agent !== 'claude' || options.working || !state.turns || !state.auth || !state.lastAuth || state.lastAuth === state.auth) return;
  return { from: state.lastAuth, to: state.auth, tokens: state.contextTokens ?? 0 };
}

export function authSendWarningText(warning: AuthSendWarning): string {
  const size = warning.tokens >= 1000 ? `(약 ${Math.round(warning.tokens / 1000)}k 토큰)` : '';
  const was = warning.from === 'login' ? '지금까지 CLI 플랜으로' : '지금까지 API 키로';
  const effect = warning.to === 'key' ? '이 메시지부터 API 요금이 청구됩니다.' : '플랜 한도(5시간·주간)를 쓰게 됩니다.';
  return `이 채팅은 ${was} 답했습니다\n${authWords[warning.to]} 보내면 프롬프트 캐시를 이어 쓰지 못해 대화 전체${size}를 다시 처리하고, ${effect}`;
}
