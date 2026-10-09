import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, basename } from './api';
import type { Settings } from './Editor';

export type Call = <T = any>(action: string, input?: object) => Promise<T>;
export type Ask = { input(title: string, initial?: string): Promise<string | null>; confirm(message: string): Promise<boolean> };
export type GitChange = { path: string; status: string; original?: string };
export type GitState = { branch: string; changes: GitChange[]; additions: number; deletions: number };
type Entry = { name: string; kind: string };

const icons: Record<string, string> = { ts: 'TS', tsx: '⚛', js: 'JS', jsx: '⚛', mjs: 'JS', json: '{}', css: '#', scss: '#', html: '<>', md: 'M↓', py: 'Py', java: 'J', kt: 'K', yml: '≡', yaml: '≡', sh: '$', png: '▣', jpg: '▣', jpeg: '▣', svg: '◇', lock: '🔒' };
export function Modal({ children, onClose, className = '', labelledBy = 'conflict-title' }: { children: ReactNode; onClose(): void; className?: string; labelledBy?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className={className} aria-labelledby={labelledBy} onCancel={onClose}>{children}</dialog>;
}
export function Dropdown({ value, options, onChange, label, className = '' }: { value: string; options: { value: string; label: string }[]; onChange(value: string): void; label: string; className?: string }) {
  const root = useRef<HTMLDetailsElement>(null);
  return <details className={`dropdown ${className}`} ref={root}><summary aria-label={label}>{options.find(option => option.value === value)?.label}<span aria-hidden="true">⌄</span></summary><div role="listbox" aria-label={label}>{options.map(option => <button role="option" aria-selected={option.value === value} key={option.value} onClick={() => { onChange(option.value); root.current!.open = false; }}>{option.label}</button>)}</div></details>;
}

// ---- Explorer ----
type TreeProps = { entry: Entry; path: string; depth: number; active: string; expanded: Set<string>; version: number; load(path: string): Promise<Entry[]>; toggle(path: string): void; open(path: string, preview: boolean): void; menu(path: string, kind: string, x: number, y: number): void; act(action: 'rename' | 'delete', path: string, kind: string): void; fail(error: unknown): void };
function TreeNode(props: TreeProps) {
  const { entry, path, depth, active, expanded, version, load, toggle, open, menu, act, fail } = props;
  const directory = entry.kind === 'directory', isOpen = expanded.has(path);
  const [children, setChildren] = useState<Entry[]>([]);
  useEffect(() => { if (isOpen && directory) void load(path).then(setChildren).catch(fail); }, [isOpen, path, version]);
  const ext = entry.name.split('.').pop()?.toLowerCase() || '';
  return <div className="tree-node" role="treeitem" aria-expanded={directory ? isOpen : undefined}>
    <button className={`tree-row ${active === path ? 'active' : ''}`} title={path} style={{ paddingLeft: 8 + depth * 12 }}
      onContextMenu={event => { event.preventDefault(); menu(path, entry.kind, event.clientX, event.clientY); }}
      onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); act('rename', path, entry.kind); } else if (event.key === 'Delete') { event.preventDefault(); act('delete', path, entry.kind); } }}
      onClick={() => directory ? toggle(path) : open(path, true)} onDoubleClick={() => { if (!directory) open(path, false); }}>
      <span className={`twisty ${directory ? (isOpen ? 'open' : '') : 'none'}`} aria-hidden="true">›</span>
      {!directory && <span className={`file-icon ext-${ext}`} aria-hidden="true">{icons[ext] || '•'}</span>}<span className="tree-label">{entry.name}</span></button>
    {directory && isOpen && children.map(child => <TreeNode key={child.name} {...props} entry={child} path={`${path}/${child.name}`} depth={depth + 1} />)}
  </div>;
}
export function ExplorerView({ call, ask, active, version, bump, openFile, onRenamed, onDeleted, openTerminalAt, fail }: { call: Call; ask: Ask; active: string; version: number; bump(): void; openFile(path: string, preview: boolean): void; onRenamed(from: string, to: string): void; onDeleted(path: string): void; openTerminalAt(path: string): void; fail(error: unknown): void }) {
  const [root, setRoot] = useState<Entry[]>([]), [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ path: string; kind: string; x: number; y: number } | null>(null);
  useEffect(() => { void call<Entry[]>('files/list', { path: '.' }).then(setRoot).catch(fail); }, [version, call]);
  useEffect(() => { // reveal the active file
    if (!active || active.startsWith('diff:')) return;
    const parts = active.split('/').slice(0, -1); if (!parts.length) return;
    setExpanded(previous => { const next = new Set(previous); parts.forEach((_, index) => next.add(parts.slice(0, index + 1).join('/'))); return next; });
  }, [active]);
  const load = (path: string) => call<Entry[]>('files/list', { path });
  const parentOf = (path: string, kind: string) => kind === 'directory' ? path : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const join = (parent: string, name: string) => parent ? `${parent}/${name}` : name;
  async function create(parent: string, directory: boolean) {
    const name = await ask.input(directory ? '새 폴더 이름' : '새 파일 이름'); if (!name) return;
    const path = join(parent, name);
    if (directory) await call('files/mkdir', { path }); else { await call('files/save', { path, content: '', revision: null }); openFile(path, false); }
    if (parent) setExpanded(previous => new Set(previous).add(parent));
    bump();
  }
  async function act(action: 'rename' | 'delete', path: string, kind: string) {
    if (action === 'rename') {
      const to = await ask.input('새 경로', path); if (!to || to === path) return;
      await call('files/rename', { path, to }); onRenamed(path, to);
    } else {
      if (!(await ask.confirm(`${path}${kind === 'directory' ? ' 폴더와 안의 모든 파일' : ''}을(를) 삭제할까요? 되돌릴 수 없습니다.`))) return;
      await call('files/delete', { path }); onDeleted(path);
    }
    bump();
  }
  const guard = (operation: () => Promise<unknown>) => void operation().catch(fail);
  return <div className="explorer-view">
    <header><strong>탐색기</strong><span className="spacer" /><button title="새 파일" aria-label="새 파일" onClick={() => guard(() => create('', false))}>＋</button><button title="새 폴더" aria-label="새 폴더" onClick={() => guard(() => create('', true))}>▱</button><button title="새로고침" aria-label="새로고침" onClick={bump}>↻</button><button title="모두 접기" aria-label="모두 접기" onClick={() => setExpanded(new Set())}>⊟</button></header>
    <div className="tree" role="tree">{root.map(entry => <TreeNode key={entry.name} entry={entry} path={entry.name} depth={0} active={active} expanded={expanded} version={version} load={load} fail={fail} open={openFile}
      toggle={path => setExpanded(previous => { const next = new Set(previous); if (!next.delete(path)) next.add(path); return next; })} menu={(path, kind, x, y) => setMenu({ path, kind, x, y })} act={(action, path, kind) => guard(() => act(action, path, kind))} />)}{!root.length && <p className="hint">빈 폴더입니다.</p>}</div>
    {menu && <><button className="context-dismiss" aria-label="메뉴 닫기" onClick={() => setMenu(null)} onContextMenu={event => { event.preventDefault(); setMenu(null); }} />
      <div className="context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>{(() => {
        const { path, kind } = menu, dir = kind === 'directory', done = () => setMenu(null);
        return <>{!dir && <button onClick={() => { done(); openFile(path, false); }}>열기</button>}
          <button onClick={() => { done(); guard(() => create(parentOf(path, kind), false)); }}>새 파일</button><button onClick={() => { done(); guard(() => create(parentOf(path, kind), true)); }}>새 폴더</button>
          <button onClick={() => { done(); guard(() => act('rename', path, kind)); }}>이름 바꾸기 <kbd>F2</kbd></button><button onClick={() => { done(); guard(() => act('delete', path, kind)); }}>삭제 <kbd>Del</kbd></button>
          <button onClick={() => { done(); void navigator.clipboard.writeText(path); }}>상대 경로 복사</button>{dir && <button onClick={() => { done(); openTerminalAt(path); }}>터미널에서 열기</button>}</>;
      })()}</div></>}
  </div>;
}

