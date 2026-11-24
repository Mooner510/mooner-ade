// How far each submitted feedback has come (대기 → beta 반영 → 릴리스 반영), asked of the Hub and kept on the item.
// Contract with the Hub: docs/FEEDBACK_STATUS.md. Everything here is best effort: a Hub without the endpoint, no network, no signed-in
// plugin all leave the item as plain "제출됨", and nothing in this file reports an error to the user.
//
// What is stored on a submitted item (`feedback.json`, only ever added; an item without it just has not been checked):
//   track: { state, version?, sig, seenSig?, checkedAt, changedAt, latestStable?, commentCount?, comments?, seenComments? }
//   state: pending | beta | released | closed | declined; `sig` = "state:version" and `seenSig` = the sig the person has looked at,
//   so "news" is `sig !== seenSig` (and not pending). The Hub's answer never carries the feedback text.
//   Comments (what the maintainers answered): `commentCount` is the number the Hub counted last time (sent back as `have`, so the Hub only reads the
//   comments again when it changed), `comments` the [{at, body}] it gave (no author), `seenComments` how many of them the person has looked at.

const FINAL = new Set(['released', 'declined']);
// A finished item is still asked about for this long, so an answer added after the fix still arrives.
const FINAL_WATCH_MS = 14 * 86_400_000;
const MAX_COMMENTS = 50, MAX_COMMENT_CHARS = 4000;
export const STATES = new Set(['pending', 'beta', 'released', 'closed', 'declined']);
const CHUNK = 50, FIRST_MS = 20_000, MANUAL_GAP_MS = 20_000;
export const POLL_MS = 15 * 60_000, MAX_BACKOFF_MS = 6 * 3_600_000, UNSUPPORTED_MS = 24 * 3_600_000;

// ---- versions ------------------------------------------------------------------------------------------------------------
const VERSION = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,40}))?(?:\+[0-9A-Za-z.-]+)?$/;
export function parseVersion(value) {
  const match = VERSION.exec(String(value ?? '').trim());
  return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] } : null;
}
// "beta5" before "beta10": an identifier is compared as its letters, then its trailing number.
const identifier = text => { const match = /^(.*?)(\d+)$/.exec(text); return match ? [match[1], Number(match[2])] : [text, -1]; };
function comparePre(a, b) {
  if (!a.length || !b.length) return a.length === b.length ? 0 : a.length ? -1 : 1; // a release comes after its prereleases
  for (let at = 0; at < Math.max(a.length, b.length); at++) {
    if (a[at] === undefined) return -1;
    if (b[at] === undefined) return 1;
    const [la, na] = identifier(a[at]), [lb, nb] = identifier(b[at]);
    if (la !== lb) return la < lb ? -1 : 1;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}
/** -1, 0, 1 like a sort comparator; null when either is not a version. 0.6.0-beta5 < 0.6.0 < 0.6.1-beta1. */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (let at = 0; at < 3; at++) if (x.core[at] !== y.core[at]) return x.core[at] < y.core[at] ? -1 : 1;
  return comparePre(x.pre, y.pre);
}
export const isBeta = version => (parseVersion(version)?.pre.length ?? 0) > 0;
const coreOf = version => { const parsed = parseVersion(version); return parsed ? parsed.core.join('.') : null; };

// ---- what the Hub said → what is stored and shown ------------------------------------------------------------------------
/** The Hub's `{state, version}` for one item, folded with what is known about stable releases: a beta fix is "released" once a stable ≥ its version exists. */
export function settle(remote, { latestStable, appVersion } = {}) {
  const state = STATES.has(remote?.state) ? remote.state : null;
  if (!state) return null;
  const version = parseVersion(remote.version) ? String(remote.version).replace(/^v/, '') : undefined;
  if (state === 'beta' && version) {
    const stable = [latestStable, appVersion].filter(value => parseVersion(value) && !isBeta(value)).sort((a, b) => compareVersions(b, a))[0];
    if (stable && compareVersions(stable, coreOf(version)) >= 0) return { state: 'released', version };
  }
  return { state, ...(version && { version }) };
}
export const signature = track => `${track.state}:${track.version ?? ''}`;
/** The comments in the Hub's answer for one item: { count, list } when it sent them (they replace the stored ones), { count } when only the number came, null when neither. */
export function commentsOf(remote) {
  const count = Number.isSafeInteger(remote?.commentCount) && remote.commentCount >= 0 ? remote.commentCount : null;
  if (count === null) return null;
  if (!Array.isArray(remote.comments)) return count === 0 ? { count, list: [] } : { count }; // the Hub leaves a thread with no comments out of the answer
  const list = remote.comments.filter(entry => typeof entry?.body === 'string' && entry.body.trim() && Number.isFinite(Date.parse(entry.at)))
    .slice(-MAX_COMMENTS).map(entry => ({ at: new Date(entry.at).toISOString(), body: entry.body.trim().slice(0, MAX_COMMENT_CHARS) }));
  return { count, list };
}
/** What the screen needs about an item, from its stored track and the version of this app (computed on every read, never stored). */
export function viewOf(track, appVersion) {
  if (!track || !STATES.has(track.state)) return null;
  const sig = signature(track), inApp = track.version && appVersion ? compareVersions(appVersion, track.version) : null;
  const comments = track.comments ?? [], stateNews = track.state !== 'pending' && track.seenSig !== sig, commentNews = comments.length > (track.seenComments ?? 0);
  return { state: track.state, ...(track.version && { version: track.version }), ...(inApp !== null && { inApp: inApp >= 0 }), news: stateNews || commentNews, stateNews, commentNews, ...(comments.length && { comments }), checkedAt: track.checkedAt, changedAt: track.changedAt };
}

