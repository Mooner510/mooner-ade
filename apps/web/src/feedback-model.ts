// Feedback requests ("피드백 요청"): types shared with the local server (FEEDBACK_CONTRACT section C) and the pure rules and geometry the UI uses.
// No DOM or React here, so tests/feedback-model.test.mjs can bundle and run it in node.

export type FeedbackSource = 'human' | 'ai' | 'agent';
export type FeedbackStatus = 'draft' | 'review' | 'drafting' | 'queued' | 'submitting' | 'submitted' | 'failed';
export interface FeedbackImage { name: string; w: number; h: number; annotated: boolean }
export interface Feedback {
  id: string; title: string; body: string; types: string[]; source: FeedbackSource; status: FeedbackStatus;
  reviewed: boolean; images: FeedbackImage[]; createdAt: number; updatedAt: number;
  issueNumber?: number;
  // While queued, `error` is the last refused attempt's message; after `failed`, why it ended.
  error?: string;
  // Server-side send queue: when it was queued, when it may be tried next (ms epoch), how many tries so far, and how it went out.
  queuedAt?: number; nextAttemptAt?: number; attempts?: number; via?: 'account' | 'anonymous';
  // How far a submitted item has come, from the Hub (docs/FEEDBACK_STATUS.md). Absent until the Hub has answered: the item then just reads "제출됨".
  progress?: FeedbackProgress;
}
export type ProgressState = 'pending' | 'beta' | 'released' | 'closed' | 'declined';
// `inApp`: this app's own version already has the fix (undefined when not known). `news`: changed since the person last looked.
// `comments`: what the maintainers answered on this feedback, oldest first (no author is known: only when and what). `stateNews` / `commentNews`: which of the two changed (`news` is either).
export interface FeedbackComment { at: string; body: string }
export interface FeedbackProgress { state: ProgressState; version?: string; inApp?: boolean; news: boolean; stateNews?: boolean; commentNews?: boolean; comments?: FeedbackComment[]; checkedAt?: number; changedAt?: number }
// mode: 'account' = sent with the signed-in remote-access login; 'anonymous' = no login, at most one per 5 minutes from this install.
export interface FeedbackAvailability { ok: boolean; mode?: 'account' | 'anonymous'; account?: string; reason?: string }
export interface FeedbackQueue { size: number; nextAt?: number }
// What the server knows about asking the Hub: when it last got an answer; `unsupported`: this Hub has no status endpoint (only "제출됨" is shown); `off`: switched off.
export interface FeedbackProgressInfo { checkedAt?: number; unsupported?: boolean; off?: boolean }

export const MAX_IMAGES = 10;
export const MAX_TITLE = 120;
// The AI pickers offer Haiku 5.5 / Sonnet 5.5 / Opus 5.5 and low / medium only. Older saved values (aliases, '' = Claude Code's own, high) map to the nearest allowed one.
export const feedbackModelId = (value: string | undefined) => value === 'sonnet' || value === 'claude-sonnet-5-5' ? 'claude-sonnet-5-5' : value === 'opus' || value === 'claude-opus-5-5' ? 'claude-opus-5-5' : 'claude-haiku-5-5';
export const feedbackEffort = (value: string | undefined) => value === 'medium' ? 'medium' : 'low';
// A title is optional: without one the first line of the text stands in (the server does the same when submitting).
export const displayTitle = (item: Pick<Feedback, 'title' | 'body'>) => item.title.trim() || item.body.split('\n').map(line => line.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean)?.slice(0, MAX_TITLE) || '';
export const MAX_BODY_BYTES = 65536;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const statusLabels: Record<FeedbackStatus, string> = {
  draft: '작성 중', review: '검토 필요', drafting: 'AI 작성 중', queued: '전송 대기', submitting: '전송 중', submitted: '제출됨', failed: '제출 실패'
};
export const sourceLabels: Record<FeedbackSource, string> = { human: '직접 작성', ai: 'AI 작성', agent: '에이전트 초안' };

// The list's filter chips: what still needs the user, what is on its way, what is done.
export type FeedbackGroup = 'todo' | 'sending' | 'done';
export const groupLabels: Record<FeedbackGroup, string> = { todo: '처리 필요', sending: '진행 중', done: '제출됨' };
export const feedbackGroup = (item: Pick<Feedback, 'status'>): FeedbackGroup =>
  item.status === 'submitted' ? 'done' : item.status === 'drafting' || item.status === 'queued' || item.status === 'submitting' ? 'sending' : 'todo';
