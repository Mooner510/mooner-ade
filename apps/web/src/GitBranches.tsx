import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import type { Ref } from './git-graph';

// The Branches pane on the left of the Log tab: HEAD (Current Branch), Local, Remote ▸ <remote>, Tags; branches grouped by their
// "folder/" prefix; current branch first, then favourites, groups holding favourites, other groups, the rest (natural order).
type Leaf = { kind: 'leaf'; ref: Ref; label: string };
type Group = { kind: 'group'; key: string; label: string; children: Node[]; favorite: boolean };
type Node = Leaf | Group;
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function tree(refs: Ref[], prefix: string, keyBase: string, dirs: boolean, favorite: (ref: Ref) => boolean): Node[] {
  const groups = new Map<string, Ref[]>(), leaves: Leaf[] = [];
  for (const ref of refs) {
    const rest = ref.name.slice(prefix.length), slash = rest.indexOf('/');
    if (dirs && slash > 0) { const head = rest.slice(0, slash); groups.set(head, [...(groups.get(head) ?? []), ref]); }
    else leaves.push({ kind: 'leaf', ref, label: rest });
  }
  const groupNodes: Group[] = [...groups].map(([name, list]) => ({ kind: 'group', key: `${keyBase}/${name}`, label: name, children: tree(list, `${prefix}${name}/`, `${keyBase}/${name}`, dirs, favorite), favorite: list.some(favorite) }));
  const rank = (node: Node) => node.kind === 'leaf' ? (node.ref.current ? 0 : favorite(node.ref) ? 1 : 4) : node.favorite ? 2 : 3;
  return [...groupNodes, ...leaves].sort((a, b) => rank(a) - rank(b) || natural(a.label, b.label));
}