// ---- the poller ----------------------------------------------------------------------------------------------------------
/**
 * fetchers: { anonymous(keys), account(keys) } → { ok, items: { [clientKey]: {state, version?, issueNumber?} }, latestStable? } or { ok:false, error:{ code, retryAfter? } };
 * `account` may be absent or `available()` false (no signed-in plugin that can look it up): those items wait.
 */
export function createFeedbackProgress({ store, appVersion, fetchers, canAsk = () => ({ anonymous: true, account: false }), now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = POLL_MS, firstMs = FIRST_MS, log = console }) {
  let timer = null, running = null, stopped = false, lastManual = 0, unsupportedUntil = 0, lastCheckedAt = 0;
  const backoff = { anonymous: { failures: 0, until: 0 }, account: { failures: 0, until: 0 } };
  const schedule = ms => { if (stopped) return; clearTimer(timer); timer = setTimer(() => { timer = null; void poll(); }, ms); timer?.unref?.(); };

  async function apply(item, remote, context) {
    const settled = settle(remote, context);
    if (!settled) return false;
    const at = now(), sig = signature(settled), prior = item.track, found = commentsOf(remote);
    const commentsChanged = !!found?.list && (found.count !== (prior?.commentCount ?? 0) || JSON.stringify(found.list) !== JSON.stringify(prior?.comments ?? []));
    if (prior && prior.sig === sig && !commentsChanged) return false; // nothing new: not written again, so the screen is not reloaded for nothing
    // A first sight of 'pending' is nothing to read; anything else is news until the person looks at it.
    const seenSig = prior ? prior.seenSig : settled.state === 'pending' ? sig : undefined;
    // The count is only kept together with the comments it belongs to: when the Hub left the comments out (it failed to read them), the old count stays, so the next round asks again.
    const comments = found?.list ?? prior?.comments, commentCount = found?.list ? found.count : prior?.commentCount;
    const track = { ...settled, sig, checkedAt: at, changedAt: prior?.sig === sig ? prior.changedAt : at, ...(context.latestStable && { latestStable: context.latestStable }), ...(seenSig !== undefined && { seenSig }),
      ...(commentCount !== undefined && { commentCount }), ...(comments && { comments }), ...(prior?.seenComments !== undefined && { seenComments: prior.seenComments }) };
    await store.setTrack(item.id, track);
    return true;
  }

  async function ask(via, items) {
    const slot = backoff[via], fetcher = fetchers[via];
    if (!fetcher || !canAsk()[via] || now() < slot.until || !items.length) return;
    let changed = 0;
    for (let at = 0; at < items.length; at += CHUNK) {
      // `have`: the comment counts this install already holds, so the Hub reads a thread again only when its count differs.
      const chunk = items.slice(at, at + CHUNK), have = Object.fromEntries(chunk.filter(item => item.track?.commentCount !== undefined).map(item => [item.id, item.track.commentCount]));
      const answer = await fetcher(chunk.map(item => item.id), have).catch(error => ({ ok: false, error: { code: 'network_error', message: error?.message } }));
      if (!answer?.ok) {
        const code = String(answer?.error?.code ?? '');
        if (code === 'unsupported') { unsupportedUntil = now() + UNSUPPORTED_MS; slot.until = unsupportedUntil; return; } // the Hub has no such endpoint (yet)
        if (code === 'not_logged_in' || code === 'unauthorized' || code === 'FEEDBACK_UNAVAILABLE') { slot.until = now() + 60_000; return; } // asked again when availability changes
        slot.failures += 1;
        slot.until = now() + Math.max(answer?.error?.retryAfter ? answer.error.retryAfter * 1000 : 0, Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.min(slot.failures - 1, 10)));
        log.debug?.(`피드백 처리 상태를 가져오지 못했습니다(${code}): ${answer?.error?.message ?? ''}`);
        return;
      }
      slot.failures = 0; slot.until = 0; lastCheckedAt = now();
      const context = { latestStable: typeof answer.latestStable === 'string' ? answer.latestStable : undefined, appVersion };
      for (const item of chunk) if (answer.items?.[item.id]) changed += (await apply(item, answer.items[item.id], context).catch(() => false)) ? 1 : 0;
    }
    return changed;
  }

  async function run() {
    const open = (await store.list()).filter(item => item.status === 'submitted' && (!FINAL.has(item.track?.state) || now() - (item.track.changedAt ?? 0) < FINAL_WATCH_MS));
    await ask('anonymous', open.filter(item => item.via === 'anonymous'));
    await ask('account', open.filter(item => item.via === 'account'));
  }
  // One round; rounds never overlap. Always schedules the next one.
  function poll() {
    if (stopped) return Promise.resolve();
    running ??= run().catch(error => log.debug?.(`피드백 처리 상태 확인 오류: ${error.message}`)).finally(() => { running = null; schedule(intervalMs); });
    return running;
  }
  return {
    start: () => schedule(firstMs),
    poll,
    // A person asked (the refresh button): not more often than every 20 s, and a pause for "the Hub has no endpoint" is lifted.
    async refresh() {
      if (now() - lastManual < MANUAL_GAP_MS && !running) return { skipped: true };
      lastManual = now(); for (const slot of Object.values(backoff)) slot.until = 0; unsupportedUntil = 0;
      await poll();
      return { skipped: false };
    },
    // The way to ask changed (a plugin signed in, the network came back): look again soon.
    kick: () => { if (!running) schedule(2_000); },
    info: () => ({ checkedAt: lastCheckedAt || undefined, unsupported: unsupportedUntil > now() }),
    stop: () => { stopped = true; clearTimer(timer); }
  };
}
