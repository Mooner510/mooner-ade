// The live side of "선택 영역을 채팅으로 보내기" and of pasting an ADE copy as a reference (the text itself is built in chat-send.ts):
// - sources (editor, diff, terminal, project tree, Git graph) register the element they live in and how to read their selection;
// - chat panes register how to put text in their composer and which folder their paths are relative to;
// - the last copy made in the editor or the project tree is remembered (a hash, not the text) so a chat can paste it as a reference.
import { absolutePath, copyRecord, formatForChat, pickTarget, type CopyRecord, type Roots, type SendPayload, type SourcePath } from './chat-send';
import type { Leaf, Pane } from './api';

/** A short line at the bottom of the window ("nothing selected"); the key did something, so it says what. */
export function sendNote(text: string) {
  document.querySelectorAll('.send-note').forEach(old => old.remove());
  const el = document.body.appendChild(document.createElement('div'));
  el.className = 'send-note'; el.setAttribute('role', 'status'); el.textContent = text;
  setTimeout(() => el.remove(), 2700);
}

// ---- the project on screen ----
// Only the active project's workspace takes keys and shows its panes, so its roots are the ones a copy or a send refers to.
let roots: Roots = { project: '' };
export const setActiveRoots = (next: Roots) => { roots = next; };
export const activeRoots = () => roots;

// ---- selection sources ----
export type SendGet = () => SendPayload | null | Promise<SendPayload | null>;
type Source = { el: HTMLElement; get: SendGet; empty: string; at: number };
const sources = new Set<Source>();
// On screen: not removed, not in a hidden tab or project (display:none leaves no boxes), not in a drawer that is closing.
const shown = (el: HTMLElement) => el.isConnected && el.getClientRects().length > 0 && !el.closest('[inert]');
/**
 * `get` reads what is selected now (null: nothing to send, and `empty` says what to do). The source counts as the one the user means while
 * the focus is inside `el`, and stays the latest one after the focus leaves (the command palette takes it).
 */
export function registerSendSource(el: HTMLElement, get: SendGet, empty = '보낼 내용을 먼저 선택하세요.'): () => void {
  const source: Source = { el, get, empty, at: 0 };
  const touch = () => { source.at = Date.now(); };
  sources.add(source);
  el.addEventListener('focusin', touch); el.addEventListener('pointerdown', touch, true);
  if (el.contains(document.activeElement)) touch();
  return () => { sources.delete(source); el.removeEventListener('focusin', touch); el.removeEventListener('pointerdown', touch, true); };
}
export function currentSendSource(): Pick<Source, 'get' | 'empty'> | null {
  const visible = [...sources].filter(source => shown(source.el));
  const focused = document.activeElement && visible.filter(source => source.el.contains(document.activeElement));
  // The innermost one when sources nest (a diff inside a chat pane).
  if (focused?.length) return focused.sort((a, b) => a.el.contains(b.el) ? 1 : b.el.contains(a.el) ? -1 : 0)[0];
  return visible.filter(source => source.at > 0).sort((a, b) => b.at - a.at)[0] ?? null;
}
/** A context-menu item: send this payload (or what it resolves to) the same way the key does. The active workspace handles it. */
export function requestSendToChat(get: SendGet) { window.dispatchEvent(new CustomEvent('ade:send-to-chat', { detail: { get } })); }

// ---- chats ----
type Chat = { cwd(): string; insert(text: string): void };
const chats = new Map<string, Chat>(), focusTimes = new Map<string, number>();
const pending = new Map<string, { payload: SendPayload; roots: Roots }>();
/** The folder a chat's paths are relative to: the chat's own working folder (a worktree chat's worktree), else the project root. */
export const chatCwd = (id: string, fallback: string) => chats.get(id)?.cwd() || fallback;
export const chatFocusedAt = (id: string) => focusTimes.get(id) ?? 0;
export const noteChatFocus = (id: string) => { focusTimes.set(id, Date.now()); };
export function registerChat(id: string, chat: Chat): () => void {
  chats.set(id, chat);
  const waiting = pending.get(id);
  if (waiting) { pending.delete(id); chat.insert(formatForChat(waiting.payload, waiting.roots, chat.cwd())); }
  return () => { if (chats.get(id) === chat) chats.delete(id); };
}
/** Fills the chat's composer with the payload (never sends). A chat that is not mounted yet (just opened) gets it when it mounts. */
export function deliverToChat(id: string, payload: SendPayload, at: Roots) {
  const chat = chats.get(id);
  if (chat) chat.insert(formatForChat(payload, at, chat.cwd()));
  else pending.set(id, { payload, roots: at });
}

// ---- copies made in ADE ----
let lastCopy: CopyRecord | null = null;
/** The editor or the tree put `text` on the clipboard for these files; a chat that gets the same text pasted inserts the reference. */
export function recordCopy(text: string, ref: { kind: 'file'; file: SourcePath; range?: { start: number; end: number } } | { kind: 'paths'; paths: SourcePath[] }) {
  const at = activeRoots(), abs = (file: SourcePath): SourcePath => ({ path: absolutePath(file, at), base: 'abs', ...(file.folder && { folder: true }) });
  lastCopy = copyRecord(text, ref.kind === 'file' ? { ...ref, file: abs(ref.file) } : { kind: 'paths', paths: ref.paths.map(abs) }, Date.now());
}
// A later copy of other text (anywhere, any app) is caught by the hash when pasting, so nothing has to clear the record.
export const lastCopyRecord = () => lastCopy;

// ---- the command ----
/** What the workspace lends the command: its tabs, where the focus is, how to show a chat and how to open one. */
export type SendHost = {
  tabs(): { id: string; pane: Pane | null }[]; activeTab(): string; focus(): string; roots(): Roots;
  /** Brings the chat's tab forward and focuses its pane (out of another pane's zoom). */
  reveal(tabId: string, chatId: string): void;
  /** No chat in the project: opens one beside the focused pane and returns its id. */
  openChat(): string;
};
const isChat = (leaf: Leaf) => leaf.kind === 'chat';
/**
 * 채팅으로 보내기: reads the payload (`get` from a context menu, else the source the user was in), picks the chat (chat-send.ts
 * pickTarget) or opens one, and fills its composer. Never sends.
 */
export async function sendToChat(host: SendHost, get?: SendGet) {
  const source = get ? { get, empty: '보낼 내용이 없습니다.' } : currentSendSource();
  if (!source) { sendNote('편집기, 터미널, 파일 트리, Git 그래프에서 보낼 부분을 먼저 선택하세요.'); return; }
  const payload = await source.get();
  if (!payload) { sendNote(source.empty); return; }
  const listLeaves = (pane: Pane | null): Leaf[] => !pane ? [] : 'id' in pane ? [pane] : pane.children.flatMap(listLeaves);
  const chats = host.tabs().flatMap(tab => listLeaves(tab.pane).filter(isChat).map(leaf => ({ id: leaf.id, tabId: tab.id, focusedAt: chatFocusedAt(leaf.id) })));
  const target = pickTarget(chats, host.activeTab(), host.focus());
  let id: string;
  if (target) { host.reveal(target.tabId, target.id); id = target.id; } else id = host.openChat();
  deliverToChat(id, payload, host.roots());
}