// ---- Search ----
type Hit = { path: string; line: number; column: number; length: number; text: string };
export function SearchView({ call, ask, openAt, dirtyPaths, onReplaced, fail, focusToken, replaceMode }: { call: Call; ask: Ask; openAt(path: string, line: number, column: number, length: number): void; dirtyPaths: Set<string>; onReplaced(paths: string[]): void; fail(error: unknown): void; focusToken: number; replaceMode: boolean }) {
  const [query, setQuery] = useState(''), [replacement, setReplacement] = useState(''), [showReplace, setShowReplace] = useState(false);
  const [regex, setRegex] = useState(false), [caseSensitive, setCase] = useState(false), [wholeWord, setWord] = useState(false), [include, setInclude] = useState(''), [exclude, setExclude] = useState('');
  const [hits, setHits] = useState<Hit[]>([]), [truncated, setTruncated] = useState(false), [searched, setSearched] = useState(false), [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); field.current?.select(); if (replaceMode) setShowReplace(true); }, [focusToken]);
  const options = { query, regex, caseSensitive, wholeWord, include, exclude };
  const grouped = new Map<string, Hit[]>(); for (const hit of hits) grouped.set(hit.path, [...(grouped.get(hit.path) || []), hit]);
  async function doSearch() { const result = await call<{ hits: Hit[]; truncated: boolean }>('files/search', options); setHits(result.hits); setTruncated(result.truncated); setSearched(true); }
  async function replace(paths: string[]) {
    const blocked = paths.filter(path => dirtyPaths.has(path));
    if (blocked.length) throw new Error(`저장하지 않은 편집이 있는 파일은 건너뜁니다: ${blocked.join(', ')}`);
    if (!(await ask.confirm(`${paths.length}개 파일에서 "${query}" → "${replacement}" 로 바꿀까요?`))) return;
    const changed: string[] = [];
    for (const path of paths) {
      try {
        const current = await call<{ revision: string }>('files/read', { path });
        const result = await call<{ count: number }>('files/replace', { ...options, path, revision: current.revision, replacement });
        if (result.count) changed.push(path);
      } catch (cause) { if (cause instanceof ApiError && ['BINARY_FILE', 'UNSUPPORTED_FILE'].includes(cause.code)) continue; throw cause; }
    }
    onReplaced(changed); await doSearch();
  }
  const guard = (operation: () => Promise<unknown>) => void operation().catch(fail);
  const toggle = (label: string, title: string, on: boolean, set: (value: boolean) => void) => <button type="button" className="toggle" title={title} aria-label={title} aria-pressed={on} onClick={() => set(!on)}>{label}</button>;
  return <div className="search-view">
    <header><strong>검색</strong><span className="spacer" /><button title="바꾸기 표시" aria-pressed={showReplace} onClick={() => setShowReplace(value => !value)}>⇄</button></header>
    <form onSubmit={event => { event.preventDefault(); guard(doSearch); }}>
      <div className="field-row"><input ref={field} value={query} onChange={event => setQuery(event.target.value)} placeholder="검색" aria-label="검색어" required />{toggle('Aa', '대소문자 구분', caseSensitive, setCase)}{toggle('ab', '단어 단위', wholeWord, setWord)}{toggle('.*', '정규식', regex, setRegex)}</div>
      {showReplace && <div className="field-row"><input value={replacement} onChange={event => setReplacement(event.target.value)} placeholder="바꾸기" aria-label="바꿀 내용" /><button type="button" title="모두 바꾸기" aria-label="모두 바꾸기" disabled={!hits.length} onClick={() => guard(() => replace([...grouped.keys()]))}>모두</button></div>}
      <input value={include} onChange={event => setInclude(event.target.value)} placeholder="포함할 파일 (예: src/**, *.ts)" aria-label="포함할 파일" />
      <input value={exclude} onChange={event => setExclude(event.target.value)} placeholder="제외할 파일" aria-label="제외할 파일" />
      <button hidden type="submit">검색</button></form>
    <div className="results">{searched && <p className="hint">{hits.length ? `${grouped.size}개 파일에서 ${hits.length}개 결과` : '결과가 없습니다.'}</p>}
      {[...grouped].map(([path, list]) => <div key={path} className="result-file"><div className="result-head"><button className="file-toggle" onClick={() => setCollapsed(previous => { const next = new Set(previous); if (!next.delete(path)) next.add(path); return next; })}><span className={`twisty ${collapsed.has(path) ? '' : 'open'}`}>›</span><strong>{basename(path)}</strong><small>{path}</small><span className="count">{list.length}</span></button>
        {showReplace && <button title="이 파일에서 바꾸기" aria-label={`${path}에서 바꾸기`} onClick={() => guard(() => replace([path]))}>⇄</button>}</div>
        {!collapsed.has(path) && list.map((hit, index) => <button key={index} className="search-hit" onClick={() => openAt(hit.path, hit.line, hit.column, hit.length)}><span className="line-no">{hit.line}</span><span>{hit.text.trim()}</span></button>)}</div>)}
      {truncated && <p className="hint">결과 200개 또는 파일 10,000개 제한에 도달했습니다.</p>}</div>
  </div>;
}