// "방금 · 5분 전 · 3시간 전 · 어제 · 11월 3일" for the list rows.
export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`;
  if (minutes < 2880) return '어제';
  return new Date(at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
}

// ---- progress after submitting (대기 → beta 반영 → 릴리스 반영) ----
export const progressLabels: Record<ProgressState, string> = { pending: '대기', beta: 'beta 반영', released: '릴리스 반영', closed: '처리됨', declined: '반영하지 않음' };
const isPre = (version: string) => /^v?\d+\.\d+\.\d+-/.test(version);
const shownVersion = (version: string) => `v${version.replace(/^v/, '')}`;
/** The badge on a submitted item: its words and tone. null when the Hub has not said anything (the item stays "제출됨"). */
export function progressBadge(progress: FeedbackProgress | undefined): { text: string; tone: 'wait' | 'beta' | 'done' | 'muted' | 'declined' } | null {
  if (!progress) return null;
  const v = progress.version ? ` ${shownVersion(progress.version)}` : '';
  switch (progress.state) {
    case 'pending': return { text: progressLabels.pending, tone: 'wait' };
    case 'beta': return { text: `${progressLabels.beta}${v}`, tone: 'beta' };
    // A beta's fix that a stable release has since taken in: the stable number is not known here, the version it was fixed in is.
    case 'released': return { text: progress.version && isPre(progress.version) ? `${progressLabels.released} (${shownVersion(progress.version)}부터)` : `${progressLabels.released}${v}`, tone: 'done' };
    case 'closed': return { text: progressLabels.closed, tone: 'muted' };
    // 처리됨(closed, 회색)과 한눈에 갈리도록 반영하지 않음은 붉은 계열 + ✕ 표시.
    default: return { text: progressLabels.declined, tone: 'declined' };
  }
}
/** Whether the running app already has the change: a sentence for the detail view, '' when that is not known or not a fix. */
export function progressInApp(progress: FeedbackProgress | undefined, appVersion?: string): string {
  if (!progress?.version || (progress.state !== 'beta' && progress.state !== 'released')) return '';
  const mine = appVersion ? `(v${appVersion})` : '';
  if (progress.inApp === true) return `지금 쓰는 버전${mine}에 이미 반영되어 있습니다.`;
  if (progress.inApp === false) return `지금 쓰는 버전${mine}에는 아직 없습니다. ${shownVersion(progress.version)} 이상으로 업데이트하면 반영됩니다.`;
  return '';
}
/** Submitted items whose progress changed since the person last looked. */
export const progressNews = <T extends Pick<Feedback, 'status' | 'progress'>>(items: T[]): T[] => items.filter(item => item.status === 'submitted' && item.progress?.news === true);
/** The one-line toast for news ('' when there is none): one item says what happened, several say how many. */
export function progressNewsText(items: Pick<Feedback, 'issueNumber' | 'progress'>[]): string {
  if (!items.length) return '';
  if (items.length > 1) return `제출한 피드백 ${items.length}건의 처리 상태나 답변이 바뀌었어요`;
  const [item] = items, badge = progressBadge(item.progress), name = item.issueNumber ? `피드백 #${item.issueNumber}` : '제출한 피드백';
  if (item.progress?.commentNews && !item.progress.stateNews) return `${name}에 답변이 달렸어요`;
  const state = badge ? `${name}: ${badge.text}` : `${name}의 처리 상태가 바뀌었어요`;
  return item.progress?.commentNews ? `${state}, 답변도 달렸어요` : state;
}
/**
 * News is told once per change: a function that is given the list each time it loads and returns the toast text for what it has not told yet ('' if nothing).
 * Items the person already opened carry `news: false`, so they never come back; a later change (beta → released) is a new announcement.
 */
export function progressAnnouncer() {
  const told = new Set<string>(), key = (item: Pick<Feedback, 'id' | 'progress'>) => `${item.id}:${item.progress?.state}:${item.progress?.version ?? ''}:${item.progress?.comments?.length ?? 0}`;
  return (items: Pick<Feedback, 'id' | 'status' | 'issueNumber' | 'progress'>[]): string => {
    const fresh = progressNews(items).filter(item => !told.has(key(item)));
    for (const item of fresh) told.add(key(item));
    return progressNewsText(fresh);
  };
}

