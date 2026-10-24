import { forwardRef, Fragment, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { api, ApiError, basename, editorLeaf, equalize, findLeaf, isDiffTab, isTerminal, leafList, leaves, mapLeaf, newId, pruneDead, remove, split, type Leaf, type Pane } from './api';
import { statusLayout, usageHue, type Settings } from './Editor';
import { Icon, IconButton } from './Icon';
import { Launchers, launchers, Panes, type Agent, type AgentEventKind, type EditorCtx, type TerminalBus } from './Panes';
import { detectAgent, resolveAgent } from './terminal-agent';
import { QuickInput, type QuickItem, type QuickRequest } from './QuickInput';
import { ReviewPanel } from './Review';
import { Dropdown, type Ask, type GitState } from './views';

// The app shell owns the single websocket; each open project subscribes to it and receives only its own messages.
export type Hub = { subscribe(projectId: string, handler: (message: any) => void): () => void; send(message: object): boolean };
export type AgentAlert = { kind: AgentEventKind; agent: Agent; tabId: string; paneId: string; name: string; looking?: boolean };
export type PaneInfo = { id: string; label: string; kind: 'terminal' | 'editor'; agent?: Agent; attention: boolean; asking: boolean; working: boolean; focused: boolean };
export type TabInfo = { id: string; label: string; count: number; panes: PaneInfo[]; agent?: Agent; attention: boolean; asking: boolean; working: boolean };
export type WorkspaceStatus = { id: string; name: string; loaded: boolean; attention: number; tabs: TabInfo[]; activeTab: string };
// The shell lists every project's tabs in its sidebar, so a project exposes them here instead of drawing its own tab strip.
export type WorkspaceHandle = { requestClose(): Promise<boolean>; selectTab(id: string): void; selectPane(tabId: string, paneId: string): void; closePane(paneId: string): void; moveTab(id: string, targetId: string, after: boolean): void; mergeTabs(id: string, targetId: string): void; movePane(tabId: string, paneId: string, targetId: string | undefined, mode: 'before' | 'after' | 'merge'): void; closeTab(id: string): void; newTab(): void; renameTab(id: string): void; launcher(): void };
export type Command = { id: string; label: string; keys?: string; hidden?: boolean; run(): void | Promise<unknown> };
export type SystemInfo = { cpu: number; cores: number; memory: { total: number; used: number }; uptime: number; platform: string; hostname: string };
type WorkspaceProps = {
  root: string; active: boolean; hub: Hub; connection: string; settings: Settings; setSettings: Dispatch<SetStateAction<Settings>>; projectCommands: Command[]; system: SystemInfo | null;
  onLegacySettings(settings: Partial<Settings>): void; onStatus(root: string, status: WorkspaceStatus): void; onFailed(root: string, cause: unknown): void; onAddProject(): void; onOpenSettings(): void; onAgentAlert(root: string, alert: AgentAlert): void;
};

type Repository = { id: string; name: string; path: string; worktreeEnabled: boolean; worktreePath: string | null; branch: string | null };
type Snapshot = { id: string; root: string; multiRepo: boolean; repositories: Repository[]; terminals: { id: string; exited: boolean; cwd?: string }[]; ui: any };
// A Warp-style tab: one pane tree of terminals (and editor panes opened next to them).
type PaneTab = { id: string; title?: string; pane: Pane | null; focus?: string };
const emptyGit: GitState = { branch: '', changes: [], additions: 0, deletions: 0 };
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const formatBytes = (bytes: number) => bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)}GB` : `${Math.round(bytes / 2 ** 20)}MB`;
const shortPath = (path: string) => { const clean = path.replace(/\\/g, '/'), parts = clean.split('/').filter(Boolean); return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : clean; };
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(timer); }, []);
  return <span className="stat" title="현재 시각"><Icon name="clock" size={13} />{now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>;
}
// "1 hr 29 mins" → "1h 29m"; the full text stays in the tooltip.
const compactDuration = (text: string) => text.replace(/\s*hrs?\b/g, 'h').replace(/\s*mins?\b/g, 'm').replace(/\s*secs?\b/g, 's');
function WakaTimeStat() {
  const [status, setStatus] = useState<{ today: string; lastSent: number; lastError: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    // The server refreshes today's total at most once a minute, so polling faster would show nothing new.
    const load = () => api<{ today: string; lastSent: number; lastError: string | null }>('wakatime/status').then(value => { if (live) setStatus(value); }, () => {});
    void load(); const timer = setInterval(load, 60000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  if (!status) return null;
  const sent = status.lastSent ? `마지막 전송 ${new Date(status.lastSent).toLocaleTimeString()}` : '아직 전송 전';
  return <span className={`stat ${status.lastError ? 'warn' : ''}`} title={`WakaTime 오늘 기록: ${status.today || '알 수 없음'}\n${sent}${status.lastError ? `\n${status.lastError}` : ''}`}><Icon name="clock" size={13} />{status.today ? compactDuration(status.today) : '—'}</span>;
}
type UsageWindow = { key: string; label: string; percent: number; resetsAt: number | null };
type Usage = { provider: 'claude' | 'codex'; windows: UsageWindow[]; plan: string; source: 'api' | 'log' | null; at: number; error: string | null; note?: string; account: { dir: string; from: 'process' | 'direnv' | 'server' } };
const accountSources = { process: '실행 중인 에이전트', direnv: '프로젝트 .envrc', server: '앱 환경' };
const defaultAccountDir = { claude: '~/.claude', codex: '~/.codex' };
const usageNames = { claude: 'Claude Code', codex: 'Codex' };
const untilReset = (at: number) => {
  const minutes = Math.max(0, Math.round((at - Date.now()) / 60000)), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days ? `${days}일 ${hours}시간` : hours ? `${hours}시간 ${minutes % 60}분` : `${minutes}분`;
};
// The 5-hour and weekly plan limits of the login this project's agent CLI uses; clicking asks the server for a fresh reading.
function UsageStat({ provider, colors, projectId, active }: { provider: Usage['provider']; colors: boolean; projectId: string; active: boolean }) {
  const [usage, setUsage] = useState<Usage | null>(null), [loading, setLoading] = useState(false);
  const load = useCallback((force = false) => {
    setLoading(force);
    return api<Usage>('usage/status', { provider, force, projectId }).then(setUsage, () => {}).finally(() => setLoading(false));
  }, [provider, projectId]);
  useEffect(() => {
    // Hidden projects keep their last reading; switching back refreshes it, since its agent may have changed accounts.
    if (!active) return;
    let live = true;
    const tick = () => { if (live) void load(); };
    tick(); const timer = setInterval(tick, 120000);
    return () => { live = false; clearInterval(timer); };
  }, [load, active]);
  if (!usage) return null;
  const main = ['session', 'weekly'].map(key => usage.windows.find(item => item.key === key)).filter(Boolean) as UsageWindow[];
  const peak = Math.max(0, ...usage.windows.map(item => item.percent));
  const lines = usage.windows.map(item => `${item.label}: ${item.percent}%${item.resetsAt ? ` · ${untilReset(item.resetsAt)} 후 초기화 (${new Date(item.resetsAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })})` : ''}`);
  const from = usage.source === 'log' ? `마지막 Codex 세션 기록 기준 (${new Date(usage.at).toLocaleString()})` : usage.at ? `갱신 ${new Date(usage.at).toLocaleTimeString()}` : '';
  const account = `계정: ${usage.account?.dir || defaultAccountDir[provider]} (${accountSources[usage.account?.from] ?? '앱 환경'} 기준)`;
  const title = [`${usageNames[provider]} 사용량${usage.plan ? ` · ${usage.plan}` : ''}`, account, ...lines, from, usage.error, usage.note, '클릭: 새로고침'].filter(Boolean).join('\n');
  const level = colors ? '' : peak >= 95 ? 'full' : peak >= 80 ? 'warn' : '';
  return <button className={`stat usage ${level} ${usage.error && !main.length ? 'warn' : ''}`} title={title} aria-label={title} aria-busy={loading} onClick={() => void load(true)}>
    <Icon name={provider} size={13} />
    {main.length ? main.map(item => <span key={item.key} className={`usage-window ${colors ? 'graded' : ''}`} style={colors ? { '--usage-hue': usageHue(item.percent) } as CSSProperties : undefined}><small>{item.key === 'session' ? '5h' : '주'}</small>{item.percent}%<i style={{ width: `${item.percent}%` }} /></span>) : '—'}
  </button>;
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
  const [project, setProject] = useState<Snapshot | null>(null), [openError, setOpenError] = useState('');
  const [health, setHealth] = useState<Record<string, any>>({});
  const [gitVersion, setGitVersion] = useState(0);
  const [rightVisible, setRightVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false), [termSizes, setTermSizes] = useState<Record<string, string>>({});
  const [git, setGit] = useState<GitState>(emptyGit), [gitRepositoryId, setGitRepositoryId] = useState('');
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
  const [quick, setQuick] = useState<{ key: number; request: QuickRequest } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const refs = {
    repository: useRef(''), paneTabs: useRef(paneTabs), activeTab: useRef(activeTab), focus: useRef(focus),
    project: useRef(project), lastEditor: useRef(''), commands: useRef<Command[]>([]), quickKey: useRef(0),
    tabFocus: useRef<Record<string, string>>({}), pending: useRef(new Map<string, string>()), active: useRef(active), started: useRef(false), onMessage: useRef<(message: any) => void>(() => {}),
    gitRefresh: useRef<{ running: Promise<void> | null; again: Promise<void> | null }>({ running: null, again: null }), fsRefresh: useRef(0)
  };
  refs.active.current = active;
  refs.repository.current = gitRepositoryId; refs.paneTabs.current = paneTabs; refs.activeTab.current = activeTab;
  refs.focus.current = focus; refs.project.current = project;
  const bus = useRef<TerminalBus>({ buffers: new Map(), listeners: new Map() });
  const call = useCallback(<T = any,>(action: string, input: object = {}) => api<T>(action, { projectId: refs.project.current?.id, ...(refs.project.current?.multiRepo && /^git\//.test(action) ? { repositoryId: refs.repository.current } : {}), ...input }), []);
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const run = (operation: () => Promise<unknown>) => { setError(''); void operation().catch(report); };
  const refresh = useCallback(async () => { const state = await call<Snapshot>('snapshot'); setProject(state); return state; }, [call]);
  const send = useCallback((message: object) => hub.send({ ...message, projectId: refs.project.current?.id }), [hub]);
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
  const focusedLeaf = (): Leaf | undefined => [findLeaf(activePane(), refs.focus.current), findLeaf(activePane(), refs.lastEditor.current)].find(leaf => leaf?.kind === 'editor');
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
  // Empty editor panes disappear.
  function compact(tree: Pane | null): Pane | null {
    let next = tree;
    for (const leaf of leafList(tree)) if (leaf.kind === 'editor' && !(leaf.tabs || []).length) next = next && remove(next, leaf.id);
    return next;
  }
  // A diff opens in the focused (or first) diff pane, or in a new one beside the focused terminal.
  function openDiff(path: string) {
    const tree = activePane();
    const current = focusedLeaf(), target = (current && findLeaf(tree, current.id)) || leafList(tree).find(leaf => leaf.kind === 'editor');
    let id: string;
    if (target) { id = target.id; commitPane(mapLeaf(tree!, id, leaf => ({ ...leaf, tabs: (leaf.tabs || []).includes(path) ? leaf.tabs : [...(leaf.tabs || []), path], active: path }))); }
    else {
      const leaf = editorLeaf([path], path); id = leaf.id;
      const anchor = findLeaf(tree, refs.focus.current) || leafList(tree)[0];
      commitPane(!tree || !anchor ? leaf : split(tree, anchor.id, leaf, 'row'));
    }
    setFocusLeaf(id);
  }
  function closeTab(groupId: string, path: string) {
    const leaf = findLeaf(treeOf(groupId), groupId); if (!leaf) return;
    const list = leaf.tabs || [], index = list.indexOf(path), rest = list.filter(item => item !== path);
    commitFor(groupId, compact(mapLeaf(treeOf(groupId)!, groupId, item => ({ ...item, tabs: rest, active: item.active === path ? rest[index] ?? rest[index - 1] ?? '' : item.active }))));
  }
  function closeGroup(groupId: string) {
    if (findLeaf(treeOf(groupId), groupId)) commitFor(groupId, remove(treeOf(groupId)!, groupId));
  }
  // One git/status at a time: each costs several git processes, and file events arrive every 150 ms while an agent writes.
  // Requests made during a run share a single follow-up run, which still sees every change made before it started.
  function refreshGit(): Promise<void> {
    const slot = refs.gitRefresh.current;
    if (!slot.running) {
      slot.running = loadGit().finally(() => { slot.running = null; });
      return slot.running;
    }
    slot.again ??= slot.running.catch(() => {}).then(() => { slot.again = null; return refreshGit(); });
    return slot.again;
  }
  async function loadGit() {
    const state = refs.project.current;
    if (!state || !state.repositories.length || (state.multiRepo && !state.repositories.some(repo => repo.id === refs.repository.current))) { setGit(emptyGit); return; }
    const next = await call<GitState>('git/status');
    setGit(previous => { if (JSON.stringify(previous) === JSON.stringify(next)) return previous; setGitVersion(value => value + 1); return next; });
  }

  // ---- project lifecycle ----
  // Each open project is its own mounted Workspace, so opening happens once per mount; switching projects never reloads one.
  useEffect(() => {
    if (refs.started.current) return; refs.started.current = true;
    open();
  }, []);
  // A failed open keeps the project in the list with a retry instead of dropping it; a server restart mid-open is the usual cause.
  function open() {
    setOpenError('');
    void loadProject().catch(cause => { setOpenError(cause instanceof Error ? cause.message : String(cause)); onFailed(root, cause); });
  }
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
    if (leaf.kind === 'launcher') return '새 창';
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
      panes: list.length > 1 ? list.map(leaf => ({ id: leaf.id, label: leafLabel(leaf), kind: leaf.kind === 'editor' ? 'editor' : 'terminal', agent: leaf.kind === 'editor' ? undefined : agentOf(leaf.id), attention: Boolean(attention[leaf.id]), asking: attention[leaf.id] === 'attention', working: working.has(leaf.id), focused: leaf.id === current?.id })) : [] };
  }));
  useEffect(() => {
    onStatus(root, { id: project?.id ?? '', name: basename((project?.root ?? root).replace(/\\/g, '/')), loaded: Boolean(project), attention: attentionCount, tabs: JSON.parse(tabInfo), activeTab });
  }, [root, project?.id, project?.root, attentionCount, tabInfo, activeTab]);

  async function loadProject() {
    const state = await api<Snapshot>('project/open', { path: root });
    setRestoring(true);
    refs.project.current = state; setProject(state); bus.current.buffers.clear(); setProcessAgents({}); setLaunched({}); setWorking(new Set()); setAttention({}); setSshSet(new Set()); setTitles({});
    const ui = state.ui || {};
    const nextRepoId = state.repositories.some(repo => repo.id === ui.gitRepositoryId) ? ui.gitRepositoryId : state.repositories[0]?.id || '';
    refs.repository.current = nextRepoId; setGitRepositoryId(nextRepoId);
    setZoom('');
    // Settings used to live in each project's layout; the shell adopts them once and keeps its own copy from then on.
    if (ui.settings) onLegacySettings(ui.settings);
    setRightVisible(ui.rightVisible ?? false);
    // Older versions could also open plain files in editor panes; only diff tabs are kept.
    const clean = (tree: Pane | null): Pane | null => {
      let next = tree; for (const leaf of leafList(tree)) if (leaf.kind === 'editor') next = next && mapLeaf(next, leaf.id, item => { const list = (item.tabs || []).filter(isDiffTab); return { id: item.id, kind: 'editor', tabs: list, active: list.includes(item.active || '') ? item.active : list[0] || '' }; });
      return next;
    };
    const live = new Set(state.terminals.filter(terminal => !terminal.exited).map(terminal => terminal.id));
    // Older layouts saved one `pane`; it becomes the first tab.
    const saved: PaneTab[] = Array.isArray(ui.paneTabs) && ui.paneTabs.length ? ui.paneTabs : ui.pane ? [{ id: newId(), pane: ui.pane }] : [];
    // Terminals that died with the server are reopened in the same place; agents get their previous conversation resumed.
    const renamed = new Map<string, string>(), failed = new Set<string>();
    const revive = async (tree: Pane | null): Promise<Pane | null> => {
      const dead = leafList(tree).filter(leaf => isTerminal(leaf) && !live.has(leaf.id)).slice(0, 16);
      const reopened = await Promise.all(dead.map(async leaf => {
        try {
          const agent = leaf.agent ? { agent: leaf.agent, restoreId: leaf.id } : {};
          const result = await call<{ id: string; command?: string }>('terminal/open', { ...agent, ...(leaf.cwd ? { path: leaf.cwd } : {}) }).catch(() => call<{ id: string; command?: string }>('terminal/open', agent));
          if (result.command && leaf.agent) { refs.pending.current.set(result.id, result.command); setLaunched(previous => ({ ...previous, [result.id]: leaf.agent! })); }
          renamed.set(leaf.id, result.id); live.add(result.id);
          return [leaf.id, result.id] as const;
        } catch (cause) { report(cause); failed.add(leaf.id); return null; }
      }));
      return reopened.reduce<Pane | null>((next, entry) => entry && next ? mapLeaf(next, entry[0], item => ({ ...item, id: entry[1] })) : next, tree);
    };
    const revived: PaneTab[] = await Promise.all(saved.map(async tab => {
      const pane = await revive(clean(tab.pane));
      return { ...tab, pane, focus: tab.focus && renamed.get(tab.focus) || tab.focus };
    }));
    let nextTabs = revived.map(tab => ({ id: tab.id, title: tab.title, focus: tab.focus, pane: compact(pruneDead(tab.pane, new Set([...live, ...failed]))) })).filter(tab => tab.pane);
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
    setRestoring(false);
    void call<Record<string, any>>('readiness').then(setHealth).catch(report);
    if (!leafList(active.pane).some(leaf => leaf.kind !== 'editor')) await openTerminalLeaf('').catch(report);
  }

  refs.onMessage.current = message => {
    try {
          if (message.type === 'snapshot') setProject(message.snapshot);
          // A stream of file events (an agent at work) refreshes Git at most twice a second.
          else if (message.type === 'fs') {
            if (refs.active.current && !refs.fsRefresh.current) refs.fsRefresh.current = window.setTimeout(() => { refs.fsRefresh.current = 0; void refreshGit().catch(report); }, 500);
          }
          else if (message.type === 'terminal' || message.type === 'terminal/replay') {
            const previous = bus.current.buffers.get(message.id);
            if (message.type === 'terminal/replay') {
              if (previous && message.sequence < previous.sequence) return;
              bus.current.buffers.set(message.id, message);
              bus.current.listeners.get(message.id)?.({ ...message, reset: true });
            } else if (!previous || message.sequence > previous.sequence) {
              bus.current.buffers.set(message.id, { ...message, data: ((previous?.data || '') + message.data).slice(-262144) });
              bus.current.listeners.get(message.id)?.(message);
              // A launcher command (claude, codex, cursor-agent) is typed once the shell has printed its first output.
              const command = refs.pending.current.get(message.id);
              if (command !== undefined) { refs.pending.current.delete(message.id); setTimeout(() => send({ type: 'terminal/input', id: message.id, data: `${command}\r` }), 150); }
            }
          } else if (message.type === 'terminal/status') {
            const previous = bus.current.buffers.get(message.id);
            if (previous) {
              bus.current.buffers.set(message.id, { ...previous, status: message.status });
              bus.current.listeners.get(message.id)?.({ data: '', sequence: previous.sequence, status: message.status });
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
            // `lost`: the pty-host connection dropped, not the shell. Keep the pane so the saved layout survives and can be revived.
            if (!message.lost) removeTerminalPane(message.id);
            void refresh().catch(report);
          } else if (message.type === 'error') report(message.error.message);
    } catch (cause) { report(cause); }
  };
  useEffect(() => {
    if (!project?.id) return;
    return hub.subscribe(project.id, message => refs.onMessage.current(message));
  }, [project?.id, hub]);

  // ---- persistence and background refresh ----
  // Terminal leaves are saved with their folder and agent; dead ones are reopened from these on the next start. Unchosen launchers are not saved.
  // An agent running over ssh lives on the remote host, so it is not saved: reviving it would start the local CLI instead.
  const savedAgent = (id: string) => sshSet.has(id) ? undefined : agentOf(id);
  const remember = (tree: Pane | null): Pane | null => leafList(tree).reduce<Pane | null>((next, leaf) => {
    if (leaf.kind === 'launcher') return next && remove(next, leaf.id);
    if (leaf.kind === 'editor' || !next) return next;
    const cwd = cwds[leaf.id] ?? leaf.cwd, agent = savedAgent(leaf.id);
    return mapLeaf(next, leaf.id, item => ({ ...item, ...(cwd ? { cwd } : {}), agent }));
  }, tree);
  const agentKey = paneTabs.flatMap(tab => leafList(tab.pane)).map(leaf => leaf.kind === 'editor' ? '' : savedAgent(leaf.id) ?? '').join(',');
  useEffect(() => {
    if (!project?.id || restoring) return;
    const timer = setTimeout(() => {
      const savedTabs = paneTabs.map(tab => ({ id: tab.id, pane: remember(tab.pane), ...(tab.title ? { title: tab.title } : {}), ...(refs.tabFocus.current[tab.id] ? { focus: refs.tabFocus.current[tab.id] } : {}) }));
      void call('ui', { ui: { gitRepositoryId, paneTabs: savedTabs, activeTab, focus, rightVisible } }).catch(report);
    }, 400);
    return () => clearTimeout(timer);
  }, [project?.id, gitRepositoryId, restoring, paneTabs, activeTab, focus, rightVisible, agentKey, call, report]);
  // Polling only runs for the project being shown and while the window is visible; coming back refreshes immediately.
  useEffect(() => {
    if (!project?.id || !active) return;
    const tick = () => { if (!document.hidden) void refreshGit().catch(report); };
    tick(); const timer = setInterval(tick, settings.diffRefresh * 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [project?.id, gitRepositoryId, active, settings.diffRefresh]);
  useEffect(() => { if (zoom && !findLeaf(activePane(), zoom)) setZoom(''); }, [paneTabs, activeTab, zoom]);

  // ---- terminals ----
  async function openTerminalLeaf(anchorId: string, direction: 'row' | 'column' = 'row', path?: string, command = '') {
    const agent = detectAgent(command);
    const result = await call<{ id: string; command?: string }>('terminal/open', { ...(path ? { path } : {}), ...(agent ? { agent } : {}) });
    if (command) {
      refs.pending.current.set(result.id, result.command || command);
      if (agent) setLaunched(previous => ({ ...previous, [result.id]: agent }));
    }
    const leaf: Leaf = { id: result.id, kind: 'terminal' }, current = activePane();
    const anchor = leaves(current).includes(anchorId) ? anchorId : leaves(current)[0];
    commitPane(!current || !anchor ? leaf : split(current, anchor, leaf, direction)); setFocusLeaf(result.id);
    await refresh();
  }
  // A split first shows the launcher in the new pane; picking an entry turns it into that terminal.
  function splitTerminal(id: string, direction: 'row' | 'column') {
    const leaf: Leaf = { id: newId(), kind: 'launcher' }, current = activePane();
    const anchor = leaves(current).includes(id) ? id : leaves(current)[0];
    commitPane(!current || !anchor ? leaf : split(current, anchor, leaf, direction)); setFocusLeaf(leaf.id);
  }
  async function fillLauncher(id: string, command: string) {
    const agent = detectAgent(command);
    const result = await call<{ id: string; command?: string }>('terminal/open', agent ? { agent } : {});
    if (command) {
      refs.pending.current.set(result.id, result.command || command);
      if (agent) setLaunched(previous => ({ ...previous, [result.id]: agent }));
    }
    const tree = treeOf(id);
    if (tree) { commitFor(id, mapLeaf(tree, id, () => ({ id: result.id, kind: 'terminal' }))); setFocusLeaf(result.id); }
    else await call('terminal/close', { id: result.id });
    await refresh();
  }
  // A plain new tab opens empty, showing the launcher; a command or folder opens its terminal right away.
  async function newTab(command = '', path?: string) {
    const tab: PaneTab = { id: newId(), pane: null };
    commitTabs([...refs.paneTabs.current, tab]); refs.activeTab.current = tab.id; setActiveTab(tab.id); setZoom('');
    if (!command && !path) { setFocusLeaf(''); return; }
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
    if (running.length && !(await ask.confirm(`이 탭을 닫을까요? 실행 중인 터미널 ${running.length}개가 종료됩니다.`))) return;
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
    await call('git/checkout', { branch: choice }); await refreshGit();
  }

  // ---- quick input / commands ----
  async function openPalette() {
    const items = refs.commands.current.filter(command => !command.hidden).map(command => ({ id: command.id, label: command.label, keys: command.keys && showKeys(command.keys) }));
    const choice = await pick('명령 팔레트', items);
    if (choice) await refs.commands.current.find(command => command.id === choice)?.run();
  }
  const showReview = () => { setRightVisible(true); run(refreshGit); };
  const toggleReview = () => { if (rightVisible) setRightVisible(false); else showReview(); };
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
    { id: 'newCursor', label: '새 탭에서 Cursor CLI 실행', run: () => launch('cursor-agent', 'tab') },
    { id: 'splitClaude', label: '오른쪽 pane에서 Claude Code 실행', run: () => launch('claude', 'split') },
    { id: 'splitCodex', label: '오른쪽 pane에서 Codex 실행', run: () => launch('codex', 'split') },
    { id: 'splitCursor', label: '오른쪽 pane에서 Cursor CLI 실행', run: () => launch('cursor-agent', 'split') },
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
    { id: 'palette', label: '명령 팔레트', keys: 'mod+shift+p', hidden: true, run: openPalette },
    { id: 'palette2', label: '명령 팔레트(F1)', keys: 'f1', hidden: true, run: openPalette },
    { id: 'branch', label: '브랜치 전환…', run: switchBranch },
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
  if (!project) return <main className="app loading" hidden={!active}>{errorBanner}{openError && <div className="open-failed"><p>프로젝트를 열지 못했습니다: {openError}</p><button onClick={open}>다시 시도</button></div>}{quickDialog}</main>;

  const gitRepository = project.repositories.find(repo => repo.id === gitRepositoryId);
  const gitControls = project.multiRepo && <><label>Git 저장소<Dropdown label="Git 저장소" value={gitRepositoryId} options={[{ value: '', label: '저장소 선택' }, ...project.repositories.map(repo => ({ value: repo.id, label: repo.name }))]} onChange={selectGitRepository} /></label>{gitRepository && <div className="actions"><label className="check"><input type="checkbox" checked={gitRepository.worktreeEnabled} onChange={event => run(async () => { await call('git/worktree-setting', { enabled: event.target.checked }); await refresh(); await refreshGit(); })} /> worktree 사용</label>{gitRepository.worktreeEnabled && <button onClick={() => run(async () => { if (!(await ask.confirm(`${gitRepository.branch} 변경을 기본 저장소에 fast-forward 통합할까요?`))) return; await call('git/worktree/integrate', { confirm: gitRepository.branch }); await refreshGit(); })}>원본에 통합</button>}</div>}</>;
  const editorCtx: EditorCtx = {
    settings, gitVersion, loadDiff,
    onSelectTab: (group, path) => { commitFor(group, mapLeaf(treeOf(group)!, group, leaf => ({ ...leaf, active: path }))); setFocusLeaf(group); },
    onCloseTab: closeTab, onCloseGroup: closeGroup
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
      // Needing an answer is worth a sound even while you watch the pane; the popup is only for when you are away.
      if (!looking || kind === 'attention') onAgentAlert(root, { kind, agent, tabId: owner.id, paneId: id, name: tabLabel(owner), looking: Boolean(looking) });
    }, focus, zoom, onFocus: setFocusLeaf, onZoom: (id: string) => setZoom(value => value === id ? '' : id),
    onSplit: (id: string, direction: 'row' | 'column') => splitTerminal(id, direction), onLaunch: (id: string, command: string) => run(() => fillLauncher(id, command)), onClose: (id: string) => run(() => closeTerminal(id)),
    onSize: (id: string, cols: number, rows: number) => setTermSizes(previous => previous[id] === `${cols}×${rows}` ? previous : { ...previous, [id]: `${cols}×${rows}` }),
    onTitle: (id: string, title: string) => setTitles(previous => previous[id] === title ? previous : { ...previous, [id]: title }), editor: editorCtx
  };
  const rightPanel = <aside className="right-panel" aria-label="오른쪽 패널">
    <ReviewPanel git={git} gitVersion={gitVersion} settings={settings} controls={gitControls} fail={report} refresh={refreshGit} loadDiff={loadDiff}
      openDiffTab={path => openDiff(`diff:all:${path}`)} switchBranch={() => run(switchBranch)}
      hasRepository={project.repositories.length > 0} selectionRequired={project.multiRepo && !gitRepositoryId} />
  </aside>;
  const shown = (id: string) => settings.statusItems.includes(id);
  const liveTerminals = project.terminals.filter(terminal => !terminal.exited).length;
  const layout = statusLayout(settings);
  const statusNodes: Record<string, ReactNode> = {
    connection: <span className={`conn ${connection === '연결됨' ? 'ok' : ''}`} title={connection}><Icon name="wifi" size={13} /></span>,
    path: <span className="stat" title={project.root}><Icon name="folder" size={13} />{shortPath(project.root)}</span>,
    branch: <button title="브랜치 전환" onClick={() => run(switchBranch)}><Icon name="branch" size={13} />{git.branch || '브랜치 없음'}</button>,
    changes: <button title="변경사항 열기" onClick={showReview}><Icon name="diff" size={13} />{git.changes.length}개 파일<ins>+{git.additions}</ins><del>−{git.deletions}</del></button>,
    terminals: <span className="stat" title="실행 중인 터미널"><Icon name="terminal" size={13} />{liveTerminals}</span>,
    size: termSizes[focus] && <span className="stat" title="포커스된 터미널 크기 (열 × 행)">{termSizes[focus]}</span>,
    cpu: system && <span className="stat" title={`CPU 사용률 · ${system.cores}코어`}><Icon name="cpu" size={13} />{system.cpu}%</span>,
    memory: system && <span className="stat" title={`메모리 ${formatBytes(system.memory.used)} / ${formatBytes(system.memory.total)}`}><Icon name="memory" size={13} />{formatBytes(system.memory.used)}</span>,
    claudeusage: <UsageStat provider="claude" colors={settings.usageColors} projectId={project.id} active={active} />,
    codexusage: <UsageStat provider="codex" colors={settings.usageColors} projectId={project.id} active={active} />,
    wakatime: settings.wakatime && <WakaTimeStat />,
    clock: <Clock />,
    readiness: <details className="readiness"><summary title="에이전트·셸 준비 상태"><Icon name="info" size={13} /></summary><div>{Object.entries(health).map(([name, value]) => <p key={name}><b>{name}</b> {value.version} {value.message}</p>)}<button onClick={() => run(async () => setHealth(await call('readiness', { force: true })))}>다시 확인</button></div></details>,
    openproject: <button title={`프로젝트 열기 (${showKeys('mod+alt+o')})`} aria-label="프로젝트 열기" onClick={onAddProject}><Icon name="folderPlus" size={14} /></button>
  };
  const center = <div className="tab-stack">{paneTabs.map(tab => <div key={tab.id} className="tab-page" hidden={tab.id !== activeTab}>
    {tab.pane ? <Panes pane={tab.pane} visible={active && tab.id === activeTab} onLayout={next => commitTab(tab.id, next)} {...paneProps} zoom={tab.id === activeTab ? zoom : ''} />
      : <Launchers title="새 탭" autoFocus onLaunch={command => run(() => launch(command, 'split'))} />}
  </div>)}</div>;
  return <main className={`app ${settings.dimInactivePanes ? 'dim-inactive' : ''}`} hidden={!active}>
    <header className="tabbar">
      <div className="split-button">
        <button className="bar-button new-tab" title={`새 터미널 탭 (${showKeys('mod+shift+t')})`} aria-label="새 터미널 탭" onClick={() => run(() => newTab())}><Icon name="plus" /><span>새 탭</span></button>
        <button className="bar-button caret" title="Claude Code · Codex · Cursor CLI로 새 탭 열기" aria-label="새 탭 종류 선택" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><Icon name="chevronDown" size={14} /></button>
        {menuOpen && <><button className="context-dismiss" aria-label="메뉴 닫기" onClick={() => setMenuOpen(false)} />
          <div className="menu" role="menu">{launchers.map(item => <button role="menuitem" key={item.id} onClick={() => { setMenuOpen(false); run(() => launch(item.command, 'tab')); }}><Icon name={item.icon} /><span><strong>{item.label}</strong><small>{item.detail}</small></span></button>)}</div></>}
      </div>
      <span className="drag-space" />
      <button className="palette-button" onClick={() => run(openPalette)} title={`명령 팔레트 (${showKeys('mod+shift+p')})`}><Icon name="search" /><span>{basename(project.root.replace(/\\/g, '/'))}</span><kbd>{showKeys('mod+shift+p')}</kbd></button>
      <button className={`bar-button ${rightVisible ? 'on' : ''}`} title={`변경사항 Diff (${showKeys('mod+shift+g')})`} aria-label="변경사항 Diff 패널" aria-pressed={rightVisible} onClick={toggleReview}>
        <Icon name="diff" />{git.changes.length > 0 && <span className="diffstat"><ins>+{git.additions}</ins><del>−{git.deletions}</del></span>}</button>
      <IconButton icon="settings" label="설정" keys={showKeys('mod+,')} className="bar-icon" onClick={onOpenSettings} />
    </header>
    {errorBanner}
    {/* The review panel floats over the terminals instead of taking a column, so opening it never shrinks them. */}
    <div className="workbench">{center}{rightVisible && rightPanel}</div>
    <footer className="statusbar">
      <div className="status-left">{layout.left.filter(shown).map(id => <Fragment key={id}>{statusNodes[id]}</Fragment>)}</div>
      <div className="status-right">{layout.right.filter(shown).map(id => <Fragment key={id}>{statusNodes[id]}</Fragment>)}</div>
    </footer>
    {quickDialog}
  </main>;
}));

