import { useId, useState, type ReactNode } from 'react';
import { Icon, IconButton } from './Icon';
import { Modal } from './views';
import type { RepoState } from './git-graph';

// The dialogs of the Git tool window, in IntelliJ's shape and wording (translated).
function Frame({ title, children, submit, onSubmit, onClose, danger, disabled, wide, extra }: { title: string; children: ReactNode; submit: string; onSubmit(): void; onClose(): void; danger?: boolean; disabled?: boolean; wide?: boolean; extra?: ReactNode }) {
  const id = useId();
  return <Modal className={`git-dialog ${wide ? 'wide' : ''}`} labelledBy={id} onClose={onClose} region={title}>
    <form onSubmit={event => { event.preventDefault(); if (!disabled) onSubmit(); }}>
      <h3 id={id}>{title}</h3>
      <div className="git-dialog-body">{children}</div>
      <div className="actions">{extra}<span className="spacer" /><button type="button" onClick={onClose}>취소</button><button type="submit" className={danger ? 'danger' : 'primary'} disabled={disabled}>{submit}</button></div>
    </form>
  </Modal>;
}

export function BranchDialog({ from, exists, onSubmit, onClose }: { from: string; exists(name: string): boolean; onSubmit(value: { name: string; checkout: boolean; force: boolean }): void; onClose(): void }) {
  const [name, setName] = useState(''), [checkout, setCheckout] = useState(true), [force, setForce] = useState(false);
  const clean = name.trim(), clash = clean !== '' && exists(clean);
  const problem = !clean ? '' : clean === 'HEAD' ? 'HEAD는 예약된 이름입니다' : /\s|\.\.|[~^:?*[\\]|^-|\/$|\.lock$|^\.|@\{/.test(clean) ? '브랜치 이름에 쓸 수 없는 문자가 있습니다' : clash && !force ? `${clean} 브랜치가 이미 있습니다` : '';
  return <Frame onSubmit={() => { if (clean && !problem) onSubmit({ name: clean, checkout, force: clash && force }); }} title={`${from}에서 브랜치 생성`} submit="생성" onClose={onClose} disabled={!clean || Boolean(problem)}>
      <label className="git-field">새 브랜치 이름:<input autoFocus value={name} spellCheck={false} onChange={event => setName(event.target.value)} aria-invalid={Boolean(problem)} /></label>
      {problem && <p className="git-error">{problem}</p>}
      <label className="check"><input type="checkbox" checked={checkout} onChange={event => setCheckout(event.target.checked)} /> 브랜치 체크아웃</label>
      <label className="check"><input type="checkbox" checked={force} disabled={!clash} onChange={event => setForce(event.target.checked)} /> 기존 브랜치 덮어쓰기</label>
  </Frame>;
}

export function TagDialog({ target, onSubmit, onClose }: { target: string; onSubmit(value: { name: string; message: string }): void; onClose(): void }) {
  const [name, setName] = useState(''), [message, setMessage] = useState('');
  return <Frame onSubmit={() => { if (name.trim()) onSubmit({ name: name.trim(), message }); }} title={`${target}에 태그 만들기`} submit="생성" onClose={onClose} disabled={!name.trim()}>
      <label className="git-field">태그 이름:<input autoFocus value={name} spellCheck={false} onChange={event => setName(event.target.value)} /></label>
      <label className="git-field">메시지 (비우면 가벼운 태그):<textarea rows={3} value={message} onChange={event => setMessage(event.target.value)} /></label>
  </Frame>;
}

const RESET_MODES = [
  { id: 'soft', label: 'Soft', text: '파일은 바뀌지 않고, 차이는 커밋할 수 있게 스테이징됩니다.' },
  { id: 'mixed', label: 'Mixed', text: '파일은 바뀌지 않고, 차이는 스테이징되지 않습니다.' },
  { id: 'hard', label: 'Hard', text: '파일이 선택한 커밋의 상태로 되돌아갑니다. 경고: 로컬 변경은 모두 사라집니다.' },
  { id: 'keep', label: 'Keep', text: '파일이 선택한 커밋의 상태로 되돌아가지만, 로컬 변경은 그대로 유지됩니다.' }
] as const;
export function ResetDialog({ branch, target, onSubmit, onClose }: { branch: string; target: string; onSubmit(mode: string): void; onClose(): void }) {
  const [mode, setMode] = useState('mixed');
  return <Frame onSubmit={() => onSubmit(mode)} title="Git 리셋" submit="리셋" danger={mode === 'hard'} onClose={onClose}>
      <p>현재 브랜치 헤드(<b>{branch}</b>)를 선택한 커밋 <code>{target}</code>(으)로 리셋하고, 고른 방식에 따라 작업 트리와 인덱스를 바꿉니다.</p>
      <div className="git-radios" role="radiogroup" aria-label="리셋 방식">{RESET_MODES.map(item =>
        <label key={item.id} className="git-radio"><input type="radio" name="reset" checked={mode === item.id} onChange={() => setMode(item.id)} autoFocus={item.id === 'mixed'} /><b>{item.label}</b><span>{item.text}</span></label>)}</div>
  </Frame>;
}

export function MessageDialog({ title, initial, submit, note, onSubmit, onClose }: { title: string; initial: string; submit: string; note?: string; onSubmit(message: string): void; onClose(): void }) {
  const [message, setMessage] = useState(initial);
  return <Frame onSubmit={() => { if (message.trim()) onSubmit(message); }} title={title} submit={submit} onClose={onClose} disabled={!message.trim()} wide>
      {note && <p className="git-note">{note}</p>}
      <textarea className="git-message" autoFocus rows={10} value={message} spellCheck={false} onChange={event => setMessage(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && message.trim()) { event.preventDefault(); onSubmit(message); } }} />
  </Frame>;
}

type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';
const ACTIONS: { id: RebaseAction; label: string; hint: string }[] = [
  { id: 'pick', label: 'Pick', hint: '커밋 유지' }, { id: 'reword', label: 'Reword', hint: '커밋 메시지 편집' }, { id: 'edit', label: 'Edit', hint: '이 커밋에서 일시 정지' },
  { id: 'squash', label: 'Squash', hint: '이전 커밋에 통합 · 메시지 병합' }, { id: 'fixup', label: 'Fixup', hint: '이전 커밋에 통합 · 현재 메시지 삭제' }, { id: 'drop', label: 'Drop', hint: '현재 커밋 삭제' }
];
export type RebaseRow = { sha: string; subject: string; message: string };
// Newest on top, like the log; the list is applied bottom-up. Alt+↑/↓ moves the focused row.
export function RebaseDialog({ commits, onto, onSubmit, onClose }: { commits: RebaseRow[]; onto: string; onSubmit(entries: { sha: string; action: RebaseAction; message?: string }[]): void; onClose(): void }) {
  const [rows, setRows] = useState(() => commits.map(commit => ({ ...commit, action: 'pick' as RebaseAction, edited: commit.message })));
  const [selected, setSelected] = useState(0);
  const move = (index: number, dir: number) => {
    const to = index + dir; if (to < 0 || to >= rows.length) return;
    setRows(list => { const next = [...list]; [next[index], next[to]] = [next[to], next[index]]; return next; }); setSelected(to);
  };
  const applied = [...rows].reverse();
  const first = applied.find(row => row.action !== 'drop');
  const problem = !first ? '모든 커밋을 버릴 수는 없습니다.' : first.action === 'squash' || first.action === 'fixup' ? '맨 아래(가장 오래된) 커밋은 합칠 대상이 없습니다.' : '';
  const row = rows[selected];
  return <Frame onSubmit={() => { if (!problem) onSubmit(applied.map(item => ({ sha: item.sha, action: item.action, ...(item.action === 'reword' ? { message: item.edited } : {}) }))); }} title={`${onto}에서 커밋 ${rows.length}개 리베이스`} submit="리베이스 시작" onClose={onClose} disabled={Boolean(problem)} wide
      extra={<><IconButton icon="arrowUp" label="위로 (Alt+↑)" disabled={selected === 0} onClick={() => move(selected, -1)} /><IconButton icon="arrowDown" label="아래로 (Alt+↓)" disabled={selected === rows.length - 1} onClick={() => move(selected, 1)} /></>}>
      <div className="git-rebase" role="listbox" aria-label="리베이스할 커밋" tabIndex={0}
        onKeyDown={event => {
          if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); move(selected, event.key === 'ArrowUp' ? -1 : 1); }
          else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setSelected(index => Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))); }
        }}>
        {rows.map((item, index) => <div key={item.sha} role="option" aria-selected={index === selected} className={`git-rebase-row ${index === selected ? 'selected' : ''} ${item.action}`} onClick={() => setSelected(index)}>
          <select value={item.action} aria-label={`${item.subject} 동작`} onChange={event => { const action = event.target.value as RebaseAction; setRows(list => list.map((other, at) => at === index ? { ...other, action } : other)); setSelected(index); }}>
            {ACTIONS.map(action => <option key={action.id} value={action.id}>{action.label}</option>)}</select>
          <code>{item.sha.slice(0, 8)}</code><span>{item.action === 'reword' ? item.edited.split('\n')[0] : item.subject}</span>
        </div>)}
      </div>
      {row?.action === 'reword' && <label className="git-field">새 메시지:<textarea rows={4} value={row.edited} onChange={event => { const edited = event.target.value; setRows(list => list.map((other, at) => at === selected ? { ...other, edited } : other)); }} /></label>}
      <p className="git-note">{ACTIONS.find(action => action.id === row?.action)?.hint}</p>
      {problem && <p className="git-error">{problem}</p>}
  </Frame>;
}

