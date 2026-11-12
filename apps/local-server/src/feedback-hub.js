// Anonymous feedback submission straight to MoonerADE Hub (`POST /v1/feedback/anonymous`), for people who are not signed in
// through the remote access plugin. The Hub tells installs apart by a random id kept in <dataRoot>/feedback/device.json
// (never anything about the person or the machine) and allows one submission per id every 5 minutes.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_HUB_URL = 'https://ade-hub.mooner510.kr';
export const ANONYMOUS_INTERVAL_MS = 5 * 60_000;
const DEVICE = /^[A-Za-z0-9_-]{16,64}$/;

export async function anonymousDeviceId(root) {
  const file = path.join(root, 'device.json');
  try {
    const id = JSON.parse(await fs.readFile(file, 'utf8'))?.id;
    if (DEVICE.test(id ?? '')) return id;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const id = randomBytes(24).toString('base64url');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ id }), { mode: 0o600 });
  return id;
}

const MESSAGES = {
  400: ['bad_request', '피드백 내용이 올바르지 않아 Hub가 받지 않았습니다.'],
  413: ['too_large', '이미지가 너무 커서 Hub가 받지 않았습니다.'],
  429: ['rate_limited', '익명 제출은 5분에 1건씩 보낼 수 있습니다. 순서대로 자동 전송합니다.'],
  502: ['upstream_failed', 'Hub가 GitHub에 올리지 못했습니다. 잠시 뒤 다시 보냅니다.'],
  503: ['feedback_disabled', 'Hub가 지금 익명 피드백을 받지 않습니다.']
};
const retryAfterOf = (response, body) => {
  const value = Number(response.headers.get('retry-after') ?? body?.error?.retryAfter);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 86_400) : undefined;
};

// Resolves { ok, issueUrl?, issueNumber? } or { ok:false, error:{ code, message, retryAfter? } }; never rejects.
export async function postAnonymousFeedback({ hubUrl = DEFAULT_HUB_URL, deviceId, meta, images, fetchImpl = fetch, timeoutMs = 90_000 }) {
  try {
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    for (const [index, image] of images.entries()) {
      const bytes = await fs.readFile(image.path);
      form.append('image', new Blob([bytes], { type: image.mime }), `image-${index + 1}.${image.mime === 'image/png' ? 'png' : 'jpg'}`);
    }
    const response = await fetchImpl(new URL('/v1/feedback/anonymous', hubUrl), { method: 'POST', headers: { 'X-ADE-Device': deviceId }, body: form, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json().catch(() => null);
    if (response.ok && typeof body?.issueUrl === 'string') return { ok: true, issueUrl: body.issueUrl, ...(Number.isSafeInteger(body.issueNumber) && { issueNumber: body.issueNumber }) };
    const [code, fallback] = MESSAGES[response.status] ?? (response.status >= 500 ? ['upstream_failed', `Hub 오류 (${response.status})`] : ['bad_request', `Hub가 피드백을 받지 않았습니다 (${response.status}).`]);
    const retryAfter = response.status === 429 ? retryAfterOf(response, body) : undefined;
    return { ok: false, error: { code: typeof body?.error?.code === 'string' && response.status !== 503 ? body.error.code.replace(/-/g, '_') : code, message: typeof body?.error?.message === 'string' ? body.error.message.slice(0, 500) : fallback, ...(retryAfter && { retryAfter }) } };
  } catch (error) {
    return { ok: false, error: { code: 'network_error', message: error?.name === 'TimeoutError' ? 'Hub가 제때 응답하지 않았습니다.' : `Hub에 연결하지 못했습니다: ${error?.message ?? error}` } };
  }
}
