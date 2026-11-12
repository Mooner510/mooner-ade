// The persistent submit queue of the feedback inbox. "제출" only puts an item in the queue (status `queued`, kept in its
// feedback.json, so it survives restarts); this sends queued items one at a time, oldest first, when it looks possible:
// - signed in through a plugin: right away (the Hub limits that account itself);
// - anonymous: at most one per 5 minutes from this install (the Hub's per-device limit), remembered across restarts;
// - a refused attempt (rate limit, network, Hub or GitHub trouble) waits (Retry-After, or a growing backoff) and tries again;
//   only an answer that cannot change by waiting (bad request, too large, forbidden) ends as `failed`.
// The item id is the Hub's idempotency key, so an attempt whose answer was lost is safe to send again.
import { promises as fs } from 'node:fs';
import { ANONYMOUS_INTERVAL_MS } from './feedback-hub.js';

const PERMANENT = new Set(['bad_request', 'too_large', 'forbidden', 'INVALID_INPUT']);
// Codes that mean "the other way (account / anonymous) may work now": tried again shortly with whatever is available then.
const SWITCH = new Set(['not_logged_in', 'unauthorized', 'invalid_token', 'token_expired', 'FEEDBACK_UNAVAILABLE', 'PLUGIN_STOPPED']);
const MAX_BACKOFF_MS = 30 * 60_000;
// Answers after which the Hub surely made no issue. After any other failure (a lost answer: network, timeout, a plugin that
// died mid-upload) the issue may exist, and the Hub keeps account and anonymous submissions apart, so the retry must go the
// same way (`pinnedVia`) or it could open a second issue.
const NOTHING_SENT = new Set([...PERMANENT, 'rate_limited', 'rate-limited', 'feedback_disabled', 'upstream_failed', ...SWITCH].filter(code => code !== 'PLUGIN_STOPPED'));
export const surelyNotCreated = error => NOTHING_SENT.has(String(error?.code ?? ''));
export const backoffMs = attempts => Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.max(0, attempts - 1));

// What to do after a failed attempt: { retryAt } or { fail: true }.
export function nextStep(error, attempts, at) {
  const code = String(error?.code ?? '');
  if (PERMANENT.has(code)) return { fail: true };
  if (code === 'rate_limited' || code === 'rate-limited') return { retryAt: at + (error.retryAfter ? error.retryAfter * 1000 : ANONYMOUS_INTERVAL_MS) };
  if (SWITCH.has(code)) return { retryAt: at + 5_000 };
  if (code === 'feedback_disabled') return { retryAt: at + MAX_BACKOFF_MS };
  return { retryAt: at + backoffMs(attempts) };
}