const OP_NAME: Record<string, string> = { merge: '머지', rebase: '리베이스', 'cherry-pick': '체리픽', revert: '되돌리기' };
export const opName = (op: string | null | undefined) => (op && OP_NAME[op]) || '작업';
// "Yours" is the user's own side: the current branch in a merge, the commit being replayed in a rebase (git's "theirs" there),
// the current branch for cherry-pick and revert, the stashed changes after a smart checkout.
export const sides = (op: RepoState['op']) => op === 'rebase'
  ? { yours: 'theirs' as const, theirs: 'ours' as const, yoursText: '리베이스 중인 내 커밋', theirsText: '리베이스 대상 브랜치' }
  // no operation: the changes a smart checkout put aside came back on top of the new branch
  : !op ? { yours: 'theirs' as const, theirs: 'ours' as const, yoursText: '보관해 둔 내 변경', theirsText: '체크아웃한 브랜치' }
  : { yours: 'ours' as const, theirs: 'theirs' as const, yoursText: '현재 브랜치', theirsText: op === 'merge' ? '머지해 들어오는 브랜치' : op === 'cherry-pick' ? '체리픽하는 커밋' : '되돌리는 커밋' };
type ConflictsProps = { state: RepoState; onResolve(path: string, side: 'ours' | 'theirs' | 'mark'): Promise<void>; onContinue(): void; onAbort(): void; onClose(): void };
export function ConflictsDialog(props: ConflictsProps) {
  const id = useId();
  return <Modal className="git-dialog wide" labelledBy={id} onClose={props.onClose} region="충돌"><ConflictsBody {...props} titleId={id} /></Modal>;
}
// The dialog's content on its own (the patch notes draw it without a dialog around it).
export function ConflictsBody({ state, onResolve, onContinue, onAbort, onClose, titleId: id }: ConflictsProps & { titleId: string }) {
  const [selected, setSelected] = useState<string>(state.conflicts[0] ?? ''), [busy, setBusy] = useState(false);
  const side = sides(state.op), file = state.conflicts.includes(selected) ? selected : state.conflicts[0] ?? '';
  const resolve = async (choice: 'ours' | 'theirs' | 'mark') => { if (!file) return; setBusy(true); try { await onResolve(file, choice); } finally { setBusy(false); } };
  return (
    <div className="git-conflicts">
      <h3 id={id}>충돌</h3>
      <p>{state.op ? `${opName(state.op)} 중 ` : ''}다음 파일{state.conflicts.length > 1 ? '들' : ''}에 충돌이 있습니다:</p>
      <div className="git-conflict-body">
        <ul role="listbox" aria-label="충돌 파일">{state.conflicts.map(path => <li key={path} role="option" aria-selected={path === file} className={path === file ? 'selected' : ''} onClick={() => setSelected(path)}><Icon name="error" size={13} />{path}</li>)}
          {!state.conflicts.length && <li className="done"><Icon name="check" size={13} />모든 충돌을 해결했습니다.</li>}</ul>
        <div className="git-conflict-actions">
          <button disabled={!file || busy} onClick={() => void resolve(side.yours)}>내 것 적용<small>{side.yoursText}</small></button>
          <button disabled={!file || busy} onClick={() => void resolve(side.theirs)}>상대 것 적용<small>{side.theirsText}</small></button>
          <button disabled={!file || busy} onClick={() => void resolve('mark')}>해결됨으로 표시<small>직접 고친 뒤</small></button>
        </div>
      </div>
      <div className="actions">{state.op && <button className="danger" onClick={onAbort}>{opName(state.op)} 중단</button>}<span className="spacer" /><button onClick={onClose}>닫기</button>
        {state.op && <button className="primary" disabled={state.conflicts.length > 0} onClick={onContinue}>{state.op === 'merge' ? '머지 커밋' : `${opName(state.op)} 계속`}</button>}</div>
    </div>
  );
}

