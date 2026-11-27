// The thread's side of turn snapshots (apps/local-server/src/chat-snapshots.js): the "이 턴 동안 바뀐 파일" card under a turn's answer, and the lines
// a file Rewind (and its undo) leaves. Pure data; TurnChanges.tsx draws it.
import type { ChatView, Item } from './chat-model';

export type TurnFile = { path: string; original?: string; status: 'A' | 'M' | 'D' | 'R'; add?: number; del?: number; binary?: boolean };
// `to`: the end snapshot (Rewind restores it when `chat` is the chat on screen: a Branch copies its parent's records); `from`: the start snapshot (the card's diffs). `files` is capped by the server (`count` is the whole number).
export type TurnChanges = { seq: number; chat?: string; from?: string; to?: string; files: TurnFile[]; count: number; add: number; del: number; failed?: string; startFailed?: string; moved?: boolean };
export type FileRewindItem = Extract<Item, { kind: 'file_rewind' }>;
export type FileRewindData = { seq: number; undo?: number; undone?: boolean; restored: string[]; restoredMore: number; removed: string[]; removedMore: number; failed: { path: string; message: string }[]; failedCount: number; skipped: string[] };

const STATUSES = new Set(['A', 'M', 'D', 'R']);
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const count = (value: unknown) => Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : 0;
const HASH = /^[0-9a-f]{40,64}$/;

export function turnChangesOf(event: any): TurnChanges {
  const files: TurnFile[] = (Array.isArray(event.files) ? event.files : []).flatMap((file: any) => typeof file?.path === 'string' && STATUSES.has(file.status)
    ? [{ path: file.path, status: file.status, ...(typeof file.original === 'string' && { original: file.original }), ...(file.binary === true ? { binary: true } : { add: count(file.add), del: count(file.del) }) }] : []);
  return { seq: Number(event.seq) || 0, ...(typeof event.chat === 'string' && { chat: event.chat }), ...(typeof event.from === 'string' && HASH.test(event.from) && { from: event.from }), ...(typeof event.to === 'string' && HASH.test(event.to) && { to: event.to }),
    files, count: Math.max(count(event.count), files.length), add: count(event.add), del: count(event.del),
    ...(typeof event.failed === 'string' && { failed: event.failed }), ...(typeof event.startFailed === 'string' && { startFailed: event.startFailed }), ...(event.moved === true && { moved: true }) };
}

// A turn's record lands on the answer that closed it (found by message id, else uuid). A record whose answer is gone (cut off the stored tail, rewound) is dropped.
export function attachTurnChanges(view: ChatView, event: any): ChatView {
  const messageId = typeof event.messageId === 'string' ? event.messageId : '', uuid = typeof event.uuid === 'string' ? event.uuid : '';
  if (!messageId && !uuid) return view;
  let at = -1;
  for (let i = view.items.length - 1; i >= 0; i--) { const item = view.items[i]; if (item.kind === 'assistant' && ((messageId && item.id === messageId) || (uuid && item.uuid === uuid))) { at = i; break; } }
  if (at < 0) return view;
  const items = [...view.items], item = items[at] as Extract<Item, { kind: 'assistant' }>;
  items[at] = { ...item, changes: turnChangesOf(event) };
  return { ...view, items };
}

export function fileRewindOf(event: any): FileRewindData {
  const failed = (Array.isArray(event.failed) ? event.failed : []).flatMap((item: any) => typeof item?.path === 'string' ? [{ path: item.path, message: String(item.message ?? '') }] : []);
  return { seq: Number(event.seq) || 0, ...(Number.isSafeInteger(event.undo) && { undo: event.undo }), restored: strings(event.restored), restoredMore: count(event.restoredMore), removed: strings(event.removed), removedMore: count(event.removedMore),
    failed, failedCount: Math.max(count(event.failedCount), failed.length), skipped: strings(event.skipped) };
}
// A restore and its undo are lines in the thread; an undo also marks the restore it took back, whose undo button then goes.
export function applyFileRewind(view: ChatView, event: any, key: string, fresh: boolean): ChatView {
  const data = fileRewindOf(event);
  const items = data.undo === undefined ? view.items : view.items.map(item => item.kind === 'file_rewind' && item.seq === data.undo ? { ...item, undone: true } : item);
  return { ...view, items: [...items, { kind: 'file_rewind', key, fresh, ...data } as Item].slice(-2000) };
}

/** The line a restore leaves: what it did, in numbers. */
export function fileRewindLine(item: FileRewindData): string {
  const restored = item.restored.length + item.restoredMore, removed = item.removed.length + item.removedMore;
  const what = [restored && `복원 ${restored}개`, removed && `삭제 ${removed}개`].filter(Boolean).join(', ');
  const head = item.undo !== undefined ? '파일 되돌리기를 취소했습니다' : '파일을 이 시점으로 되돌렸습니다';
  if (!restored && !removed && !item.failedCount) return `${head}. 바뀐 파일이 없었습니다.`;
  return `${head}${what ? ` (${what})` : ''}${item.failedCount ? `. ${item.failedCount}개는 되돌리지 못했습니다` : ''}.`;
}

export const turnChangeSummary = (changes: TurnChanges) => `이 턴 동안 바뀐 파일 ${changes.count}개`;
export const statusLabel: Record<TurnFile['status'], string> = { A: '추가', M: '수정', D: '삭제', R: '이름 변경' };

// The editor's diff tab for one file of a turn: `diff:turn@<chat id>@<start>..<end>:<path>[\t<old path>]` (git-graph.ts loadSpec reads it).
export const turnDiffSpec = (chatId: string, changes: Pick<TurnChanges, 'from' | 'to'>, file: Pick<TurnFile, 'path' | 'original'>) =>
  `diff:turn@${chatId}@${changes.from ?? ''}..${changes.to ?? ''}:${file.path}${file.original ? `\t${file.original}` : ''}`;
export function parseTurnRevision(rev: string): { chat: string; from: string | null; to: string } | null {
  const match = /^turn@([A-Za-z0-9-]{1,128})@([0-9a-f]{40,64})?\.\.([0-9a-f]{40,64})$/.exec(rev);
  return match ? { chat: match[1], from: match[2] ?? null, to: match[3] } : null;
}