// ---- Source control ----
export function ScmView({ git, controls, openDiff, call, ask, refresh, fail, hasRepository, selectionRequired }: { git: GitState; controls: ReactNode; openDiff(kind: 'staged' | 'unstaged', path: string): void; call: Call; ask: Ask; refresh(): Promise<void>; fail(error: unknown): void; hasRepository: boolean; selectionRequired: boolean }) {
  const [message, setMessage] = useState('');
  const staged = git.changes.filter(change => change.status[0] !== ' ' && change.status[0] !== '?');
  const changes = git.changes.filter(change => change.status[1] !== ' ' || change.status === '??');
  const guard = (operation: () => Promise<unknown>) => void operation().catch(fail);
  const files = (change: GitChange) => [change.path, ...(change.original ? [change.original] : [])];
  const mutate = (action: string, list: string[]) => guard(async () => { await call(action, { files: list }); await refresh(); });
  async function discard(list: GitChange[]) {
    if (!(await ask.confirm(`${list.length}개 파일의 변경을 되돌릴까요? 추적되지 않은 파일은 삭제됩니다.`))) return;
    await call('git/discard', { files: list.flatMap(files) }); await refresh();
  }
  async function commit() { await call('git/commit', { message }); setMessage(''); await refresh(); }
  const row = (change: GitChange, kind: 'staged' | 'unstaged') => <div className="scm-row" key={`${kind}:${change.path}`}>
    <button className="scm-open" title={change.path} onClick={() => openDiff(kind, change.path)}><span>{basename(change.path)}</span><small>{change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : ''}{change.original ? ` ← ${change.original}` : ''}</small></button>
    <span className="row-actions">{kind === 'unstaged' && <button title="변경 취소" aria-label={`${change.path} 변경 취소`} onClick={() => guard(() => discard([change]))}>↶</button>}
      <button title={kind === 'staged' ? '스테이지 해제' : '스테이지'} aria-label={`${change.path} ${kind === 'staged' ? '스테이지 해제' : '스테이지'}`} onClick={() => mutate(kind === 'staged' ? 'git/unstage' : 'git/stage', files(change))}>{kind === 'staged' ? '−' : '+'}</button></span>
    <b className={`status s-${(kind === 'staged' ? change.status[0] : change.status === '??' ? 'U' : change.status[1]).trim()}`}>{kind === 'staged' ? change.status[0] : change.status === '??' ? 'U' : change.status[1]}</b></div>;
  return <div className="scm-view">
    <header><strong>소스 제어</strong><span className="spacer" /><button title="새로고침" aria-label="새로고침" onClick={() => guard(refresh)}>↻</button></header>
    {controls}
    {!hasRepository ? <p className="hint">Git 저장소가 없습니다.</p> : selectionRequired ? <p className="hint">저장소를 선택하세요.</p> : <>
      <div className="commit-box"><textarea aria-label="커밋 메시지" placeholder={`메시지 (Ctrl+Enter로 커밋) · ${git.branch}`} value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && message.trim() && staged.length) { event.preventDefault(); guard(commit); } }} />
        <button className="primary" disabled={!message.trim() || !staged.length} onClick={() => guard(commit)}>✓ 커밋</button></div>
      {staged.length > 0 && <section><h3><span>스테이지된 변경 <em>{staged.length}</em></span><button title="모두 스테이지 해제" aria-label="모두 스테이지 해제" onClick={() => mutate('git/unstage', staged.flatMap(files))}>−</button></h3>{staged.map(change => row(change, 'staged'))}</section>}
      <section><h3><span>변경 <em>{changes.length}</em></span><span><button title="모두 변경 취소" aria-label="모두 변경 취소" disabled={!changes.length} onClick={() => guard(() => discard(changes))}>↶</button><button title="모두 스테이지" aria-label="모두 스테이지" disabled={!changes.length} onClick={() => mutate('git/stage', changes.flatMap(files))}>+</button></span></h3>{changes.map(change => row(change, 'unstaged'))}{!changes.length && !staged.length && <p className="hint">변경이 없습니다.</p>}</section></>}
  </div>;
}

