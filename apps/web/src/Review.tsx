import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { basename } from './api';
import { DiffView, type Settings } from './Editor';
import { Icon, IconButton } from './Icon';
import { FileIcon } from './FileIcon';
import type { GitChange, GitState } from './views';

type Props = {
  git: GitState; gitVersion: number; settings: Settings; controls: ReactNode; fail(error: unknown): void; refresh(): Promise<void>;
  loadDiff(kind: string, path: string): Promise<{ original: string; modified: string }>; openDiffTab(path: string): void; switchBranch(): void;
  hasRepository: boolean; selectionRequired: boolean; wide: boolean; toggleWide(): void;
};
const statusOf = (change: GitChange) => change.status === '??' ? 'U' : (change.status[0] !== ' ' ? change.status[0] : change.status[1]);

// A file's diff is only fetched and mounted while it is near the scrolled viewport; "expand all" on a big change set used to build
// one Monaco editor per file at once. Scrolled-away files drop back to a placeholder of their last height.
const FileDiff = memo(function FileDiff({ path, version, settings, loadDiff, ready }: { path: string; version: number; settings: Settings; loadDiff: Props['loadDiff']; ready: boolean }) {
  const [value, setValue] = useState<{ original: string; modified: string } | null>(null), [error, setError] = useState(''), [near, setNear] = useState(false);
  const box = useRef<HTMLDivElement>(null), height = useRef(240), load = useRef(loadDiff); load.current = loadDiff;
  useEffect(() => {
    const element = box.current!, observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root: element.closest('.review-list'), rootMargin: '600px 0px' });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!near || !ready) return;
    let stale = false;
    load.current('all', path).then(next => { if (!stale) { setError(''); setValue(previous => previous && previous.original === next.original && previous.modified === next.modified ? previous : next); } }, cause => { if (!stale) setError(String(cause?.message || cause)); });
    return () => { stale = true; };
  }, [path, version, near, ready]);
  const body = error ? <p className="hint">{error}</p> : !value ? <p className="hint">불러오는 중…</p>
    : value.original === value.modified ? <p className="hint">텍스트 변경이 없습니다. (바이너리, 모드 변경 또는 2 MiB 초과)</p>
    : near && ready ? <DiffView original={value.original} modified={value.modified} path={path} settings={settings} compact onHeight={next => { height.current = next; }} />
    : <div className="compact-diff" style={{ height: height.current }} />;
  return <div ref={box}>{body}</div>;
  // loadDiff is a new function on every workspace render; it is read through a ref, so only these props matter.
}, (a, b) => a.path === b.path && a.version === b.version && a.settings === b.settings && a.ready === b.ready);

// Read-only changes view: the agent edits and commits, so this only shows what differs from HEAD.
export function ReviewPanel(props: Props) {
  const { git, fail, refresh } = props;
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  // The panel slides in for ~0.22 s; loading Monaco and building editors in that window stalls the animation (and the terminals behind it),
  // so the file list appears first and the diffs follow once the slide has finished.
  const [settled, setSettled] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setSettled(true), 280); return () => clearTimeout(timer); }, []);
  const changes = git.changes, total = changes.length;
  const isOpen = (path: string) => expanded ? expanded.has(path) : changes[0]?.path === path;
  const toggle = (path: string) => setExpanded(previous => {
    const next = new Set(previous ?? changes.slice(0, 1).map(change => change.path));
    if (!next.delete(path)) next.add(path); return next;
  });
  const guard = (operation: () => Promise<unknown>) => void operation().catch(fail);
  return <div className="review-panel">
    <header className="panel-head">
      <Icon name="diff" /><strong>변경사항</strong>
      {props.hasRepository && !props.selectionRequired && <><span className="chip" title="현재 브랜치"><Icon name="branch" size={12} /> {git.branch || '브랜치 없음'}</span><span className="diffstat"><ins>+{git.additions}</ins><del>−{git.deletions}</del></span></>}
      <span className="spacer" />
      <IconButton icon="expandAll" label="모두 펼치기" disabled={!total} onClick={() => setExpanded(new Set(changes.map(change => change.path)))} />
      <IconButton icon="collapseAll" label="모두 접기" disabled={!total} onClick={() => setExpanded(new Set())} />
      <IconButton icon="refresh" label="새로고침" onClick={() => guard(refresh)} />
      <IconButton icon={props.wide ? 'minimize' : 'maximize'} label={props.wide ? '패널 크기 줄이기' : '패널 넓게 보기'} onClick={props.toggleWide} />
    </header>
    {props.controls && <div className="review-controls">{props.controls}</div>}
    {!props.hasRepository ? <p className="hint">Git 저장소가 없습니다.</p> : props.selectionRequired ? <p className="hint">저장소를 선택하세요.</p> : <div className="review-list">
      {!total && <div className="review-empty"><Icon name="check" size={22} /><strong>변경 사항 없음</strong><p>에이전트나 터미널에서 파일을 바꾸면 여기에 diff가 바로 나타납니다.</p></div>}
      {changes.map(change => {
        const open = isOpen(change.path), status = statusOf(change), dir = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : '';
        return <article className={`review-file ${open ? 'open' : ''}`} key={change.path}>
          <header>
            <button className="review-toggle" aria-expanded={open} title={change.path} onClick={() => toggle(change.path)}>
              <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
              <FileIcon name={basename(change.path)} size={15} /><b className={`status s-${status.trim()}`}>{status}</b><span className="review-name">{basename(change.path)}</span>
              <small>{dir}{change.original ? ` ← ${change.original}` : ''}</small>
            </button>
            {(change.added !== undefined || change.deleted !== undefined) && <span className="diffstat"><ins>+{change.added ?? 0}</ins><del>−{change.deleted ?? 0}</del></span>}
            <span className="row-actions"><IconButton icon="externalLink" label="큰 화면으로 보기" onClick={() => props.openDiffTab(change.path)} /></span>
          </header>
          {open && <FileDiff path={change.path} version={props.gitVersion} settings={props.settings} loadDiff={props.loadDiff} ready={settled} />}
        </article>;
      })}
    </div>}
  </div>;
}
