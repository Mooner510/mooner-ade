// Decisions of the auto-updater that do not need Electron, kept apart so they can be tested: how often to look, which
// versions the user already turned down, what counts as "everything stopped", and how a busy report is worded.

// Background checks: shortly after start and then every 10 minutes. A check without a new release is one small API call
// (about 7 KB, unauthenticated: 6 of the 60 requests an IP gets per hour) and writes nothing to disk.
export const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

// While waiting for work to finish the server is asked every 15 s, and only 4 idle answers in a row (about a minute) count:
// a Claude between two tool calls or a build between two steps can look idle for a moment.
export const IDLE_POLL_MS = 15_000;
export const IDLE_POLLS = 4;

// Versions the user answered "later" to. A background check does not ask about them again until the app is restarted;
// the manual check button always asks.
export function createDeclined() {
  const versions = new Set();
  return { has: version => versions.has(version), add: version => { versions.add(version); }, clear: () => versions.clear() };
}

const sleepFor = (ms, signal) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

// Polls until `required` answers in a row say nothing is busy, then resolves 'idle'. Resolves with the abort reason
// ('cancelled' or 'force') when `signal` is aborted first. There is deliberately no timeout: a Claude waiting on a long
// monitor is not something to guess about, and the user can always cancel or force the update.
export async function waitUntilIdle({ poll, signal, intervalMs = IDLE_POLL_MS, required = IDLE_POLLS, sleep = sleepFor }) {
  let idle = 0;
  while (!signal.aborted) {
    const report = await poll();
    if (signal.aborted) break;
    idle = report.busy ? 0 : idle + 1;
    if (idle >= required) return 'idle';
    await sleep(intervalMs, signal);
  }
  return typeof signal.reason === 'string' ? signal.reason : 'cancelled';
}

// The server's report is trusted only in shape: anything unreadable counts as busy, never as idle.
// `keepsTerminals`: the server's terminals live in the pty-host and keep running through the restart; each reason they cause is
// marked `keeps`. Only the other reasons (a plugin at work, an answer that could not be read) hold the restart back.
export function normalizeReport(value) {
  if (!value || typeof value !== 'object' || typeof value.busy !== 'boolean') return unknownReport('작업 상태 응답을 이해하지 못했습니다');
  const all = Array.isArray(value.reasons) ? value.reasons.filter(item => item && typeof item === 'object') : [];
  const keepsTerminals = value.keepsTerminals === true;
  const reasons = keepsTerminals ? all.filter(item => item.keeps !== true) : all;
  const kept = keepsTerminals ? all.filter(item => item.keeps === true) : [];
  // An old server says busy without reasons; that stays busy.
  return { busy: keepsTerminals ? reasons.length > 0 : value.busy, reasons, kept, keepsTerminals };
}
export const unknownReport = detail => ({ busy: true, reasons: [{ project: '', terminal: '', kind: 'unknown', detail }], kept: [], keepsTerminals: false });

const KIND = {
  turn: agent => `${AGENT[agent] ?? '에이전트'}가 작업 중`,
  background: () => '백그라운드 작업(shell·monitor)이 실행 중이라 끝나면 이어서 작업',
  waiting: () => '승인·답변을 기다리는 중',
  scheduled: () => '예약된 작업이 곧 실행될 예정',
  command: () => '명령 실행 중',
  plugin: () => '플러그인이 작업 중',
  unknown: () => '상태를 확인할 수 없음'
};
const AGENT = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };

// "• 프로젝트 · 터미널: Claude가 작업 중 (detail)" per reason, at most `limit` lines.
export function describeReasons(reasons, limit = 6) {
  const lines = reasons.slice(0, limit).map(item => {
    const place = [item.project, item.terminal].filter(Boolean).join(' · '), what = (KIND[item.kind] ?? KIND.unknown)(item.agent);
    return `• ${place ? `${place}: ` : ''}${what}${item.detail ? ` (${String(item.detail).slice(0, 80)})` : ''}`;
  });
  if (reasons.length > limit) lines.push(`• 그 밖에 ${reasons.length - limit}개`);
  return lines.join('\n');
}

// Old per-update scratch folders (a download or extraction the app never got to clean up) are removed once they are this old.
export const STALE_UPDATE_MS = 24 * 60 * 60 * 1000;
export const staleUpdateDirs = (entries, now, maxAge = STALE_UPDATE_MS) =>
  entries.filter(entry => /^(?:mooner-update-|\.MoonerADE-update-)/.test(entry.name) && now - entry.mtimeMs > maxAge).map(entry => entry.name);
