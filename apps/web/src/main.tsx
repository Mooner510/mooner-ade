import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, basename, editorLeaf, equalize, findLeaf, isDiffTab, leafList, leaves, mapLeaf, pruneDead, remove, split, type Leaf, type Pane } from './api';
import { defaultSettings, DiffView, disposeModel, focusedEditor, getModel, loadMonaco, setModelHooks, setRoot, type Reveal, type Settings } from './Editor';
import { attachLsp, type Diagnostic, type Lsp } from './lsp';
import { Panes, Splitter, type EditorCtx, type TerminalBus, type TerminalFeed } from './Panes';
import { QuickInput, type QuickItem, type QuickRequest } from './QuickInput';
import { Dropdown, ExplorerView, Modal, ScmView, SearchView, SettingsView, Transcript, type Ask, type GitState } from './views';
import './style.css';

type FileTab = { path: string; content: string; saved: string; revision: string; external?: boolean };
type Conversation = { id: string; title: string; agentId: string; model?: string | null; effort?: string | null; closedAt?: number; cwd: string; branch?: string; activeRun?: string; threadId?: string; runs: string[]; removed?: boolean };
type AgentModel = { id: string; label: string; efforts: string[]; isDefault?: boolean };
type AgentCatalog = { agentId: string; models: AgentModel[] };
type Event = { sessionId: string; sequence: number; kind: string; text?: string; mode?: string; itemId?: string; [key: string]: any };
type Repository = { id: string; name: string; path: string; worktreeEnabled: boolean; worktreePath: string | null; branch: string | null };
type Snapshot = { id: string; root: string; multiRepo: boolean; repositories: Repository[]; conversations: Conversation[]; runs: { id: string; status: string; prompt: string; conversationId: string }[]; approvals: { id: string; sessionId: string; tool: string; summary: string }[]; terminals: { id: string; exited: boolean; cwd?: string }[]; ui: any };
type Side = 'files' | 'search' | 'git' | 'ai' | 'settings';
type Command = { id: string; label: string; keys?: string; hidden?: boolean; run(): void | Promise<unknown> };
const emptyGit: GitState = { branch: '', changes: [], additions: 0, deletions: 0 };
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const showKeys = (keys: string) => keys.split('+').map(part => ({ mod: mac ? '⌘' : 'Ctrl', ctrl: mac ? '⌃' : 'Ctrl', shift: mac ? '⇧' : 'Shift', alt: mac ? '⌥' : 'Alt' } as Record<string, string>)[part] || (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))).join(mac ? '' : '+');
function keyOf(event: KeyboardEvent) {
  const code = event.code;
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  return ({ Backquote: '`', Backslash: '\\', Comma: ',', BracketLeft: '[', BracketRight: ']' } as Record<string, string>)[code] || event.key.toLowerCase();
}
function matches(keys: string, event: KeyboardEvent) {
  const parts = keys.split('+'), key = parts[parts.length - 1], mods = new Set(parts.slice(0, -1));
  if (mods.has('mod') ? !(event.ctrlKey || event.metaKey) : mods.has('ctrl') ? !event.ctrlKey || event.metaKey : event.ctrlKey || event.metaKey) return false;
  return event.shiftKey === mods.has('shift') && event.altKey === mods.has('alt') && keyOf(event) === key;
}

