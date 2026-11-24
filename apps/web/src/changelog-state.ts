// Which changelog versions count as new. LAST is the version that ran last time; FROM is the version before the most recent update.
const DUE = 'ade-changelog-due', SEEN = 'ade-changelog-seen', VIEWED = 'ade-changelog-viewed', LAST = 'ade-changelog-last', FROM = 'ade-changelog-from';

export type ChangelogStore = { getItem(key: string): string | null; setItem(key: string, value: string): void };

// The desktop app keeps these values in its own file (preload `changelogStore`): the page's origin changes with every launch (the server picks a free port),
// so its localStorage is empty at each start and could never tell that the version changed. A plain browser has a fixed origin and uses localStorage.
const browserStore = (): ChangelogStore => {
  const desktop = (globalThis as unknown as { adeDesktop?: { changelogStore?: ChangelogStore } }).adeDesktop?.changelogStore;
  if (desktop) return desktop;
  return {
    getItem: key => { try { return localStorage.getItem(key); } catch { return null; } },
    setItem: (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode keeps the window usable */ } }
  };
};

export const changelogSeen = (store = browserStore()) => store.getItem(SEEN);
export const readChangelogViewed = (store = browserStore()): string[] => { try { const parsed = JSON.parse(store.getItem(VIEWED) ?? '[]'); return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []; } catch { return []; } };
export const writeChangelogViewed = (list: string[], store = browserStore()) => store.setItem(VIEWED, JSON.stringify(list));
export const markChangelogSeen = (version: string, store = browserStore()) => store.setItem(SEEN, version);

// From this version on notes use the patch-note page with live UI demos; older notes keep the plain page.
export const CHANGELOG_RICH_FROM = '0.6.0';
export const changelogIsRich = (version: string) => !changelogNewer(CHANGELOG_RICH_FROM, version);
// Rules for the full-screen version intro (연출):
// 1. A patch version (x.y.Z, Z > 0) and any beta never plays an intro (the stable x.y.0 gets it): it opens straight on the page, and an `intro` in its entry is ignored (write none).
// 2. Every minor/major version (x.y.0) from CHANGELOG_RICH_FROM on always has one, designed from that version's own features, and it must not
//    repeat any earlier version's intro (colour, line or concept). tests/changelog.test.mjs checks the entries for both.
export const changelogIsPatch = (version: string) => (parseInt(version.split('-')[0].split('.')[2] ?? '0', 10) || 0) > 0;
export const changelogPlaysIntro = (version: string) => changelogIsRich(version) && !changelogIsPatch(version) && !changelogIsBeta(version);
// 0.6.3-beta2 < 0.6.3 < 0.6.4-beta1; beta numbers compare as numbers, so beta10 is after beta2.
const parse = (version: string) => { const [core, pre] = version.split(/-(.*)/); return { nums: core.split('.').map(part => parseInt(part, 10) || 0), beta: pre === undefined ? Infinity : parseInt(/\d+/.exec(pre)?.[0] ?? '0', 10) }; };
const compare = (a: string, b: string) => { const x = parse(a), y = parse(b); for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) { const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0); if (d) return d; } return x.beta === y.beta ? 0 : x.beta < y.beta ? -1 : 1; };
// The sidebar's "새 소식" tag.
export const changelogNewer = (a: string, b: string) => compare(a, b) > 0;
// A beta version (x.y.z-betaN) has its own short note: the changes of that beta only. Betas show only to a beta app of the same x.y.z (at most its own number);
// a stable release folds them into its own note and deletes them from changelog.json, so a stable app and an older beta never see one (tests/changelog.test.mjs keeps the file that way).
export const changelogIsBeta = (version: string) => version.includes('-');

// The last release that did not remember which version ran: a profile that was used before (`legacyFrom` is passed for it) is taken to come from this one,
// so its first launch of a newer version counts as an update and shows that version's notes once.
export const LEGACY_CHANGELOG_VERSION = '0.5.12';

// Records an update when `current` is newer than the last run. True only for that update, not the first launch.
export const syncChangelogVersion = (current: string, store = browserStore(), legacyFrom?: string) => {
  const last = store.getItem(LAST) ?? store.getItem(SEEN) ?? (legacyFrom && compare(current, legacyFrom) > 0 ? legacyFrom : null);
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

// The update notes open once the tour and the launch splash are out of the way. If the app is closed before that (mid-tour), the next start has no update to detect any more
// (the version was recorded at the first launch), so "the notes are still due" is kept here until they are opened.
export const changelogDue = (store = browserStore()) => store.getItem(DUE) === '1';
export const setChangelogDue = (on: boolean, store = browserStore()) => store.setItem(DUE, on ? '1' : '0');
