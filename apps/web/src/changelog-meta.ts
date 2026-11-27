// What the app shell needs from the release notes at start (is there something unread, is a tour due) without loading the notes window itself (Changelog.tsx, split off).
import changelog from './changelog.json';
import { hasUnreadChangelogVersions } from './changelog-state';
export { syncChangelogVersion, changelogDue, setChangelogDue } from './changelog-state';
export const changelogVersions = (changelog as { version: string }[]).map(entry => entry.version);
// Same rule as the red dots in the window: some version of the latest update has never been opened (the sidebar button shows a dot for it).
export const hasUnreadChangelog = () => hasUnreadChangelogVersions(changelogVersions);