// availability() -> { ok, mode: 'account'|'anonymous' }; sendAccount / sendAnonymous(meta, images) resolve a result, never reject.
export function createFeedbackQueue({ store, stateFile, availability, sendAccount, sendAnonymous, metaOf, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = console }) {
  let state = { lastAnonymousAt: 0 }, loaded = false, running = false, again = false, timer = null, stopped = false;
  async function load() {
    if (loaded) return;
    loaded = true;
    try { const value = JSON.parse(await fs.readFile(stateFile, 'utf8')); if (Number.isFinite(value?.lastAnonymousAt)) state.lastAnonymousAt = value.lastAnonymousAt; }
    catch { /* first run */ }
  }
  const save = () => fs.writeFile(stateFile, JSON.stringify(state), { mode: 0o600 }).catch(error => log.warn(`피드백 큐 상태를 저장하지 못했습니다: ${error.message}`));
  function schedule(at) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; void run(); }, Math.max(1_000, at - now()));
    timer?.unref?.();
  }
  // When the next anonymous submission is allowed.
  const anonymousAt = () => state.lastAnonymousAt + ANONYMOUS_INTERVAL_MS;

  async function run() {
    if (running) { again = true; return; }
    running = true;
    try {
      await load();
      for (;;) {
        again = false;
        const queued = (await store.list()).filter(item => item.status === 'queued').sort((a, b) => (a.queuedAt ?? a.updatedAt) - (b.queuedAt ?? b.updatedAt) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        if (!queued.length) return;
        const available = availability(), at = now();
        // Each item goes the way it is pinned to, else the way available now. An item pinned to the account waits for a sign-in
        // (a change of availability kicks the queue again).
        const way = item => item.pinnedVia ?? (available.ok ? (available.mode === 'account' ? 'account' : 'anonymous') : null);
        const usable = queued.filter(item => way(item) === 'anonymous' ? available.ok || item.pinnedVia === 'anonymous' : way(item) === 'account' && available.mode === 'account');
        const dueAt = item => Math.max(item.nextAttemptAt ?? 0, way(item) === 'anonymous' ? anonymousAt() : 0);
        const ready = usable.find(item => dueAt(item) <= at);
        if (!ready) { if (usable.length) schedule(Math.min(...usable.map(dueAt))); return; }
        await attempt(ready, way(ready) === 'anonymous');
      }
    } catch (error) {
      log.warn(`피드백 전송 큐 오류: ${error.message}`);
      schedule(now() + 60_000);
    } finally {
      running = false;
      if (again) void run();
    }
  }
  async function attempt(item, anonymous) {
    let current;
    // Pinned before sending: if the app stops mid-upload, the resend after a restart goes the same way.
    try { current = await store.setStatus(item.id, 'submitting', { pinnedVia: anonymous ? 'anonymous' : 'account' }, { from: ['queued'] }); }
    catch { return; } // cancelled or deleted meanwhile
    const attempts = (current.attempts ?? 0) + 1;
    if (anonymous) { state.lastAnonymousAt = now(); await save(); }
    const result = await (anonymous ? sendAnonymous : sendAccount)(metaOf(current), store.imagesOf(current))
      .catch(error => ({ ok: false, error: { code: 'network_error', message: error.message } }));
    if (result.ok) {
      await store.setStatus(item.id, 'submitted', { issueUrl: result.issueUrl, issueNumber: result.issueNumber, error: undefined, nextAttemptAt: undefined, pinnedVia: undefined, attempts, submittedAt: now(), via: anonymous ? 'anonymous' : 'account' });
      return;
    }
    const step = nextStep(result.error, attempts, now());
    const message = result.error?.message || '피드백을 보내지 못했습니다.';
    const pinnedVia = surelyNotCreated(result.error) ? item.pinnedVia : current.pinnedVia;
    if (step.fail) await store.setStatus(item.id, 'failed', { error: message, nextAttemptAt: undefined, attempts, pinnedVia });
    else await store.setStatus(item.id, 'queued', { error: message, nextAttemptAt: step.retryAt, attempts, pinnedVia });
  }

  return {
    // Puts a reviewed item at the end of the queue and starts sending if possible.
    async enqueue(id) {
      const item = await store.setStatus(id, 'queued', { queuedAt: now(), nextAttemptAt: now(), attempts: 0, error: undefined }, { from: ['draft', 'review', 'failed'] });
      void run();
      return item;
    },
    // Takes a waiting item back out (only while it is not being sent).
    async cancel(id) {
      const item = await store.get(id);
      return store.setStatus(id, item.source === 'human' ? 'draft' : 'review', { queuedAt: undefined, nextAttemptAt: undefined, error: undefined }, { from: ['queued'] });
    },
    // Availability changed, the app started, or the network may be back: look again now.
    kick: () => { void run(); },
    // { size, nextAt } for the inbox: how many wait and when the next one may go.
    async info() {
      await load();
      const queued = (await store.list()).filter(item => item.status === 'queued' || item.status === 'submitting');
      const available = availability(), anonymous = available.ok && available.mode !== 'account';
      const next = Math.min(...queued.map(item => item.nextAttemptAt ?? 0));
      return { size: queued.length, ...(queued.length && { nextAt: Math.max(next, anonymous ? anonymousAt() : 0) }) };
    },
    stop: () => { stopped = true; if (timer) clearTimer(timer); },
    run
  };
}
