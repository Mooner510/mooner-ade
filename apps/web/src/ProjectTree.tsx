import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type KeyboardEvent, type SetStateAction } from 'react';
import { basename } from './api';
import { FileIcon } from './FileIcon';
import { Icon, IconButton } from './Icon';

type Entry = { name: string; folder: boolean };
type TreeContext = {
  visible: boolean; selected: string; expanded: Set<string>;
  prefetched: Map<string, Entry[]>;
  select(path: string, folder: boolean): void; toggle(path: string): void; open(path: string): void;
  call<T>(action: string, input: object): Promise<T>;
  watch(listener: (paths: string[]) => void): () => void;
};
const alphabetical = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
const childPath = (parent: string, name: string) => parent === '.' ? name : `${parent}/${name}`;

function TreeRow({ path, name, folder, depth, ctx }: { path: string; name: string; folder: boolean; depth: number; ctx: TreeContext }) {
  const expanded = folder && ctx.expanded.has(path);
  return <div role="treeitem" aria-label={name} aria-expanded={folder ? expanded : undefined} aria-selected={ctx.selected === path}
    tabIndex={ctx.selected === path ? 0 : -1} data-path={path} data-parent={parentOf(path)} style={{ '--depth': depth } as CSSProperties} onFocus={event => {
      if (event.target === event.currentTarget) ctx.select(path, folder);
    }}>
    <div className="project-tree-row" title={path === '.' ? name : path}
      onMouseDown={event => { if (event.button === 0) event.currentTarget.parentElement?.focus(); }}
      onDoubleClick={() => folder ? ctx.toggle(path) : ctx.open(path)}>
      <span className="project-tree-chevron" aria-hidden="true" onClick={event => {
        if (folder && event.detail === 1) ctx.toggle(path);
      }} onDoubleClick={event => event.stopPropagation()}>
        {folder && <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={15} />}
      </span>
      <FileIcon name={name} folder={folder} />
      <span className="project-tree-name">{name}</span>
    </div>
    {expanded && <Directory path={path} depth={depth + 1} ctx={ctx} />}
  </div>;
}

function Directory({ path, depth, ctx }: { path: string; depth: number; ctx: TreeContext }) {
  const [entries, setEntries] = useState<Entry[]>();
  const [error, setError] = useState('');
  const { watch, call, visible, prefetched } = ctx;
  useEffect(() => {
    if (!visible) return;
    let live = true, running = false, again = false;
    const show = (entries: Entry[]) => {
      entries.sort((a, b) => Number(b.folder) - Number(a.folder) || alphabetical.compare(a.name, b.name));
      setEntries(previous => previous?.length === entries.length && previous.every((entry, index) =>
        entry.name === entries[index].name && entry.folder === entries[index].folder) ? previous : entries);
      setError('');
    };
    const load = async () => {
      if (running) { again = true; return; }
      running = true;
      try {
        const { entries } = await call<{ entries: Entry[] }>('files/directory', { path });
        if (live) show(entries);
      } catch (cause) {
        if (live) setError((cause as Error).message);
      } finally {
        running = false;
        if (live && again) { again = false; void load(); }
      }
    };
    const ready = prefetched.get(path);
    if (ready) { prefetched.delete(path); show(ready); }
    else void load();
    const unsubscribe = watch(paths => {
      if (!paths.length || paths.some(changed => changed === path || parentOf(changed) === path || path.startsWith(`${changed}/`))) void load();
    });
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { live = false; unsubscribe(); clearInterval(timer); };
  }, [path, visible, watch, call, prefetched]);
  return <div role="group">
    {error ? <div className="project-tree-message" role="status">{error}</div> : entries?.map(entry =>
      <TreeRow key={entry.name} path={childPath(path, entry.name)} name={entry.name} folder={entry.folder} depth={depth} ctx={ctx} />)}
  </div>;
}