// ---- Settings ----
export function SettingsView({ settings, onChange }: { settings: Settings; onChange(settings: Settings): void }) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value });
  const number = (key: 'fontSize' | 'tabSize', label: string, min: number, max: number) => <label>{label}<input type="number" min={min} max={max} value={settings[key]} onChange={event => { const value = Math.round(Number(event.target.value)); if (value >= min && value <= max) set(key, value); }} /></label>;
  return <div className="settings-view"><header><strong>설정</strong></header>
    <label>색 테마<select value={settings.theme} onChange={event => set('theme', event.target.value as Settings['theme'])}><option value="dark">어둡게</option><option value="light">밝게</option></select></label>
    {number('fontSize', '편집기 글꼴 크기', 8, 40)}{number('tabSize', '탭 크기', 1, 8)}
    <label className="check"><input type="checkbox" checked={settings.wordWrap} onChange={event => set('wordWrap', event.target.checked)} />자동 줄바꿈</label>
    <label className="check"><input type="checkbox" checked={settings.minimap} onChange={event => set('minimap', event.target.checked)} />미니맵 표시</label>
    <label>자동 저장<select value={settings.autoSave} onChange={event => set('autoSave', event.target.value as Settings['autoSave'])}><option value="off">끄기</option><option value="afterDelay">입력 후 1초</option></select></label>
  </div>;
}

export function Transcript({ events }: { events: { sequence: number; kind: string; text?: string; mode?: string; itemId?: string; [key: string]: any }[] }) {
  const text = new Map<string, string>();
  for (const event of events) if (event.kind === 'text') { const id = event.itemId || 'response'; text.set(id, event.mode === 'replace' || event.phase === 'item.completed' ? event.text || '' : (text.get(id) || '') + (event.text || '')); }
  return <>{[...text].map(([id, content]) => <pre className="answer" key={id}>{content}</pre>)}{events.filter(event => ['tool', 'error', 'approval', 'result'].includes(event.kind)).map(event => <details key={event.sequence} open={event.kind === 'error'}><summary>{event.kind} · {event.tool || event.phase || event.status || event.message}</summary><pre>{JSON.stringify(event.data || event.summary || event, null, 2)}</pre></details>)}</>;
}
