import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type Dispatch, type KeyboardEvent, type MouseEvent, type SetStateAction } from 'react';
import { basename } from './api';
import { errorText } from './errors';
import { FileIcon } from './FileIcon';
import { closeAll, PopupMenu, type MenuEntry } from './GitMenu';
import { Icon, IconButton } from './Icon';
import { copyText } from './toast';
import { recordCopy, registerSendSource, requestSendToChat } from './send-to-chat';
import type { SendPayload } from './chat-send';
import { useActionKeys } from './shortcuts';

type Entry = { name: string; folder: boolean };
type Move = { from: string; to: string };
type DroppedMove = { from: string | null; to: string };
type DesktopDrop = (files: File[], projectId: string, dir: string, dirty: string[]) => Promise<{ moved: DroppedMove[]; error?: string }>;
// What the tree asks of the workspace: its dialogs, which open files have unsaved edits, tabs that follow a moved file, and a nudge for the open listings to reload.
export type TreeHost = {
  confirm(message: string): Promise<boolean>; input(title: string, initial?: string): Promise<string | null>;
  dirty(paths: string[]): string[]; moved(moves: Move[]): void; changed(paths: string[]): void; openWith(path: string, folder: boolean): void;
};
type TreeContext = {
  visible: boolean; selected: string; picked: Set<string>; cut: Set<string>; dropOn: string; expanded: Set<string>;
  prefetched: Map<string, Entry[]>;
  select(path: string, folder: boolean): void; toggle(path: string): void; open(path: string): void;
  press(event: MouseEvent, path: string): void; click(event: MouseEvent, path: string): void; menu(event: MouseEvent, path: string, folder: boolean): void;
  dragStart(event: DragEvent, path: string): void; dragOver(event: DragEvent, path: string, folder: boolean): void; drop(event: DragEvent, path: string, folder: boolean): void; dragEnd(): void;
  call<T>(action: string, input: object): Promise<T>;
  watch(listener: (paths: string[]) => void): () => void;
};
const alphabetical = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
const childPath = (parent: string, name: string) => parent === '.' ? name : `${parent}/${name}`;
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const modKey = mac ? '⌘' : 'Ctrl+';
// `path` is `folder` or somewhere under it ('.' is the project folder, which holds everything).
const inside = (path: string, folder: string) => folder === '.' || path === folder || path.startsWith(`${folder}/`);
// A selected folder already carries what is selected under it.
const topLevel = (paths: string[]) => paths.filter(path => !paths.some(other => other !== path && inside(path, other)));
const remapPath = (path: string, moves: Move[]) => { const hit = moves.find(({ from }) => inside(path, from)); return hit ? hit.to + path.slice(hit.from.length) : path; };
// Dropping onto the folder the items already sit in changes nothing (for a move), and nothing goes into itself.
const droppable = (paths: string[], dest: string, copy: boolean) => paths.every(path => !inside(dest, path)) && (copy || paths.some(path => parentOf(path) !== dest));
const where = (dir: string) => dir === '.' ? '프로젝트 루트' : dir;
const listOf = (paths: string[]) => [...paths.slice(0, 8).map(path => `• ${path}`), paths.length > 8 && `외 ${paths.length - 8}개`].filter(Boolean).join('\n');

