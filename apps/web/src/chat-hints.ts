// Every line the chat uses to point at a feature, in one place: the one-time pointer cards (HINTS), the start screen's "알아 두면 좋은 기능" (DISCOVER) and the
// message box's placeholder (composerPlaceholder). A new feature gets its line here, not a new card in ChatPane.
// Texts name keys as {id}: a chat key id from chat-model `chatKeyDefs` (shown with the user's own binding) or a fixed combo like {shift+tab} or {escape}.
// Least intrusive first: a placeholder or a menu line costs the user nothing, a start-screen line only shows on an empty chat, and a pointer card (HINTS) only right
// after the user did by mouse what a key does. All of them stop when 설정 › 팁 is off. Pure (no React), so node tests load it.

export type GuideText = string;

/** One-time pointer cards next to the control they explain (Hint.tsx). `id` is also the hintsSeen entry; the card shows once the pane asks for it (ChatPane `hintCandidates`). */
export const HINTS: Record<string, { title: string; text: GuideText; wide?: boolean }> = {
  keymodel: { title: '모델은 단축키로도 바꿀 수 있어요', text: '입력창에서 {modelNext}, {modelPrev}로 다음/이전 모델로 넘어가요.' },
  keyeffort: { title: 'Effort도 단축키로 바꿀 수 있어요', text: '입력창에서 {effortUp}로 올리고 {effortDown}로 내려요.' },
  keymode: { title: '권한 모드도 단축키로 바꿀 수 있어요', text: '입력창에서 {shift+tab}을 누를 때마다 다음 모드로 넘어가요.' },
  keystash: { title: '쓰던 입력은 보관해 둘 수 있어요', text: '지우는 대신 {stash}로 보관하고, 다른 요청을 보낸 뒤 {stash}로 다시 꺼내요.', wide: true },
  keyturn: { title: '요청 사이를 키로 오갈 수 있어요', text: '입력창에서도 {turnPrev}, {turnNext}로 이전/다음 요청으로 건너뛰고, {threadBottom}로 맨 아래로 돌아와요.', wide: true },
  tocli: { title: '언제든 CLI로 전환할 수 있어요', text: '이 버튼을 누르면 지금 대화를 터미널(CLI)에서 그대로 이어가요. 익숙한 CLI 화면이 필요할 때 써 보세요.' },
  stats: { title: '이번 세션의 통계를 볼 수 있어요', text: '토큰, 비용, 도구 사용과 컨텍스트가 어떻게 늘었는지 이 버튼에서 한눈에 확인해요.' },
};

/** A text split into words and keys, for rendering the keys as <kbd>. `key` resolves an id or combo to how it is shown. */
export function guideParts(text: GuideText, key: (name: string) => string): ({ text: string } | { key: string })[] {
  return text.split(/(\{[\w+]+\})/).filter(Boolean).map(part => /^\{[\w+]+\}$/.test(part) ? { key: key(part.slice(1, -1)) } : { text: part });
}
/** The same as plain text (placeholders, titles). */
export const guideLine = (text: GuideText, key: (name: string) => string) => guideParts(text, key).map(part => 'key' in part ? part.key : part.text).join('');

/** The start screen's short list. `insert`: clicking the line puts this in the message box. `slash`: the command it is about, so it drops out once this user ran it.
 *  `agents`: only for these CLIs. Lines that are the same idea for another feature (worktree, per-turn changes, sending a selection, reverting files) go here too. */
export type DiscoverItem = { id: string; text: GuideText; insert?: string; slash?: string; agents?: string[] };
export const DISCOVER: DiscoverItem[] = [
  { id: 'btw', text: '/btw 질문: 작업을 멈추지 않고 곁가지 질문하기', insert: '/btw ', slash: 'btw' },
  { id: 'shell', text: '!명령: 이 폴더에서 셸 명령을 바로 실행하고 결과를 다음 메시지에 붙이기', insert: '!' },
  { id: 'send', text: '{mod+shift+l}: 편집기·터미널·diff에서 고른 내용을 이 채팅 입력창으로' },
  { id: 'resume', text: '/resume: 이 프로젝트의 이전 대화 이어가기', insert: '/resume', slash: 'resume' },
  { id: 'queue', text: '응답 중에 Enter는 끼워 넣기, Tab은 끝난 뒤 보내기' },
  { id: 'turns', text: '{turnPrev} {turnNext} 요청 사이 이동, {find} 대화 안 찾기' },
  { id: 'copy', text: '{copyAnswer} 마지막 답변 복사, {copyCode} 마지막 코드 블록 복사' },
  { id: 'stats', text: '/stats: 토큰·비용·도구 사용 통계', insert: '/stats', slash: 'stats', agents: ['claude'] },
  { id: 'keys', text: '{mod+slash}: 모든 단축키 한눈에 보기, {mod+alt+c}: 어디서든 채팅 입력창으로' },
];
export const DISCOVER_SHOWN = 3;
/** The lines for this chat: the ones about a command this user already ran drop out, then the first few. */
export const discoverFor = (agent: string, recent: readonly string[], items = DISCOVER, max = DISCOVER_SHOWN) =>
  items.filter(item => (!item.agents || item.agents.includes(agent)) && !(item.slash && recent.includes(item.slash))).slice(0, max);

/** The message box's placeholder for where the chat is: a steady line while it answers (what Enter, Tab and Esc do now), the stash when one is kept, and when idle
 *  one feature line that changes with each finished turn (never the same line twice in a row, never while typing). Tips off: only the plain defaults. */
export type PlaceholderInput = { oneLine: boolean; busy: boolean; stash: boolean; foldIn: boolean; agent: string; modSend: boolean; tips: boolean; turns: number };
export const IDLE_LINES: GuideText[] = [
  '!명령으로 셸 실행, /btw 곁가지 질문, ↑ 이전 메시지',
  '{turnPrev} {turnNext} 이전/다음 요청, {find} 대화 안 찾기',
  '{copyAnswer} 마지막 답변 복사, {stash} 입력 임시 보관',
  '{mod+shift+l} 편집기·터미널에서 고른 내용 보내기, {mod+slash} 단축키 한눈에 보기',
];
export function composerPlaceholder(input: PlaceholderInput, key: (name: string) => string): string {
  const send = input.modSend ? 'Cmd/Ctrl+Enter' : 'Enter';
  if (input.oneLine && input.busy && !input.stash) return input.foldIn ? '응답 중, 입력해 끼워 넣기' : input.agent === 'cursor' ? '응답을 끊고 바로 보내기' : '응답이 끝나면 순서대로 보냅니다';
  if (input.stash) return `보관된 입력이 있습니다 (${key('stash')}로 복원)`;
  if (input.busy) return input.foldIn ? `${send}: 지금 끼워 넣기, Tab: 끝난 뒤 보내기, Esc: 중단` : input.agent === 'cursor' ? 'Enter: 응답을 끊고 바로 보내기, Tab: 끝난 뒤 보내기, Esc: 중단' : '응답이 끝난 뒤 순서대로 전송합니다';
  if (!input.tips || input.turns === 0) return '작업을 설명하거나 질문하세요, !명령으로 셸 실행';
  return guideLine(IDLE_LINES[(input.turns - 1) % IDLE_LINES.length], key);
}

/** The cold-cache question before a send can also turn on the compact that prevents it next time (/idlecompact on), when it is off for this chat and tips are on. */
export const idleCompactOffer = ({ agent, tips, idleCompactOn }: { agent: string; tips: boolean; idleCompactOn: boolean | undefined }) => agent === 'claude' && tips && idleCompactOn !== true;
