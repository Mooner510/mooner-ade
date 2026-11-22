import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { Icon } from './Icon';
import { Modal } from './views';
import { errorText } from './errors';

// The folder chooser on a phone. The desktop asks the PC to open its system dialog, which a phone cannot see, so the page browses the
// PC's folders itself (`fs/folders`) and returns the chosen path the way the dialog would, or null when closed.
type Listing = { path: string; parent: string | null; folders: string[]; sep: string };

function FolderPicker({ title, start, done }: { title: string; start: string; done(path: string | null): void }) {
  const [listing, setListing] = useState<Listing | null>(null), [error, setError] = useState(''), [hidden, setHidden] = useState(false);
  const go = (path: string) => { setError(''); void api<Listing>('fs/folders', { path }).then(setListing, cause => setError(errorText(cause))); };
  useEffect(() => go(start), []); // eslint-disable-line react-hooks/exhaustive-deps
  const join = (name: string) => listing ? (listing.path.endsWith(listing.sep) ? listing.path + name : listing.path + listing.sep + name) : name;
  const shown = (listing?.folders ?? []).filter(name => hidden || !name.startsWith('.'));
  return <Modal onClose={() => done(null)} className="folder-picker" labelledBy="folder-picker-title">
    <header className="folder-picker-head">
      <h2 id="folder-picker-title">{title}</h2>
      <p className="folder-picker-path" title={listing?.path}>{listing?.path ?? '불러오는 중…'}</p>
    </header>
    {error && <p className="folder-picker-error" role="alert">{error}</p>}
    <ul className="folder-picker-list" aria-label="하위 폴더">
      {listing?.parent && <li><button type="button" onClick={() => go(listing.parent!)}><Icon name="arrowUp" /><span>상위 폴더</span></button></li>}
      {shown.map(name => <li key={name}><button type="button" onClick={() => go(join(name))}><Icon name="folder" /><span>{name}</span></button></li>)}
      {listing && !shown.length && <li className="folder-picker-empty">하위 폴더가 없습니다.</li>}
    </ul>
    <footer className="folder-picker-actions">
      <label className="folder-picker-hidden"><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} /> 숨김 폴더</label>
      <button type="button" onClick={() => done(null)}>취소</button>
      <button type="button" className="primary" disabled={!listing} onClick={() => listing && done(listing.path)}>이 폴더 선택</button>
    </footer>
  </Modal>;
}

export function pickRemoteFolder(title: string, defaultPath: string) {
  return new Promise<string | null>(resolve => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const done = (path: string | null) => { resolve(path); setTimeout(() => { root.unmount(); host.remove(); }); };
    root.render(<FolderPicker title={title} start={defaultPath} done={done} />);
  });
}
