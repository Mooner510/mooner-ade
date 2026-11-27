// The chat's keys for a key list or cheat sheet, one entry per line in the same shape as the app's key guide (group, label, keys). `keys` is a combo
// ("mod+enter", "shift+tab"; show it with chat-model `showCombo` after mapping mod to ctrl/meta) or, for a key that is not a single combo, words ("↑ / ↓").
// The bindable ones come from chatKeyDefs with the user's overrides; the fixed ones are listed here. Pure, so node tests load it.
import { chatKey, chatKeyDefs, type ChatKeyId } from './chat-model.ts';

export type KeyGuideEntry = { group: string; label: string; keys: string; id?: string };
export const CHAT_KEY_GROUPS = { input: '채팅 입력창', thread: '채팅 대화', card: '채팅 승인·계획·질문 카드' } as const;

const GROUP_OF: Partial<Record<ChatKeyId, string>> = {
  cardAllow: CHAT_KEY_GROUPS.card, cardAllowMore: CHAT_KEY_GROUPS.card, cardMore: CHAT_KEY_GROUPS.card,
  turnPrev: CHAT_KEY_GROUPS.thread, turnNext: CHAT_KEY_GROUPS.thread, threadTop: CHAT_KEY_GROUPS.thread, threadBottom: CHAT_KEY_GROUPS.thread, find: CHAT_KEY_GROUPS.thread, copyAnswer: CHAT_KEY_GROUPS.thread, copyCode: CHAT_KEY_GROUPS.thread,
};

/** The settings group of a bindable chat key (설정 › 단축키). */
export const chatKeyGroup = (id: string) => GROUP_OF[id as ChatKeyId] ?? CHAT_KEY_GROUPS.input;

/** Keys that cannot be rebound (they follow the send-key setting, or are the text box's own). */
export const CHAT_FIXED_KEYS: KeyGuideEntry[] = [
  { group: CHAT_KEY_GROUPS.input, label: '보내기 (설정에 따라 Ctrl/⌘+Enter)', keys: 'enter' },
  { group: CHAT_KEY_GROUPS.input, label: '줄바꿈', keys: 'shift+enter' },
  { group: CHAT_KEY_GROUPS.input, label: '권한 모드 순환', keys: 'shift+tab' },
  { group: CHAT_KEY_GROUPS.input, label: '응답 중: 끝난 뒤 보내기(대기열)', keys: 'tab' },
  { group: CHAT_KEY_GROUPS.input, label: '응답 중단 (대기 중인 끼워 넣기는 바로 보냄)', keys: 'escape' },
  { group: CHAT_KEY_GROUPS.input, label: '보낸 메시지 기록', keys: '↑ / ↓' },
  { group: CHAT_KEY_GROUPS.input, label: '대기 중인 메시지 되돌리기', keys: 'shift+arrowup' },
  { group: CHAT_KEY_GROUPS.input, label: '셸 명령 실행', keys: '!명령' },
  { group: CHAT_KEY_GROUPS.input, label: '슬래시 명령 / 파일 언급', keys: '/ / @' },
  { group: CHAT_KEY_GROUPS.input, label: '원문으로 붙여넣기 (ADE에서 복사한 코드도 참조 대신 원문)', keys: 'mod+shift+v' },
  { group: CHAT_KEY_GROUPS.thread, label: '대화 한 화면 위/아래 (입력창이 한 줄일 때도)', keys: 'pageup / pagedown' },
  { group: CHAT_KEY_GROUPS.thread, label: '찾기: 다음 / 이전 / 닫기', keys: 'enter / shift+enter / escape' },
  { group: CHAT_KEY_GROUPS.card, label: '거부하고 응답 중단', keys: 'escape' },
  { group: CHAT_KEY_GROUPS.card, label: '카드 안으로 포커스 (입력창이 숨었을 때)', keys: 'tab' },
  { group: CHAT_KEY_GROUPS.card, label: '질문 카드: 질문 탭 이동', keys: '← / →' },
];

/** Every chat key with the user's bindings: the bindable ones in chatKeyDefs order (composer keys first), then the fixed ones. */
export function chatKeyGuide(overrides?: Record<string, string>): KeyGuideEntry[] {
  return [...chatKeyDefs.map(def => ({ group: chatKeyGroup(def.id), label: def.label, keys: chatKey(overrides, def.id), id: def.id })), ...CHAT_FIXED_KEYS];
}
