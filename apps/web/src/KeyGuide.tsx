// mod+/: every shortcut on one screen (key-guide.ts), searchable, with the way into Settings › 단축키 to change them.
import { useMemo, useState } from 'react';
import { Icon, IconButton } from './Icon';
import { Modal } from './views';
import { keyGuideGroups } from './key-guide';
import './keyboard.css';

export function KeyGuide({ settings, onClose, onSettings }: { settings: { appKeys?: Record<string, string>; chatKeys?: Record<string, string> }; onClose(): void; onSettings(): void }) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => keyGuideGroups(settings, query), [settings.appKeys, settings.chatKeys, query]);
  return <Modal className="key-guide" labelledBy="key-guide-title" region="단축키 한눈에 보기" onClose={onClose}>
    <header className="key-guide-head">
      <h2 id="key-guide-title"><Icon name="keyboard" size={16} />단축키</h2>
      <input type="search" autoFocus value={query} placeholder="동작이나 키로 찾기" aria-label="단축키 찾기" onChange={event => setQuery(event.target.value)} />
      <button type="button" onClick={onSettings}><Icon name="settings" size={14} />설정에서 바꾸기</button>
      <IconButton icon="x" label="닫기" onClick={onClose} />
    </header>
    <div className="key-guide-groups">
      {groups.map(group => <section key={group.title}>
        <h3>{group.title}</h3>
        <dl>{group.rows.map((row, index) => <div key={index}><dt>{row.keys.map((key, at) => <kbd key={at}>{key}</kbd>)}</dt><dd>{row.label}</dd></div>)}</dl>
      </section>)}
      {!groups.length && <p className="hint">일치하는 단축키가 없습니다.</p>}
    </div>
    <p className="key-guide-foot hint">팔레트 명령은 모두 설정 › 단축키에서 키를 정할 수 있습니다. 터미널에서는 일반 Ctrl 조합이 셸에 먼저 갑니다.</p>
  </Modal>;
}
