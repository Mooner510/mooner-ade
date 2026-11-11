// Feedback inbox ("피드백 창고"): types shared with the local server (FEEDBACK_CONTRACT section C) and the pure rules and geometry the UI uses.
// No DOM or React here, so tests/feedback-model.test.mjs can bundle and run it in node.

export type FeedbackSource = 'human' | 'ai' | 'agent';
export type FeedbackStatus = 'draft' | 'review' | 'drafting' | 'queued' | 'submitting' | 'submitted' | 'failed';
export interface FeedbackImage { name: string; w: number; h: number; annotated: boolean }
export interface Feedback {
  id: string; title: string; body: string; source: FeedbackSource; status: FeedbackStatus;
  reviewed: boolean; images: FeedbackImage[]; createdAt: number; updatedAt: number;
  issueUrl?: string; issueNumber?: number;
  // While queued, `error` is the last refused attempt's message; after `failed`, why it ended.
  error?: string;
  // Server-side send queue: when it was queued, when it may be tried next (ms epoch), how many tries so far, and how it went out.
  queuedAt?: number; nextAttemptAt?: number; attempts?: number; via?: 'account' | 'anonymous';
}
// mode: 'account' = sent with the signed-in remote-access login; 'anonymous' = no login, at most one per 5 minutes from this install.
export interface FeedbackAvailability { ok: boolean; mode?: 'account' | 'anonymous'; account?: string; reason?: string }
export interface FeedbackQueue { size: number; nextAt?: number }

export const MAX_IMAGES = 10;
export const MAX_TITLE = 120;
export const MAX_BODY_BYTES = 65536;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const statusLabels: Record<FeedbackStatus, string> = {
  draft: '작성 중', review: '검토 필요', drafting: 'AI 작성 중', queued: '전송 대기', submitting: '전송 중', submitted: '제출됨', failed: '제출 실패'
};
export const sourceLabels: Record<FeedbackSource, string> = { human: '직접 작성', ai: 'AI 초안', agent: '에이전트 초안' };

// Title, body and images can only change in these states (the server refuses edits while drafting, queued, submitting and after submit).
export const isEditable = (item: Pick<Feedback, 'status'>) => item.status === 'draft' || item.status === 'review' || item.status === 'failed';
// An AI or agent draft that no human has opened yet.
export const needsReview = (item: Pick<Feedback, 'source' | 'reviewed'>) => item.source !== 'human' && !item.reviewed;
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
  if (!item.title.trim()) return no('제목을 입력하세요.');
  if (item.title.trim().length > MAX_TITLE) return no(`제목은 ${MAX_TITLE}자 이하로 입력하세요.`);
  if (!item.body.trim()) return no('본문을 입력하세요.');
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
  if (available.mode === 'anonymous') return '익명 제출 (이 기기에서 5분에 1건씩 자동 전송)';
  return available.account ? `${available.account} 계정으로 제출` : '계정으로 제출';
}

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
