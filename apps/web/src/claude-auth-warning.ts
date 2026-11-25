// No React imports: node tests load this file as it is.
export type Auth = 'login' | 'key';
export type AuthLike = { agent?: string; turns?: number; auth?: Auth; lastAuth?: Auth | null; contextTokens?: number | null };
export type AuthSendWarning = { from: Auth; to: Auth; tokens: number; cache: boolean };

export const authWords: Record<Auth, string> = { login: 'CLI 플랜으로', key: 'API 키로' };

// Switching the login is silent. The question comes when a message is about to go out on another login than the chat's last turn ran on, and only
// when a turn has been run. Claude's two logins do not share a prompt cache, so that question also says the conversation is read again.
// Codex and Cursor only change which account's limit or bill the next message uses.
export function authSendWarning(state: AuthLike, options: { working: boolean }): AuthSendWarning | undefined {
  if (options.working || !state.turns || !state.auth || !state.lastAuth || state.lastAuth === state.auth) return;
  if (state.agent && state.agent !== 'claude' && state.agent !== 'codex' && state.agent !== 'cursor') return;
  return { from: state.lastAuth, to: state.auth, tokens: state.contextTokens ?? 0, cache: (state.agent ?? 'claude') === 'claude' };
}

export function authSendWarningText(warning: AuthSendWarning): string {
  const was = warning.from === 'login' ? '지금까지 CLI 플랜으로' : '지금까지 API 키로';
  const effect = warning.to === 'key' ? '이 메시지부터 API 요금이 청구됩니다.' : '플랜 한도(5시간/주간)를 쓰게 됩니다.';
  if (!warning.cache) return `이 채팅은 ${was} 답했습니다\n${authWords[warning.to]} 보내면 요금·한도를 쓰는 계정이 바뀝니다. ${effect}`;
  const size = warning.tokens >= 1000 ? `(약 ${Math.round(warning.tokens / 1000)}k 토큰)` : '';
  return `이 채팅은 ${was} 답했습니다\n${authWords[warning.to]} 보내면 프롬프트 캐시를 이어 쓰지 못해 대화 전체${size}를 다시 처리하고, ${effect}`;
}