export function ProjectTree({ root, visible, open, expanded, setExpanded, onClose, call, watch, onOpen }: {
  root: string; visible: boolean; open: boolean; expanded: Set<string>; setExpanded: Dispatch<SetStateAction<Set<string>>>;
  onClose(): void; call: TreeContext['call']; watch: TreeContext['watch']; onOpen(path: string): void;
}) {
  const [selection, setSelection] = useState({ path: '.', folder: true });
  const [expanding, setExpanding] = useState(false);
  const [expandError, setExpandError] = useState('');
  const [width, setWidth] = useState(272);
  const prefetched = useRef(new Map<string, Entry[]>());
  const expansion = useRef<AbortController | null>(null);
  const search = useRef({ value: '', at: 0 });
  const rootRow = useRef<HTMLDivElement>(null);
  const selected = selection.path, scope = selection.folder ? selected : '.';
  const select = (path: string, folder: boolean) => setSelection({ path, folder });
  useEffect(() => {
    if (!visible || !open) return;
    const cache = prefetched.current;
    return () => { expansion.current?.abort(); cache.clear(); setExpandError(''); };
  }, [visible, open]);
  const toggle = (path: string) => {
    expansion.current?.abort();
    const next = new Set(expanded);
    if (next.delete(path)) {
      if (path === '.' || selected.startsWith(`${path}/`)) select(path, true);
    } else next.add(path);
    setExpanded(next);
  };
  function collapseAll() {
    expansion.current?.abort();
    prefetched.current.clear();
    setExpandError('');
    if (scope === '.') {
      select('.', true);
      setExpanded(new Set(['.']));
      rootRow.current?.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
    } else {
      setExpanded(previous => new Set([...previous].filter(path => path !== scope && !path.startsWith(`${scope}/`))));
    }
  }
  async function expandAll() {
    const controller = new AbortController();
    expansion.current = controller;
    setExpanding(true);
    setExpandError('');
    const folders = [scope];
    const listings = new Map<string, Entry[]>();
    try {
      for (const path of folders) {
        if (controller.signal.aborted) return;
        try {
          const { entries } = await call<{ entries: Entry[] }>('files/directory', { path });
          if (!expanded.has(path)) listings.set(path, entries);
          for (const entry of entries) if (entry.folder) folders.push(childPath(path, entry.name));
        } catch (cause) {
          // A descendant can disappear or become unreadable while the other branches are being expanded.
          if (path === scope) throw cause;
        }
      }
      if (controller.signal.aborted) return;
      for (const [path, entries] of listings) prefetched.current.set(path, entries);
      setExpanded(previous => new Set([...previous, ...folders]));
    } catch (cause) {
      if (!controller.signal.aborted) setExpandError((cause as Error).message);
    } finally {
      expansion.current = null;
      setExpanding(false);
    }
  }
  const ctx: TreeContext = { expanded, selected, select, toggle, prefetched: prefetched.current, visible: visible && open, call, watch, open: onOpen };
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const item = event.target as HTMLElement;
    const current = item.dataset.path;
    if (!current) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const index = rows.indexOf(item), folder = item.hasAttribute('aria-expanded'), open = expanded.has(current);
    let next: HTMLElement | undefined;
    switch (event.key) {
      case 'ArrowDown': next = rows[index + 1]; break;
      case 'ArrowUp': next = rows[index - 1]; break;
      case 'Home': next = rows[0]; break;
      case 'End': next = rows.at(-1); break;
      case 'ArrowRight': if (folder && !open) toggle(current); else if (folder && rows[index + 1]?.dataset.parent === current) next = rows[index + 1]; break;
      case 'ArrowLeft': if (folder && open) toggle(current); else if (current !== '.') next = rows.find(row => row.dataset.path === item.dataset.parent); break;
      case 'Enter': if (folder) toggle(current); else onOpen(current); break;
      case ' ': if (folder) toggle(current); else return; break;
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
        const now = Date.now(), value = (now - search.current.at < 750 ? search.current.value : '') + event.key.toLocaleLowerCase();
        search.current = { value, at: now };
        next = [...rows.slice(index + 1), ...rows.slice(0, index + 1)].find(row => row.getAttribute('aria-label')?.toLocaleLowerCase().startsWith(value));
      }
    }
    event.preventDefault();
    event.stopPropagation();
    next?.focus();
  }

  const resize = (value: number) => setWidth(Math.max(160, Math.min(600, value)));
  return <aside className="project-tree" aria-label="프로젝트 파일" hidden={!open} style={{ '--project-width': `${width}px` } as CSSProperties}>
    <header>
      <span>프로젝트</span>
      <IconButton icon="collapseAll" label={scope === '.' ? '모두 접기' : '선택 폴더 모두 접기'} onClick={collapseAll} />
      <IconButton icon="expandAll" label={scope === '.' ? '모두 펼치기' : '선택 폴더 모두 펼치기'} disabled={expanding} onClick={() => void expandAll()} />
      <IconButton icon="x" label="파일 트리 닫기" onClick={onClose} />
    </header>
    {expanding && <div className="project-tree-message" role="status">폴더 펼치는 중…</div>}
    {expandError && <div className="project-tree-message" role="alert">{expandError}</div>}
    <div className="project-tree-list" role="tree" aria-label="프로젝트 파일 트리" aria-busy={expanding} ref={rootRow} onKeyDown={navigate}>
      <TreeRow path="." name={basename(root)} folder depth={0} ctx={ctx} />
    </div>
    <div className="project-tree-resize" role="separator" aria-label="파일 트리 너비" aria-orientation="vertical"
      aria-valuemin={160} aria-valuemax={600} aria-valuenow={width} tabIndex={0}
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault(); resize(width + (event.key === 'ArrowLeft' ? -20 : 20));
      }}
      onPointerDown={event => {
        event.preventDefault();
        const handle = event.currentTarget, start = event.clientX;
        const initial = handle.parentElement!.getBoundingClientRect().width;
        handle.setPointerCapture(event.pointerId);
        const move = (event: PointerEvent) => resize(initial + event.clientX - start);
        handle.addEventListener('pointermove', move);
        handle.addEventListener('lostpointercapture', () => handle.removeEventListener('pointermove', move), { once: true });
      }} />
  </aside>;
}
