import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { api, ApiError, basename, editorLeaf, equalize, findLeaf, isDiffTab, leafList, leaves, mapLeaf, newId, pruneDead, remove, split, type Leaf, type Pane } from './api';
import { disposeModel, DiffView, type Reveal, type Settings } from './Editor';
import { Icon, IconButton, type IconName } from './Icon';
import { Panes, Splitter, type Agent, type AgentEventKind, type EditorCtx, type TerminalBus } from './Panes';
import { detectAgent, resolveAgent } from './terminal-agent';
import { QuickInput, type QuickItem, type QuickRequest } from './QuickInput';
import { ReviewPanel } from './Review';
import { Dropdown, Modal, type Ask, type GitState } from './views';

// The app shell owns the single websocket; each open project subscribes to it and receives only its own messages.
export type Hub = { subscribe(projectId: string, handler: (message: any) => void, cursors: () => Record<string, number>): () => void; send(message: object): boolean };
export type AgentAlert = { kind: AgentEventKind; agent: Agent; tabId: string; paneId: string; name: string };
export type PaneInfo = { id: string; label: string; kind: 'terminal' | 'editor'; agent?: Agent; attention: boolean; asking: boolean; working: boolean; focused: boolean };
export type TabInfo = { id: string; label: string; count: number; panes: PaneInfo[]; agent?: Agent; attention: boolean; asking: boolean; working: boolean };
export type WorkspaceStatus = { id: string; name: string; loaded: boolean; attention: number; dirty: number; tabs: TabInfo[]; activeTab: string };
// The shell lists every project's tabs in its sidebar, so a project exposes them here instead of drawing its own tab strip.
export type WorkspaceHandle = { requestClose(): Promise<boolean>; selectTab(id: string): void; selectPane(tabId: string, paneId: string): void; closePane(paneId: string): void; moveTab(id: string, targetId: string, after: boolean): void; mergeTabs(id: string, targetId: string): void; movePane(tabId: string, paneId: string, targetId: string | undefined, mode: 'before' | 'after' | 'merge'): void; closeTab(id: string): void; newTab(): void; renameTab(id: string): void; launcher(): void };
export type Command = { id: string; label: string; keys?: string; hidden?: boolean; run(): void | Promise<unknown> };
export type SystemInfo = { cpu: number; cores: number; memory: { total: number; used: number }; uptime: number; platform: string; hostname: string };
type WorkspaceProps = {
  root: string; active: boolean; hub: Hub; connection: string; settings: Settings; setSettings: Dispatch<SetStateAction<Settings>>; projectCommands: Command[]; system: SystemInfo | null;
  onLegacySettings(settings: Partial<Settings>): void; onStatus(root: string, status: WorkspaceStatus): void; onFailed(root: string, cause: unknown): void; onAddProject(): void; onOpenSettings(): void; onAgentAlert(root: string, alert: AgentAlert): void;
};