export function LocalChangesDialog({ action, files, onChoose, onClose }: { action: string; files: string[]; onChoose(mode: 'smart' | 'force'): void; onClose(): void }) {
  const id = useId();
  return <Modal className="git-dialog wide" labelledBy={id} onClose={onClose} region="로컬 변경">
    <div className="git-conflicts">
      <h3 id={id}>Git {action} 문제</h3>
      <p>커밋하지 않은 로컬 변경이 {action}(으)로 덮어써집니다. 먼저 커밋하거나, 스마트 {action}으로 변경을 잠시 보관했다가 되돌리세요.</p>
      {files.length > 0 && <ul className="git-file-list">{files.map(file => <li key={file}>{file}</li>)}</ul>}
      <div className="actions"><button className="danger" onClick={() => onChoose('force')} title="로컬 변경 삭제">강제 {action}</button><span className="spacer" /><button onClick={onClose}>취소</button>
        <button className="primary" autoFocus onClick={() => onChoose('smart')}>스마트 {action}</button></div>
    </div>
  </Modal>;
}

export function PushDialog({ source, target, commits, newBranch, onSubmit, onClose }: { source: string; target: string; commits: { sha: string; subject: string }[]; newBranch: boolean; onSubmit(force: boolean): void; onClose(): void }) {
  const [force, setForce] = useState(false);
  return <Frame onSubmit={() => onSubmit(force)} title="커밋 Push" submit={force ? '강제 Push' : 'Push'} danger={force} onClose={onClose} wide>
      <p className="git-push-target"><Icon name="branch" size={14} /><b>{source}</b><Icon name="arrowRight" size={14} /><b>{target}</b>{newBranch && <span className="badge">새 브랜치</span>}</p>
      <ul className="git-file-list">{commits.length ? commits.map(commit => <li key={commit.sha}><code>{commit.sha.slice(0, 8)}</code> {commit.subject}</li>) : <li className="muted">보낼 새 커밋이 없습니다. (불러온 기록 기준)</li>}</ul>
      <label className="check"><input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} /> 강제 Push (--force-with-lease)</label>
  </Frame>;
}
