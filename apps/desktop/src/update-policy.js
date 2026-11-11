// Decisions of the auto-updater that do not need Electron, kept apart so they can be tested: how often to look, which
// versions the user already turned down, and how a busy report is worded. A downloaded update installs on the next quit;
// nothing here waits for the app to look idle.

// Background checks: shortly after start and then every 10 minutes. A check without a new release is one small API call
// (about 7 KB, unauthenticated: 6 of the 60 requests an IP gets per hour) and writes nothing to disk.
export const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

// Versions are 1.2.3 (stable) or 1.2.3-beta1 (a prerelease, offered only to users who turned beta updates on).
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/;
export const isPrerelease = version => version.includes('-');

// Digits compare as numbers inside a tag (beta2 < beta10); any other text compares as text.
function compareTags(a, b) {
  const x = a.match(/\d+|\D+/g) ?? [], y = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const order = /^\d+$/.test(x[i]) && /^\d+$/.test(y[i]) ? Number(x[i]) - Number(y[i]) : x[i] < y[i] ? -1 : x[i] > y[i] ? 1 : 0;
    if (order) return Math.sign(order);
  }
  return 0;
}

// Negative, 0 or positive like a sort comparator. A prerelease is older than the stable release it leads up to: 1.2.3-beta2 < 1.2.3.
export function compareVersions(a, b) {
  const [coreA, tagA] = a.split(/-(.*)/s), [coreB, tagB] = b.split(/-(.*)/s);
  const x = coreA.split('.').map(Number), y = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  if (tagA === undefined || tagB === undefined) return tagA === tagB ? 0 : tagA === undefined ? 1 : -1;
  return compareTags(tagA, tagB);
}
export const isNewer = (a, b) => compareVersions(a, b) > 0;

// The release to offer from GitHub's release list: the highest valid version that carries this platform's zip. Prereleases only count
// with `beta`; a draft never does. { release, version } or null.
export function pickRelease(releases, { beta, asset }) {
  let best = null;
  for (const release of releases) {
    if (!release || release.draft) continue;
    const version = String(release.tag_name).replace(/^v/, '');
    if (!VERSION_PATTERN.test(version) || (isPrerelease(version) && !beta)) continue;
    if (!(release.assets ?? []).some(item => item.name === asset)) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { release: { ...release, assets: release.assets ?? [] }, version };
  }
  return best;
}

// Versions the user answered "later" to. A background check does not ask about them again until the app is restarted;
// the manual check button always asks.
export function createDeclined() {
  const versions = new Set();
  return { has: version => versions.has(version), add: version => { versions.add(version); }, clear: () => versions.clear() };
}

// The server's report is trusted only in shape: anything unreadable counts as busy, never as idle.
// `keepsTerminals`: the server's terminals live in the pty-host and keep running through the restart; each reason they cause is
// marked `keeps`. Only the other reasons (a plugin at work, an answer that could not be read) are work a quit would cut off.
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