type FileTab = { path: string; content: string; saved: string; revision: string; external?: boolean };
type Conversation = { id: string; title: string; agentId: string; model?: string | null; effort?: string | null; closedAt?: number; cwd: string; branch?: string; activeRun?: string; runs: string[]; removed?: boolean };
type Repository = { id: string; name: string; path: string; worktreeEnabled: boolean; worktreePath: string | null; branch: string | null };
type Snapshot = { id: string; root: string; multiRepo: boolean; repositories: Repository[]; conversations: Conversation[]; terminals: { id: string; exited: boolean; cwd?: string }[]; ui: any };
// A Warp-style tab: one pane tree of terminals (and editor panes opened next to them).
type PaneTab = { id: string; title?: string; pane: Pane | null; focus?: string };
const emptyGit: GitState = { branch: '', changes: [], additions: 0, deletions: 0 };
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const launchers: { id: string; label: string; detail: string; command: string; icon: IconName }[] = [
  { id: 'shell', label: '터미널', detail: '기본 셸', command: '', icon: 'terminal' },
  { id: 'claude', label: 'Claude Code', detail: 'claude', command: 'claude', icon: 'claude' },
  { id: 'codex', label: 'Codex', detail: 'codex', command: 'codex', icon: 'codex' }
];
const formatBytes = (bytes: number) => bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)}GB` : `${Math.round(bytes / 2 ** 20)}MB`;
const shortPath = (path: string) => { const clean = path.replace(/\\/g, '/'), parts = clean.split('/').filter(Boolean); return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : clean; };
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(timer); }, []);
  return <span className="stat" title="현재 시각"><Icon name="clock" size={13} />{now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>;
}
export const showKeys = (keys: string) => keys.split('+').map(part => ({ mod: mac ? '⌘' : 'Ctrl', ctrl: mac ? '⌃' : 'Ctrl', shift: mac ? '⇧' : 'Shift', alt: mac ? '⌥' : 'Alt' } as Record<string, string>)[part] || (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))).join(mac ? '' : '+');
function keyOf(event: KeyboardEvent) {
  const code = event.code;
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  return ({ Backquote: '`', Backslash: '\\', Comma: ',', BracketLeft: '[', BracketRight: ']' } as Record<string, string>)[code] || event.key.toLowerCase();
}
function matches(keys: string, event: KeyboardEvent) {
  const parts = keys.split('+'), key = parts[parts.length - 1], mods = new Set(parts.slice(0, -1));
  if (mods.has('mod') ? !(event.ctrlKey || event.metaKey) : mods.has('ctrl') ? !event.ctrlKey || event.metaKey : event.ctrlKey || event.metaKey) return false;
  return event.shiftKey === mods.has('shift') && event.altKey === mods.has('alt') && keyOf(event) === key;
}
export const Workspace = memo(forwardRef<WorkspaceHandle, WorkspaceProps>(function Workspace({ root, active, hub, connection, settings, setSettings, projectCommands, system, onLegacySettings, onStatus, onFailed, onAddProject, onOpenSettings, onAgentAlert }, handleRef) {
  const [error, setError] = useState('');
  const [project, setProject] = useState<Snapshot | null>(null);
  const [health, setHealth] = useState<Record<string, any>>({});
  const [treeVersion, setTreeVersion] = useState(0), [gitVersion, setGitVersion] = useState(0);
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [conflict, setConflict] = useState<{ path: string; content: string; revision: string } | null>(null);
  const [rightVisible, setRightVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false), [termSizes, setTermSizes] = useState<Record<string, string>>({});
  const [git, setGit] = useState<GitState>(emptyGit), [gitRepositoryId, setGitRepositoryId] = useState('');
  const [diffText, setDiffText] = useState<string | null>(null);
  const [paneTabs, setPaneTabs] = useState<PaneTab[]>([]), [activeTab, setActiveTab] = useState('');
  const [focus, setFocus] = useState(''), [zoom, setZoom] = useState('');
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [processAgents, setProcessAgents] = useState<Record<string, Agent | null>>({});
  const [launched, setLaunched] = useState<Record<string, Agent>>({});
  // Completion clears on focus; questions stay marked until the CLI accepts an answer.
  const [attention, setAttention] = useState<Record<string, AgentEventKind>>({});
  const [working, setWorking] = useState<Set<string>>(new Set());
  // Terminals whose shell currently runs an ssh client (reported by the server).
  const [sshSet, setSshSet] = useState<Set<string>>(new Set());
  const clearAttention = (id: string) => setAttention(previous => { if (!(id in previous)) return previous; const { [id]: _gone, ...rest } = previous; return rest; });
  const agentOf = (id: string): Agent | undefined => resolveAgent(processAgents[id], launched[id], titles[id], sshSet.has(id));
  const [widths, setWidths] = useState([18, 52, 30]), [heights] = useState([68, 32]);
  const [reveal, setReveal] = useState<Record<string, Reveal>>({}), [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [quick, setQuick] = useState<{ key: number; request: QuickRequest } | null>(null);
  const [workspaceId, setWorkspaceId] = useState(''), [restoring, setRestoring] = useState(false);
  const refs = {
    workspace: useRef(''), repository: useRef(''), tabs: useRef(tabs), paneTabs: useRef(paneTabs), activeTab: useRef(activeTab), focus: useRef(focus),
    project: useRef(project), lastEditor: useRef(''), commands: useRef<Command[]>([]), checking: useRef(false), quickKey: useRef(0),
    tabFocus: useRef<Record<string, string>>({}), pending: useRef(new Map<string, string>()), active: useRef(active), started: useRef(false), onMessage: useRef<(message: any) => void>(() => {})
  };
  refs.active.current = active;
  refs.workspace.current = workspaceId; refs.repository.current = gitRepositoryId; refs.tabs.current = tabs; refs.paneTabs.current = paneTabs; refs.activeTab.current = activeTab;
  refs.focus.current = focus; refs.project.current = project;
  const cursors = useRef<Record<string, number>>({});
  const bus = useRef<TerminalBus>({ buffers: new Map(), listeners: new Map() });
  const call = useCallback(<T = any,>(action: string, input: object = {}) => api<T>(action, { projectId: refs.project.current?.id, ...(/^(files\/|git\/|terminal\/open)/.test(action) && refs.workspace.current ? { conversationId: refs.workspace.current } : {}), ...(refs.project.current?.multiRepo && /^git\//.test(action) ? { repositoryId: refs.repository.current } : {}), ...input }), []);
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const run = (operation: () => Promise<unknown>) => { setError(''); void operation().catch(report); };
  const refresh = useCallback(async () => { const state = await call<Snapshot>('snapshot'); setProject(state); return state; }, [call]);
  const send = useCallback((message: object) => hub.send({ ...message, projectId: refs.project.current?.id }), [hub]);
  // Models are keyed by the server's real path, which may differ from the path the user typed.
  const rootOf = () => refs.project.current?.root ?? root;
  const ask = useMemo<Ask>(() => ({
    input: (title, initial) => new Promise<string | null>(resolve => setQuick({ key: ++refs.quickKey.current, request: { kind: 'input', title, initial, resolve } })),
    confirm: async message => (await new Promise<string | null>(resolve => setQuick({ key: ++refs.quickKey.current, request: { kind: 'pick', title: message, items: [{ id: 'yes', label: '확인' }, { id: 'no', label: '취소' }], resolve } }))) === 'yes'
  }), []);
  const pick = (title: string, items: QuickItem[]) => new Promise<string | null>(resolve => setQuick({ key: ++refs.quickKey.current, request: { kind: 'pick', title, items, resolve } }));

  // ---- tabs and pane trees ----
  const commitTabs = (next: PaneTab[]) => { refs.paneTabs.current = next; setPaneTabs(next); };
  const activePane = () => refs.paneTabs.current.find(tab => tab.id === refs.activeTab.current)?.pane ?? null;
  const tabOf = (leafId: string) => refs.paneTabs.current.find(tab => findLeaf(tab.pane, leafId));
  const commitTab = (tabId: string, next: Pane | null) => commitTabs(refs.paneTabs.current.map(tab => tab.id === tabId ? { ...tab, pane: next } : tab));
  const commitPane = (next: Pane | null) => commitTab(refs.activeTab.current, next);
  const treeOf = (id: string) => tabOf(id)?.pane ?? null;
  const commitFor = (id: string, next: Pane | null) => commitTab(tabOf(id)?.id ?? refs.activeTab.current, next);
  const trees = () => refs.paneTabs.current.map(tab => tab.pane);
  const focusedLeaf = (): Leaf | undefined => [findLeaf(activePane(), refs.focus.current), findLeaf(activePane(), refs.lastEditor.current)].find(leaf => leaf?.kind === 'editor');
  const activePath = () => { const leaf = focusedLeaf(); return leaf?.active && !isDiffTab(leaf.active) ? leaf.active : ''; };
  const setFocusLeaf = (id: string) => {
    setFocus(id); refs.focus.current = id;
    const owner = tabOf(id); if (owner) refs.tabFocus.current[owner.id] = id;
    if (findLeaf(activePane(), id)?.kind === 'editor') refs.lastEditor.current = id;
  };
  function selectTab(id: string) {
    const tab = refs.paneTabs.current.find(item => item.id === id); if (!tab) return;
    refs.activeTab.current = id; setActiveTab(id); setZoom('');
    const remembered = refs.tabFocus.current[id];
    setFocusLeaf(findLeaf(tab.pane, remembered || '') ? remembered : leaves(tab.pane)[0] || '');
  }
  const nextReveal = (id: string, value: Omit<Reveal, 'nonce'> = {}) => setReveal(previous => ({ ...previous, [id]: { ...value, nonce: Math.random() } }));
  // Empty editor panes disappear.
  function compact(tree: Pane | null): Pane | null {
    let next = tree;
    for (const leaf of leafList(tree)) if (leaf.kind === 'editor' && !(leaf.tabs || []).length) next = next && remove(next, leaf.id);
    return next;
  }
  const isDirty = (path: string) => refs.tabs.current.some(tab => tab.path === path && tab.content !== tab.saved);
  function addTab(leaf: Leaf, path: string, preview: boolean): Leaf {
    const list = leaf.tabs || [];
    if (list.includes(path)) return { ...leaf, active: path, preview: preview || leaf.preview !== path ? leaf.preview : undefined };
    const base = preview && leaf.preview && list.includes(leaf.preview) && !isDirty(leaf.preview) ? list.filter(item => item !== leaf.preview) : list;
    return { ...leaf, tabs: [...base, path], active: path, preview: preview ? path : leaf.preview && base.includes(leaf.preview) ? leaf.preview : undefined };
  }
  function placeTab(path: string, { preview = false, line, column, length }: { preview?: boolean; line?: number; column?: number; length?: number } = {}) {
    const tree = activePane();
    const current = focusedLeaf(), target = (current && findLeaf(tree, current.id)) || leafList(tree).find(leaf => leaf.kind === 'editor');
    let id: string;
    if (target) { id = target.id; commitPane(mapLeaf(tree!, id, leaf => addTab(leaf, path, preview))); }
    else {
      const leaf = editorLeaf([path], path); id = leaf.id; leaf.preview = preview ? path : undefined;
      const anchor = findLeaf(tree, refs.focus.current) || leafList(tree)[0];
      commitPane(!tree || !anchor ? leaf : split(tree, anchor.id, leaf, 'row'));
    }
    setFocusLeaf(id); nextReveal(id, { line, column, length });
  }
  async function openFile(path: string, options: { preview?: boolean; line?: number; column?: number; length?: number } = {}) {
    if (!isDiffTab(path) && !refs.tabs.current.some(tab => tab.path === path)) {
      if (refs.tabs.current.length >= 30) throw new Error('열린 파일을 닫은 후 다시 여세요. 최대 30개 파일을 복원합니다.');
      const value = await call<{ content: string; revision: string }>('files/read', { path });
      setTabs(previous => previous.some(tab => tab.path === path) ? previous : [...previous, { path, ...value, saved: value.content }]);
    }
    placeTab(path, options);
  }
  const openAt = (path: string, line: number, column: number, length = 0) => run(() => openFile(path, { line, column, length }));
  const mapEditors = (change: (leaf: Leaf) => Leaf) => {
    let changed = false;
    const next = refs.paneTabs.current.map(tab => {
      let tree = tab.pane; for (const leaf of leafList(tab.pane)) if (leaf.kind === 'editor') tree = tree && mapLeaf(tree, leaf.id, change);
      if (tree === tab.pane) return tab; changed = true; return { ...tab, pane: tree };
    });
    if (changed) commitTabs(next);
  };
  const compactAll = () => commitTabs(refs.paneTabs.current.map(tab => ({ ...tab, pane: compact(tab.pane) })));
  async function closeTab(groupId: string, path: string) {
    const leaf = findLeaf(treeOf(groupId), groupId); if (!leaf) return;
    const elsewhere = trees().flatMap(leafList).some(other => other.id !== groupId && other.kind === 'editor' && (other.tabs || []).includes(path));
    const doc = refs.tabs.current.find(tab => tab.path === path);
    if (!elsewhere && doc && doc.content !== doc.saved && !(await ask.confirm(`${path}의 저장하지 않은 변경을 버릴까요?`))) return;
    const list = leaf.tabs || [], index = list.indexOf(path), rest = list.filter(item => item !== path);
    const updated = mapLeaf(treeOf(groupId)!, groupId, item => ({ ...item, tabs: rest, active: item.active === path ? rest[index] ?? rest[index - 1] ?? '' : item.active, preview: item.preview === path ? undefined : item.preview }));
    commitFor(groupId, compact(updated));
    if (!elsewhere && doc) { setTabs(previous => previous.filter(tab => tab.path !== path)); disposeModel(rootOf(), path); }
  }
  async function closeGroup(groupId: string) {
    const leaf = findLeaf(treeOf(groupId), groupId); if (!leaf) return;
    for (const path of [...(leaf.tabs || [])]) await closeTab(groupId, path);
    const still = findLeaf(treeOf(groupId), groupId);
    if (still) commitFor(groupId, remove(treeOf(groupId)!, groupId));
  }
  function splitEditor(groupId: string, direction: 'row' | 'column') {
    const tree = treeOf(groupId), leaf = findLeaf(tree, groupId); if (!tree || !leaf) return;
    const copy = editorLeaf(leaf.active && !isDiffTab(leaf.active) ? [leaf.active] : [], leaf.active);
    commitFor(groupId, split(tree, groupId, copy, direction)); setFocusLeaf(copy.id); nextReveal(copy.id);
  }
  function dropPaths(matchPath: (path: string) => boolean) {
    mapEditors(leaf => { const list = (leaf.tabs || []).filter(path => !matchPath(path)); return list.length === (leaf.tabs || []).length ? leaf : { ...leaf, tabs: list, active: list.includes(leaf.active || '') ? leaf.active : list[0] || '' }; });
    compactAll();
    for (const tab of refs.tabs.current) if (matchPath(tab.path)) disposeModel(rootOf(), tab.path);
    setTabs(previous => previous.filter(tab => !matchPath(tab.path)));
  }
  function renamePaths(from: string, to: string) {
    const rename = (path: string) => path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
    mapEditors(leaf => ({ ...leaf, tabs: (leaf.tabs || []).map(rename), active: rename(leaf.active || ''), preview: leaf.preview && rename(leaf.preview) }));
    for (const tab of refs.tabs.current) if (rename(tab.path) !== tab.path) disposeModel(rootOf(), tab.path);
    setTabs(previous => previous.map(tab => ({ ...tab, path: rename(tab.path) })));
  }

  // ---- documents ----
  const onDocChange = useCallback((path: string, value: string) => {
    setTabs(previous => previous.some(tab => tab.path === path && tab.content !== value) ? previous.map(tab => tab.path === path ? { ...tab, content: value } : tab) : previous);
    mapEditors(leaf => leaf.preview === path ? { ...leaf, preview: undefined } : leaf);
  }, []);
  async function saveFile(path = activePath(), revision?: string) {
    const file = refs.tabs.current.find(tab => tab.path === path); if (!file) return;
    try {
      const value = await call<{ content: string; revision: string }>('files/save', { path, content: file.content, revision: revision ?? file.revision });
      setTabs(previous => previous.map(tab => tab.path === path ? { ...tab, saved: value.content, revision: value.revision, external: false } : tab));
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'REVISION_CONFLICT' && cause.details) setConflict({ path, ...cause.details });
      else throw cause;
    }
  }
  async function checkExternal() {
    if (refs.checking.current) return; refs.checking.current = true;
    const projectId = refs.project.current?.id, conversationId = refs.workspace.current;
    try {
      for (const file of refs.tabs.current) {
        const current = await api<{ content: string; revision: string }>('files/read', { projectId, conversationId, path: file.path }).catch(() => null);
        if (!current) continue;
        if (refs.project.current?.id !== projectId || refs.workspace.current !== conversationId) break;
        const latest = refs.tabs.current.find(tab => tab.path === file.path);
        if (!latest || current.revision === latest.revision) continue;
        if (current.content === latest.saved) setTabs(previous => previous.map(tab => tab.path === file.path ? { ...tab, revision: current.revision } : tab));
        else if (latest.content === latest.saved) setTabs(previous => previous.map(tab => tab.path === file.path ? { ...tab, content: current.content, saved: current.content, revision: current.revision, external: false } : tab));
        else setTabs(previous => previous.map(tab => tab.path === file.path ? { ...tab, external: true } : tab));
      }
    } finally { refs.checking.current = false; }
  }
  const reloadPaths = async (paths: string[]) => {
    for (const path of paths) {
      const current = await call<{ content: string; revision: string }>('files/read', { path }).catch(() => null);
      if (current) setTabs(previous => previous.map(tab => tab.path === path ? { ...tab, ...current, saved: current.content, external: false } : tab));
    }
  };
  async function refreshGit() {
    const state = refs.project.current;
    if (!state || !state.repositories.length || (state.multiRepo && !state.repositories.some(repo => repo.id === refs.repository.current))) { setGit(emptyGit); return; }
    const next = await call<GitState>('git/status');
    setGit(previous => { if (JSON.stringify(previous) === JSON.stringify(next)) return previous; setGitVersion(value => value + 1); return next; });
  }

  // ---- project lifecycle ----
  // Each open project is its own mounted Workspace, so opening happens once per mount; switching projects never reloads one.
  useEffect(() => {
    if (refs.started.current) return; refs.started.current = true;
    void loadProject().catch(cause => onFailed(root, cause));
  }, []);
  // Closing a project frees its editor models; the server side is released by `project/close`.
  useEffect(() => () => { for (const tab of refs.tabs.current) disposeModel(rootOf(), tab.path); }, []);
  useImperativeHandle(handleRef, () => ({
    selectTab: id => selectTab(id), closePane: id => run(() => closeTerminal(id)),
    // Reordering only changes the list order; the saved layout follows it.
    // Dropping a tab onto another folds its panes into it, side by side.
    mergeTabs: (id, targetId) => {
      const list = refs.paneTabs.current, source = list.find(tab => tab.id === id), target = list.find(tab => tab.id === targetId);
      if (!source?.pane || !target?.pane || id === targetId) return;
      const merged = equalize({ direction: 'row', children: [target.pane, source.pane], sizes: [1, 1] }), first = leafList(source.pane)[0]?.id || '';
      commitTabs(list.filter(tab => tab.id !== id).map(tab => tab.id === targetId ? { ...tab, pane: merged } : tab));
      delete refs.tabFocus.current[id];
      selectTab(targetId); if (first) setFocusLeaf(first);
    },
    // Pulls one pane out of a split tab: into another tab ('merge'), or out as a tab of its own before/after a tab (no target: right after its old tab).
    movePane: (tabId, paneId, targetId, mode) => {
      const list = refs.paneTabs.current, source = list.find(tab => tab.id === tabId), leaf = source?.pane && findLeaf(source.pane, paneId);
      if (!source?.pane || !leaf || leafList(source.pane).length < 2 || (mode === 'merge' && targetId === tabId)) return;
      const rest = remove(source.pane, paneId), target = targetId ? list.find(tab => tab.id === targetId) : undefined;
      let next = list.map(tab => tab.id === tabId ? { ...tab, pane: rest } : tab), landed = '';
      if (mode === 'merge' && target?.pane) {
        landed = target.id;
        next = next.map(tab => tab.id === target.id ? { ...tab, pane: equalize({ direction: 'row', children: [target.pane!, leaf], sizes: [1, 1] }) } : tab);
      } else {
        const fresh: PaneTab = { id: newId(), pane: leaf }, anchor = next.findIndex(tab => tab.id === (target?.id ?? tabId));
        landed = fresh.id; next = [...next.slice(0, anchor + (mode === 'before' ? 0 : 1)), fresh, ...next.slice(anchor + (mode === 'before' ? 0 : 1))];
      }
      commitTabs(next); delete refs.tabFocus.current[tabId];
      selectTab(landed); setFocusLeaf(paneId);
    },
    moveTab: (id, targetId, after) => {
      const list = refs.paneTabs.current, moving = list.find(tab => tab.id === id); if (!moving || id === targetId) return;
      const rest = list.filter(tab => tab.id !== id), at = rest.findIndex(tab => tab.id === targetId); if (at < 0) return;
      const next = [...rest.slice(0, at + (after ? 1 : 0)), moving, ...rest.slice(at + (after ? 1 : 0))];
      if (next.every((tab, index) => tab === list[index])) return;
      commitTabs(next);
    },
    selectPane: (tabId, paneId) => { selectTab(tabId); setFocusLeaf(paneId); }, closeTab: id => run(() => closePaneTab(id)), newTab: () => run(() => newTab()), renameTab: id => run(() => renamePaneTab(id)), launcher: () => run(() => pickLauncher('tab')),
    async requestClose() {
      const dirty = refs.tabs.current.filter(file => file.content !== file.saved).length;
      if (dirty && !(await ask.confirm(`저장하지 않은 파일 ${dirty}개가 있습니다. 프로젝트를 닫을까요?`))) return false;
      const projectId = refs.project.current?.id; if (!projectId) return true;
      try { await api('project/close', { projectId }); }
      catch (cause) {
        if (!(cause instanceof ApiError)) throw cause;
        if (cause.code === 'PROJECT_BUSY') {
          if (!(await ask.confirm(`${cause.message} 모두 종료하고 프로젝트를 닫을까요?`))) return false;
          await api('project/close', { projectId, force: true });
        } else if (cause.code !== 'NOT_FOUND') throw cause;
      }
      return true;
    }
  }));
  const leafLabel = (leaf: Leaf, fallbackTitle?: string) => {
    if (leaf.kind === 'editor') return leaf.active ? basename(leaf.active.split(':').pop() || leaf.active) : '편집기';
    const title = titles[leaf.id] || fallbackTitle, cwd = project?.terminals.find(terminal => terminal.id === leaf.id)?.cwd;
    // Windows shells title themselves with their executable path; show just the program name.
    const clean = title && /^[A-Za-z]:[\\/]|^\//.test(title) ? basename(title.replace(/\\/g, '/')).replace(/\.exe$/i, '') : title;
    return clean || (cwd ? basename(cwd.replace(/\\/g, '/')) : '터미널');
  };
  const tabLabel = (tab: PaneTab) => {
    if (tab.title) return tab.title;
    const ids = leaves(tab.pane), focused = refs.tabFocus.current[tab.id], leaf = findLeaf(tab.pane, focused || '') || leafList(tab.pane)[0];
    if (!leaf) return '새 탭';
    return leafLabel(leaf, ids.map(id => titles[id]).find(Boolean));
  };
  const needsYou = attention[focus] === 'done';
  useEffect(() => {
    if (!active || !focus || !needsYou) return;
    const clear = () => { if (document.hasFocus()) setAttention(previous => { if (previous[focus] !== 'done') return previous; const { [focus]: _gone, ...rest } = previous; return rest; }); };
    clear(); window.addEventListener('focus', clear);
    return () => window.removeEventListener('focus', clear);
  }, [active, focus, activeTab, needsYou]);
  const attentionCount = Object.keys(attention).length;
  const tabInfo = JSON.stringify(paneTabs.map(tab => {
    const list = leafList(tab.pane);
    const focusedId = refs.tabFocus.current[tab.id], current = list.find(leaf => leaf.id === focusedId) || list[0];
    return { id: tab.id, label: tabLabel(tab), count: list.length, agent: current && current.kind !== 'editor' ? agentOf(current.id) : undefined, attention: list.some(leaf => attention[leaf.id]), asking: list.some(leaf => attention[leaf.id] === 'attention'), working: list.some(leaf => working.has(leaf.id)),
      panes: list.length > 1 ? list.map(leaf => ({ id: leaf.id, label: leafLabel(leaf), kind: leaf.kind || 'terminal', agent: leaf.kind === 'editor' ? undefined : agentOf(leaf.id), attention: Boolean(attention[leaf.id]), asking: attention[leaf.id] === 'attention', working: working.has(leaf.id), focused: leaf.id === current?.id })) : [] };
  }));
  useEffect(() => {
    onStatus(root, { id: project?.id ?? '', name: basename((project?.root ?? root).replace(/\\/g, '/')), loaded: Boolean(project), attention: attentionCount, dirty: tabs.filter(file => file.content !== file.saved).length, tabs: JSON.parse(tabInfo), activeTab });
  }, [root, project?.id, project?.root, attentionCount, tabs, tabInfo, activeTab]);

  async function loadProject() {
    const state = await api<Snapshot>('project/open', { path: root });
    setRestoring(true);
    refs.project.current = state; setProject(state); cursors.current = {}; bus.current.buffers.clear(); setProcessAgents({}); setLaunched({}); setWorking(new Set()); setAttention({}); setSshSet(new Set()); setTitles({});
    const ui = state.ui || {};
    const nextRepoId = state.repositories.some(repo => repo.id === ui.gitRepositoryId) ? ui.gitRepositoryId : state.repositories[0]?.id || '';
    refs.repository.current = nextRepoId; setGitRepositoryId(nextRepoId);
    const restoredWorkspace = !state.multiRepo && state.conversations.some(c => c.id === ui.workspaceId && !c.removed) ? ui.workspaceId : '';
    refs.workspace.current = restoredWorkspace; setWorkspaceId(restoredWorkspace);
    setDiffText(null); setZoom('');
    // Settings used to live in each project's layout; the shell adopts them once and keeps its own copy from then on.
    if (ui.settings) onLegacySettings(ui.settings);
    setRightVisible(ui.rightVisible ?? false);
    setWidths(ui.widths?.length === 3 ? ui.widths : [18, 52, 30]);
    const restored = await Promise.all((ui.tabs || []).slice(0, 30).map(async (file: any): Promise<FileTab | null> => {
      try {
        const current = await api<{ content: string; revision: string }>('files/read', { projectId: state.id, conversationId: restoredWorkspace, path: file.path });
        return { path: file.path, ...current, revision: file.draft !== undefined && file.revision ? file.revision : current.revision, saved: current.content, content: file.draft ?? current.content, external: file.revision && file.revision !== current.revision && file.draft !== undefined };
      } catch (cause) { report(cause); return typeof file.draft === 'string' ? { path: file.path, content: file.draft, saved: '', revision: file.revision, external: true } : null; }
    })).then(files => files.filter((file): file is FileTab => file !== null));
    const known = new Set(restored.map(tab => tab.path)), clean = (tree: Pane | null): Pane | null => {
      let next = tree; for (const leaf of leafList(tree)) if (leaf.kind === 'editor') next = next && mapLeaf(next, leaf.id, item => { const list = (item.tabs || []).filter(path => known.has(path) || isDiffTab(path)); return { ...item, tabs: list, active: list.includes(item.active || '') ? item.active : list[0] || '' }; });
      return next;
    };
    const live = new Set(state.terminals.filter(terminal => !terminal.exited).map(terminal => terminal.id));
    // Older layouts saved one `pane`; it becomes the first tab.
    const saved: PaneTab[] = Array.isArray(ui.paneTabs) && ui.paneTabs.length ? ui.paneTabs : ui.pane ? [{ id: newId(), pane: ui.pane }] : [];
    // Terminals that died with the server are reopened in the same place; agents get their previous conversation resumed.
    const resume = { claude: 'claude --continue', codex: 'codex resume --last' } as const, renamed = new Map<string, string>();
    const revive = async (tree: Pane | null): Promise<Pane | null> => {
      const dead = leafList(tree).filter(leaf => leaf.kind !== 'editor' && !live.has(leaf.id)).slice(0, 16);
      const reopened = await Promise.all(dead.map(async leaf => {
        try {
          const result = await call<{ id: string }>('terminal/open', leaf.cwd ? { path: leaf.cwd } : {}).catch(() => call<{ id: string }>('terminal/open'));
          if (leaf.agent) { refs.pending.current.set(result.id, resume[leaf.agent]); setLaunched(previous => ({ ...previous, [result.id]: leaf.agent! })); }
          renamed.set(leaf.id, result.id); live.add(result.id);
          return [leaf.id, result.id] as const;
        } catch (cause) { report(cause); return null; }
      }));
      return reopened.reduce<Pane | null>((next, entry) => entry && next ? mapLeaf(next, entry[0], item => ({ ...item, id: entry[1] })) : next, tree);
    };
    const revived: PaneTab[] = [];
    for (const tab of saved) revived.push({ ...tab, pane: await revive(clean(tab.pane)), focus: tab.focus && renamed.get(tab.focus) || tab.focus });
    let nextTabs = revived.map(tab => ({ id: tab.id, title: tab.title, focus: tab.focus, pane: compact(pruneDead(tab.pane, live)) })).filter(tab => tab.pane);
    const placed = new Set(nextTabs.flatMap(tab => leaves(tab.pane)));
    const orphans = [...live].filter(id => !placed.has(id));
    if (orphans.length) nextTabs.push({ id: newId(), title: undefined, focus: undefined, pane: orphans.length === 1 ? { id: orphans[0], kind: 'terminal' } : { direction: 'row', children: orphans.map(id => ({ id, kind: 'terminal' as const })), sizes: orphans.map(() => 1) } });
    if (!nextTabs.length) nextTabs = [{ id: newId(), title: undefined, focus: undefined, pane: null }];
    refs.tabFocus.current = Object.fromEntries(nextTabs.filter(tab => tab.focus).map(tab => [tab.id, tab.focus!]));
    commitTabs(nextTabs);
    const active = nextTabs.find(tab => tab.id === ui.activeTab) || nextTabs[0];
    refs.activeTab.current = active.id; setActiveTab(active.id);
    const focused = renamed.get(ui.focus) || ui.focus;
    setFocusLeaf(findLeaf(active.pane, focused) ? focused : refs.tabFocus.current[active.id] && findLeaf(active.pane, refs.tabFocus.current[active.id]) ? refs.tabFocus.current[active.id] : leaves(active.pane)[0] || '');
    const lastEditor = leafList(active.pane).find(leaf => leaf.kind === 'editor');
    if (lastEditor) refs.lastEditor.current = lastEditor.id;
    setTabs(restored); setRestoring(false);
    setTreeVersion(value => value + 1);
    void call<Record<string, any>>('readiness').then(setHealth).catch(report);
    if (!leafList(active.pane).some(leaf => leaf.kind !== 'editor')) await openTerminalLeaf('').catch(report);
  }

  refs.onMessage.current = message => {
    try {
          if (message.type === 'snapshot') setProject(message.snapshot);
          else if (message.type === 'fs') { if (refs.active.current) void refreshGit().catch(report); }
          else if (message.type === 'terminal' || message.type === 'terminal/replay') {
            const previous = bus.current.buffers.get(message.id);
            if (message.type === 'terminal/replay') {
              if (previous && message.sequence < previous.sequence) return;
              bus.current.buffers.set(message.id, message);
              bus.current.listeners.get(message.id)?.({ ...message, reset: true });
            } else if (!previous || message.sequence > previous.sequence) {
              bus.current.buffers.set(message.id, { ...message, data: ((previous?.data || '') + message.data).slice(-262144) });
              bus.current.listeners.get(message.id)?.(message);
              // A launcher command (claude, codex) is typed once the shell has printed its first output.
              const command = refs.pending.current.get(message.id);
              if (command !== undefined) { refs.pending.current.delete(message.id); setTimeout(() => send({ type: 'terminal/input', id: message.id, data: `${command}\r` }), 150); }
            }
          } else if (message.type === 'terminal/ssh') {
            setSshSet(previous => previous.has(message.id) === message.ssh ? previous : message.ssh ? new Set(previous).add(message.id) : new Set([...previous].filter(item => item !== message.id)));
          } else if (message.type === 'terminal/agent') {
            setProcessAgents(previous => previous[message.id] === message.agent ? previous : { ...previous, [message.id]: message.agent });
            setSshSet(previous => message.ssh ? new Set(previous).add(message.id) : new Set([...previous].filter(item => item !== message.id)));
            if (!message.agent && !message.ssh) {
              clearAttention(message.id);
              setWorking(previous => new Set([...previous].filter(item => item !== message.id)));
              setLaunched(previous => { const next = { ...previous }; delete next[message.id]; return next; });
            }
          } else if (message.type === 'terminal/exit') {
            removeTerminalPane(message.id);
            void refresh().catch(report);
          } else if (message.type === 'error') report(message.error.message);
    } catch (cause) { report(cause); }
  };
  useEffect(() => {
    if (!project?.id) return;
    return hub.subscribe(project.id, message => refs.onMessage.current(message), () => cursors.current);
  }, [project?.id, hub]);

  // ---- persistence and background refresh ----
  // Terminal leaves are saved with their folder and agent; dead ones are reopened from these on the next start.
  const remember = (tree: Pane | null): Pane | null => leafList(tree).reduce<Pane | null>((next, leaf) => {
    if (leaf.kind === 'editor' || !next) return next;
    const cwd = cwds[leaf.id] ?? leaf.cwd, agent = agentOf(leaf.id);
    return mapLeaf(next, leaf.id, item => ({ ...item, ...(cwd ? { cwd } : {}), agent }));
  }, tree);
  const agentKey = paneTabs.flatMap(tab => leafList(tab.pane)).map(leaf => leaf.kind === 'editor' ? '' : agentOf(leaf.id) ?? '').join(',');
  useEffect(() => {
    if (!project?.id || restoring) return;
    const timer = setTimeout(() => {
      const savedTabs = paneTabs.map(tab => ({ id: tab.id, pane: remember(tab.pane), ...(tab.title ? { title: tab.title } : {}), ...(refs.tabFocus.current[tab.id] ? { focus: refs.tabFocus.current[tab.id] } : {}) }));
      void call('ui', { ui: { tabs: tabs.map(file => ({ path: file.path, revision: file.revision, ...(file.content !== file.saved ? { draft: file.content } : {}) })), activeFile: activePath(), conversationId: '', workspaceId, gitRepositoryId, pane: activePane(), paneTabs: savedTabs, activeTab, focus, widths, heights, side: 'files', sideVisible: false, rightVisible } }).catch(report);
    }, 400);
    return () => clearTimeout(timer);
  }, [project?.id, tabs, workspaceId, gitRepositoryId, restoring, paneTabs, activeTab, focus, widths, heights, rightVisible, agentKey, call, report]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (refs.tabs.current.some(file => file.content !== file.saved)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, []);
  // Polling only runs for the project being shown; coming back to a project refreshes it immediately.
  useEffect(() => {
    if (!project?.id || !active) return;
    let checking = false;
    const tick = async () => { if (checking) return; checking = true; try { await Promise.all([refreshGit(), checkExternal()]); } catch (cause) { report(cause); } finally { checking = false; } };
    void tick(); const timer = setInterval(tick, settings.diffRefresh * 1000);
    return () => clearInterval(timer);
  }, [project?.id, workspaceId, gitRepositoryId, active, settings.diffRefresh]);
  useEffect(() => { // documents no pane shows any more are closed, unless they hold unsaved edits
    if (restoring) return;
    const shown = new Set(paneTabs.flatMap(tab => leafList(tab.pane)).flatMap(leaf => leaf.kind === 'editor' ? leaf.tabs || [] : []));
    const drop = refs.tabs.current.filter(tab => !shown.has(tab.path) && tab.content === tab.saved);
    if (!drop.length) return;
    drop.forEach(tab => disposeModel(rootOf(), tab.path));
    setTabs(previous => previous.filter(tab => !drop.some(item => item.path === tab.path)));
  }, [paneTabs, restoring]);
  useEffect(() => { if (zoom && !findLeaf(activePane(), zoom)) setZoom(''); }, [paneTabs, activeTab, zoom]);

  // ---- terminals ----
  async function openTerminalLeaf(anchorId: string, direction: 'row' | 'column' = 'row', path?: string, command = '') {
    const result = await call<{ id: string }>('terminal/open', path ? { path } : {});
    if (command) {
      refs.pending.current.set(result.id, command);
      const agent = detectAgent(command); if (agent) setLaunched(previous => ({ ...previous, [result.id]: agent }));
    }
    const leaf: Leaf = { id: result.id, kind: 'terminal' }, current = activePane();
    const anchor = leaves(current).includes(anchorId) ? anchorId : leaves(current)[0];
    commitPane(!current || !anchor ? leaf : split(current, anchor, leaf, direction)); setFocusLeaf(result.id);
    await refresh();
  }
  const splitTerminal = (id: string, direction: 'row' | 'column', path?: string) => openTerminalLeaf(id, direction, path);
  async function newTab(command = '', path?: string) {
    const tab: PaneTab = { id: newId(), pane: null };
    commitTabs([...refs.paneTabs.current, tab]); refs.activeTab.current = tab.id; setActiveTab(tab.id); setZoom('');
    await openTerminalLeaf('', 'row', path, command);
  }
  async function launch(command: string, where: 'tab' | 'split') {
    if (where === 'tab') await newTab(command);
    else await openTerminalLeaf(refs.focus.current, 'row', undefined, command);
  }
  // Closing the last pane of a tab closes the tab, as in Warp; the final tab stays open and empty.
  function dropEmptyTab(tabId: string) {
    const list = refs.paneTabs.current, tab = list.find(item => item.id === tabId);
    if (!tab || tab.pane || list.length < 2) return;
    const index = list.indexOf(tab), rest = list.filter(item => item.id !== tabId);
    commitTabs(rest); delete refs.tabFocus.current[tabId];
    if (refs.activeTab.current === tabId) selectTab(rest[Math.min(index, rest.length - 1)].id);
  }
  function removeTerminalPane(id: string) {
    refs.pending.current.delete(id); bus.current.buffers.delete(id); bus.current.listeners.delete(id);
    const owner = tabOf(id);
    if (owner) { commitTab(owner.id, compact(owner.pane && remove(owner.pane, id))); dropEmptyTab(owner.id); }
    if (refs.focus.current === id) setFocusLeaf(leaves(activePane())[0] || '');
    clearAttention(id);
    setWorking(previous => { const next = new Set(previous); next.delete(id); return next; });
  }
  async function closeTerminal(id: string) {
    const info = refs.project.current?.terminals.find(terminal => terminal.id === id);
    if (info && !info.exited && !(await ask.confirm('터미널 프로세스를 종료할까요?'))) return;
    if (info) await call('terminal/close', { id });
    removeTerminalPane(id);
    await refresh();
  }
  async function closePaneTab(tabId: string) {
    const tab = refs.paneTabs.current.find(item => item.id === tabId); if (!tab) return;
    const running = leafList(tab.pane).filter(leaf => leaf.kind !== 'editor' && refs.project.current?.terminals.some(terminal => terminal.id === leaf.id && !terminal.exited));
    const dirty = leafList(tab.pane).flatMap(leaf => leaf.tabs || []).filter(isDirty);
    if ((running.length || dirty.length) && !(await ask.confirm(`이 탭을 닫을까요?${running.length ? ` 실행 중인 터미널 ${running.length}개가 종료됩니다.` : ''}${dirty.length ? ` 저장하지 않은 파일 ${dirty.length}개의 변경을 버립니다.` : ''}`))) return;
    for (const leaf of leafList(tab.pane)) if (leaf.kind !== 'editor' && refs.project.current?.terminals.some(terminal => terminal.id === leaf.id)) await call('terminal/close', { id: leaf.id });
    if (refs.paneTabs.current.length < 2) { commitTab(tabId, null); await refresh(); await openTerminalLeaf(''); return; }
    commitTab(tabId, null); dropEmptyTab(tabId); await refresh();
  }
  function cyclePaneTab(step: number) {
    const list = refs.paneTabs.current; if (list.length < 2) return;
    const index = list.findIndex(tab => tab.id === refs.activeTab.current);
    selectTab(list[(Math.max(0, index) + step + list.length) % list.length].id);
  }
  async function renamePaneTab(tabId: string) {
    const tab = refs.paneTabs.current.find(item => item.id === tabId); if (!tab) return;
    const title = await ask.input('탭 이름 (비우면 자동)', tab.title || ''); if (title === null) return;
    commitTabs(refs.paneTabs.current.map(item => item.id === tabId ? { ...item, title: title.trim().slice(0, 200) || undefined } : item));
  }
  const withoutTerminals = (tree: Pane | null) => leafList(tree).filter(leaf => leaf.kind !== 'editor').reduce<Pane | null>((rest, leaf) => rest && remove(rest, leaf.id), tree);
  const join = (rest: Pane | null, grid: Pane): Pane => rest ? { direction: 'row', children: [rest, grid], sizes: [1, 2] } : grid;
  async function preset() {
    const terminalsInTree = leafList(activePane()).filter(leaf => leaf.kind !== 'editor');
    if (terminalsInTree.length && !(await ask.confirm('현재 탭의 터미널을 닫고 6개 새 터미널(2 × 3)로 바꿀까요? 기존 프로세스는 종료됩니다.'))) return;
    for (const leaf of terminalsInTree) if (refs.project.current?.terminals.some(terminal => terminal.id === leaf.id)) await call('terminal/close', { id: leaf.id });
    commitPane(withoutTerminals(activePane()));
    const ids: string[] = [];
    try { for (let i = 0; i < 6; i++) ids.push((await call<{ id: string }>('terminal/open')).id); }
    finally {
      if (ids.length) {
        const rows = [ids.slice(0, 3), ids.slice(3)].filter(row => row.length);
        commitPane(join(activePane(), { direction: 'column', sizes: rows.map(() => 1), children: rows.map(row => ({ direction: 'row' as const, sizes: row.map(() => 1), children: row.map(id => ({ id, kind: 'terminal' as const })) })) }));
      }
      setFocusLeaf(ids[0] || ''); await refresh();
    }
  }
  function moveFocus(step: number) {
    const ids = leaves(activePane());
    if (ids.length) setFocusLeaf(ids[(Math.max(0, ids.indexOf(refs.focus.current)) + step + ids.length) % ids.length]);
  }
  async function closeFocused() {
    const leaf = findLeaf(activePane(), refs.focus.current); if (!leaf) return;
    if (leaf.kind === 'editor') { if (leaf.active) await closeTab(leaf.id, leaf.active); }
    else await closeTerminal(leaf.id);
  }

  // ---- workspace / git ----
  async function changeWorkspace(next: string) {
    if (refs.tabs.current.some(file => file.content !== file.saved) && !(await ask.confirm('미저장 편집을 버리고 작업 경로를 바꿀까요?'))) return;
    for (const tab of refs.tabs.current) disposeModel(rootOf(), tab.path);
    refs.workspace.current = next; setWorkspaceId(next); setTabs([]);
    mapEditors(leaf => ({ ...leaf, tabs: [], active: '', preview: undefined }));
    compactAll();
    setTreeVersion(value => value + 1); await refreshGit();
  }
  const selectGitRepository = (id: string) => {
    refs.repository.current = id; setGitRepositoryId(id);
    if (refs.project.current?.multiRepo && id) void call('git/status', { repositoryId: id }).then(setGit).catch(report); else setGit(emptyGit);
  };
  async function loadDiff(kind: string, path: string) {
    const [before, after] = await Promise.all([
      call<{ content: string }>('git/show', { path, staged: kind === 'unstaged' }),
      call<{ content: string }>('git/show', kind === 'staged' ? { path, staged: true } : { path, working: true })
    ]);
    const original = before.content, modified = after.content;
    return { original, modified };
  }
  async function switchBranch() {
    const { branches } = await call<{ branches: string[] }>('git/branches');
    const choice = await pick('브랜치 전환', branches.map(name => ({ id: name, label: name, detail: name === git.branch ? '현재' : '' })));
    if (!choice || choice === git.branch) return;
    await call('git/checkout', { branch: choice }); await refreshGit(); setTreeVersion(value => value + 1);
  }

  // ---- quick input / commands ----
  async function openQuick(initial = '') {
    const files: string[] = [];
    const commands = refs.commands.current.filter(command => !command.hidden).map(command => ({ id: `cmd:${command.id}`, label: command.label, keys: command.keys && showKeys(command.keys) }));
    const choice = await new Promise<string | null>(resolve => setQuick({ key: ++refs.quickKey.current, request: { kind: 'files', files, initial, commands, resolve } }));
    if (!choice) return;
    if (choice.startsWith('cmd:')) await refs.commands.current.find(command => command.id === choice.slice(4))?.run();
  }
  const showReview = () => { setRightVisible(true); run(refreshGit); };
  const toggleReview = () => { if (rightVisible) setRightVisible(false); else showReview(); };
  async function pickWorkspace() {
    const options = [{ id: '', label: '기본 프로젝트', detail: project?.root || '' }, ...(project?.conversations || []).filter(c => c.branch && !c.removed).map(c => ({ id: c.id, label: c.title, detail: c.branch || '' }))];
    const choice = await pick('작업 경로', options.map(option => ({ ...option, detail: option.id === workspaceId ? `현재 · ${option.detail}` : option.detail })));
    if (choice !== null && choice !== workspaceId) await changeWorkspace(choice);
  }
  async function pickLauncher(where: 'tab' | 'split') {
    const choice = await pick(where === 'tab' ? '새 탭에서 실행' : '오른쪽 pane에서 실행', launchers.map(item => ({ id: item.id, label: item.label, detail: item.detail })));
    const item = launchers.find(entry => entry.id === choice);
    if (item) await launch(item.command, where);
  }
  const commands: Command[] = [
    { id: 'newTab', label: '새 탭', keys: 'mod+shift+t', run: () => newTab() },
    { id: 'newTab2', label: '새 탭', keys: 'alt+t', hidden: true, run: () => newTab() },
    { id: 'newClaude', label: '새 탭에서 Claude Code 실행', run: () => launch('claude', 'tab') },
    { id: 'newCodex', label: '새 탭에서 Codex 실행', run: () => launch('codex', 'tab') },
    { id: 'splitClaude', label: '오른쪽 pane에서 Claude Code 실행', run: () => launch('claude', 'split') },
    { id: 'splitCodex', label: '오른쪽 pane에서 Codex 실행', run: () => launch('codex', 'split') },
    { id: 'launcher', label: '새 탭에서 실행…', keys: 'mod+shift+n', run: () => pickLauncher('tab') },
    { id: 'closeTab', label: '탭 닫기', keys: 'mod+shift+w', run: () => closePaneTab(refs.activeTab.current) },
    { id: 'renameTab', label: '탭 이름 바꾸기…', run: () => renamePaneTab(refs.activeTab.current) },
    { id: 'nextTab', label: '다음 탭', keys: 'alt+]', run: () => cyclePaneTab(1) },
    { id: 'prevTab', label: '이전 탭', keys: 'alt+[', run: () => cyclePaneTab(-1) },
    { id: 'nextTab2', label: '다음 탭', keys: 'mod+shift+]', hidden: true, run: () => cyclePaneTab(1) },
    { id: 'prevTab2', label: '이전 탭', keys: 'mod+shift+[', hidden: true, run: () => cyclePaneTab(-1) },
    ...Array.from({ length: 9 }, (_, index) => ({ id: `tab${index + 1}`, label: `${index + 1}번 탭`, keys: `alt+${index + 1}`, hidden: true, run: () => { const tab = refs.paneTabs.current[index === 8 ? refs.paneTabs.current.length - 1 : index]; if (tab) selectTab(tab.id); } })),
    { id: 'splitRight', label: '오른쪽으로 분할', run: () => splitTerminal(refs.focus.current, 'row') },
    { id: 'splitDown', label: '아래로 분할', run: () => splitTerminal(refs.focus.current, 'column') },
    { id: 'closePane', label: '포커스된 pane 닫기', keys: 'alt+w', run: closeFocused },
    { id: 'preset', label: '현재 탭을 터미널 2 × 3 그리드로', run: preset },
    { id: 'zoom', label: 'Pane 최대화 전환', keys: 'mod+shift+enter', run: () => setZoom(value => value ? '' : refs.focus.current) },
    { id: 'equalize', label: 'Pane 크기 균등화', run: () => { const tree = activePane(); if (tree) commitPane(equalize(tree)); } },
    { id: 'focusNext', label: '다음 pane으로 이동', keys: 'alt+arrowright', run: () => moveFocus(1) },
    { id: 'focusPrev', label: '이전 pane으로 이동', keys: 'alt+arrowleft', run: () => moveFocus(-1) },
    { id: 'focusNext2', label: '다음 pane으로 이동', keys: 'alt+arrowdown', hidden: true, run: () => moveFocus(1) },
    { id: 'focusPrev2', label: '이전 pane으로 이동', keys: 'alt+arrowup', hidden: true, run: () => moveFocus(-1) },
    { id: 'review', label: '변경사항(Diff) 패널 전환', keys: 'mod+shift+g', run: toggleReview },
    { id: 'palette', label: '명령 팔레트', keys: 'mod+shift+p', hidden: true, run: () => openQuick('>') },
    { id: 'palette2', label: '명령 팔레트(F1)', keys: 'f1', hidden: true, run: () => openQuick('>') },
    { id: 'branch', label: '브랜치 전환…', run: switchBranch },
    { id: 'workspace', label: '작업 경로 전환…', run: pickWorkspace },
    { id: 'theme', label: '색 테마 전환', run: () => setSettings(previous => ({ ...previous, theme: previous.theme === 'dark' ? 'light' : 'dark' })) },
    ...projectCommands
  ];
  refs.commands.current = commands;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!refs.project.current || !refs.active.current || event.isComposing) return;
      const inTerminal = event.target instanceof Element && event.target.closest('.xterm');
      // Plain Ctrl+key belongs to the shell (readline, tmux, agent CLIs); only Cmd, Ctrl+Shift and Alt combos reach the app.
      if (inTerminal && !(event.metaKey || (event.ctrlKey && event.shiftKey) || event.altKey)) return;
      const command = refs.commands.current.find(item => item.keys && matches(item.keys, event));
      if (!command) return;
      event.preventDefault(); event.stopPropagation(); run(async () => command.run());
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // ---- render ----
  const errorBanner = error && <div role="alert" className="error">{error}<button onClick={() => setError('')}>닫기</button></div>;
  const quickDialog = quick && <QuickInput key={quick.key} request={quick.request} onClose={() => setQuick(current => current?.key === quick.key ? null : current)} />;
  if (!project) return <main className="app loading" hidden={!active}>{errorBanner}{quickDialog}</main>;

  const gitRepository = project.repositories.find(repo => repo.id === gitRepositoryId);
  const gitControls = project.multiRepo && <><label>Git 저장소<Dropdown label="Git 저장소" value={gitRepositoryId} options={[{ value: '', label: '저장소 선택' }, ...project.repositories.map(repo => ({ value: repo.id, label: repo.name }))]} onChange={selectGitRepository} /></label>{gitRepository && <div className="actions"><label className="check"><input type="checkbox" checked={gitRepository.worktreeEnabled} onChange={event => run(async () => { await call('git/worktree-setting', { enabled: event.target.checked }); await refresh(); await refreshGit(); })} /> worktree 사용</label>{gitRepository.worktreeEnabled && <button onClick={() => run(async () => { if (!(await ask.confirm(`${gitRepository.branch} 변경을 기본 저장소에 fast-forward 통합할까요?`))) return; await call('git/worktree/integrate', { confirm: gitRepository.branch }); await refreshGit(); })}>원본에 통합</button>}</div>}</>;
  const dirtyPaths = new Set(tabs.filter(tab => tab.content !== tab.saved).map(tab => tab.path));
  const editorCtx: EditorCtx = {
    root: project.root, docs: tabs, settings, reveal, gitVersion, loadDiff,
    onChange: onDocChange, onSave: () => run(() => saveFile()), onCursor: (line, column) => setCursor({ line, column }),
    onSelectTab: (group, path) => { commitFor(group, mapLeaf(treeOf(group)!, group, leaf => ({ ...leaf, active: path }))); setFocusLeaf(group); nextReveal(group); },
    onCloseTab: (group, path) => run(() => closeTab(group, path)), onPin: (group, path) => commitFor(group, mapLeaf(treeOf(group)!, group, leaf => leaf.preview === path ? { ...leaf, preview: undefined } : leaf)),
    onSplitEditor: splitEditor, onCloseGroup: group => run(() => closeGroup(group))
  };
  const live = new Set(project.terminals.filter(terminal => !terminal.exited).map(terminal => terminal.id));
  const cwds = Object.fromEntries(project.terminals.filter(terminal => terminal.cwd).map(terminal => [terminal.id, terminal.cwd!]));
  const paneProps = {
    followUpInput: async (id: string, prompt: string, sequence: number, requestId: string) => (await call<{ accepted: boolean }>('terminal/follow-up', { id, prompt, sequence, requestId })).accepted,
    send, bus: bus.current, live, cwds, titles, agentOf, onAgent: (id: string, agent: Agent) => setLaunched(previous => previous[id] === agent ? previous : { ...previous, [id]: agent }),
    onAgentResolved: clearAttention,
    ssh: sshSet, working, attention, onAgentWorking: (id: string, on: boolean) => setWorking(previous => previous.has(id) === on ? previous : on ? new Set(previous).add(id) : new Set([...previous].filter(item => item !== id))),
    onAgentEvent: (id: string, kind: AgentEventKind) => {
      const agent = agentOf(id), owner = refs.paneTabs.current.find(tab => leaves(tab.pane).includes(id)); if (!agent || !owner) return;
      const looking = refs.active.current && document.hasFocus() && refs.focus.current === id && refs.activeTab.current === owner.id;
      if (kind === 'done' && looking) return;
      setAttention(previous => previous[id] === kind || previous[id] === 'attention' ? previous : { ...previous, [id]: kind });
      if (!looking) onAgentAlert(root, { kind, agent, tabId: owner.id, paneId: id, name: tabLabel(owner) });
    }, focus, zoom, onFocus: setFocusLeaf, onZoom: (id: string) => setZoom(value => value === id ? '' : id),
    onSplit: (id: string, direction: 'row' | 'column') => run(() => splitTerminal(id, direction)), onClose: (id: string) => run(() => closeTerminal(id)),
    onSize: (id: string, cols: number, rows: number) => setTermSizes(previous => previous[id] === `${cols}×${rows}` ? previous : { ...previous, [id]: `${cols}×${rows}` }),
    onTitle: (id: string, title: string) => setTitles(previous => previous[id] === title ? previous : { ...previous, [id]: title }), editor: editorCtx
  };
  const rightPanel = <aside className="right-panel" aria-label="오른쪽 패널">
    <ReviewPanel git={git} gitVersion={gitVersion} settings={settings} controls={gitControls} fail={report} refresh={refreshGit} loadDiff={loadDiff}
      openDiffTab={path => run(() => openFile(`diff:all:${path}`))} switchBranch={() => run(switchBranch)}
      hasRepository={project.repositories.length > 0} selectionRequired={project.multiRepo && !gitRepositoryId} />
  </aside>;
  const shown = (id: string) => settings.statusItems.includes(id);
  const liveTerminals = project.terminals.filter(terminal => !terminal.exited).length;
  const center = <div className="tab-stack">{paneTabs.map(tab => <div key={tab.id} className="tab-page" hidden={tab.id !== activeTab}>
    {tab.pane ? <Panes pane={tab.pane} visible={active && tab.id === activeTab} onLayout={next => commitTab(tab.id, next)} {...paneProps} zoom={tab.id === activeTab ? zoom : ''} />
      : <div className="empty-tab"><h2>빈 탭</h2><div className="launchers">{launchers.map(item => <button key={item.id} onClick={() => run(() => launch(item.command, 'split'))}><Icon name={item.icon} size={20} /><strong>{item.label}</strong><small>{item.detail}</small></button>)}</div></div>}
  </div>)}</div>;
  // The review panel floats over the terminals instead of taking a column, so opening it never shrinks them.
  const columns = [false, center, false];
  const sizeIndex = columns.map((column, index) => column ? index : -1).filter(index => index >= 0);
  const workspaceLabel = workspaceId ? project.conversations.find(c => c.id === workspaceId)?.branch || '작업 경로' : basename(project.root.replace(/\\/g, '/'));
  return <main className={`app ${settings.dimInactivePanes ? 'dim-inactive' : ''}`} hidden={!active}>
    <header className="tabbar">
      <div className="split-button">
        <button className="bar-button new-tab" title={`새 터미널 탭 (${showKeys('mod+shift+t')})`} aria-label="새 터미널 탭" onClick={() => run(() => newTab())}><Icon name="plus" /><span>새 탭</span></button>
        <button className="bar-button caret" title="Claude Code · Codex로 새 탭 열기" aria-label="새 탭 종류 선택" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><Icon name="chevronDown" size={14} /></button>
        {menuOpen && <><button className="context-dismiss" aria-label="메뉴 닫기" onClick={() => setMenuOpen(false)} />
          <div className="menu" role="menu">{launchers.map(item => <button role="menuitem" key={item.id} onClick={() => { setMenuOpen(false); run(() => launch(item.command, 'tab')); }}><Icon name={item.icon} /><span><strong>{item.label}</strong><small>{item.detail}</small></span></button>)}</div></>}
      </div>
      <span className="drag-space" />
      <button className="palette-button" onClick={() => run(() => openQuick('>'))} title={`명령 팔레트 (${showKeys('mod+shift+p')})`}><Icon name="search" /><span>{basename(project.root.replace(/\\/g, '/'))}</span><kbd>{showKeys('mod+shift+p')}</kbd></button>
      <button className={`bar-button ${rightVisible ? 'on' : ''}`} title={`변경사항 Diff (${showKeys('mod+shift+g')})`} aria-label="변경사항 Diff 패널" aria-pressed={rightVisible} onClick={toggleReview}>
        <Icon name="diff" />{git.changes.length > 0 && <span className="diffstat"><ins>+{git.additions}</ins><del>−{git.deletions}</del></span>}</button>
      <IconButton icon="settings" label="설정" keys={showKeys('mod+,')} className="bar-icon" onClick={onOpenSettings} />
    </header>
    {errorBanner}
    {/* Always a Splitter, so the center keeps its key and terminals stay mounted when side panels toggle. */}
    <div className="workbench"><Splitter direction="row" keys={sizeIndex.map(index => ['side', 'center', 'right'][index])} sizes={sizeIndex.map(index => widths[index])} onSizes={sizes => setWidths(previous => previous.map((value, index) => sizeIndex.includes(index) ? sizes[sizeIndex.indexOf(index)] : value))}>{columns.filter(Boolean) as ReactNode[]}</Splitter>{rightVisible && rightPanel}</div>
    <footer className="statusbar">
      <div className="status-left">
      <span className={`conn ${connection === '연결됨' ? 'ok' : ''}`} title={connection}><Icon name="wifi" size={13} /></span>
      {shown('path') && <button title={`${project.root}\n클릭: 작업 경로 전환`} onClick={() => run(pickWorkspace)}><Icon name={workspaceId ? 'layers' : 'folder'} size={13} />{workspaceId ? workspaceLabel : shortPath(project.root)}</button>}
      {shown('branch') && <button title="브랜치 전환" onClick={() => run(switchBranch)}><Icon name="branch" size={13} />{git.branch || '브랜치 없음'}</button>}
      {shown('changes') && <button title="변경사항 열기" onClick={showReview}><Icon name="diff" size={13} />{git.changes.length}개 파일<ins>+{git.additions}</ins><del>−{git.deletions}</del></button>}
      </div>
      <div className="status-right">
      {shown('terminals') && <span className="stat" title="실행 중인 터미널"><Icon name="terminal" size={13} />{liveTerminals}</span>}
      {shown('size') && termSizes[focus] && <span className="stat" title="포커스된 터미널 크기 (열 × 행)">{termSizes[focus]}</span>}
      {shown('cpu') && system && <span className="stat" title={`CPU 사용률 · ${system.cores}코어`}><Icon name="cpu" size={13} />{system.cpu}%</span>}
      {shown('memory') && system && <span className="stat" title={`메모리 ${formatBytes(system.memory.used)} / ${formatBytes(system.memory.total)}`}><Icon name="memory" size={13} />{formatBytes(system.memory.used)}</span>}
      {shown('clock') && <Clock />}
      <details className="readiness"><summary title="에이전트·셸 준비 상태"><Icon name="info" size={13} /></summary><div>{Object.entries(health).map(([name, value]) => <p key={name}><b>{name}</b> {value.version} {value.message}</p>)}<button onClick={() => run(async () => setHealth(await call('readiness')))}>다시 확인</button></div></details>
      <button title={`프로젝트 열기 (${showKeys('mod+alt+o')})`} aria-label="프로젝트 열기" onClick={onAddProject}><Icon name="folderPlus" size={14} /></button>
      </div>
    </footer>
    {quickDialog}
    {diffText !== null && <Modal className="diff-modal" labelledBy="diff-title" onClose={() => setDiffText(null)}><section><header><h2 id="diff-title">변경 비교</h2><button onClick={() => setDiffText(null)}>닫기</button></header><pre className="diff-popup">{diffText || '변경이 없습니다.'}</pre></section></Modal>}
    {conflict && <Modal className="conflict-modal" onClose={() => setConflict(null)}><section className="conflict"><h2 id="conflict-title">저장 충돌 · {conflict.path}</h2><p>디스크의 파일이 바뀌었습니다. 왼쪽이 현재 디스크, 오른쪽이 내 편집입니다.</p>
      <div className="conflict-diff"><DiffView original={conflict.content} modified={tabs.find(file => file.path === conflict.path)?.content || ''} path={conflict.path} settings={settings} /></div>
      <div className="actions"><button autoFocus onClick={() => { const { path, revision } = conflict; setConflict(null); run(() => saveFile(path, revision)); }}>내 편집으로 덮어쓰기</button>
        <button onClick={() => { const { path, content, revision } = conflict; setTabs(previous => previous.map(file => file.path === path ? { ...file, content, saved: content, revision, external: false } : file)); setConflict(null); }}>디스크 내용으로 되돌리기</button><button onClick={() => setConflict(null)}>닫기</button></div></section></Modal>}
  </main>;
}));

