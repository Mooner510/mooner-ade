import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Modal } from './views';
import changelog from './changelog.json';
import kinds from './changelog-kinds.json';

type Entry = { version: string; date: string; time?: string; items: { kind: string; title: string; text: string; icon?: string; image?: string }[] };
// Items are listed by kind, in the order of changelog-kinds.json (the release notes use the same order).
const rank = (kind: string) => kinds.indexOf(kind);
export const entries = (changelog as Entry[]).map(entry => ({ ...entry, items: [...entry.items].sort((a, b) => rank(a.kind) - rank(b.kind)) }));
const SEEN = 'ade-changelog-seen';
const seenVersion = () => { try { return localStorage.getItem(SEEN); } catch { return null; } };
// Versions whose notes were opened at least once; the red dot marks the rest. Versions up to SEEN (from before this list existed) count as viewed.
const VIEWED = 'ade-changelog-viewed';
const readViewed = (): string[] => { try { return JSON.parse(localStorage.getItem(VIEWED) ?? '[]'); } catch { return []; } };
const writeViewed = (list: string[]) => { try { localStorage.setItem(VIEWED, JSON.stringify(list)); } catch {} };
// Versions are plain x.y.z (beta releases have no entry), so a numeric compare is enough.
const newer = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0;

// The sidebar lists the versions; one version is shown at a time. A version never opened gets a red dot; opening it clears the dot. Closing the window still marks the latest version as seen for the 새 소식 tag.
export function Changelog({ onClose }: { onClose(): void }) {
  const seen = seenVersion();
  const [selected, setSelected] = useState(entries[0]?.version);
  const [viewed, setViewed] = useState<string[]>(readViewed);
  const entry = entries.find(item => item.version === selected) ?? entries[0];
  const isNew = (version: string) => !viewed.includes(version) && !(seen && !newer(version, seen));
  // Opening a version (including the one shown first) marks it viewed, so its red dot goes away.
  const view = (version: string) => {
    setSelected(version);
    setViewed(previous => { if (previous.includes(version)) return previous; const next = [...previous, version]; writeViewed(next); return next; });
  };
  useEffect(() => { if (entry) view(entry.version); }, [entry?.version]);
  const close = () => { try { if (entries[0]) localStorage.setItem(SEEN, entries[0].version); } catch {} onClose(); };
  return <Modal className="project-modal changelog" labelledBy="changelog-title" onClose={close} region="변경 내역">
    <header className="changelog-head"><h2 id="changelog-title">변경 내역</h2><button className="icon-btn" aria-label="닫기" title="닫기" onClick={close}><Icon name="x" size={16} /></button></header>
    <div className="changelog-main">
      <nav className="changelog-nav" aria-label="버전">
        {entries.map(item => <button key={item.version} aria-pressed={item.version === entry?.version} onClick={() => view(item.version)}>
          <span className="changelog-nav-text"><span className="changelog-nav-version">v{item.version}</span><time className="changelog-nav-date">{item.time ? `${item.date} ${item.time}` : item.date}</time></span>{isNew(item.version) && <span className="changelog-new-dot" role="img" aria-label="한 번도 보지 않은 버전" />}
        </button>)}
      </nav>
      <div className="changelog-body">
        {entry && <section key={entry.version} className="changelog-entry" aria-label={`v${entry.version}`}>
          <h3><span className="changelog-version">v{entry.version}</span>{seen && newer(entry.version, seen) && <span className="changelog-new">새 소식</span>}<time>{entry.date}</time></h3>
          <ul>{entry.items.map(item => <li key={item.title} data-kind={item.kind}>
            <Icon name={(item.icon ?? 'sparkles') as Parameters<typeof Icon>[0]['name']} size={18} />
            <div><strong>{item.title}<span className="changelog-kind">{item.kind}</span></strong><p>{item.text}</p>{item.image && <img src={`/changelog/${item.image}`} alt={item.title} loading="lazy" />}</div>
          </li>)}</ul>
        </section>}
      </div>
    </div>
  </Modal>;
}
