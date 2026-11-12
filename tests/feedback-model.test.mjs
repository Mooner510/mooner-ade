import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
const resolveDir = fileURLToPath(new URL('../apps/web/src', import.meta.url));

async function load(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ade-feedback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'feedback.cjs');
  await build({ stdin: { contents: `export * from './feedback-model';`, resolveDir, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile });
  return require(outfile);
}

const item = (patch = {}) => ({ id: 'f1', title: '버튼이 안 눌림', body: '설정 창에서 저장 버튼이 반응하지 않습니다.', source: 'human', status: 'draft', reviewed: true, images: [], createdAt: 1, updatedAt: 1, ...patch });
const image = n => ({ name: `img-${n}.png`, w: 10, h: 10, annotated: false });

test('canSubmit: title, body, images, review, status and availability', async t => {
  const { canSubmit, needsReview, isEditable, pendingReviewCount, statusLabels } = await load(t);
  const ok = { ok: true, account: 'me' };
  assert.deepEqual(canSubmit(item(), ok), { ok: true, reason: '' });
  assert.equal(canSubmit(item({ images: [image(1)] }), ok).ok, true);
  assert.equal(canSubmit(item({ title: '  ' }), ok).ok, true); // the title is optional
  assert.match(canSubmit(item({ title: 'x'.repeat(121) }), ok).reason, /120자/);
  assert.match(canSubmit(item({ body: '\n ' }), ok).reason, /내용/);
  assert.match(canSubmit(item({ body: '가'.repeat(22000) }), ok).reason, /64KB/); // 66 000 bytes in UTF-8
  assert.match(canSubmit(item({ images: Array.from({ length: 11 }, (_, i) => image(i)) }), ok).reason, /10장/);
  assert.equal(canSubmit(item({ images: Array.from({ length: 10 }, (_, i) => image(i)) }), ok).ok, true);
  // AI/agent drafts must be opened by a human first.
  assert.match(canSubmit(item({ source: 'ai', reviewed: false, status: 'review' }), ok).reason, /검토/);
  assert.match(canSubmit(item({ source: 'agent', reviewed: false, status: 'review' }), ok).reason, /검토/);
  assert.equal(canSubmit(item({ source: 'agent', reviewed: true, status: 'review' }), ok).ok, true);
  assert.equal(canSubmit(item({ status: 'failed' }), ok).ok, true);
  assert.equal(canSubmit(item(), { ok: true, mode: 'anonymous' }).ok, true);
  for (const status of ['drafting', 'queued', 'submitting', 'submitted']) assert.equal(canSubmit(item({ status }), ok).ok, false, status);
  assert.deepEqual(canSubmit(item(), { ok: false, reason: '원격 접속에 로그인하지 않았습니다' }), { ok: false, reason: '원격 접속에 로그인하지 않았습니다' });
  assert.equal(canSubmit(item(), { ok: false }).ok, false);
  assert.equal(canSubmit(item(), null).ok, false);
  assert.ok(needsReview({ source: 'ai', reviewed: false }) && !needsReview({ source: 'human', reviewed: false }));
  assert.ok(isEditable({ status: 'review' }) && !isEditable({ status: 'submitted' }) && !isEditable({ status: 'queued' }));
  assert.equal(statusLabels.queued, '전송 대기');
  assert.equal(statusLabels.submitting, '전송 중');
  assert.equal(pendingReviewCount([item({ status: 'review', reviewed: false }), item({ status: 'review', reviewed: true }), item({ status: 'draft', reviewed: false })]), 1);
  assert.equal(statusLabels.submitted, '제출됨');
});

test('captureRect: zoom, clamping and empty rects', async t => {
  const { captureRect, dragRect } = await load(t);
  const win = { width: 1000, height: 800 };
  assert.deepEqual(captureRect({ left: 10, top: 20, width: 100, height: 50 }, 1, win), { x: 10, y: 20, width: 100, height: 50 });
  // DIP = CSS px × zoom factor; fractional edges round outward.
  assert.deepEqual(captureRect({ left: 10.5, top: 20.6, width: 100, height: 50 }, 1.25, win), { x: 13, y: 25, width: 126, height: 64 });
  assert.deepEqual(captureRect({ left: -50, top: -10, width: 100, height: 40 }, 1, win), { x: 0, y: 0, width: 50, height: 30 });
  assert.deepEqual(captureRect({ left: 950, top: 780, width: 200, height: 200 }, 1.5, win), { x: 1425, y: 1170, width: 75, height: 30 });
  assert.deepEqual(captureRect({ left: 0, top: 0, width: 1000, height: 800 }, 0.8, win), { x: 0, y: 0, width: 800, height: 640 });
  assert.equal(captureRect({ left: 1200, top: 10, width: 50, height: 50 }, 1, win), null);
  assert.equal(captureRect({ left: 10, top: 10, width: 0, height: 50 }, 1, win), null);
  assert.equal(captureRect({ left: NaN, top: 10, width: 5, height: 5 }, 1, win), null);
  assert.deepEqual(captureRect({ left: 1, top: 1, width: 2, height: 2 }, 0, win), { x: 1, y: 1, width: 2, height: 2 }); // bad zoom → 1
  assert.deepEqual(dragRect({ x: 50, y: 10 }, { x: 20, y: 40 }), { left: 20, top: 10, width: 30, height: 30 });
  assert.deepEqual(dragRect({ x: 5, y: 5 }, { x: 5, y: 5 }), { left: 5, top: 5, width: 0, height: 0 });
});