// Title, body and images can only change in these states (the server refuses edits while drafting, queued, submitting and after submit).
export const isEditable = (item: Pick<Feedback, 'status'>) => item.status === 'draft' || item.status === 'review' || item.status === 'failed';
// An AI or agent draft that no human has opened yet.
export const needsReview = (item: Pick<Feedback, 'source' | 'reviewed'>) => item.source !== 'human' && !item.reviewed;
// Request types ("유형"): several can be picked. They are stored on the item (`types`); on submit the Hub labels the issue `type:<id>` and the title gets
// the tags in front ("[버그][성능] 제목"). Same ids and tags as FEEDBACK_TYPES in the server's feedback-store.js (tests/feedback-model.test.mjs keeps them equal).
export const feedbackTypes = [
  { id: 'bug', tag: '버그', icon: 'alert' }, { id: 'feature', tag: '제안', icon: 'sparkles' }, { id: 'pain', tag: '불편', icon: 'tune' }, { id: 'perf', tag: '성능', icon: 'clock' },
  { id: 'design', tag: '디자인', icon: 'palette' }, { id: 'question', tag: '질문', icon: 'chat' }, { id: 'praise', tag: '칭찬', icon: 'check' }
] as const;
// `types` with `id` switched on or off, in the table's order.
export const toggleType = (types: string[], id: string) => feedbackTypes.map(type => type.id).filter(known => known === id ? !types.includes(id) : types.includes(known));
export const typeTag = (id: string) => feedbackTypes.find(type => type.id === id)?.tag ?? '';
// A human draft with no title, text or images is nothing worth keeping: leaving it removes it instead of saving it (types alone are not content).
export const isEmptyDraft = (item: Pick<Feedback, 'status' | 'source' | 'title' | 'body' | 'images'>) => item.status === 'draft' && item.source === 'human' && !item.title.trim() && !item.body.trim() && !item.images.length;
// Agent-injected drafts waiting in the inbox: the status-bar badge counts these.
export const pendingReviewCount = (items: Pick<Feedback, 'status' | 'reviewed'>[]) => items.filter(item => item.status === 'review' && !item.reviewed).length;

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

export function canSubmit(item: Pick<Feedback, 'title' | 'body' | 'source' | 'status' | 'reviewed' | 'images'>, available: FeedbackAvailability | null | undefined): { ok: boolean; reason: string } {
  const no = (reason: string) => ({ ok: false, reason });
  if (item.status === 'drafting') return no('AI가 초안을 작성하는 중입니다.');
  if (item.status === 'queued') return no('이미 전송 대기 중입니다.');
  if (item.status === 'submitting') return no('전송하는 중입니다.');
  if (item.status === 'submitted') return no('이미 제출한 피드백입니다.');
  if (!isEditable(item)) return no('지금은 제출할 수 없습니다.');
  if (needsReview(item)) return no('AI가 쓴 초안은 먼저 열어서 검토해야 합니다.');
  if (item.title.trim().length > MAX_TITLE) return no(`제목은 ${MAX_TITLE}자 이하로 입력하세요.`);
  if (!item.body.trim()) return no('내용을 입력하세요.');
  if (utf8Length(item.body) > MAX_BODY_BYTES) return no('본문이 너무 깁니다. 64KB 이하로 줄이세요.');
  if (item.images.length > MAX_IMAGES) return no(`이미지는 ${MAX_IMAGES}장까지 보낼 수 있습니다.`);
  if (!available?.ok) return no(available?.reason || '지금은 피드백을 보낼 수 없습니다.');
  return { ok: true, reason: '' };
}

// When a queued item should go out, as Korean text. The head of the queue waits for whichever is later: its own retry time or the
// queue's next slot (which already includes the anonymous 5-minute spacing).
export function queueEta(item: Pick<Feedback, 'status' | 'nextAttemptAt'>, queue: FeedbackQueue | null | undefined, now: number): string {
  if (item.status === 'submitting') return '전송 중';
  const at = Math.max(item.nextAttemptAt ?? 0, queue?.nextAt ?? 0), wait = at - now;
  if (wait < 45_000) return '곧 전송';
  const minutes = Math.round(wait / 60_000);
  if (minutes < 60) return `약 ${minutes}분 뒤 전송`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `약 ${hours}시간${rest ? ` ${rest}분` : ''} 뒤 전송`;
}
// How a submission will be sent, for the confirm dialog and the settings row.
export function submitModeText(available: FeedbackAvailability | null | undefined): string {
  if (!available?.ok) return available?.reason || '지금은 피드백을 보낼 수 없습니다.';
  if (available.mode === 'anonymous') return '로그인 없이 제출';
  return available.account ? `${available.account} 계정으로 제출` : '계정으로 제출';
}
export const submitModeNote = (available: FeedbackAvailability | null | undefined) => available?.ok && available.mode === 'anonymous' ? '이 기기에서 5분에 1건씩 순서대로 자동 전송' : '';