function App() {
  const [ready, setReady] = useState(false), [error, setError] = useState('');
  const [recent, setRecent] = useState<{ root: string }[]>([]), [projectPath, setProjectPath] = useState('');
  const [project, setProject] = useState<Snapshot | null>(null), [connection, setConnection] = useState('연결 대기');
  const [health, setHealth] = useState<Record<string, any>>({});
  const [treeVersion, setTreeVersion] = useState(0), [gitVersion, setGitVersion] = useState(0);
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [conflict, setConflict] = useState<{ path: string; content: string; revision: string } | null>(null);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [side, setSide] = useState<Side>('files'), [sideVisible, setSideVisible] = useState(true), [panelVisible, setPanelVisible] = useState(false), [panelTab, setPanelTab] = useState<'terminal' | 'problems'>('terminal');
  const [searchFocus, setSearchFocus] = useState({ token: 0, replace: false });
  const [git, setGit] = useState<GitState>(emptyGit), [gitRepositoryId, setGitRepositoryId] = useState('');
  const [diffText, setDiffText] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState(''), [provider, setProvider] = useState('codex'), [mode, setMode] = useState('shared');
  const [catalogs, setCatalogs] = useState<AgentCatalog[]>([]), [model, setModel] = useState(''), [effort, setEffort] = useState(''), [fullAccess, setFullAccess] = useState(false);
  const [viewMode, setViewMode] = useState<'ade' | 'ide'>('ade');
  const [prompt, setPrompt] = useState(''), [events, setEvents] = useState<Record<string, Event[]>>({}), [sending, setSending] = useState(false);
  const [pane, setPane] = useState<Pane | null>(null), [editorPane, setEditorPane] = useState<Pane | null>(null), [panelPane, setPanelPane] = useState<Pane | null>(null), [focus, setFocus] = useState(''), [zoom, setZoom] = useState('');
  const [widths, setWidths] = useState([24, 76]), [heights, setHeights] = useState([68, 32]);
  const [reveal, setReveal] = useState<Record<string, Reveal>>({}), [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [problems, setProblems] = useState<Record<string, Diagnostic[]>>({});
  const [quick, setQuick] = useState<{ key: number; request: QuickRequest } | null>(null);
  const [unread, setUnread] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(''), [restoring, setRestoring] = useState(false);
  const refs = {
    workspace: useRef(''), repository: useRef(''), tabs: useRef(tabs), pane: useRef(pane), editorPane: useRef(editorPane), panelPane: useRef(panelPane), focus: useRef(focus), viewMode: useRef(viewMode),
    project: useRef(project), lsp: useRef<Lsp | null>(null), lastEditor: useRef(''), commands: useRef<Command[]>([]), checking: useRef(false), quickKey: useRef(0)
  };
  refs.workspace.current = workspaceId; refs.repository.current = gitRepositoryId; refs.tabs.current = tabs; refs.pane.current = pane; refs.editorPane.current = editorPane; refs.panelPane.current = panelPane;
  refs.focus.current = focus; refs.viewMode.current = viewMode; refs.project.current = project;
  const socket = useRef<WebSocket | null>(null), cursors = useRef<Record<string, number>>({});
  const bus = useRef<TerminalBus>({ buffers: new Map(), listeners: new Map() });
  const chat = useRef<HTMLDivElement>(null), atBottom = useRef(true);
  const conversation = project?.conversations.find(c => c.id === conversationId);
  const activity = new Map<string, Set<string>>();
  for (const record of project?.runs.filter(record => record.status === 'running') || []) {
    for (const event of events[record.id] || []) {
      if (event.kind !== 'tool') continue;
      const paths = event.tool === 'fileChange' ? (event.data?.changes || []).map((change: { path: string }) => change.path)
        : ['Write', 'Edit', 'MultiEdit'].includes(event.tool) ? [event.data?.input?.file_path] : [];
      for (const path of paths) if (typeof path === 'string') { const owners = activity.get(path) || new Set<string>(); owners.add(record.conversationId); activity.set(path, owners); }
    }
  }
  const call = useCallback(<T = any,>(action: string, input: object = {}) => api<T>(action, { projectId: refs.project.current?.id, ...(/^(files\/|git\/|terminal\/open)/.test(action) && refs.workspace.current ? { conversationId: refs.workspace.current } : {}), ...(refs.project.current?.multiRepo && /^git\//.test(action) ? { repositoryId: refs.repository.current } : {}), ...input }), []);
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const run = (operation: () => Promise<unknown>) => { setError(''); void operation().catch(report); };
  const refresh = useCallback(async () => { const state = await call<Snapshot>('snapshot'); setProject(state); return state; }, [call]);
  const send = useCallback((message: object) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ ...message, projectId: refs.project.current?.id })); }, []);
  const ask = useMemo<Ask>(() => ({
    input: (title, initial) => new Promise<string | null>(resolve => setQuick({ key: ++refs.quickKey.current, request: { kind: 'input', title, initial, resolve } })),
    confirm: async message => (await new Promise<string | null>(resolve => setQuick({ key: ++refs.quickKey.current, request: { kind: 'pick', title: message, items: [{ id: 'yes', label: '확인' }, { id: 'no', label: '취소' }], resolve } }))) === 'yes'
  }), []);
  const pick = (title: string, items: QuickItem[]) => new Promise<string | null>(resolve => setQuick({ key: ++refs.quickKey.current, request: { kind: 'pick', title, items, resolve } }));

  // ---- layout trees ----
  // ADE: `pane` mixes terminals and editor groups. IDE: `editorPane` holds editor groups, `panelPane` the bottom-panel terminals.
  const commitPane = (next: Pane | null) => { refs.pane.current = next; setPane(next); };
  const commitEditorPane = (next: Pane | null) => { refs.editorPane.current = next; setEditorPane(next); };
  const commitPanelPane = (next: Pane | null) => { refs.panelPane.current = next; setPanelPane(next); };
  const slots = { editor: [refs.editorPane, commitEditorPane], pane: [refs.pane, commitPane], panel: [refs.panelPane, commitPanelPane] } as const;
  type Slot = keyof typeof slots;
  const slotOf = (id: string): Slot => (['editor', 'pane', 'panel'] as const).find(name => findLeaf(slots[name][0].current, id)) || 'pane';
  const inEditorTree = (id: string) => slotOf(id) === 'editor';
  const treeOf = (id: string) => slots[slotOf(id)][0].current;
  const commitFor = (id: string, next: Pane | null) => slots[slotOf(id)][1](next);
  const trees = () => [refs.editorPane.current, refs.pane.current, refs.panelPane.current];
  const termSlot = (): Slot => refs.viewMode.current === 'ade' ? 'pane' : 'panel';
  const termTree = () => slots[termSlot()][0].current;
  const commitTerm = (next: Pane | null) => slots[termSlot()][1](next);
  const focusedLeaf = (): Leaf | undefined => trees().map(tree => findLeaf(tree, refs.focus.current)).find(leaf => leaf?.kind === 'editor') || trees().map(tree => findLeaf(tree, refs.lastEditor.current)).find(Boolean);
  const activePath = () => { const leaf = focusedLeaf(); return leaf?.active && !isDiffTab(leaf.active) ? leaf.active : ''; };
  const setFocusLeaf = (id: string) => { setFocus(id); refs.focus.current = id; if (trees().some(tree => findLeaf(tree, id)?.kind === 'editor')) refs.lastEditor.current = id; };
  const nextReveal = (id: string, value: Omit<Reveal, 'nonce'> = {}) => setReveal(previous => ({ ...previous, [id]: { ...value, nonce: Math.random() } }));
  // Empty editor groups disappear, except the last one in the IDE editor area.
  function compact(tree: Pane | null, keepLast: boolean): Pane | null {
    let next = tree;
    for (const leaf of leafList(tree)) if (leaf.kind === 'editor' && !(leaf.tabs || []).length && (!keepLast || (next && leafList(next).length > 1))) next = next && remove(next, leaf.id);
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
    const ade = refs.viewMode.current === 'ade', tree = ade ? refs.pane.current : refs.editorPane.current, commit = ade ? commitPane : commitEditorPane;
    const current = focusedLeaf(), target = (current && findLeaf(tree, current.id)) || leafList(tree).find(leaf => leaf.kind === 'editor');
    let id: string;
    if (target) { id = target.id; commit(mapLeaf(tree!, id, leaf => addTab(leaf, path, preview))); }
    else {
      const leaf = editorLeaf([path], path); id = leaf.id; leaf.preview = preview ? path : undefined;
      const anchor = findLeaf(tree, refs.focus.current) || leafList(tree)[0];
      commit(!tree || !anchor ? leaf : split(tree, anchor.id, leaf, 'row'));
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
    for (const [tree, commit] of [[refs.editorPane.current, commitEditorPane], [refs.pane.current, commitPane]] as const) {
      let next = tree; for (const leaf of leafList(tree)) if (leaf.kind === 'editor') next = next && mapLeaf(next, leaf.id, change);
      if (next !== tree) commit(next);
    }
  };
  async function closeTab(groupId: string, path: string) {
    const leaf = findLeaf(treeOf(groupId), groupId); if (!leaf) return;
    const elsewhere = trees().flatMap(leafList).some(other => other.id !== groupId && other.kind === 'editor' && (other.tabs || []).includes(path));
    const doc = refs.tabs.current.find(tab => tab.path === path);
    if (!elsewhere && doc && doc.content !== doc.saved && !(await ask.confirm(`${path}의 저장하지 않은 변경을 버릴까요?`))) return;
    const slot = slotOf(groupId), list = leaf.tabs || [], index = list.indexOf(path), rest = list.filter(item => item !== path);
    const updated = mapLeaf(treeOf(groupId)!, groupId, item => ({ ...item, tabs: rest, active: item.active === path ? rest[index] ?? rest[index - 1] ?? '' : item.active, preview: item.preview === path ? undefined : item.preview }));
    slots[slot][1](compact(updated, slot === 'editor'));
    if (!elsewhere && doc) { setTabs(previous => previous.filter(tab => tab.path !== path)); disposeModel(path); }
  }
  async function closeGroup(groupId: string) {
    const leaf = findLeaf(treeOf(groupId), groupId); if (!leaf) return;
    for (const path of [...(leaf.tabs || [])]) await closeTab(groupId, path);
    const still = findLeaf(treeOf(groupId), groupId); if (!still) return;
    if (!inEditorTree(groupId) || leafList(refs.editorPane.current).length > 1) commitFor(groupId, remove(treeOf(groupId)!, groupId));
  }
  function splitEditor(groupId: string, direction: 'row' | 'column') {
    const tree = treeOf(groupId), leaf = findLeaf(tree, groupId); if (!tree || !leaf) return;
    const copy = editorLeaf(leaf.active && !isDiffTab(leaf.active) ? [leaf.active] : [], leaf.active);
    commitFor(groupId, split(tree, groupId, copy, direction)); setFocusLeaf(copy.id); nextReveal(copy.id);
  }
  function dropPaths(matchPath: (path: string) => boolean) {
    mapEditors(leaf => { const list = (leaf.tabs || []).filter(path => !matchPath(path)); return list.length === (leaf.tabs || []).length ? leaf : { ...leaf, tabs: list, active: list.includes(leaf.active || '') ? leaf.active : list[0] || '' }; });
    commitEditorPane(compact(refs.editorPane.current, true)); commitPane(compact(refs.pane.current, false));
    for (const tab of refs.tabs.current) if (matchPath(tab.path)) disposeModel(tab.path);
    setTabs(previous => previous.filter(tab => !matchPath(tab.path)));
  }
  function renamePaths(from: string, to: string) {
    const rename = (path: string) => path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
    mapEditors(leaf => ({ ...leaf, tabs: (leaf.tabs || []).map(rename), active: rename(leaf.active || ''), preview: leaf.preview && rename(leaf.preview) }));
    for (const tab of refs.tabs.current) if (rename(tab.path) !== tab.path) disposeModel(tab.path);
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
  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    history.replaceState(null, '', location.pathname);
    api('auth', { token }).then(async () => {
      setReady(true); setRecent(await api('recent'));
      const active = sessionStorage.getItem('ade-project');
      if (active) await openProject(active);
      else void api<Record<string, any>>('readiness').then(setHealth).catch(report);
    }).catch(report);
  }, [report]);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; }, [settings.theme]);
  useEffect(() => {
    setModelHooks({ created: (model, path) => refs.lsp.current?.sync.open(model, path), changed: (model, path) => { onDocChange(path, model.getValue()); refs.lsp.current?.sync.change(model); }, disposed: (model, path) => refs.lsp.current?.sync.close(model, path) });
    return () => setModelHooks(null);
  }, [onDocChange]);

  async function openProject(root: string) {
    if (refs.tabs.current.some(file => file.content !== file.saved) && !(await ask.confirm('저장하지 않은 편집 내용이 있습니다. 프로젝트를 전환할까요?'))) return;
    const state = await api<Snapshot>('project/open', { path: root });
    sessionStorage.setItem('ade-project', state.root);
    setRestoring(true);
    for (const tab of refs.tabs.current) disposeModel(tab.path);
    setRoot(state.root);
    refs.project.current = state; setProject(state); setEvents({}); cursors.current = {}; bus.current.buffers.clear(); setProblems({});
    const ui = state.ui || {};
    const nextRepoId = state.repositories.some(repo => repo.id === ui.gitRepositoryId) ? ui.gitRepositoryId : state.repositories[0]?.id || '';
    refs.repository.current = nextRepoId; setGitRepositoryId(nextRepoId);
    const restoredWorkspace = !state.multiRepo && state.conversations.some(c => c.id === ui.workspaceId && !c.removed) ? ui.workspaceId : '';
    refs.workspace.current = restoredWorkspace; setWorkspaceId(restoredWorkspace);
    const nextMode: 'ade' | 'ide' = ui.viewMode || 'ade';
    setConversationId(ui.conversationId || ''); setViewMode(nextMode); refs.viewMode.current = nextMode; setDiffText(null); setZoom('');
    setSettings({ ...defaultSettings, ...ui.settings }); setSide(ui.side || 'files'); setSideVisible(ui.sideVisible ?? true); setPanelVisible(ui.panelVisible ?? false); setPanelTab(ui.panelTab || 'terminal');
    setWidths(ui.widths?.length === 2 ? ui.widths : [24, 76]); setHeights(ui.heights || [68, 32]);
    const restored: FileTab[] = [];
    for (const file of (ui.tabs || []).slice(0, 30)) {
      try {
        const current = await api<{ content: string; revision: string }>('files/read', { projectId: state.id, conversationId: restoredWorkspace, path: file.path });
        restored.push({ path: file.path, ...current, revision: file.draft !== undefined && file.revision ? file.revision : current.revision, saved: current.content, content: file.draft ?? current.content, external: file.revision && file.revision !== current.revision && file.draft !== undefined });
      } catch (cause) { report(cause); if (typeof file.draft === 'string') restored.push({ path: file.path, content: file.draft, saved: '', revision: file.revision, external: true }); }
    }
    const known = new Set(restored.map(tab => tab.path)), clean = (tree: Pane | null): Pane | null => {
      let next = tree; for (const leaf of leafList(tree)) if (leaf.kind === 'editor') next = next && mapLeaf(next, leaf.id, item => { const list = (item.tabs || []).filter(path => known.has(path) || isDiffTab(path)); return { ...item, tabs: list, active: list.includes(item.active || '') ? item.active : list[0] || '' }; });
      return next;
    };
    const live = new Set(state.terminals.filter(terminal => !terminal.exited).map(terminal => terminal.id));
    const adopt = (tree: Pane | null) => {
      if (leafList(tree).some(leaf => leaf.kind !== 'editor') || !live.size) return tree;
      const adopted: Pane = live.size === 1 ? { id: [...live][0], kind: 'terminal' } : { direction: 'row', children: [...live].map(id => ({ id, kind: 'terminal' as const })), sizes: [...live].map(() => 1) };
      return tree ? { direction: 'row' as const, children: [tree, adopted], sizes: [1, 1] } : adopted;
    };
    const nextPane = compact(adopt(pruneDead(clean(ui.pane || null), live)), false);
    const nextPanel = adopt(pruneDead(ui.panelPane || null, live));
    const nextEditor = compact(ui.editorPane ? clean(ui.editorPane) : restored.length ? editorLeaf(restored.map(tab => tab.path), ui.activeFile || restored[0].path) : null, true);
    commitPane(nextPane); commitEditorPane(nextEditor); commitPanelPane(nextPanel);
    const everyLeaf = [...leafList(nextPane), ...leafList(nextEditor), ...leafList(nextPanel)];
    setFocusLeaf(everyLeaf.some(leaf => leaf.id === ui.focus) ? ui.focus : leafList(nextMode === 'ade' ? nextPane : nextPanel)[0]?.id || everyLeaf[0]?.id || '');
    const lastEditor = leafList(nextEditor).find(leaf => leaf.kind === 'editor') || leafList(nextPane).find(leaf => leaf.kind === 'editor');
    if (lastEditor) refs.lastEditor.current = lastEditor.id;
    setTabs(restored); setRestoring(false);
    setTreeVersion(value => value + 1);
    void call<Record<string, any>>('readiness').then(setHealth).catch(report);
    setCatalogs([]); void call<AgentCatalog[]>('agents/catalog').then(setCatalogs).catch(report);
    if (nextMode === 'ade' && !leafList(nextPane).some(leaf => leaf.kind !== 'editor')) await openTerminalLeaf('').catch(report);
  }

  // ---- websocket ----
  useEffect(() => {
    if (!project?.id) return;
    let stopped = false, retry: ReturnType<typeof setTimeout>;
    function connect() {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); socket.current = ws;
      ws.onopen = () => { setConnection('연결됨'); ws.send(JSON.stringify({ type: 'subscribe', projectId: project!.id, cursors: cursors.current })); };
      ws.onmessage = event => {
        if (stopped) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'snapshot') setProject(message.snapshot);
          else if (message.type === 'approvals') setProject(previous => previous ? { ...previous, approvals: message.approvals } : previous);
          else if (message.type === 'lsp') refs.lsp.current?.handle(message.message);
          else if (message.type === 'fs') { setTreeVersion(value => value + 1); void checkExternal(); }
          else if (message.type === 'event') {
            const entry: Event = message.event;
            // Replay can interleave with live delivery; sort and retain every unique sequence.
            setEvents(previous => {
              const values = previous[entry.sessionId] || [];
              if (values.some(value => value.sequence === entry.sequence)) return previous;
              const next = [...values, entry].sort((a, b) => a.sequence - b.sequence);
              let cursor = 0; for (const value of next) { if (value.sequence !== cursor + 1) break; cursor = value.sequence; }
              cursors.current[entry.sessionId] = cursor;
              return { ...previous, [entry.sessionId]: next };
            });
            if (!atBottom.current) setUnread(true);
          } else if (message.type === 'terminal' || message.type === 'terminal/replay') {
            const previous = bus.current.buffers.get(message.id);
            if (message.type === 'terminal/replay') {
              if (previous && message.sequence < previous.sequence) return;
              bus.current.buffers.set(message.id, message);
              bus.current.listeners.get(message.id)?.({ ...message, reset: true });
            } else if (!previous || message.sequence > previous.sequence) {
              bus.current.buffers.set(message.id, { ...message, data: ((previous?.data || '') + message.data).slice(-262144) });
              bus.current.listeners.get(message.id)?.(message);
            }
          } else if (message.type === 'terminal/exit') {
            const value: TerminalFeed = { ...(bus.current.buffers.get(message.id) || { data: '', sequence: 0 }), exited: true };
            bus.current.buffers.set(message.id, value); bus.current.listeners.get(message.id)?.({ data: '', sequence: value.sequence, exited: true });
            void refresh().catch(report);
          } else if (message.type === 'error') report(message.error.message);
        } catch (cause) { report(cause); }
      };
      ws.onclose = () => { setConnection('연결 끊김 · 재연결 중'); if (!stopped) retry = setTimeout(connect, 1500); };
    }
    connect();
    return () => { stopped = true; clearTimeout(retry); socket.current?.close(); };
  }, [project?.id, refresh, report]);

  // TS/JS language server: only for the project root; worktree workspaces would point at the wrong files.
  useEffect(() => {
    if (!project?.id || workspaceId || connection !== '연결됨') return;
    let stopped = false, lsp: Lsp | undefined;
    void loadMonaco().then(monaco => {
      if (stopped) return;
      send({ type: 'lsp/reset' });
      lsp = attachLsp(monaco, message => send({ type: 'lsp', message }), project.root, {
        diagnostics: (path, items) => setProblems(previous => { const { [path]: _drop, ...rest } = previous; return items.length ? { ...rest, [path]: items } : rest; }),
        open: (path, line, column) => openAt(path, line, column)
      });
      refs.lsp.current = lsp;
    });
    return () => { stopped = true; lsp?.dispose(); refs.lsp.current = null; setProblems({}); };
  }, [project?.id, workspaceId, connection]);

  // ---- persistence and background refresh ----
  useEffect(() => {
    if (!project?.id || restoring) return;
    const timer = setTimeout(() => {
      void call('ui', { ui: { tabs: tabs.map(file => ({ path: file.path, revision: file.revision, ...(file.content !== file.saved ? { draft: file.content } : {}) })), activeFile: activePath(), conversationId, workspaceId, gitRepositoryId, pane, editorPane, panelPane, focus, widths, heights, viewMode, settings, side, sideVisible, panelVisible, panelTab } }).catch(report);
    }, 400);
    return () => clearTimeout(timer);
  }, [project?.id, tabs, conversationId, workspaceId, gitRepositoryId, restoring, pane, editorPane, panelPane, focus, widths, heights, viewMode, settings, side, sideVisible, panelVisible, panelTab, call, report]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (refs.tabs.current.some(file => file.content !== file.saved)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, []);
  useEffect(() => { if (project?.id) { const timer = setInterval(() => void checkExternal(), 10000); return () => clearInterval(timer); } }, [project?.id]);
  useEffect(() => {
    if (!project?.id) return;
    let checking = false;
    const tick = async () => { if (checking) return; checking = true; try { await refreshGit(); } catch (cause) { report(cause); } finally { checking = false; } };
    void tick(); const timer = setInterval(tick, 3000);
    return () => clearInterval(timer);
  }, [project?.id, workspaceId, gitRepositoryId]);
  useEffect(() => { // documents no group shows any more are closed, unless they hold unsaved edits
    if (restoring) return;
    const shown = new Set([...leafList(pane), ...leafList(editorPane)].flatMap(leaf => leaf.kind === 'editor' ? leaf.tabs || [] : []));
    const drop = refs.tabs.current.filter(tab => !shown.has(tab.path) && tab.content === tab.saved);
    if (!drop.length) return;
    drop.forEach(tab => disposeModel(tab.path));
    setTabs(previous => previous.filter(tab => !drop.some(item => item.path === tab.path)));
  }, [pane, editorPane, restoring]);
  useEffect(() => { if (zoom && !trees().some(tree => findLeaf(tree, zoom))) setZoom(''); }, [pane, editorPane, panelPane, zoom]);
  useEffect(() => {
    if (settings.autoSave !== 'afterDelay') return;
    const dirty = tabs.filter(tab => tab.content !== tab.saved && !tab.external);
    if (!dirty.length) return;
    const timer = setTimeout(() => { for (const tab of dirty) saveFile(tab.path).catch(report); }, 1000);
    return () => clearTimeout(timer);
  }, [tabs, settings.autoSave]);
  useEffect(() => { if (atBottom.current && chat.current) chat.current.scrollTop = chat.current.scrollHeight; }, [events]);

  // ---- terminals ----
  async function openTerminalLeaf(anchorId: string, direction: 'row' | 'column' = 'row', path?: string) {
    const result = await call<{ id: string }>('terminal/open', path ? { path } : {});
    const leaf: Leaf = { id: result.id, kind: 'terminal' }, current = termTree();
    const anchor = leaves(current).includes(anchorId) ? anchorId : leaves(current)[0];
    commitTerm(!current || !anchor ? leaf : split(current, anchor, leaf, direction)); setFocusLeaf(result.id);
    await refresh();
  }
  const splitTerminal = (id: string, direction: 'row' | 'column', path?: string) => openTerminalLeaf(id, direction, path);
  async function closeTerminal(id: string) {
    const info = refs.project.current?.terminals.find(terminal => terminal.id === id);
    if (info && !info.exited && !(await ask.confirm('터미널 프로세스를 종료할까요?'))) return;
    if (info) await call('terminal/close', { id });
    commitPane(compact(refs.pane.current && remove(refs.pane.current, id), false)); commitPanelPane(refs.panelPane.current && remove(refs.panelPane.current, id)); await refresh();
  }
  const withoutTerminals = (tree: Pane | null) => leafList(tree).filter(leaf => leaf.kind !== 'editor').reduce<Pane | null>((rest, leaf) => rest && remove(rest, leaf.id), tree);
  const join = (rest: Pane | null, grid: Pane): Pane => rest ? { direction: 'row', children: [rest, grid], sizes: [1, 2] } : grid;
  async function preset() {
    const terminalsInTree = leafList(termTree()).filter(leaf => leaf.kind !== 'editor');
    if (terminalsInTree.length && !(await ask.confirm('현재 터미널을 닫고 6개 새 터미널(2 × 3)로 바꿀까요? 기존 프로세스는 종료됩니다.'))) return;
    for (const leaf of terminalsInTree) if (refs.project.current?.terminals.some(terminal => terminal.id === leaf.id)) await call('terminal/close', { id: leaf.id });
    commitTerm(withoutTerminals(termTree()));
    const ids: string[] = [];
    try { for (let i = 0; i < 6; i++) ids.push((await call<{ id: string }>('terminal/open')).id); }
    finally {
      if (ids.length) {
        const rows = [ids.slice(0, 3), ids.slice(3)].filter(row => row.length);
        commitTerm(join(termTree(), { direction: 'column', sizes: rows.map(() => 1), children: rows.map(row => ({ direction: 'row' as const, sizes: row.map(() => 1), children: row.map(id => ({ id, kind: 'terminal' as const })) })) }));
      }
      setFocusLeaf(ids[0] || ''); await refresh();
    }
  }
  const liveIds = () => (refs.project.current?.terminals || []).filter(terminal => !terminal.exited).map(terminal => terminal.id);
  const liveTerminal = () => leafList(termTree()).find(leaf => leaf.kind !== 'editor' && liveIds().includes(leaf.id));
  // Show the terminals that already run when this layout has none, instead of spawning another shell.
  const ensureTerminal = async (anchorId: string) => { if (liveTerminal()) setFocusLeaf(liveTerminal()!.id); else if (liveIds().length) attachRunning(); else await openTerminalLeaf(anchorId); };
  async function toggleTerminal() {
    if (refs.viewMode.current === 'ide') {
      const hide = panelVisible && panelTab === 'terminal';
      setPanelVisible(!hide); setPanelTab('terminal');
      if (!hide) await ensureTerminal('');
    } else await ensureTerminal(refs.focus.current);
  }
  function attachRunning() {
    const ids = liveIds();
    if (!ids.length) return;
    commitTerm(join(withoutTerminals(termTree()), { direction: 'row', sizes: ids.map(() => 1), children: ids.map(id => ({ id, kind: 'terminal' as const })) })); setFocusLeaf(ids[0]);
  }
  function newEditorGroup() {
    const tree = refs.pane.current, leaf = editorLeaf(), anchor = findLeaf(tree, refs.focus.current) || leafList(tree)[0];
    commitPane(!tree || !anchor ? leaf : split(tree, anchor.id, leaf, 'row')); setFocusLeaf(leaf.id); run(() => openQuick(''));
  }
  function moveFocus(step: number) {
    const ids = leaves(treeOf(refs.focus.current));
    if (ids.length) setFocusLeaf(ids[(Math.max(0, ids.indexOf(refs.focus.current)) + step + ids.length) % ids.length]);
  }
  function cycleTab(step: number) {
    const leaf = focusedLeaf(); if (!leaf?.tabs?.length) return;
    const list = leaf.tabs, next = list[(Math.max(0, list.indexOf(leaf.active || '')) + step + list.length) % list.length];
    commitFor(leaf.id, mapLeaf(treeOf(leaf.id)!, leaf.id, item => ({ ...item, active: next })));
  }

  // ---- workspace / git ----
  async function changeWorkspace(next: string) {
    if (refs.tabs.current.some(file => file.content !== file.saved) && !(await ask.confirm('미저장 편집을 버리고 작업 경로를 바꿀까요?'))) return;
    for (const tab of refs.tabs.current) disposeModel(tab.path);
    refs.workspace.current = next; setWorkspaceId(next); setTabs([]);
    mapEditors(leaf => ({ ...leaf, tabs: [], active: '', preview: undefined }));
    commitEditorPane(compact(refs.editorPane.current, true)); commitPane(compact(refs.pane.current, false));
    setTreeVersion(value => value + 1); await refreshGit();
  }
  const selectGitRepository = (id: string) => {
    refs.repository.current = id; setGitRepositoryId(id);
    if (refs.project.current?.multiRepo && id) void call('git/status', { repositoryId: id }).then(setGit).catch(report); else setGit(emptyGit);
  };
  async function loadDiff(kind: string, path: string) {
    const original = (await call<{ content: string }>('git/show', { path, staged: kind === 'unstaged' })).content;
    const modified = (await call<{ content: string }>('git/show', kind === 'staged' ? { path, staged: true } : { path, working: true })).content;
    return { original, modified };
  }
  async function switchBranch() {
    const { branches } = await call<{ branches: string[] }>('git/branches');
    const choice = await pick('브랜치 전환', branches.map(name => ({ id: name, label: name, detail: name === git.branch ? '현재' : '' })));
    if (!choice || choice === git.branch) return;
    await call('git/checkout', { branch: choice }); await refreshGit(); setTreeVersion(value => value + 1); void checkExternal();
  }

  // ---- AI conversation ----
  async function selectConversation(id: string) {
    const chosen = project?.conversations.find(item => item.id === id);
    if (chosen?.closedAt) await call('conversation/reopen', { conversationId: id });
    setConversationId(id);
    if (chosen) { setProvider(chosen.agentId); setModel(chosen.model || ''); setEffort(chosen.effort || ''); }
    atBottom.current = true; setUnread(false);
    if (chosen?.closedAt) await refresh();
  }
  async function closeConversation() {
    if (!conversation) return;
    await call('conversation/close', { conversationId: conversation.id });
    setConversationId(''); await refresh();
  }
  const interrupted = Boolean(conversation?.threadId && !conversation.activeRun && !conversation.removed &&
    project?.runs.filter(record => record.conversationId === conversationId).at(-1)?.status === 'interrupted');
  async function resumeInterrupted() {
    if (!conversation || sending) return;
    setSending(true);
    try {
      await call('run/start', { conversationId, prompt: '서버가 재시작되어 중단된 작업이 있습니다. 중단된 지점부터 이어서 계속 진행해 주세요.', agentId: conversation.agentId,
        model: conversation.model || null, effort: conversation.effort || null, fullAccess, workspaceMode: mode });
      await refresh();
    } finally { setSending(false); }
  }
  async function submit() {
    if (!prompt.trim() || sending || (conversation?.agentId === provider && conversation.activeRun)) return;
    setSending(true);
    try {
      const result = await call<{ runId: string; conversationId: string }>('run/start', {
        ...(conversation?.agentId === provider ? { conversationId } : {}), prompt, agentId: provider, model: model || null, effort: effort || null, fullAccess,
        workspaceMode: project?.multiRepo ? 'shared' : mode
      });
      setConversationId(result.conversationId); setPrompt(''); await refresh();
    }
    finally { setSending(false); }
  }

  // ---- quick input / commands ----
  async function openQuick(initial = '') {
    const { files } = await call<{ files: string[] }>('files/index');
    const commands = refs.commands.current.filter(command => !command.hidden).map(command => ({ id: `cmd:${command.id}`, label: command.label, keys: command.keys && showKeys(command.keys) }));
    const choice = await new Promise<string | null>(resolve => setQuick({ key: ++refs.quickKey.current, request: { kind: 'files', files, initial, commands, resolve } }));
    if (!choice) return;
    if (choice.startsWith('cmd:')) await refs.commands.current.find(command => command.id === choice.slice(4))?.run();
    else await openFile(choice);
  }
  const showSide = (next: Side) => { setSide(next); setSideVisible(true); };
  const toggleSetting = (key: 'wordWrap' | 'minimap') => setSettings(previous => ({ ...previous, [key]: !previous[key] }));
  const runEditorAction = (id: string) => void loadMonaco().then(monaco => focusedEditor(monaco)?.getAction(id)?.run());
  const saveAs = async () => {
    const path = activePath(), file = refs.tabs.current.find(tab => tab.path === path); if (!file) return;
    const to = await ask.input('다른 이름으로 저장', path); if (!to || to === path) return;
    await call('files/save', { path: to, content: file.content, revision: null }); await openFile(to);
  };
  const closeActiveTab = () => { const leaf = focusedLeaf(); return leaf?.active ? closeTab(leaf.id, leaf.active) : undefined; };
  const selectView = (next: 'ade' | 'ide') => {
    setViewMode(next); refs.viewMode.current = next; setZoom('');
    if (next === 'ade' && !liveTerminal()) run(() => ensureTerminal(refs.focus.current));
  };
  const commands: Command[] = [
    { id: 'quickOpen', label: '파일로 이동…', keys: 'mod+p', run: () => openQuick('') },
    { id: 'palette', label: '명령 팔레트', keys: 'mod+shift+p', hidden: true, run: () => openQuick('>') },
    { id: 'palette2', label: '명령 팔레트(F1)', keys: 'f1', hidden: true, run: () => openQuick('>') },
    { id: 'save', label: '파일 저장', keys: 'mod+s', run: () => saveFile() },
    { id: 'saveAs', label: '다른 이름으로 저장…', keys: 'mod+shift+s', run: saveAs },
    { id: 'saveAll', label: '모두 저장', run: async () => { for (const tab of refs.tabs.current) if (tab.content !== tab.saved) await saveFile(tab.path); } },
    { id: 'closeTab', label: '편집기 닫기', keys: 'alt+w', run: closeActiveTab },
    { id: 'closeTab2', label: '편집기 닫기', keys: 'mod+w', hidden: true, run: closeActiveTab },
    { id: 'nextTab', label: '다음 편집기', keys: 'alt+]', run: () => cycleTab(1) },
    { id: 'prevTab', label: '이전 편집기', keys: 'alt+[', run: () => cycleTab(-1) },
    { id: 'splitEditor', label: '편집기 오른쪽으로 분할', keys: 'mod+\\', run: () => { const leaf = focusedLeaf(); if (leaf) splitEditor(leaf.id, 'row'); else newEditorGroup(); } },
    { id: 'splitEditorDown', label: '편집기 아래로 분할', run: () => { const leaf = focusedLeaf(); if (leaf) splitEditor(leaf.id, 'column'); } },
    { id: 'newEditor', label: '새 편집기 pane 열기 (ADE)', run: newEditorGroup },
    { id: 'toggleSide', label: '사이드바 표시 전환', keys: 'mod+b', run: () => setSideVisible(value => !value) },
    { id: 'togglePanel', label: '패널 표시 전환', keys: 'mod+j', run: () => setPanelVisible(value => !value) },
    { id: 'explorer', label: '탐색기 보기', keys: 'mod+shift+e', run: () => showSide('files') },
    { id: 'search', label: '검색 보기', keys: 'mod+shift+f', run: () => { showSide('search'); setSearchFocus(previous => ({ token: previous.token + 1, replace: false })); } },
    { id: 'replace', label: '파일에서 바꾸기', keys: 'mod+shift+h', run: () => { showSide('search'); setSearchFocus(previous => ({ token: previous.token + 1, replace: true })); } },
    { id: 'scm', label: '소스 제어 보기', keys: 'mod+shift+g', run: () => { showSide('git'); return refreshGit(); } },
    { id: 'ai', label: 'AI 작업 보기', run: () => showSide('ai') },
    { id: 'settings', label: '설정 열기', keys: 'mod+,', run: () => showSide('settings') },
    { id: 'terminal', label: '터미널 표시 전환', keys: 'ctrl+`', run: toggleTerminal },
    { id: 'newTerminal', label: '새 터미널', run: async () => { if (refs.viewMode.current === 'ide') { setPanelVisible(true); setPanelTab('terminal'); } await splitTerminal(refs.focus.current, 'row'); } },
    { id: 'preset', label: '터미널 2 × 3 그리드로 열기', run: preset },
    { id: 'zoom', label: 'Pane 최대화 전환', keys: 'mod+shift+enter', run: () => setZoom(value => value ? '' : refs.focus.current) },
    { id: 'equalize', label: 'Pane 크기 균등화', run: () => { for (const [tree, commit] of Object.values(slots)) if (tree.current) commit(equalize(tree.current)); } },
    { id: 'focusNext', label: '다음 pane으로 이동', keys: 'alt+arrowright', run: () => moveFocus(1) },
    { id: 'focusPrev', label: '이전 pane으로 이동', keys: 'alt+arrowleft', run: () => moveFocus(-1) },
    { id: 'focusNext2', label: '다음 pane으로 이동', keys: 'alt+arrowdown', hidden: true, run: () => moveFocus(1) },
    { id: 'focusPrev2', label: '이전 pane으로 이동', keys: 'alt+arrowup', hidden: true, run: () => moveFocus(-1) },
    { id: 'problems', label: '문제 보기', run: () => { setPanelVisible(true); setPanelTab('problems'); } },
    { id: 'gotoLine', label: '줄로 이동…', run: () => runEditorAction('editor.action.gotoLine') },
    { id: 'gotoSymbol', label: '파일의 기호로 이동…', run: () => runEditorAction('editor.action.quickOutline') },
    { id: 'branch', label: '브랜치 전환…', run: switchBranch },
    { id: 'theme', label: '색 테마 전환', run: () => setSettings(previous => ({ ...previous, theme: previous.theme === 'dark' ? 'light' : 'dark' })) },
    { id: 'wrap', label: '자동 줄바꿈 전환', keys: 'alt+z', run: () => toggleSetting('wordWrap') },
    { id: 'minimap', label: '미니맵 전환', run: () => toggleSetting('minimap') },
    { id: 'viewAde', label: 'ADE 모드로 전환', run: () => selectView('ade') },
    { id: 'viewIde', label: 'IDE 모드로 전환', run: () => selectView('ide') }
  ];
  refs.commands.current = commands;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!refs.project.current || event.isComposing) return;
      const inTerminal = event.target instanceof Element && event.target.closest('.xterm');
      // Plain Ctrl+key belongs to the shell (readline, tmux); only Cmd, Ctrl+Shift and Alt combos reach the IDE.
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
  if (!project) return <main className="welcome"><span className="brand">MOONER ADE</span><h1>내 프로젝트, 한 곳에서.</h1><p>편집 · AI 작업 · 터미널 · 변경 검토</p>{errorBanner}
    <form onSubmit={event => { event.preventDefault(); run(() => openProject(projectPath)); }}><label>프로젝트 절대 경로<input value={projectPath} onChange={event => setProjectPath(event.target.value)} placeholder="/Users/me/project" required /></label><button disabled={!ready}>프로젝트 열기</button></form>
    <h2>준비 상태</h2>{Object.entries(health).map(([name, value]) => <p key={name}>{name}: {value.version} {value.message}</p>)}<button disabled={!ready} onClick={() => run(async () => setHealth(await api('readiness')))}>상태 다시 확인</button>
    <h2>최근 프로젝트</h2>{recent.length ? recent.map(item => <button className="recent" key={item.root} onClick={() => run(() => openProject(item.root))}>{item.root}</button>) : <p>아직 연 프로젝트가 없습니다.</p>}
    {!ready && <p>서버 터미널에 표시된 접속 링크를 여세요.</p>}{quickDialog}</main>;

  const workspaceOptions = [{ value: '', label: '기본 프로젝트' }, ...project.conversations.filter(c => c.branch && !c.removed).map(c => ({ value: c.id, label: `${c.title} · ${c.branch}` }))];
  const gitRepository = project.repositories.find(repo => repo.id === gitRepositoryId);
  const gitControls = project.multiRepo && <><label>Git 저장소<Dropdown label="Git 저장소" value={gitRepositoryId} options={[{ value: '', label: '저장소 선택' }, ...project.repositories.map(repo => ({ value: repo.id, label: repo.name }))]} onChange={selectGitRepository} /></label>{gitRepository && <div className="actions"><label className="check"><input type="checkbox" checked={gitRepository.worktreeEnabled} onChange={event => run(async () => { await call('git/worktree-setting', { enabled: event.target.checked }); await refresh(); await refreshGit(); })} /> worktree 사용</label>{gitRepository.worktreeEnabled && <button onClick={() => run(async () => { if (!(await ask.confirm(`${gitRepository.branch} 변경을 기본 저장소에 fast-forward 통합할까요?`))) return; await call('git/worktree/integrate', { confirm: gitRepository.branch }); await refreshGit(); })}>원본에 통합</button>}</div>}</>;
  const dirtyPaths = new Set(tabs.filter(tab => tab.content !== tab.saved).map(tab => tab.path));
  const allProblems = Object.entries(problems).flatMap(([path, list]) => list.map(item => ({ path, ...item })));
  const errors = allProblems.filter(item => item.severity === 1).length, warnings = allProblems.filter(item => item.severity === 2).length;
  const editorCtx: EditorCtx = {
    docs: tabs, settings, reveal, gitVersion, loadDiff,
    onChange: onDocChange, onSave: () => run(() => saveFile()), onCursor: (line, column) => setCursor({ line, column }),
    onSelectTab: (group, path) => { commitFor(group, mapLeaf(treeOf(group)!, group, leaf => ({ ...leaf, active: path }))); setFocusLeaf(group); nextReveal(group); },
    onCloseTab: (group, path) => run(() => closeTab(group, path)), onPin: (group, path) => commitFor(group, mapLeaf(treeOf(group)!, group, leaf => leaf.preview === path ? { ...leaf, preview: undefined } : leaf)),
    onSplitEditor: splitEditor, onCloseGroup: group => run(() => closeGroup(group))
  };
  const paneProps = {
    send, bus: bus.current, live: new Set(project.terminals.filter(terminal => !terminal.exited).map(terminal => terminal.id)), cwds: Object.fromEntries(project.terminals.filter(terminal => terminal.cwd).map(terminal => [terminal.id, terminal.cwd!])),
    focus, zoom, onFocus: setFocusLeaf, onZoom: (id: string) => setZoom(value => value === id ? '' : id), onSplit: (id: string, direction: 'row' | 'column') => run(() => splitTerminal(id, direction)), onClose: (id: string) => run(() => closeTerminal(id)), editor: editorCtx
  };
  const providerModels = catalogs.find(item => item.agentId === provider)?.models || [], selectedModel = providerModels.find(item => item.id === model);
  const aiView = <section className="ai-panel"><header><strong>AI 작업</strong><select aria-label="세션 선택" value={conversationId} onChange={event => run(() => selectConversation(event.target.value))}><option value="">새 세션</option><optgroup label="열린 세션">{project.conversations.filter(c => !c.closedAt).map(c => <option key={c.id} value={c.id}>{c.title}{c.activeRun ? ' · 실행 중' : ''}</option>)}</optgroup><optgroup label="닫힌 세션">{project.conversations.filter(c => c.closedAt).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</optgroup></select>{conversation && <button aria-label="세션 닫기" title="세션 닫기 · 실행은 계속됩니다" onClick={() => run(closeConversation)}>×</button>}</header>
    {activity.size > 0 && <details className="activity"><summary>AI 파일 작업 · {activity.size}개</summary>{[...activity].map(([path, owners]) => <p key={path}>{owners.size > 1 ? '⚠ 병렬 변경 가능: ' : ''}{path}<small> · {[...owners].map(id => project.conversations.find(c => c.id === id)?.title || id).join(', ')}</small></p>)}</details>}
    {conversation && <details><summary>{conversation.agentId} · {conversation.branch || '공유 작업공간'} · 작업 경로</summary><code>{conversation.cwd}</code><p>확인된 도구 활동은 아래 기록에 표시됩니다. 출처를 확인할 수 없는 파일 변경은 외부 변경으로 표시합니다.</p>
      {conversation.branch && <><button onClick={() => run(async () => setDiffText((await call<{ diff: string }>('git/diff', { conversationId })).diff))}>worktree diff</button><button onClick={() => run(async () => { const message = await ask.input('worktree의 staged 변경 커밋 메시지'); if (message) await call('git/commit', { conversationId, message }); })}>worktree 커밋</button>
        <button disabled={conversation.removed} onClick={() => run(async () => { const status = await call<{ branch: string; changes: unknown[] }>('git/status', { conversationId }); const target = await call<{ branch: string }>('git/status', { conversationId: '' }); if (!(await ask.confirm(`${conversation.branch} → ${target.branch} · 작업 변경 ${status.changes.length}개 · fast-forward 통합할까요?`))) return; await call('worktree/integrate', { conversationId, confirm: conversation.branch, targetBranch: target.branch }); await refresh(); })}>통합</button>
        <button disabled={conversation.removed} onClick={() => run(async () => { const status = await call<{ changes: unknown[] }>('git/status', { conversationId }); if (!(await ask.confirm(`${conversation.cwd} · ${conversation.branch} · 변경 ${status.changes.length}개 · 작업 폴더를 제거할까요? 브랜치는 보존됩니다.`))) return; if (workspaceId === conversationId && tabs.some(file => file.content !== file.saved)) throw new Error('이 작업 경로의 편집 내용을 먼저 저장하세요.'); await call('worktree/remove', { conversationId, confirm: conversation.branch }); if (workspaceId === conversationId) await changeWorkspace(''); await refresh(); })}>제거</button></>}
    </details>}
    <div className="chat" ref={chat} onScroll={() => { if (chat.current) { atBottom.current = chat.current.scrollHeight - chat.current.scrollTop - chat.current.clientHeight < 60; if (atBottom.current) setUnread(false); } }}>
      {!conversation && <p>메시지를 입력하면 선택한 Agent의 새 세션이 시작됩니다.</p>}
      {project.runs.filter(record => record.conversationId === conversationId).map(record => <article key={record.id}><p className="user-message">{record.prompt}</p><small>{record.status} · {record.id.slice(0, 8)}</small><Transcript events={events[record.id] || []} />
        {project.approvals.filter(approval => approval.sessionId === record.id).map(approval => <section className="approval" key={approval.id}><strong>승인 요청 · {approval.tool}</strong><pre>{approval.summary}</pre><button onClick={() => run(() => call('approval', { id: approval.id, approved: true }))}>승인</button><button onClick={() => run(() => call('approval', { id: approval.id, approved: false }))}>거절</button></section>)}
      </article>)}
    </div>
    {unread && <button onClick={() => { atBottom.current = true; setUnread(false); chat.current?.scrollTo({ top: chat.current.scrollHeight }); }}>새 응답 · 최신으로 이동 ↓</button>}
    {interrupted && <div className="notice" role="status"><span>이전 실행이 중단되었습니다 (서버 재시작 등).</span> <button type="button" disabled={sending} onClick={() => run(resumeInterrupted)}>이어하기</button></div>}
    <form className="composer" onSubmit={event => { event.preventDefault(); run(submit); }}><div className="composer-settings"><select aria-label="Agent" value={provider} onChange={event => { setProvider(event.target.value); setModel(''); setEffort(''); }}><option value="codex">Codex</option><option value="claude">Claude</option></select><select aria-label="모델" value={model} onChange={event => { setModel(event.target.value); setEffort(''); }}><option value="">기본 모델</option>{providerModels.map(item => <option key={item.id} value={item.id}>{item.label}{item.isDefault ? ' · 기본' : ''}</option>)}</select><select aria-label="Effort" value={effort} onChange={event => setEffort(event.target.value)}><option value="">기본 Effort</option>{(selectedModel?.efforts || []).map(value => <option key={value} value={value}>{value}</option>)}</select><label title="승인 없이 샌드박스 밖까지 실행합니다"><input type="checkbox" checked={fullAccess} onChange={event => setFullAccess(event.target.checked)} /> Full access</label>{!project.multiRepo && <select aria-label="작업 경로" value={mode} onChange={event => setMode(event.target.value)}><option value="shared">공유 작업공간</option><option value="worktree">별도 worktree</option></select>}</div><label><textarea aria-label="메시지 입력" placeholder="무엇을 만들거나 수정할까요?" value={prompt} onChange={event => setPrompt(event.target.value)} disabled={Boolean(conversation?.removed) || Boolean(conversation?.activeRun && conversation.agentId === provider)} required /></label><div className="actions"><button disabled={!prompt.trim() || sending || Boolean(conversation?.removed) || Boolean(conversation?.activeRun && conversation.agentId === provider)}>{sending ? '시작 중…' : conversation?.agentId === provider ? '보내기' : '세션 시작'}</button><button type="button" disabled={!conversation?.activeRun} onClick={() => run(() => call('run/stop', { runId: conversation?.activeRun }))}>중지</button></div></form>
  </section>;
  const sidebar = <aside className="sidebar" aria-label="사이드바">
    {!project.multiRepo && side !== 'ai' && side !== 'settings' && <label className="workspace-select">작업 경로<Dropdown label="작업 경로 선택" value={workspaceId} options={workspaceOptions} onChange={value => run(() => changeWorkspace(value))} /></label>}
    {side === 'files' && <ExplorerView call={call} ask={ask} active={activePath()} version={treeVersion} bump={() => setTreeVersion(value => value + 1)} fail={report} openFile={(path, preview) => run(() => openFile(path, { preview }))}
      onRenamed={renamePaths} onDeleted={path => dropPaths(item => item === path || item.startsWith(`${path}/`))} openTerminalAt={path => run(async () => { if (viewMode === 'ide') { setPanelVisible(true); setPanelTab('terminal'); } await splitTerminal(refs.focus.current, 'row', path); })} />}
    {side === 'search' && <SearchView call={call} ask={ask} openAt={openAt} dirtyPaths={dirtyPaths} onReplaced={paths => run(() => reloadPaths(paths))} fail={report} focusToken={searchFocus.token} replaceMode={searchFocus.replace} />}
    {side === 'git' && <ScmView git={git} controls={gitControls} call={call} ask={ask} fail={report} refresh={refreshGit} hasRepository={project.repositories.length > 0} selectionRequired={project.multiRepo && !gitRepositoryId} openDiff={(kind, path) => run(() => openFile(`diff:${kind}:${path}`))} />}
    {side === 'ai' && aiView}
    {side === 'settings' && <SettingsView settings={settings} onChange={setSettings} />}
  </aside>;
  const problemsList = <div className="problems" role="list">{allProblems.length ? allProblems.sort((a, b) => a.severity - b.severity || a.path.localeCompare(b.path)).map((item, index) => <button key={index} role="listitem" onClick={() => openAt(item.path, item.line, item.column, 0)}><span className={`sev sev-${item.severity}`}>{item.severity === 1 ? '⊗' : item.severity === 2 ? '⚠' : 'ⓘ'}</span><span>{item.message}</span><small>{item.path} [{item.line}, {item.column}]</small></button>) : <p className="hint">작업 공간에서 문제가 감지되지 않았습니다. (TS/JS 파일을 열면 진단이 표시됩니다.)</p>}</div>;
  const termPane = viewMode === 'ade' ? pane : panelPane;
  const terminalTools = <><button onClick={() => run(() => splitTerminal(focus, 'row'))}>새 터미널</button><button onClick={() => run(preset)}>2 × 3</button><button onClick={attachRunning}>실행 중 PTY 연결</button><button disabled={!termPane} onClick={() => termPane && commitTerm(equalize(termPane))}>균등 배치</button></>;
  const emptyTerminals = <div className="empty">새 터미널 또는 2 × 3 프리셋을 여세요. 이전 서버의 PTY는 복원되지 않습니다.</div>;
  const panes = termPane ? <Panes pane={termPane} onLayout={commitTerm} {...paneProps} /> : emptyTerminals;
  const panel = <section className="panel"><header className="panel-tabs"><button aria-pressed={panelTab === 'terminal'} onClick={() => setPanelTab('terminal')}>터미널</button><button aria-pressed={panelTab === 'problems'} onClick={() => setPanelTab('problems')}>문제{allProblems.length > 0 && <em>{allProblems.length}</em>}</button><span className="spacer" />{panelTab === 'terminal' && terminalTools}<button aria-label="패널 닫기" onClick={() => setPanelVisible(false)}>×</button></header>
    {panelTab === 'terminal' ? panes : problemsList}</section>;
  const editorArea = editorPane ? <Panes pane={editorPane} onLayout={commitEditorPane} {...paneProps} /> : <div className="empty"><h2>파일을 열어 시작하세요</h2><p>{showKeys('mod+p')}로 파일을 열거나 탐색기에서 선택하세요.</p></div>;
  const ideMain = <div className="main-column">{panelVisible ? <Splitter direction="column" sizes={heights} onSizes={setHeights}>{[editorArea, panel]}</Splitter> : editorArea}</div>;
  const problemsPanel = <section className="panel"><header className="panel-tabs"><strong>문제</strong><span className="spacer" /><button aria-label="패널 닫기" onClick={() => setPanelVisible(false)}>×</button></header>{problemsList}</section>;
  const adeMain = <div className="main-column ade-main"><header className="ade-toolbar"><strong>작업 영역</strong>{terminalTools}<button onClick={newEditorGroup}>새 편집기</button><small>Ctrl+D 좌우 · Ctrl+Shift+D 상하 · Alt+←/→ 포커스 · {showKeys('mod+shift+enter')} 최대화</small></header>
    {panelVisible && panelTab === 'problems' ? <Splitter direction="column" sizes={heights} onSizes={setHeights}>{[panes, problemsPanel]}</Splitter> : panes}</div>;
  const activeModel = activePath() ? getModel(activePath()) : undefined;
  const activityItems: { id: Side; label: string; icon: ReactNode; badge?: number }[] = [
    { id: 'files', label: `탐색기 (${showKeys('mod+shift+e')})`, icon: <path d="M3 5h7l2 2h9v12H3z" /> },
    { id: 'search', label: `검색 (${showKeys('mod+shift+f')})`, icon: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></> },
    { id: 'git', label: `소스 제어 (${showKeys('mod+shift+g')})`, icon: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="9" r="2" /><path d="M6 7v10M18 11c0 4-6 3-12 6" /></>, badge: git.changes.length },
    { id: 'ai', label: 'AI 작업', icon: <path d="m12 3 2 6 6 2-6 2-2 6-2-6-6-2 6-2z" /> }
  ];
  const toggleSide = (id: Side) => { if (side === id && sideVisible) setSideVisible(false); else showSide(id); if (id === 'git') run(refreshGit); };
  return <main className={`app ${viewMode}-mode`}>
    <header className="topbar"><strong className="brand-mark">MOONER <em>ADE</em></strong>
      <div className="view-switch" aria-label="화면 모드"><button aria-pressed={viewMode === 'ade'} onClick={() => selectView('ade')}>ADE</button><button aria-pressed={viewMode === 'ide'} onClick={() => selectView('ide')}>IDE</button></div>
      <button className="command-center" onClick={() => run(() => openQuick(''))} title={`파일 검색 ${showKeys('mod+p')} · 명령 ${showKeys('mod+shift+p')}`}>🔍 {basename(project.root)}</button>
      <span className="spacer" /><span className="connection">{connection}</span>
      <button onClick={() => run(async () => { if (tabs.some(file => file.content !== file.saved) && !(await ask.confirm('미저장 편집이 있습니다. 프로젝트 선택으로 돌아갈까요?'))) return; for (const tab of tabs) disposeModel(tab.path); sessionStorage.removeItem('ade-project'); setProject(null); setTabs([]); setRecent(await api<{ root: string }[]>('recent')); })}>프로젝트</button>
      <details className="readiness"><summary>준비 상태</summary><div>{Object.entries(health).map(([name, value]) => <p key={name}>{name}: {value.version} {value.message}</p>)}<button onClick={() => run(async () => setHealth(await call('readiness')))}>다시 확인</button></div></details></header>
    {errorBanner}
    <div className="body">
      <nav className="activitybar" aria-label="활동 표시줄">{activityItems.map(item => <button key={item.id} className={side === item.id && sideVisible ? 'active' : ''} title={item.label} aria-label={item.label} aria-pressed={side === item.id && sideVisible} onClick={() => toggleSide(item.id)}><svg viewBox="0 0 24 24" aria-hidden="true">{item.icon}</svg>{item.badge ? <i>{item.badge > 99 ? '99+' : item.badge}</i> : null}</button>)}
        <span className="spacer" /><button className={side === 'settings' && sideVisible ? 'active' : ''} title={`설정 (${showKeys('mod+,')})`} aria-label="설정" onClick={() => toggleSide('settings')}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></svg></button></nav>
      <div className="workbench">{sideVisible ? <Splitter direction="row" sizes={widths} onSizes={setWidths}>{[sidebar, viewMode === 'ide' ? ideMain : adeMain]}</Splitter> : viewMode === 'ide' ? ideMain : adeMain}</div>
    </div>
    <footer className="statusbar">
      <button title="브랜치 전환" onClick={() => run(switchBranch)}>⎇ {git.branch || '브랜치 없음'}</button><span title="변경 줄 수">+{git.additions} −{git.deletions}</span>
      <button title="문제 보기" onClick={() => { setPanelVisible(true); setPanelTab('problems'); }}>⊗ {errors} ⚠ {warnings}</button><span className="spacer" />
      {activeModel && <><span>줄 {cursor.line}, 열 {cursor.column}</span><span>공백: {settings.tabSize}</span><span>UTF-8</span><span>{activeModel.getEOL() === '\r\n' ? 'CRLF' : 'LF'}</span><span>{activeModel.getLanguageId()}</span></>}
      {dirtyPaths.size > 0 && <span>● 저장 안 됨 {dirtyPaths.size}</span>}</footer>
    {quickDialog}
    {diffText !== null && <Modal className="diff-modal" labelledBy="diff-title" onClose={() => setDiffText(null)}><section><header><h2 id="diff-title">변경 비교</h2><button onClick={() => setDiffText(null)}>닫기</button></header><pre className="diff-popup">{diffText || '변경이 없습니다.'}</pre></section></Modal>}
    {conflict && <Modal className="conflict-modal" onClose={() => setConflict(null)}><section className="conflict"><h2 id="conflict-title">저장 충돌 · {conflict.path}</h2><p>디스크의 파일이 바뀌었습니다. 왼쪽이 현재 디스크, 오른쪽이 내 편집입니다.</p>
      <div className="conflict-diff"><DiffView original={conflict.content} modified={tabs.find(file => file.path === conflict.path)?.content || ''} path={conflict.path} settings={settings} /></div>
      <div className="actions"><button autoFocus onClick={() => { const { path, revision } = conflict; setConflict(null); run(() => saveFile(path, revision)); }}>내 편집으로 덮어쓰기</button>
        <button onClick={() => { const { path, content, revision } = conflict; setTabs(previous => previous.map(file => file.path === path ? { ...file, content, saved: content, revision, external: false } : file)); setConflict(null); }}>디스크 내용으로 되돌리기</button><button onClick={() => setConflict(null)}>닫기</button></div></section></Modal>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
