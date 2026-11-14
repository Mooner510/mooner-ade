import { Icon } from './Icon';
import { Modal } from './views';
import changelog from './changelog.json';

type Entry = { version: string; date: string; items: { title: string; text: string; image?: string }[] };
export const entries = changelog as Entry[];
const SEEN = 'ade-changelog-seen';
const seenVersion = () => { try { return localStorage.getItem(SEEN); } catch { return null; } };
// Versions are plain x.y.z (beta releases have no entry), so a numeric compare is enough.
const newer = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0;

// Everything since the version last looked at is marked new; closing the window marks the latest as seen.
export function Changelog({ onClose }: { onClose(): void }) {
  const seen = seenVersion();
  const close = () => { try { if (entries[0]) localStorage.setItem(SEEN, entries[0].version); } catch {} onClose(); };
  return <Modal className="project-modal changelog" labelledBy="changelog-title" onClose={close} region="변경 내역">
    <div className="welcome-card">
      <h2 id="changelog-title" className="picker-title"><Icon name="sparkles" size={18} /> 변경 내역</h2>
      {entries.map(entry => <section key={entry.version} className="changelog-entry">
        <h3>v{entry.version}{seen && newer(entry.version, seen) && <span className="changelog-new">새 소식</span>}<time>{entry.date}</time></h3>
        <ul>{entry.items.map(item => <li key={item.title}>
          <strong>{item.title}</strong><span>{item.text}</span>
          {item.image && <img src={`/changelog/${item.image}`} alt={item.title} loading="lazy" />}
        </li>)}</ul>
      </section>)}
    </div>
    <div className="actions"><button className="primary" onClick={close}>닫기</button></div>
  </Modal>;
}