test('annotation geometry and base64', async t => {
  const { toNatural, strokeWidth, arrowHead, shapeTooSmall, bytesToBase64, base64Bytes, aiContext } = await load(t);
  assert.deepEqual(toNatural({ x: 50, y: 25 }, { width: 100, height: 50 }, { width: 400, height: 200 }), { x: 200, y: 100 });
  assert.deepEqual(toNatural({ x: 150, y: -5 }, { width: 100, height: 50 }, { width: 400, height: 200 }), { x: 400, y: 0 });
  assert.equal(strokeWidth({ width: 100, height: 80 }), 2);
  assert.equal(strokeWidth({ width: 2560, height: 1440 }), 10);
  assert.equal(strokeWidth({ width: 20000, height: 100 }), 24);
  const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
  assert.ok(a.x < 100 && b.x < 100 && Math.abs(a.y + b.y) < 1e-9 && Math.abs(a.x - b.x) < 1e-9);
  assert.ok(Math.abs(Math.hypot(100 - a.x, a.y) - 10) < 1e-9);
  assert.ok(shapeTooSmall({ kind: 'rect', color: 'red', from: { x: 0, y: 0 }, to: { x: 2, y: 2 } }, 4));
  assert.ok(!shapeTooSmall({ kind: 'arrow', color: 'red', from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }, 4));
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 256);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
  assert.equal(base64Bytes(bytesToBase64(bytes)), 70000);
  assert.equal(base64Bytes(bytesToBase64(new Uint8Array(4))), 4);
  assert.equal(aiContext({}), '');
  assert.match(aiContext({ appVersion: '0.5.2', project: 'ade', panes: ['탭1[채팅]'], errors: ['boom\nline'] }), /앱 버전: 0\.5\.2[\s\S]*현재 프로젝트: ade[\s\S]*- boom line/);
});

test('queue eta and submit mode text', async t => {
  const { queueEta, submitModeText, submitModeNote, feedbackModelId, feedbackEffort } = await load(t);
  const now = 1_000_000_000_000, queued = patch => ({ status: 'queued', ...patch });
  assert.equal(queueEta(queued({}), { size: 1 }, now), '곧 전송');
  assert.equal(queueEta(queued({ nextAttemptAt: now - 5000 }), { size: 1, nextAt: now + 30_000 }, now), '곧 전송');
  assert.equal(queueEta(queued({ nextAttemptAt: now + 60_000 }), { size: 1, nextAt: now + 180_000 }, now), '약 3분 뒤 전송');
  assert.equal(queueEta(queued({ nextAttemptAt: now + 600_000 }), { size: 2, nextAt: now + 60_000 }, now), '약 10분 뒤 전송');
  assert.equal(queueEta(queued({ nextAttemptAt: now + 90 * 60_000 }), null, now), '약 1시간 30분 뒤 전송');
  assert.equal(queueEta(queued({ nextAttemptAt: now + 120 * 60_000 }), undefined, now), '약 2시간 뒤 전송');
  assert.equal(queueEta({ status: 'submitting' }, { size: 1, nextAt: now + 600_000 }, now), '전송 중');
  assert.equal(submitModeText({ ok: true, mode: 'account', account: 'mooner' }), 'mooner 계정으로 제출');
  assert.equal(submitModeText({ ok: true, mode: 'anonymous' }), '로그인 없이 제출');
  assert.match(submitModeNote({ ok: true, mode: 'anonymous' }), /5분에 1건/);
  assert.equal(submitModeNote({ ok: true, mode: 'account', account: 'a' }), '');
  // AI pickers: only Haiku/Sonnet/Opus 5.5 and low/medium; anything else falls back to the default.
  assert.deepEqual(['sonnet', 'claude-opus-5-5', '', 'x'].map(feedbackModelId), ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(['medium', 'high', '', undefined].map(feedbackEffort), ['medium', 'low', 'low', 'low']);
  assert.equal(submitModeText({ ok: false, reason: '익명 제출이 꺼져 있습니다' }), '익명 제출이 꺼져 있습니다');
  assert.equal(submitModeText(null), '지금은 피드백을 보낼 수 없습니다.');
});

test('isEmptyDraft: only a human draft with no title, text or images is dropped', async t => {
  const { isEmptyDraft } = await load(t);
  const empty = { title: ' ', body: '\n', images: [] };
  assert.equal(isEmptyDraft(item(empty)), true);
  assert.equal(isEmptyDraft(item({ ...empty, title: '제목' })), false);
  assert.equal(isEmptyDraft(item({ ...empty, body: '내용' })), false);
  assert.equal(isEmptyDraft(item({ ...empty, images: [image(1)] })), false);
  assert.equal(isEmptyDraft(item({ ...empty, source: 'agent' })), false);
  assert.equal(isEmptyDraft(item({ ...empty, status: 'review' })), false);
});