export type BranchesProps = {
  refs: Ref[]; headBranch: string | null; detached: boolean; favorites: string[]; dirs: boolean; tags: boolean; filtered: string[];
  selected: string; onSelect(ref: Ref): void; onActivate(ref: Ref): void; onMenu(ref: Ref, x: number, y: number): void;
  toolbar: ReactNode;
};
export function BranchesPane({ refs, headBranch, detached, favorites, dirs, tags, filtered, selected, onSelect, onActivate, onMenu, toolbar }: BranchesProps) {
  const [query, setQuery] = useState(''), [closed, setClosed] = useState<Set<string>>(new Set());
  const favorite = (ref: Ref) => favorites.includes(ref.name);
  const match = (ref: Ref) => !query.trim() || ref.name.toLowerCase().includes(query.trim().toLowerCase());
  const sections = useMemo(() => {
    const local = refs.filter(ref => ref.kind === 'local' && match(ref)), remote = refs.filter(ref => ref.kind === 'remote' && match(ref)), tagRefs = tags ? refs.filter(ref => ref.kind === 'tag' && match(ref)) : [];
    const remotes = [...new Set(remote.map(ref => ref.name.split('/')[0]))].sort(natural);
    const list: Group[] = [];
    if (local.length) list.push({ kind: 'group', key: 'local', label: '로컬', children: tree(local, '', 'local', dirs, favorite), favorite: false });
    if (remote.length) list.push({ kind: 'group', key: 'remote', label: '원격', children: remotes.map(name => ({ kind: 'group' as const, key: `remote:${name}`, label: name, children: tree(remote.filter(ref => ref.name.startsWith(`${name}/`)), `${name}/`, `remote:${name}`, dirs, favorite), favorite: false })), favorite: false });
    if (tagRefs.length) list.push({ kind: 'group', key: 'tags', label: '태그', children: tree(tagRefs, '', 'tags', false, () => false).reverse(), favorite: false });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, query, dirs, tags, favorites.join('\n')]);
  const current = refs.find(ref => ref.kind === 'local' && ref.current);
  // visible leaves in order, for the arrow keys
  const visible: Ref[] = [];
  const searching = query.trim() !== '';
  const walk = (nodes: Node[]) => { for (const node of nodes) { if (node.kind === 'leaf') visible.push(node.ref); else if (searching || !closed.has(node.key)) walk(node.children); } };
  if (current) visible.push(current);
  walk(sections);
  const toggle = (key: string) => setClosed(previous => { const next = new Set(previous); if (!next.delete(key)) next.add(key); return next; });
  const row = (ref: Ref, label: string, depth: number, key: string) => <div key={key} role="treeitem" aria-selected={selected === ref.ref} tabIndex={-1} style={{ paddingLeft: 8 + depth * 14 }}
    className={`git-branch ${selected === ref.ref ? 'selected' : ''} ${ref.current ? 'current' : ''} ${filtered.includes(ref.name) ? 'filtered' : ''}`}
    title={`${ref.name}${ref.upstream ? ` → ${ref.upstream}` : ''}${ref.gone ? ' (원격에서 사라짐)' : ''}`}
    onClick={() => onSelect(ref)} onDoubleClick={() => onActivate(ref)} onContextMenu={event => { event.preventDefault(); onSelect(ref); onMenu(ref, event.clientX, event.clientY); }}>
    <span className={`git-branch-icon ${ref.kind}`}>{ref.kind === 'tag' ? <TagGlyph /> : <Icon name="branch" size={12} />}</span>
    <span className="git-branch-name">{label}</span>
    {favorite(ref) && <Icon name="star" size={12} />}
    {(ref.ahead || ref.behind) ? <span className="git-track" title={`보낼 커밋 ${ref.ahead ?? 0}개 · 받을 커밋 ${ref.behind ?? 0}개`}>{ref.behind ? <span className="in">↓{ref.behind}</span> : null}{ref.ahead ? <span className="out">↑{ref.ahead}</span> : null}</span> : null}
  </div>;
  const render = (nodes: Node[], depth: number): ReactNode[] => nodes.flatMap(node => node.kind === 'leaf' ? [row(node.ref, node.label, depth, node.ref.ref)]
    : [<div key={node.key} role="treeitem" aria-expanded={searching || !closed.has(node.key)} className="git-branch-group" style={{ paddingLeft: 4 + depth * 14 }} onClick={() => toggle(node.key)}>
        <Icon name={searching || !closed.has(node.key) ? 'chevronDown' : 'chevronRight'} size={13} />{depth === 0 ? <b>{node.label}</b> : <><Icon name="folder" size={12} />{node.label}</>}</div>,
      ...(searching || !closed.has(node.key) ? render(node.children, depth + 1) : [])]);
  const onKey = (event: React.KeyboardEvent) => {
    const at = visible.findIndex(ref => ref.ref === selected);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = visible[Math.max(0, Math.min(visible.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]; if (next) onSelect(next); }
    else if (event.key === 'Enter' && at >= 0) { event.preventDefault(); onActivate(visible[at]); }
    else if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && at >= 0) {
      event.preventDefault(); const el = (event.currentTarget as HTMLElement).querySelector('.git-branch.selected')?.getBoundingClientRect();
      onMenu(visible[at], el ? el.left + 24 : 100, el ? el.bottom : 100);
    }
  };
  return <div className="git-branches" data-feedback-region="Git 브랜치 패널">
    <div className="git-branches-tools">{toolbar}</div>
    <input className="git-branch-search" type="search" placeholder="브랜치 검색" value={query} onChange={event => setQuery(event.target.value)} aria-label="브랜치 검색" />
    <div className="git-branch-tree" role="tree" aria-label="브랜치" tabIndex={0} onKeyDown={onKey}>
      <div className="git-branch-group head"><b>HEAD (현재 브랜치)</b></div>
      {current ? row(current, current.name, 1, 'head') : <div className="git-branch detached" style={{ paddingLeft: 22 }}><Icon name="alert" size={12} />{detached ? 'Detached HEAD' : '커밋 없음'}</div>}
      {render(sections, 0)}
      {!sections.length && searching && <p className="hint">일치하는 브랜치가 없습니다.</p>}
    </div>
  </div>;
}
export function TagGlyph({ color }: { color?: string }) {
  return <svg className="tag-glyph" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 2.2C1 1.5 1.5 1 2.2 1h3.6l5.2 5.2-4.8 4.8L1 5.8z" fill={color ?? 'currentColor'} /><circle cx="3.6" cy="3.6" r="1" fill="var(--bg)" /></svg>;
}
