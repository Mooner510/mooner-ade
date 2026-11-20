import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Modal } from './views';
import changelog from './changelog.json';
import kinds from './changelog-kinds.json';
import { changelogIsFresh, changelogNewer, changelogSeen, hasUnreadChangelogVersions, markChangelogSeen, readChangelogViewed, syncChangelogVersion, writeChangelogViewed } from './changelog-state';

type Entry = { version: string; date: string; time?: string; items: { kind: string; title: string; text: string; icon?: string; image?: string }[] };
// Items are listed by kind, in the order of changelog-kinds.json (the release notes use the same order).
const rank = (kind: string) => kinds.indexOf(kind);
export const entries = (changelog as Entry[]).map(entry => ({ ...entry, items: [...entry.items].sort((a, b) => rank(a.kind) - rank(b.kind)) }));
// One section per kind (same order as the release notes), so a long version reads as a patch-note page instead of one flat list.
const groups = (entry: Entry) => kinds.map(kind => ({ kind, items: entry.items.filter(item => item.kind === kind) })).filter(group => group.items.length);
const seenVersion = changelogSeen;
const readViewed = readChangelogViewed;
const writeViewed = writeChangelogViewed;
// How long ago a release was, in the words the sidebar shows. `date` and `time` are the KST clock time written in changelog.json.
const ago = (date: string, time: string, now = Date.now()) => {
  const minutes = (now - Date.parse(`${date}T${time}:00+09:00`)) / 60_000;
  if (minutes < 10) return '방금';
  if (minutes < 60) return `${Math.floor(minutes)}분 전`;
  const days = minutes / 1440;
  if (days < 1) return `${Math.floor(minutes / 60)}시간 전`;
  if (days < 7) return `${Math.floor(days)}일 전`;
  if (days < 30) return `${Math.floor(days / 7)}주 전`;
  if (days < 365) return `${Math.max(1, Math.floor(days / 30.4))}달 전`;
  return `${Math.floor(days / 365)}년 전`;
};
const newer = changelogNewer;
const isFresh = changelogIsFresh;
// Run once at startup with the real app version (the desktop app's; the bundle's newest entry in a plain browser). True only when this launch recorded an update.
export { syncChangelogVersion };
export { changelogDue, setChangelogDue } from './changelog-state';
// Same rule as the red dots in the window: some version of the latest update has never been opened (the sidebar button shows a dot for it).
export const hasUnreadChangelog = () => hasUnreadChangelogVersions(entries.map(item => item.version));

// The sidebar lists the versions; one version is shown at a time. A version never opened gets a red dot; opening it clears the dot. Closing the window still marks the latest version as seen for the 새 소식 tag.
export function Changelog({ onClose }: { onClose(): void }) {
  const seen = seenVersion();
  const [selected, setSelected] = useState(entries[0]?.version);
  const [viewed, setViewed] = useState<string[]>(readViewed);
  const entry = entries.find(item => item.version === selected) ?? entries[0];
  const isNew = (version: string) => !viewed.includes(version) && isFresh(version);
  // Opening a version (including the one shown first) marks it viewed, so its red dot goes away.
  const view = (version: string) => {
    setSelected(version);
    setViewed(previous => { if (previous.includes(version)) return previous; const next = [...previous, version]; writeViewed(next); return next; });
  };
  useEffect(() => { if (entry) view(entry.version); }, [entry?.version]);
  const close = () => { if (entries[0]) markChangelogSeen(entries[0].version); onClose(); };
  return <Modal className="project-modal changelog" labelledBy="changelog-title" onClose={close} region="변경 내역">
    <header className="changelog-head"><h2 id="changelog-title">변경 내역</h2><button className="icon-btn" aria-label="닫기" onClick={close}><Icon name="x" size={16} /></button></header>
    <div className="changelog-main">
      <nav className="changelog-nav" aria-label="버전">
        {entries.map(item => <button key={item.version} aria-pressed={item.version === entry?.version} data-read={!isNew(item.version)} onClick={() => view(item.version)}>
          <span className="changelog-nav-version">v{item.version}</span><time className="changelog-nav-date" dateTime={item.date} title={item.time ? `${item.date} ${item.time}` : undefined}>{item.time ? ago(item.date, item.time) : item.date}</time>{isNew(item.version) && <span className="changelog-new-dot" role="img" aria-label="한 번도 보지 않은 버전" />}
        </button>)}
      </nav>
      <div className="changelog-body">
        {entry && <section key={entry.version} className="changelog-entry" aria-label={`v${entry.version}`}>
          <h3><span className="changelog-version">v{entry.version}</span>{seen && newer(entry.version, seen) && <span className="changelog-new">새 소식</span>}<time>{entry.time ? `${entry.date} ${entry.time}` : entry.date}</time></h3>
          <p className="changelog-summary">{groups(entry).map(group => <span key={group.kind} data-kind={group.kind}>{group.kind} <b>{group.items.length}</b></span>)}</p>
          {groups(entry).map(group => <div key={group.kind} className="changelog-group" data-kind={group.kind}>
            <h4>{group.kind}<small>{group.items.length}</small></h4>
            <ul>{group.items.map(item => <li key={item.title} data-kind={item.kind} data-image={item.image ? '' : undefined}>
              <Icon name={(item.icon ?? 'sparkles') as Parameters<typeof Icon>[0]['name']} size={18} />
              <div><strong>{item.title}</strong><p>{item.text}</p>{item.image && <img src={`/changelog/${item.image}`} alt={item.title} loading="lazy" />}</div>
            </li>)}</ul>
          </div>)}
        </section>}
      </div>
    </div>
  </Modal>;
}
