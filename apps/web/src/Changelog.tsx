import { Icon } from './Icon';
import { Modal } from './views';
import changelog from './changelog.json';
import kinds from './changelog-kinds.json';

type Entry = { version: string; date: string; items: { kind: string; title: string; text: string; icon?: string; image?: string }[] };
// Items are listed by kind, in the order of changelog-kinds.json (the release notes use the same order).
const rank = (kind: string) => kinds.indexOf(kind);
export const entries = (changelog as Entry[]).map(entry => ({ ...entry, items: [...entry.items].sort((a, b) => rank(a.kind) - rank(b.kind)) }));
const SEEN = 'ade-changelog-seen';
const seenVersion = () => { try { return localStorage.getItem(SEEN); } catch { return null; } };
// Versions are plain x.y.z (beta releases have no entry), so a numeric compare is enough.
const newer = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0;

// Everything since the version last looked at is marked new; closing the window marks the latest as seen.
export function Changelog({ onClose }: { onClose(): void }) {
  const seen = seenVersion();
  const close = () => { try { if (entries[0]) localStorage.setItem(SEEN, entries[0].version); } catch {} onClose(); };
  return <Modal className="project-modal changelog" labelledBy="changelog-title" onClose={close} region="변경 내역">
    <header className="changelog-head"><h2 id="changelog-title">변경 내역</h2><button className="icon-btn" aria-label="닫기" title="닫기" onClick={close}><Icon name="x" size={16} /></button></header>
    <div className="changelog-body">
      {entries.map(entry => <section key={entry.version} className="changelog-entry" aria-label={`v${entry.version}`}>
        <h3><span className="changelog-version">v{entry.version}</span>{seen && newer(entry.version, seen) && <span className="changelog-new">새 소식</span>}<time>{entry.date}</time></h3>
        <ul>{entry.items.map(item => <li key={item.title} data-kind={item.kind}>
          <Icon name={(item.icon ?? 'sparkles') as Parameters<typeof Icon>[0]['name']} size={18} />
          <div><strong>{item.title}<span className="changelog-kind">{item.kind}</span></strong><p>{item.text}</p>{item.image && <img src={`/changelog/${item.image}`} alt={item.title} loading="lazy" />}</div>
        </li>)}</ul>
      </section>)}
    </div>
  </Modal>;
}
