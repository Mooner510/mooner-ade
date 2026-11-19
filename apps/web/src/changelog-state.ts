// Which changelog versions count as new. LAST is the version that ran last time; FROM is the version before the most recent update.
const SEEN = 'ade-changelog-seen', VIEWED = 'ade-changelog-viewed', LAST = 'ade-changelog-last', FROM = 'ade-changelog-from';

export type ChangelogStore = { getItem(key: string): string | null; setItem(key: string, value: string): void };

const browserStore = (): ChangelogStore => ({
  getItem: key => { try { return localStorage.getItem(key); } catch { return null; } },
  setItem: (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode keeps the window usable */ } }
});

export const changelogSeen = (store = browserStore()) => store.getItem(SEEN);
export const readChangelogViewed = (store = browserStore()): string[] => { try { const parsed = JSON.parse(store.getItem(VIEWED) ?? '[]'); return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []; } catch { return []; } };
export const writeChangelogViewed = (list: string[], store = browserStore()) => store.setItem(VIEWED, JSON.stringify(list));
export const markChangelogSeen = (version: string, store = browserStore()) => store.setItem(SEEN, version);

// Versions are plain x.y.z (beta releases have no entry), so a numeric compare is enough for the sidebar's "새 소식" tag.
export const changelogNewer = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0;
const parse = (version: string) => { const [core, pre] = version.split(/-(.*)/); return { nums: core.split('.').map(part => parseInt(part, 10) || 0), pre: Boolean(pre) }; };
// A beta counts as just before its release (0.5.9-beta2 -> 0.5.9 is new).
const compare = (a: string, b: string) => { const x = parse(a), y = parse(b); for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) { const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0); if (d) return d; } return Number(y.pre) - Number(x.pre); };

// Records an update when `current` is newer than the last run. True only for that update, not the first launch.
export const syncChangelogVersion = (current: string, store = browserStore()) => {
  const last = store.getItem(LAST) ?? store.getItem(SEEN);
  if (!last) { store.setItem(LAST, current); store.setItem(FROM, current); return false; }
  if (compare(current, last) > 0) { store.setItem(FROM, last); store.setItem(LAST, current); return true; }
  if (store.getItem(LAST) === null) store.setItem(LAST, last);
  return false;
};

// Red dots mark only the versions this app picked up in its latest update: after FROM, up to LAST.
export const changelogIsFresh = (version: string, store = browserStore()) => {
  const from = store.getItem(FROM), last = store.getItem(LAST);
  return Boolean(from) && compare(version, from!) > 0 && (!last || compare(version, last) <= 0);
};

export const hasUnreadChangelogVersions = (versions: string[], store = browserStore()) => {
  const viewed = readChangelogViewed(store);
  return versions.some(version => !viewed.includes(version) && changelogIsFresh(version, store));
};
