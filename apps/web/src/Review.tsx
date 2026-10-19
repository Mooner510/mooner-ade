import { useEffect, useState, type ReactNode } from 'react';
import { basename } from './api';
import { DiffView, type Settings } from './Editor';
import { Icon, IconButton } from './Icon';
import { FileIcon } from './FileIcon';
import type { GitChange, GitState } from './views';

type Props = {
  git: GitState; gitVersion: number; settings: Settings; controls: ReactNode; fail(error: unknown): void; refresh(): Promise<void>;
  loadDiff(kind: string, path: string): Promise<{ original: string; modified: string }>; openDiffTab(path: string): void; switchBranch(): void;
  hasRepository: boolean; selectionRequired: boolean;
};
const statusOf = (change: GitChange) => change.status === '??' ? 'U' : (change.status[0] !== ' ' ? change.status[0] : change.status[1]);

function FileDiff({ path, version, settings, loadDiff }: { path: string; version: number; settings: Settings; loadDiff: Props['loadDiff'] }) {
  const [value, setValue] = useState<{ original: string; modified: string } | null>(null), [error, setError] = useState('');
  useEffect(() => { loadDiff('all', path).then(setValue, cause => setError(String(cause?.message || cause))); }, [path, version]);
  if (error) return <p className="hint">{error}</p>;
  if (!value) return <p className="hint">불러오는 중…</p>;
  if (value.original === value.modified) return <p className="hint">텍스트 변경이 없습니다. (바이너리, 모드 변경 또는 2 MiB 초과)</p>;
  return <DiffView original={value.original} modified={value.modified} path={path} settings={settings} compact />;
}

// Read-only changes view: the agent edits and commits, so this only shows what differs from HEAD.
export function ReviewPanel(props: Props) {
  const { git, fail, refresh } = props;
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const changes = git.changes, total = changes.length;
  const isOpen = (path: string) => expanded ? expanded.has(path) : total <= 5;
  const toggle = (path: string) => setExpanded(previous => {
    const next = new Set(previous ?? (total <= 5 ? changes.map(change => change.path) : []));
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
          {open && <FileDiff path={change.path} version={props.gitVersion} settings={props.settings} loadDiff={props.loadDiff} />}
        </article>;
      })}
    </div>}
  </div>;
}
