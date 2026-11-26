// Keyboard rules of a chat pane that are not tied to the composer's own editing: the keys that answer an approval, plan or question card, and the keys that move
// through the conversation (previous/next request, top/bottom, find, copy). Pure (no DOM, no React) so node tests load it; ChatKeys.tsx wires it to the pane.
import { processGroups, type Block, type Item } from './chat-model.ts';

/** A card that just appeared (or whose pane was just brought up) ignores the approving keys this long, so a key meant for what was there before cannot answer it. */
export const CARD_GRACE_MS = 300;

export type KeyLike = { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat?: boolean };
/** allow: 허용 / 승인 / 답변 보내기. allowMore: 이 세션에서 허용 / (plan) 편집 허용으로 승인. more: the ▾ menu / (plan) 수정 요청. deny: Esc. enter: Tab from nowhere puts focus in the card. */
export type CardAction = 'allow' | 'allowMore' | 'more' | 'deny' | 'enter';
/** Where the key was pressed, seen from the pane that shows the card: nowhere (body, the composer just hid), on the pane's own non-text controls, inside the plan's large-view dialog, in a text field, or somewhere else. */
export type KeyPlace = 'body' | 'pane' | 'modal' | 'field' | 'outside';

const bare = (event: KeyLike) => !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

/** The card action of a key press. `is` matches a chat key id against the user's binding (shortcuts.ts `matches`). Plain Enter is never one of them. */
export function cardKeyAction(event: KeyLike, is: (id: 'cardAllow' | 'cardAllowMore' | 'cardMore') => boolean): CardAction | null {
  if (event.key === 'Enter' && bare(event)) return null;
  if (is('cardAllowMore')) return 'allowMore';
  if (is('cardAllow')) return 'allow';
  if (is('cardMore')) return 'more';
  if (event.key === 'Escape' && bare(event)) return 'deny';
  if (event.key === 'Tab' && bare(event)) return 'enter';
  return null;
}

/** Whether the action may run: never on a held-down key (auto-repeat), never from a text field or another pane, and an approving key not within the grace period.
 *  In the plan's dialog Esc closes the dialog (its own behaviour), so it is not a refusal there; Tab only jumps in from nowhere (elsewhere it moves focus as usual). */
export function cardKeyAllowed(action: CardAction, place: KeyPlace, { now, shownAt, repeat }: { now: number; shownAt: number; repeat?: boolean }): boolean {
  if (repeat || place === 'field' || place === 'outside') return false;
  if (action === 'deny') return place !== 'modal';
  if (action === 'enter') return place === 'body';
  return now - shownAt >= CARD_GRACE_MS;
}

export type ThreadAction = 'turnPrev' | 'turnNext' | 'top' | 'bottom' | 'find' | 'copyAnswer' | 'copyCode' | 'pageUp' | 'pageDown';
const THREAD_KEYS = ['turnPrev', 'turnNext', 'threadTop', 'threadBottom', 'find', 'copyAnswer', 'copyCode'] as const;
export type ThreadKeyId = typeof THREAD_KEYS[number];
/** The conversation action of a key press (bindable ids via `is`, plus plain PageUp/PageDown). */
export function threadKeyAction(event: KeyLike, is: (id: ThreadKeyId) => boolean): ThreadAction | null {
  const id = THREAD_KEYS.find(is);
  if (id) return id === 'threadTop' ? 'top' : id === 'threadBottom' ? 'bottom' : id;
  if ((event.key === 'PageUp' || event.key === 'PageDown') && bare(event)) return event.key === 'PageUp' ? 'pageUp' : 'pageDown';
  return null;
}

/** In the message box the text's own editing comes first: Ctrl+Home/End move the caret while there is text, ⌥↑/↓ move by paragraph on a Mac while there is text,
 *  and PageUp/PageDown scroll the box itself once it has a scrollbar. Otherwise the key moves the conversation. */
export function threadKeyInComposer(action: ThreadAction, { empty, mac, overflow }: { empty: boolean; mac: boolean; overflow: boolean }): boolean {
  if (action === 'top' || action === 'bottom') return empty;
  if (action === 'turnPrev' || action === 'turnNext') return empty || !mac;
  if (action === 'pageUp' || action === 'pageDown') return !overflow;
  return true;
}

/** The request to jump to. `tops`: each request's top, relative to the top of the visible thread, oldest first. A request above the edge (or the one the reader is
 *  inside) is "previous"; one below it is "next". `from`: the request of the last jump when keys come faster than the smooth scroll, so each press moves one on. null: none that way. */
export function turnJumpTarget(tops: readonly number[], dir: -1 | 1, from?: number | null, slack = 12): number | null {
  if (from != null && from >= 0 && from < tops.length) { const at = from + dir; return at >= 0 && at < tops.length ? at : null; }
  if (dir < 0) { for (let at = tops.length - 1; at >= 0; at--) if (tops[at] < -slack) return at; return null; }
  for (let at = 0; at < tops.length; at++) if (tops[at] > slack) return at;
  return null;
}

/** The answer of a turn, the same text its "응답 복사" button copies: the plain text after the last process (tools, thinking), else the last main assistant message's text. */
export function turnAnswer(turn: readonly Item[], agentIds: ReadonlySet<string> = new Set()): string {
  const flat: { block: Block; sub: boolean }[] = [];
  let last: Extract<Item, { kind: 'assistant' }> | undefined;
  for (const item of turn) {
    if (item.kind !== 'assistant') continue;
    if (!item.sub) last = item;
    if (item.parent && agentIds.has(item.parent)) continue;
    for (const block of item.blocks) if (block.type === 'tool_use' || ((block.type === 'text' || block.type === 'thinking') && block.text.trim())) flat.push({ block, sub: Boolean(item.sub) });
  }
  const { plain } = processGroups(flat), cut = plain.lastIndexOf(false) + 1;
  const texts = (blocks: Block[]) => blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n');
  return texts(flat.slice(cut).map(entry => entry.block)) || (last ? texts(last.blocks) : '');
}

/** The newest answer that has text, newest turn first (a turn still running counts once it has said something). */
export function lastAnswer(turns: readonly (readonly Item[])[], agentIds?: ReadonlySet<string>): string {
  for (let at = turns.length - 1; at >= 0; at--) { const text = turnAnswer(turns[at], agentIds); if (text.trim()) return text; }
  return '';
}

/** Everything the main agent wrote in a turn (not its subagents), for finding code in it. */
export const turnText = (turn: readonly Item[]) => turn.flatMap(item => item.kind === 'assistant' && !item.sub ? item.blocks.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join('\n\n');
/** The newest fenced code block the agent wrote, newest turn first. */
export function lastCode(turns: readonly (readonly Item[])[]): string {
  for (let at = turns.length - 1; at >= 0; at--) { const code = lastCodeBlock(turnText(turns[at])); if (code.trim()) return code; }
  return '';
}

/** The body of the last fenced code block of a Markdown text (``` or ~~~, any length of three or more), or '' when there is none. An unclosed fence runs to the end. */
export function lastCodeBlock(text: string): string {
  const lines = text.split('\n');
  let open: { mark: string; start: number } | null = null, found = '';
  for (let at = 0; at < lines.length; at++) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[at]);
    if (!open) { if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) open = { mark: fence[1], start: at + 1 }; continue; }
    if (fence && fence[1][0] === open.mark[0] && fence[1].length >= open.mark.length && !fence[2].trim()) { found = lines.slice(open.start, at).join('\n'); open = null; }
  }
  return open ? lines.slice(open.start).join('\n') : found;
}