// ---- capture geometry ----
export type Point = { x: number; y: number };
export type Box = { left: number; top: number; width: number; height: number };
export type CaptureRect = { x: number; y: number; width: number; height: number };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const validZoom = (zoom: number) => Number.isFinite(zoom) && zoom > 0 ? zoom : 1;

// The rectangle two drag points span, whichever corner the drag started from.
export function dragRect(a: Point, b: Point): Box {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

// A CSS-px box (getBoundingClientRect, window of `windowSize` CSS px) → the integer DIP rect capturePage takes (CSS px × zoom factor).
// Clamped inside the window and rounded outward so the edge of the element is included; null when nothing is left.
export function captureRect(box: Box, zoom: number, windowSize: { width: number; height: number }): CaptureRect | null {
  const factor = validZoom(zoom);
  const maxX = Math.floor(windowSize.width * factor), maxY = Math.floor(windowSize.height * factor);
  if (![box.left, box.top, box.width, box.height].every(Number.isFinite)) return null;
  const x = clamp(Math.floor(box.left * factor), 0, maxX), y = clamp(Math.floor(box.top * factor), 0, maxY);
  const right = clamp(Math.ceil((box.left + box.width) * factor), 0, maxX), bottom = clamp(Math.ceil((box.top + box.height) * factor), 0, maxY);
  if (right - x < 1 || bottom - y < 1 || box.width <= 0 || box.height <= 0) return null;
  return { x, y, width: right - x, height: bottom - y };
}

// Desktop capture() resolves raw PNG bytes; the server takes base64 without a data: prefix.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
// Decoded size of a base64 string, to check the 8 MiB limit before uploading.
export const base64Bytes = (data: string) => Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);

// ---- annotation ----
export type ShapeKind = 'rect' | 'arrow';
export type Shape = { kind: ShapeKind; color: string; from: Point; to: Point };
export const annotateColors = [{ id: '#ff3b30', label: '빨강' }, { id: '#ffcc00', label: '노랑' }] as const;

// A pointer offset inside the displayed (scaled) image → the same spot in the image's own pixels.
export function toNatural(offset: Point, displayed: { width: number; height: number }, natural: { width: number; height: number }): Point {
  const sx = displayed.width > 0 ? natural.width / displayed.width : 1, sy = displayed.height > 0 ? natural.height / displayed.height : 1;
  return { x: clamp(offset.x, 0, displayed.width) * sx, y: clamp(offset.y, 0, displayed.height) * sy };
}
// Stroke width in image pixels: about the same on screen whether the capture is a small button or a whole 4K window.
export const strokeWidth = (natural: { width: number; height: number }) => clamp(Math.round(Math.max(natural.width, natural.height) / 250), 2, 24);
// The two barb points of an arrowhead at `to`, `size` long, 30° off the shaft.
export function arrowHead(from: Point, to: Point, size: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x), spread = Math.PI / 6;
  const barb = (side: number) => ({ x: to.x - size * Math.cos(angle + side * spread), y: to.y - size * Math.sin(angle + side * spread) });
  return [barb(1), barb(-1)];
}
// A click without a drag draws nothing.
export const shapeTooSmall = (shape: Shape, minimum: number) => Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) < minimum;

// ---- AI draft context ----
export function aiContext(info: { appVersion?: string; project?: string; panes?: string[]; errors?: string[] }): string {
  const lines: string[] = [];
  if (info.appVersion) lines.push(`앱 버전: ${info.appVersion}`);
  if (info.project) lines.push(`현재 프로젝트: ${info.project}`);
  if (info.panes?.length) lines.push(`열린 화면: ${info.panes.join(', ')}`);
  if (info.errors?.length) lines.push('최근 오류:', ...info.errors.map(error => `- ${error.replace(/\s+/g, ' ').slice(0, 300)}`));
  return lines.join('\n');
}