function TreeRow({ path, name, folder, depth, ctx }: { path: string; name: string; folder: boolean; depth: number; ctx: TreeContext }) {
  const expanded = folder && ctx.expanded.has(path);
  return <div role="treeitem" aria-label={name} aria-expanded={folder ? expanded : undefined} aria-selected={ctx.picked.has(path)}
    tabIndex={ctx.selected === path ? 0 : -1} data-path={path} data-parent={parentOf(path)} style={{ '--depth': depth } as CSSProperties} onFocus={event => {
      if (event.target === event.currentTarget) ctx.select(path, folder);
    }}>
    <div className={`project-tree-row${ctx.cut.has(path) ? ' cut' : ''}${ctx.dropOn === path ? ' drop' : ''}`} title={path === '.' ? name : path} draggable={path !== '.'}
      onMouseDown={event => ctx.press(event, path)} onClick={event => ctx.click(event, path)} onContextMenu={event => ctx.menu(event, path, folder)}
      onDragStart={event => ctx.dragStart(event, path)} onDragOver={event => ctx.dragOver(event, path, folder)} onDrop={event => ctx.drop(event, path, folder)} onDragEnd={ctx.dragEnd}
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

export function ProjectTree({ projectId, root, visible, open, expanded, setExpanded, onClose, call, watch, onOpen, host }: {
  projectId: string; root: string; visible: boolean; open: boolean; expanded: Set<string>; setExpanded: Dispatch<SetStateAction<Set<string>>>;
  onClose(): void; call: TreeContext['call']; watch: TreeContext['watch']; onOpen(path: string): void; host: TreeHost;
}) {
  // `selection` is the row with the keyboard focus (the "lead"); `picked` is everything selected, as the rows draw it. The same facts live in `live` too so a handler that
  // runs before React re-renders (focus fires inside the mouse-down that just changed the selection) reads the newest value.
  const [selection, setSelection] = useState({ path: '.', folder: true });
  const [picked, setPicked] = useState(() => new Set(['.']));
  const [clip, setClip] = useState<{ paths: string[]; cut: boolean } | null>(null);
  const [dropOn, setDropOn] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; paths: string[]; dir: string; lone: { path: string; folder: boolean } | null } | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [notice, setNotice] = useState('');
  const [width, setWidth] = useState(272);
  const prefetched = useRef(new Map<string, Entry[]>());
  const expansion = useRef<AbortController | null>(null);
  const search = useRef({ value: '', at: 0 });
  const rootRow = useRef<HTMLDivElement>(null);
  const live = useRef({ picked: new Set(['.']), anchor: '.', pointer: false, drag: null as string[] | null, hover: { path: '', timer: undefined as ReturnType<typeof setTimeout> | undefined } });
  const selected = selection.path, scope = selection.folder ? selected : '.';
  const pick = (paths: Iterable<string>) => { live.current.picked = new Set(paths); setPicked(live.current.picked); };
  // Focus (a click, the arrow keys) selects the row alone, unless the selection was just built on purpose (modifier click, Shift+arrow) or is being dragged.
  const select = (path: string, folder: boolean) => {
    setSelection({ path, folder });
    if (!live.current.pointer && !live.current.picked.has(path)) { pick([path]); live.current.anchor = path; }
  };
  useEffect(() => {
    if (!visible || !open) return;
    const cache = prefetched.current;
    return () => { expansion.current?.abort(); cache.clear(); setNotice(''); };
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
    setNotice('');
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
    setNotice('');
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
      if (!controller.signal.aborted) setNotice((cause as Error).message);
    } finally {
      expansion.current = null;
      setExpanding(false);
    }
  }

  // ---- file operations (menu, keys and drag and drop all end up here) ----
  const rows = () => [...(rootRow.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
  // A dialog or menu that ends gives the focus back to the selected row, so the keyboard keeps working (and a new file opens with the cursor in it).
  const back = () => rootRow.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  const confirm = async (message: string) => { const answer = await host.confirm(message); back(); return answer; };
  const input = async (title: string, initial?: string) => { const answer = await host.input(title, initial); back(); return answer; };
  const absolute = (path: string) => path === '.' ? root : `${root.replace(/[\\/]+$/, '')}/${path}`;
  async function attempt(task: () => Promise<void>) {
    setNotice('');
    try { await task(); } catch (cause) { setNotice(errorText(cause)); }
  }
  const unsavedIn = (paths: string[]) => {
    const unsaved = host.dirty(paths);
    if (unsaved.length) throw new Error(`저장하지 않은 변경 사항이 있는 파일이 있어 옮길 수 없습니다. 먼저 저장하세요: ${unsaved.map(basename).join(', ')}`);
  };
  // Read before an operation changes the rows: whether a listed path is a folder (only folders carry aria-expanded).
  const isFolder = (path: string) => rows().some(row => row.dataset.path === path && row.hasAttribute('aria-expanded'));
  // Where the moved or copied items end up: selected, and their folder open so they can be seen.
  const reveal = (paths: string[], folder: boolean, dir: string, changed: string[]) => {
    setExpanded(previous => new Set([...previous, dir]));
    host.changed(changed);
    pick(paths); live.current.anchor = paths[0];
    setSelection({ path: paths[0], folder });
  };
  async function create(dir: string, folder: boolean) {
    const typed = await input(`${folder ? '새 폴더' : '새 파일'} 이름\n${where(dir)} 안에 만듭니다. a/b.txt처럼 쓰면 중간 폴더도 함께 만듭니다.`, '');
    const name = typed?.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!name) return;
    const path = childPath(dir, name);
    await attempt(async () => {
      await call('files/create', { path, folder });
      const parts = path.split('/'), made = parts.slice(0, -1).map((_, at) => parts.slice(0, at + 1).join('/'));
      setExpanded(previous => new Set([...previous, dir, ...made]));
      host.changed([path, ...made]);
      pick([path]); live.current.anchor = path;
      setSelection({ path, folder });
      if (!folder) onOpen(path);
    });
  }
  async function rename(path: string) {
    const typed = await input(`이름 바꾸기\n${path}`, basename(path));
    const name = typed?.trim();
    if (!name || name === basename(path)) return;
    await attempt(async () => {
      if (/[\\/]/.test(name)) throw new Error('이름에는 /를 쓸 수 없습니다. 다른 폴더로 옮기려면 끌어다 놓으세요.');
      const moves = [{ from: path, to: childPath(parentOf(path), name) }], folder = isFolder(path);
      unsavedIn([path]);
      await call('files/move', { moves });
      host.moved(moves);
      setExpanded(previous => new Set([...previous].map(item => remapPath(item, moves))));
      reveal([moves[0].to], folder, parentOf(path), [path, moves[0].to]);
    });
  }
  async function transfer(sources: string[], dest: string, copy: boolean, ask: boolean) {
    const list = topLevel(sources.filter(path => path !== '.'));
    await attempt(async () => {
      const moves = list.filter(from => parentOf(from) !== dest).map(from => ({ from, to: childPath(dest, basename(from)) }));
      if (!copy && !moves.length) return;
      const folder = isFolder(copy ? list[0] : moves[0].from);
      if (!copy) unsavedIn(moves.map(move => move.from));
      if (ask && !(await confirm(`${dest === '.' ? '프로젝트 루트' : `"${dest}" 폴더`}로 ${copy ? '복사' : '이동'}할까요?\n${listOf(copy ? list : moves.map(move => move.from))}`))) return;
      if (copy) {
        const { created } = await call<{ created: string[] }>('files/copy', { paths: list, dir: dest });
        reveal(created, folder, dest, [dest]);
      } else {
        await call('files/move', { moves });
        host.moved(moves);
        setExpanded(previous => new Set([...previous].map(item => remapPath(item, moves))));
        reveal(moves.map(move => move.to), folder, dest, moves.flatMap(move => [move.from, move.to]));
        setClip(null);
      }
    });
  }
  const moveDroppedFiles = (window as unknown as { adeDesktop?: { moveDroppedFiles?: DesktopDrop } }).adeDesktop?.moveDroppedFiles;
  async function transferDrop(files: File[], dest: string) {
    if (!moveDroppedFiles || !files.length) return;
    await attempt(async () => {
      if (!(await confirm(`${where(dest)}(으)로 이동할까요?\n${listOf(files.map(file => file.name))}`))) return;
      const { moved, error } = await moveDroppedFiles(files, projectId, dest, host.dirty(['.']));
      if (moved.length) {
        const localMoves = moved.filter((move): move is Move => move.from !== null);
        if (localMoves.length) host.moved(localMoves);
        reveal(moved.map(move => move.to), false, dest, moved.flatMap(({ from, to }) => from === null ? [to] : [from, to]));
      }
      if (error) setNotice(error);
    });
  }
  async function remove(sources: string[]) {
    const list = topLevel(sources.filter(path => path !== '.'));
    if (!list.length) return;
    const folders = new Map(rows().map(row => [row.dataset.path, row.hasAttribute('aria-expanded')]));
    const unsaved = host.dirty(list);
    const detail = [listOf(list), list.some(path => folders.get(path)) ? '폴더 안의 모든 파일도 함께 삭제되며 되돌릴 수 없습니다.' : '되돌릴 수 없습니다.',
      unsaved.length && `저장하지 않은 변경 사항이 있는 열린 파일: ${unsaved.map(basename).join(', ')}`].filter(Boolean).join('\n');
    if (!(await confirm(`${list.length === 1 ? `"${basename(list[0])}"` : `${list.length}개 항목`} 삭제할까요?\n${detail}`))) return;
    await attempt(async () => {
      await call('files/delete', { paths: list });
      setExpanded(previous => new Set([...previous].filter(item => !list.some(path => inside(item, path)))));
      host.changed(list);
      const parent = parentOf(list[0]);
      pick([parent]); live.current.anchor = parent;
      setSelection({ path: parent, folder: true });
      if (clip?.paths.some(path => list.some(gone => inside(path, gone)))) setClip(null);
    });
  }
  const copyPaths = (paths: string[], cut: boolean) => { setClip({ paths: topLevel(paths.filter(path => path !== '.')), cut }); clipPaths(paths); };
  // 채팅으로 보내기 / 참조로 붙여넣기: the picked rows as `@path` mentions. A copy also puts their absolute paths on the clipboard (like a file
  // manager does), and pasting that into a chat inserts the mentions instead (send-to-chat.ts).
  const pathsPayload = (all: string[]): SendPayload | null => { const paths = all.filter(path => path !== '.'); return paths.length ? { kind: 'paths', paths: paths.map(path => ({ path, base: 'project', ...(isFolder(path) && { folder: true }) })) } : null; };
  const clipPaths = (paths: string[]) => { const payload = pathsPayload(topLevel(paths)); if (payload?.kind !== 'paths') return; const text = payload.paths.map(item => absolute(item.path)).join('\n'); copyText(text); recordCopy(text, payload); };
  const sendKeys = useActionKeys('sendToChat');
  useEffect(() => { const list = rootRow.current; if (list) return registerSendSource(list, () => pathsPayload([...live.current.picked]), '보낼 파일이나 폴더를 먼저 선택하세요.'); }, []);
  const paste = (dir: string) => { if (clip) void transfer(clip.paths, dir, !clip.cut, false); };
  // Where a new item or a paste goes: the selected folder, or the folder of the selected file.
  const targetDir = () => selection.folder ? selection.path : parentOf(selection.path);

  // ---- selection with the mouse ----
  function press(event: MouseEvent, path: string) {
    if (event.button !== 0 && event.button !== 2) return;
    const state = live.current;
    // On a Mac, Ctrl+click is a right click (the system sends the context menu too), so ⌘ is the multi-select key there.
    const secondary = event.button === 2 || (mac && event.ctrlKey), additive = event.metaKey || (!mac && event.ctrlKey);
    if (secondary) { if (!state.picked.has(path)) { pick([path]); state.anchor = path; } }
    else if (event.shiftKey) {
      const order = rows().map(row => row.dataset.path!), from = order.indexOf(state.anchor), to = order.indexOf(path);
      if (from >= 0 && to >= 0) pick([...(additive ? state.picked : []), ...order.slice(Math.min(from, to), Math.max(from, to) + 1)]);
    } else if (additive) {
      const next = new Set(state.picked);
      if (!next.delete(path)) next.add(path);
      pick(next); state.anchor = path;
    } else if (!state.picked.has(path)) { pick([path]); state.anchor = path; }
    // A plain press on a selected row keeps the selection so it can be dragged; the click that follows (when it was not a drag) narrows it to this row.
    state.pointer = true;
    event.currentTarget.parentElement?.focus();
    state.pointer = false;
  }
  function click(event: MouseEvent, path: string) {
    if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey) return;
    if (live.current.picked.size > 1 && live.current.picked.has(path)) { pick([path]); live.current.anchor = path; }
  }
  function openMenu(event: MouseEvent, path: string | null, folder = true) {
    event.preventDefault(); event.stopPropagation();
    const state = live.current;
    if (path && !state.picked.has(path)) { pick([path]); state.anchor = path; }
    const paths = path ? [...state.picked] : [];
    setMenu({ x: event.clientX, y: event.clientY, paths, dir: path ? (folder ? path : parentOf(path)) : '.', lone: path && paths.length === 1 ? { path, folder } : null });
  }
  const menuItems = ({ paths, dir, lone }: NonNullable<typeof menu>): MenuEntry[] => {
    const real = paths.filter(path => path !== '.');
    return [
      { label: '새로 만들기', icon: 'plus', items: [
        { label: '파일…', icon: 'fileNew', run: () => void create(dir, false) },
        { label: '폴더…', icon: 'folderPlus', run: () => void create(dir, true) }] },
      'separator',
      { label: '잘라내기', icon: 'cut', keys: `${modKey}X`, disabled: !real.length, run: () => copyPaths(real, true) },
      { label: '복사', icon: 'copy', keys: `${modKey}C`, disabled: !real.length, run: () => copyPaths(real, false) },
      { label: '붙여넣기', icon: 'paste', keys: `${modKey}V`, disabled: !clip, run: () => paste(dir) },
      { label: '채팅으로 보내기', icon: 'send', keys: sendKeys, disabled: !paths.filter(path => path !== '.').length, run: () => requestSendToChat(() => pathsPayload(paths)) },
      { label: '경로 복사', icon: 'link', disabled: !paths.length, items: [
        { label: '절대 경로', run: () => copyText(paths.map(absolute).join('\n')) },
        { label: '프로젝트 기준 경로', run: () => copyText(paths.join('\n')) },
        { label: '파일 이름', run: () => copyText(paths.map(path => path === '.' ? basename(root) : basename(path)).join('\n')) }] },
      'separator',
      { label: '이름 바꾸기…', icon: 'edit', keys: 'F2', disabled: real.length !== 1, run: () => void rename(real[0]) },
      { label: '삭제…', icon: 'trash', keys: mac ? '⌘⌫' : 'Delete', danger: true, disabled: !real.length, run: () => void remove(real) },
      'separator',
      !!lone && { label: mac ? 'Finder에서 보기' : '파일 관리자에서 보기', icon: 'folderOpen', run: () => void attempt(async () => { await call('ide/open', { ide: 'files', path: lone.path }); }) },
      !!lone && { label: '다른 프로그램에서 열기…', icon: 'externalLink', run: () => host.openWith(lone.path, lone.folder) },
      { label: '새로고침', icon: 'refresh', run: () => host.changed([]) }
    ];
  };

  // ---- drag and drop: a move always asks first; Option/Alt copies instead ----
  const clearHover = () => {
    const { hover } = live.current;
    clearTimeout(hover.timer); hover.path = '';
    setDropOn('');
  };
  const clearDrag = () => { live.current.drag = null; clearHover(); };
  function dragStart(event: DragEvent, path: string) {
    const state = live.current;
    if (!state.picked.has(path)) { pick([path]); state.anchor = path; }
    state.drag = topLevel([...state.picked].filter(item => item !== '.'));
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/plain', state.drag.join('\n'));
  }
  function dragOver(event: DragEvent, path: string, folder: boolean) {
    const state = live.current;
    if (!state.drag && !(moveDroppedFiles && event.dataTransfer.types.includes('Files'))) return;
    event.stopPropagation();
    const dest = folder ? path : parentOf(path);
    if (state.drag && !droppable(state.drag, dest, event.altKey)) { clearHover(); return; }
    event.preventDefault();
    // Keep the native source intact while the confirmation is open. The app performs the move itself.
    event.dataTransfer.dropEffect = !state.drag || event.altKey ? 'copy' : 'move';
    setDropOn(dest);
    // A closed folder under the pointer opens after a moment, so the drop can go deeper.
    const hover = state.hover, target = folder ? path : '';
    if (hover.path !== target) {
      clearTimeout(hover.timer); hover.path = target;
      if (target && !expanded.has(target)) hover.timer = setTimeout(() => setExpanded(previous => new Set(previous).add(target)), 700);
    }
  }
  function drop(event: DragEvent, path: string, folder: boolean) {
    const paths = live.current.drag;
    const files = moveDroppedFiles && !paths ? [...event.dataTransfer.files] : [];
    if (!paths && !files.length) { clearHover(); return; }
    event.preventDefault(); event.stopPropagation();
    const dest = folder ? path : parentOf(path), copy = event.altKey;
    clearDrag();
    if (!paths) void transferDrop(files, dest);
    else if (droppable(paths, dest, copy)) void transfer(paths, dest, copy, true);
  }

  const ctx: TreeContext = { expanded, selected, picked, cut: new Set(clip?.cut ? clip.paths : []), dropOn, select, toggle, press, click, menu: (event, path, folder) => openMenu(event, path, folder), dragStart, dragOver, drop, dragEnd: clearDrag,
    prefetched: prefetched.current, visible: visible && open, call, watch, open: onOpen };
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const item = event.target as HTMLElement;
    const current = item.dataset.path;
    if (!current) return;
    const list = rows(), state = live.current, mod = mac ? event.metaKey : event.ctrlKey;
    const index = list.indexOf(item), folder = item.hasAttribute('aria-expanded'), open = expanded.has(current);
    const targets = [...state.picked];
    // Editing keys act on everything selected; typing a letter below only searches.
    if (mod && !event.altKey && !event.shiftKey && ['a', 'c', 'x', 'v'].includes(event.key.toLowerCase())) {
      const key = event.key.toLowerCase();
      if (key === 'a') pick(list.map(row => row.dataset.path!));
      else if (key === 'v') paste(selection.folder ? selection.path : parentOf(selection.path));
      else copyPaths(targets, key === 'x');
      event.preventDefault(); event.stopPropagation();
      return;
    }
    if (event.key === 'F2' || (event.key === 'F6' && event.shiftKey)) { if (current !== '.') void rename(current); event.preventDefault(); event.stopPropagation(); return; }
    if (event.key === 'Delete' || (event.key === 'Backspace' && !event.nativeEvent.isComposing)) { void remove(targets); event.preventDefault(); event.stopPropagation(); return; }
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const box = item.querySelector('.project-tree-row')!.getBoundingClientRect();
      if (!state.picked.has(current)) { pick([current]); state.anchor = current; }
      setMenu({ x: box.left + 24, y: box.bottom, paths: [...state.picked], dir: folder ? current : parentOf(current), lone: state.picked.size === 1 ? { path: current, folder } : null });
      event.preventDefault(); event.stopPropagation();
      return;
    }
    if (event.key === 'Escape') {
      if (clip) setClip(null); else if (state.picked.size > 1) pick([current]); else return;
      event.preventDefault(); event.stopPropagation();
      return;
    }
    let next: HTMLElement | undefined;
    switch (event.key) {
      case 'ArrowDown': next = list[index + 1]; break;
      case 'ArrowUp': next = list[index - 1]; break;
      case 'Home': next = list[0]; break;
      case 'End': next = list.at(-1); break;
      case 'ArrowRight': if (folder && !open) toggle(current); else if (folder && list[index + 1]?.dataset.parent === current) next = list[index + 1]; break;
      case 'ArrowLeft': if (folder && open) toggle(current); else if (current !== '.') next = list.find(row => row.dataset.path === item.dataset.parent); break;
      case 'Enter': if (folder) toggle(current); else onOpen(current); break;
      case ' ': if (folder) toggle(current); else return; break;
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
        const now = Date.now(), value = (now - search.current.at < 750 ? search.current.value : '') + event.key.toLocaleLowerCase();
        search.current = { value, at: now };
        next = [...list.slice(index + 1), ...list.slice(0, index + 1)].find(row => row.getAttribute('aria-label')?.toLocaleLowerCase().startsWith(value));
      }
    }
    // Shift with a vertical move grows the selection from where it started; any other move selects just the row it lands on.
    if (next && event.shiftKey && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const order = list.map(row => row.dataset.path!), from = order.indexOf(state.anchor), to = order.indexOf(next.dataset.path!);
      if (from >= 0) pick(order.slice(Math.min(from, to), Math.max(from, to) + 1));
    } else if (next) { pick([next.dataset.path!]); state.anchor = next.dataset.path!; }
    event.preventDefault();
    event.stopPropagation();
    next?.focus();
  }

  const closeMenu = () => { setMenu(null); back(); };
  const resize = (value: number) => setWidth(Math.max(160, Math.min(600, value)));
  return <aside className="project-tree" aria-label="프로젝트 파일" hidden={!open} style={{ '--project-width': `${width}px` } as CSSProperties}>
    <header>
      <span>프로젝트</span>
      <IconButton icon="collapseAll" label={scope === '.' ? '모두 접기' : '선택 폴더 모두 접기'} onClick={collapseAll} />
      <IconButton icon="expandAll" label={scope === '.' ? '모두 펼치기' : '선택 폴더 모두 펼치기'} disabled={expanding} onClick={() => void expandAll()} />
      <IconButton icon="x" label="파일 트리 닫기" onClick={onClose} />
    </header>
    {expanding && <div className="project-tree-message" role="status">폴더 펼치는 중…</div>}
    {notice && <div className="project-tree-message project-tree-notice" role="alert" title="눌러서 닫기" onClick={() => setNotice('')}>{notice}</div>}
    <div className="project-tree-list" role="tree" aria-label="프로젝트 파일 트리" aria-busy={expanding} aria-multiselectable="true" ref={rootRow} onKeyDown={navigate}
      onContextMenu={event => openMenu(event, null)} onDragOver={event => dragOver(event, '.', true)} onDrop={event => drop(event, '.', true)}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearHover(); }}>
      <TreeRow path="." name={basename(root)} folder depth={0} ctx={ctx} />
    </div>
    {menu && <PopupMenu x={menu.x} y={menu.y} items={closeAll(menuItems(menu), closeMenu)} label="파일 메뉴" onClose={closeMenu} />}
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
