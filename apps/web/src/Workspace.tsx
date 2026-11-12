import { appKey, matches, showAppKey } from './shortcuts';
export { matches } from './shortcuts';
import { forwardRef, Fragment, memo, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { api, ApiError, basename, beside, chatLeaf, editorLeaf, equalize, findLeaf, isDiffTab, isTerminal, leafList, leaves, mapLeaf, newId, pruneDead, remove, split, type Leaf, type Pane } from './api';
import { agentArgs, preloadMonaco, statusLayout, usageHue, type Settings } from './Editor';
import { PluginBadges } from './PluginSettings';
import { accountSources, cursorUsageCompact, defaultAccountDir, placeAbove, UsageRows, usageHueStyle, usageStatusKeys, usageStatusShort, useUsage, type Usage, type UsageWindow } from './Usage';
import type { ChatCtx } from './ChatPane';
import { showCombo, type ChatState } from './chat-model';
import { Icon, IconButton } from './Icon';
import { useHiddenAgents } from './installed-agents';
import { chatAgent, Launchers, Panes, type Agent, type AgentEventKind, type ClaudeCache, type EditorCtx, type TerminalBus } from './Panes';
import { useShells, shellLabel } from './shells';
import { LauncherMenu } from './LauncherMenu';
import { launchersFor, type AgentMode } from './launchers';
import { chatModeTipDue } from './tips';
import { detectAgent, resolveAgent } from './terminal-agent';
import { QuickInput, type QuickItem, type QuickRequest } from './QuickInput';
import { errorText, pushError } from './errors';
import { ErrorPanel, ErrorTabButton, ErrorToast } from './error-ui';
import { ReviewPanel } from './Review';
import { Dropdown, type Ask, type GitState } from './views';
import { copyText } from './toast';
import { errorLog } from './errors';
import { FeedbackPanel } from './FeedbackPanel';
import { FeedbackCapture } from './FeedbackCapture';
import { aiContext, bytesToBase64, pendingReviewCount } from './feedback-model';
import { canCapture, endCapture, ensureDraft, feedbackCall, openFeedback, refreshFeedback, requestCapture, useFeedback } from './feedback-store';

// The app shell owns the single websocket; each open project subscribes to it and receives only its own messages.
export type Hub = { subscribe(projectId: string, handler: (message: any) => void): () => void; send(message: object): boolean };
export type AgentAlert = { kind: AgentEventKind; agent: Agent; tabId: string; paneId: string; name: string; looking?: boolean };
export type PaneInfo = { id: string; label: string; kind: 'terminal' | 'editor' | 'chat' | 'launcher'; agent?: Agent; attention: boolean; asking: boolean; working: boolean; focused: boolean; cache?: ClaudeCache };
export type TabInfo = { id: string; label: string; kind?: 'chat' | 'launcher'; count: number; panes: PaneInfo[]; agent?: Agent; attention: boolean; asking: boolean; working: boolean; cache?: ClaudeCache };
export type WorkspaceStatus = { id: string; name: string; loaded: boolean; attention: number; tabs: TabInfo[]; activeTab: string };
// The shell lists every project's tabs in its sidebar, so a project exposes them here instead of drawing its own tab strip.
export type WorkspaceHandle = { requestClose(): Promise<boolean>; selectTab(id: string): void; selectPane(tabId: string, paneId: string): void; closePane(paneId: string): void; moveTab(id: string, targetId: string, after: boolean): void; mergeTabs(id: string, targetId: string): void; movePane(tabId: string, paneId: string, targetId: string | undefined, mode: 'before' | 'after' | 'merge'): void; closeTab(id: string): void; newTab(): void; renameTab(id: string): void; launcher(): void };
export type Command = { id: string; label: string; keys?: string; hidden?: boolean; run(): void | Promise<unknown> };
export type SystemInfo = { cpu: number; cores: number; memory: { total: number; used: number }; uptime: number; platform: string; hostname: string };
type WorkspaceProps = {
  root: string; active: boolean; hub: Hub; connection: string; settings: Settings; setSettings: Dispatch<SetStateAction<Settings>>; projectCommands: Command[];
  onLegacySettings(settings: Partial<Settings>): void; onStatus(root: string, status: WorkspaceStatus): void; onFailed(root: string, cause: unknown): void; onAddProject(): void; onOpenSettings(): void; onOpenPlugins(): void; onAgentAlert(root: string, alert: AgentAlert): void;
};

type Repository = { id: string; name: string; path: string; worktreeEnabled: boolean; worktreePath: string | null; branch: string | null };
type Snapshot = { id: string; root: string; multiRepo: boolean; repositories: Repository[]; terminals: { id: string; exited: boolean; cwd?: string }[]; ui: any };
// A Warp-style tab: one pane tree of terminals (and editor panes opened next to them).
type PaneTab = { id: string; title?: string; pane: Pane | null; focus?: string };
const emptyGit: GitState = { branch: '', changes: [], additions: 0, deletions: 0 };
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const formatBytes = (bytes: number) => bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)}GB` : `${Math.round(bytes / 2 ** 20)}MB`;
const shortPath = (path: string) => { const clean = path.replace(/\\/g, '/'), parts = clean.split('/').filter(Boolean); return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : clean; };
// The status bar items are memoized: the workspace re-renders on every pane and agent change, and formatting dates is not free.
const Clock = memo(function Clock({ hour12, seconds }: { hour12: boolean; seconds: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), seconds ? 1000 : 15000); return () => clearInterval(timer); }, [seconds]);
  return <span className="stat" title="현재 시각"><Icon name="clock" size={13} />{now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', ...(seconds && { second: '2-digit' }), hour12 })}</span>;
});
// CPU and memory, sampled every 5 s while a status item shows them and the window is visible. A store of its own, so a sample
// re-renders only these items instead of the whole workspace; one shared poll, since the server reports CPU since the previous call.
let systemInfo: SystemInfo | null = null, systemTimer = 0, systemEvery = 5000;
const systemListeners = new Set<() => void>();
// Changing the interval restarts a running poll; with no item shown the next subscribe picks it up.
const setSystemRefresh = (seconds: number) => { systemEvery = seconds * 1000; if (systemListeners.size) { clearInterval(systemTimer); systemTimer = window.setInterval(sampleSystem, systemEvery); } };
const sampleSystem = () => { if (!document.hidden) void api<SystemInfo>('system/info').then(value => { systemInfo = value; systemListeners.forEach(listener => listener()); }, () => {}); };
function subscribeSystem(listener: () => void) {
  if (!systemListeners.size) { sampleSystem(); systemTimer = window.setInterval(sampleSystem, systemEvery); }
  systemListeners.add(listener);
  return () => { systemListeners.delete(listener); if (!systemListeners.size) { clearInterval(systemTimer); systemInfo = null; } };
}
const SystemStat = memo(function SystemStat({ kind }: { kind: 'cpu' | 'memory' }) {
  const system = useSyncExternalStore(subscribeSystem, () => systemInfo);
  if (!system) return null;
  return kind === 'cpu' ? <span className="stat" title={`CPU 사용률 · ${system.cores}코어`}><Icon name="cpu" size={13} />{system.cpu}%</span>
    : <span className="stat" title={`메모리 ${formatBytes(system.memory.used)} / ${formatBytes(system.memory.total)}`}><Icon name="memory" size={13} />{formatBytes(system.memory.used)}</span>;
});
// "1 hr 29 mins" → "1h 29m"; the full text stays in the tooltip.
const compactDuration = (text: string) => text.replace(/\s*hrs?\b/g, 'h').replace(/\s*mins?\b/g, 'm').replace(/\s*secs?\b/g, 's');
const WakaTimeStat = memo(function WakaTimeStat() {
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
});
const usageNames = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
// The 5-hour and weekly plan limits of the login this project's agent CLI uses; clicking asks the server for a fresh reading.
const UsageStat = memo(function UsageStat({ provider, colors, projectId, active, showSession, refresh }: { provider: Usage['provider']; colors: boolean; projectId: string; active: boolean; showSession: boolean; refresh: number }) {
  const { usage, loading, load } = useUsage(provider, projectId, active, refresh), panel = `usage-${useId()}`;
  if (!usage) return null;
  // Plans without a 5-hour window (Claude Ultra) still get a 0% reading from the API, so the setting hides it everywhere.
  const windows = provider === 'cursor' ? usage.windows : (showSession ? usage.windows : usage.windows.filter(item => item.key !== 'session'));
  const preferred = usageStatusKeys[provider];
  const main = (preferred.map(key => windows.find(item => item.key === key)).filter(Boolean) as UsageWindow[]).slice(0, provider === 'cursor' ? 3 : 2);
  const compact = provider === 'cursor' ? cursorUsageCompact(windows) : (main.length ? main : windows.slice(0, 2));
  const peak = Math.max(0, ...windows.map(item => item.percent));
  const from = usage.source === 'log' ? `마지막 Codex 세션 기록 기준 (${new Date(usage.at).toLocaleString()})` : usage.at ? `갱신 ${new Date(usage.at).toLocaleTimeString()}` : '';
  const account = `${usage.account?.dir || defaultAccountDir[provider]} (${accountSources[usage.account?.from] ?? '앱 환경'} 기준)`;
  const level = colors ? '' : peak >= 95 ? 'full' : peak >= 80 ? 'warn' : '';
  const hue = usageHueStyle;
  return <>
    <button className={`stat usage ${level} ${usage.error && !compact.length ? 'warn' : ''}`} popoverTarget={panel} aria-label={`${usageNames[provider]} 사용량 상세 보기`} aria-busy={loading} onClick={() => void load(true)}>
      <Icon name={provider} size={13} />
      {compact.length ? compact.map(item => <span key={item.key} className={`usage-window ${colors ? 'graded' : ''}`} style={colors ? hue(item.percent) : undefined}><small>{usageStatusShort[item.key] ?? item.label}</small>{item.percent}%<i style={{ width: `${item.percent}%` }} /></span>) : '—'}
    </button>
    <div id={panel} popover="auto" className="usage-detail" role="dialog" aria-label={`${usageNames[provider]} 사용량`} onToggle={placeAbove}>
      <header><Icon name={provider} size={14} /><strong>{usageNames[provider]} 사용량</strong>{usage.plan && <span className="plan">{usage.plan}</span>}
        <button className="icon-btn" title="새로고침" aria-label="새로고침" aria-busy={loading} onClick={() => void load(true)}><Icon name="refresh" size={13} /></button></header>
      <UsageRows windows={windows} colors={colors} />
      <dl><dt>계정</dt><dd>{account}</dd>{from && <><dt>기준</dt><dd>{from}</dd></>}</dl>
      {usage.error && <p className="usage-note warn">{usage.error}</p>}
      {usage.note && <p className="usage-note">{usage.note}</p>}
    </div>
  </>;
});
export const showKeys = (keys: string) => showCombo(keys.replace('mod+', mac ? 'meta+' : 'ctrl+'));

export const Workspace = memo(forwardRef<WorkspaceHandle, WorkspaceProps>(function Workspace({ root, active, hub, connection, settings, setSettings, projectCommands, onLegacySettings, onStatus, onFailed, onAddProject, onOpenSettings, onOpenPlugins, onAgentAlert }, handleRef) {
  const [project, setProject] = useState<Snapshot | null>(null), [openError, setOpenError] = useState('');
  const [health, setHealth] = useState<Record<string, any>>({});
  const [gitVersion, setGitVersion] = useState(0);
  const [rightVisible, setRightVisible] = useState(false), [errorsOpen, setErrorsOpen] = useState(false), [feedbackOpen, setFeedbackOpen] = useState(false), [reviewWide, setReviewWide] = useState(false);
  const feedback = useFeedback();
  const [menuOpen, setMenuOpen] = useState(false), [termSizes, setTermSizes] = useState<Record<string, string>>({});
  const launcherButton = useRef<HTMLButtonElement>(null);
  const closeLauncherMenu = () => { setMenuOpen(false); launcherButton.current?.focus(); };
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
  const [caches, setCaches] = useState<Record<string, ClaudeCache>>({});
  const dropCache = (id: string) => setCaches(previous => { if (!(id in previous)) return previous; const { [id]: _gone, ...rest } = previous; return rest; });
  const clearAttention = (id: string) => setAttention(previous => { if (!(id in previous)) return previous; const { [id]: _gone, ...rest } = previous; return rest; });
  const agentOf = (id: string): Agent | undefined => resolveAgent(processAgents[id], launched[id], titles[id], sshSet.has(id));
  const [quick, setQuick] = useState<{ key: number; request: QuickRequest } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const shells = useShells();
  const settingsRef = useRef(settings); settingsRef.current = settings;
  useEffect(() => setSystemRefresh(settings.systemRefresh), [settings.systemRefresh]);
  // Monaco is several MB to parse; reading it while the app is idle keeps that cost out of the moment the review panel opens.
  useEffect(() => {
    if (!('requestIdleCallback' in window)) return;
    const id = requestIdleCallback(preloadMonaco, { timeout: 8000 }); return () => cancelIdleCallback(id);
  }, []);
  const refs = {
    repository: useRef(''), paneTabs: useRef(paneTabs), activeTab: useRef(activeTab), focus: useRef(focus),
    project: useRef(project), lastEditor: useRef(''), commands: useRef<Command[]>([]), quickKey: useRef(0), quickRequest: useRef<QuickRequest | null>(null),
    tabFocus: useRef<Record<string, string>>({}), pending: useRef(new Map<string, string>()), active: useRef(active), started: useRef(false), onMessage: useRef<(message: any) => void>(() => {}),
    gitRefresh: useRef<{ running: Promise<void> | null; again: Promise<void> | null }>({ running: null, again: null }), fsRefresh: useRef(0)
  };
  refs.active.current = active;
  refs.repository.current = gitRepositoryId; refs.paneTabs.current = paneTabs; refs.activeTab.current = activeTab;
  refs.focus.current = focus; refs.project.current = project;
  // Chat panes listen here for their own `chat/event` / `chat/state` messages; `chatPrev` remembers each chat's last status to tell "finished" from "started".
  const chatBus = useRef(new Map<string, (message: any) => void>()), chatPrev = useRef(new Map<string, ChatState['status']>());
  const bus = useRef<TerminalBus>({ buffers: new Map(), listeners: new Map(), sizes: new Map(), sizeListeners: new Map() });
  const call = useCallback(<T = any,>(action: string, input: object = {}) => api<T>(action, { projectId: refs.project.current?.id, ...(refs.project.current?.multiRepo && /^git\//.test(action) ? { repositoryId: refs.repository.current } : {}), ...input }), []);
  const report = useCallback((cause: unknown) => pushError(root, errorText(cause)), [root]);
  const switching = useRef(new Set<string>());
  const run = (operation: () => Promise<unknown>) => { void operation().catch(report); };
  const refresh = useCallback(async () => { const state = await call<Snapshot>('snapshot'); setProject(state); return state; }, [call]);
  const send = useCallback((message: object) => hub.send({ ...message, projectId: refs.project.current?.id }), [hub]);
  // A dialog that replaces another one cancels it: its caller (e.g. a terminal holding an Enter back) would otherwise wait forever.
  const openQuick = (request: QuickRequest) => { refs.quickRequest.current?.resolve(null); refs.quickRequest.current = request; setQuick({ key: ++refs.quickKey.current, request }); };
  const ask = useMemo<Ask>(() => ({
    input: (title, initial) => new Promise<string | null>(resolve => openQuick({ kind: 'input', title, initial, resolve })),
    confirm: async message => (await new Promise<string | null>(resolve => openQuick({ kind: 'pick', title: message, items: [{ id: 'yes', label: '확인' }, { id: 'no', label: '취소' }], resolve }))) === 'yes'
  }), []);
  const pick = (title: string, items: QuickItem[]) => new Promise<string | null>(resolve => openQuick({ kind: 'pick', title, items, resolve }));
  // A link clicked in a terminal: warn, then open in the default browser, copy the address, or cancel. Only the visible project answers.
  useEffect(() => {
    const onLink = (event: Event) => {
      const uri = (event as CustomEvent<string>).detail;
      if (!refs.active.current || typeof uri !== 'string') return;
      void pick(`외부 링크를 열까요? 신뢰할 수 있는 주소인지 확인하세요.\n${uri}`, [{ id: 'open', label: '기본 브라우저로 열기' }, { id: 'copy', label: '링크 복사' }, { id: 'cancel', label: '취소' }]).then(choice => {
        if (choice === 'open') window.open(uri, '_blank', 'noopener');
        else if (choice === 'copy') {
          copyText(uri);
        }
      });
    };
    window.addEventListener('ade:link', onLink);
    return () => window.removeEventListener('ade:link', onLink);
  }, []);

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
  // Pulls one pane out of a split tab: into another tab ('merge'), or out as a tab of its own before/after a tab (no target: right after its old tab).
  function movePane(tabId: string, paneId: string, targetId: string | undefined, mode: 'before' | 'after' | 'merge') {
    const list = refs.paneTabs.current, source = list.find(tab => tab.id === tabId), leaf = source?.pane && findLeaf(source.pane, paneId);
    if (!source?.pane || !leaf || leafList(source.pane).length < 2 || (mode === 'merge' && targetId === tabId)) return;
    const rest = remove(source.pane, paneId), target = targetId ? list.find(tab => tab.id === targetId) : undefined;
    let next = list.map(tab => tab.id === tabId ? { ...tab, pane: rest } : tab), landed = '';
    if (mode === 'merge' && target?.pane) {
      landed = target.id;
      next = next.map(tab => tab.id === target.id ? { ...tab, pane: beside(target.pane!, leaf) } : tab);
    } else {
      const fresh: PaneTab = { id: newId(), pane: leaf }, anchor = next.findIndex(tab => tab.id === (target?.id ?? tabId));
      landed = fresh.id; next = [...next.slice(0, anchor + (mode === 'before' ? 0 : 1)), fresh, ...next.slice(anchor + (mode === 'before' ? 0 : 1))];
    }
    commitTabs(next); delete refs.tabFocus.current[tabId];
    selectTab(landed); setFocusLeaf(paneId);
  }
  // Swaps the active tab with its neighbour (sidebar order).
  function moveTabBy(step: number) {
    const list = refs.paneTabs.current, at = list.findIndex(tab => tab.id === refs.activeTab.current), to = at + step;
    if (at < 0 || to < 0 || to >= list.length) return;
    const next = [...list]; [next[at], next[to]] = [next[to], next[at]]; commitTabs(next);
  }
  useImperativeHandle(handleRef, () => ({
    selectTab: id => selectTab(id), closePane: id => run(() => closeTerminal(id)),
    // Reordering only changes the list order; the saved layout follows it.
    // Dropping a tab onto another folds its panes into it, side by side.
    mergeTabs: (id, targetId) => {
      const list = refs.paneTabs.current, source = list.find(tab => tab.id === id), target = list.find(tab => tab.id === targetId);
      if (!source?.pane || !target?.pane || id === targetId) return;
      const merged = beside(target.pane, source.pane), first = leafList(source.pane)[0]?.id || '';
      commitTabs(list.filter(tab => tab.id !== id).map(tab => tab.id === targetId ? { ...tab, pane: merged } : tab));
      delete refs.tabFocus.current[id];
      selectTab(targetId); if (first) setFocusLeaf(first);
    },
    movePane,
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
          if (settingsRef.current.confirmCloseProject && !(await ask.confirm(`${cause.message} 모두 종료하고 프로젝트를 닫을까요?`))) return false;
          await api('project/close', { projectId, force: true });
        } else if (cause.code !== 'NOT_FOUND') throw cause;
      }
      return true;
    }
  }));
  const leafLabel = (leaf: Leaf, fallbackTitle?: string) => {
    if (leaf.kind === 'editor') return leaf.active ? basename(leaf.active.split(':').pop() || leaf.active) : '편집기';
    if (leaf.kind === 'launcher') return '새 창';
    if (leaf.kind === 'chat') return titles[leaf.id] || `${leaf.agent === 'codex' ? 'Codex' : leaf.agent === 'cursor' ? 'Cursor' : 'Claude'} 채팅`;
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
  const cacheOf = (id: string) => agentOf(id) === 'claude' ? caches[id] : undefined;
  const tabInfo = JSON.stringify(paneTabs.map(tab => {
    const list = leafList(tab.pane);
    const focusedId = refs.tabFocus.current[tab.id], current = list.find(leaf => leaf.id === focusedId) || list[0];
    return { id: tab.id, label: tabLabel(tab), kind: current?.kind === 'chat' ? 'chat' : !current || current.kind === 'launcher' ? 'launcher' : undefined, count: list.length, agent: current?.kind === 'chat' ? current.agent ?? 'claude' : current && current.kind !== 'editor' ? agentOf(current.id) : undefined, attention: list.some(leaf => attention[leaf.id]), asking: list.some(leaf => attention[leaf.id] === 'attention'), working: list.some(leaf => working.has(leaf.id)), cache: list.length === 1 ? cacheOf(list[0].id) : undefined,
      panes: list.length > 1 ? list.map(leaf => ({ id: leaf.id, label: leafLabel(leaf), kind: leaf.kind === 'editor' ? 'editor' : leaf.kind === 'chat' ? 'chat' : leaf.kind === 'launcher' ? 'launcher' : 'terminal', agent: leaf.kind === 'editor' ? undefined : leaf.kind === 'chat' ? leaf.agent ?? 'claude' : agentOf(leaf.id), attention: Boolean(attention[leaf.id]), asking: attention[leaf.id] === 'attention', working: working.has(leaf.id), focused: leaf.id === current?.id, cache: cacheOf(leaf.id) })) : [] };
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
          const agent = leaf.agent ? { agent: leaf.agent, restoreId: leaf.id, args: agentArgs(settingsRef.current, leaf.agent) } : {};
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
    // A project with nothing to restore shows the launcher (an empty tab) instead of opening a shell nobody chose.
  }

  refs.onMessage.current = message => {
    try {
          if (message.type === 'snapshot') { setProject(message.snapshot); for (const listener of chatBus.current.values()) listener({ type: 'reconnect' }); }
          else if (message.type === 'chat/event' || message.type === 'chat/state') chatBus.current.get(message.id)?.(message);
          // Global (no projectId), so every open project hears it; the store folds the burst into one reload.
          else if (message.type === 'feedback/changed') void refreshFeedback();
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
              // Kept for a remounted pane's replay (which takes the last 256 KB). Trimming copies it all, so it waits for twice that.
              const data = (previous?.data || '') + message.data;
              bus.current.buffers.set(message.id, { ...message, data: data.length > 524288 ? data.slice(-262144) : data });
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
          } else if (message.type === 'terminal/size') {
            // Kept for a pane that mounts later; the server sends it again on every (re)subscribe.
            const size = { cols: message.cols, rows: message.rows };
            bus.current.sizes.set(message.id, size);
            bus.current.sizeListeners.get(message.id)?.(size);
          } else if (message.type === 'terminal/ssh') {
            setSshSet(previous => previous.has(message.id) === message.ssh ? previous : message.ssh ? new Set(previous).add(message.id) : new Set([...previous].filter(item => item !== message.id)));
          } else if (message.type === 'terminal/agent') {
            setProcessAgents(previous => previous[message.id] === message.agent ? previous : { ...previous, [message.id]: message.agent });
            setSshSet(previous => message.ssh ? new Set(previous).add(message.id) : new Set([...previous].filter(item => item !== message.id)));
            if (!message.agent) {
              clearAttention(message.id);
              setWorking(previous => new Set([...previous].filter(item => item !== message.id)));
              setLaunched(previous => { const next = { ...previous }; delete next[message.id]; return next; });
            }
          } else if (message.type === 'terminal/cache') {
            if (message.cache) setCaches(previous => ({ ...previous, [message.id]: message.cache })); else dropCache(message.id);
          } else if (message.type === 'terminal/exit') {
            dropCache(message.id);
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
    if (leaf.kind === 'editor' || leaf.kind === 'chat' || !next) return next;
    const cwd = cwds[leaf.id] ?? leaf.cwd, agent = savedAgent(leaf.id);
    return mapLeaf(next, leaf.id, item => ({ ...item, ...(cwd ? { cwd } : {}), agent }));
  }, tree);
  const agentKey = paneTabs.flatMap(tab => leafList(tab.pane)).map(leaf => leaf.kind === 'editor' || leaf.kind === 'chat' ? '' : savedAgent(leaf.id) ?? '').join(',');
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
  // A chat leaf has no server-side process of its own: the pane asks the server to open its session (chat/open) when it mounts.
  function addChatLeaf(anchorId: string, direction: 'row' | 'column', path?: string, agent: Agent = 'claude') {
    const leaf = chatLeaf(path, agent), current = activePane();
    const anchor = leaves(current).includes(anchorId) ? anchorId : leaves(current)[0];
    commitPane(!current || !anchor ? leaf : split(current, anchor, leaf, direction)); setFocusLeaf(leaf.id);
  }
  async function openTerminalLeaf(anchorId: string, direction: 'row' | 'column' = 'row', path?: string, command = '') {
    if (chatAgent(command)) return addChatLeaf(anchorId, direction, path, chatAgent(command));
    const agent = detectAgent(command);
    const result = await call<{ id: string; command?: string }>('terminal/open', { ...(path ? { path } : {}), ...(agent ? { agent, args: agentArgs(settings, agent) } : {}) });
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
    if (chatAgent(command)) {
      const tree = treeOf(id), leaf = chatLeaf(undefined, chatAgent(command));
      if (tree) { commitFor(id, mapLeaf(tree, id, () => leaf)); setFocusLeaf(leaf.id); }
      return;
    }
    const agent = detectAgent(command);
    const result = await call<{ id: string; command?: string }>('terminal/open', agent ? { agent, args: agentArgs(settings, agent) } : {});
    if (command) {
      refs.pending.current.set(result.id, result.command || command);
      if (agent) setLaunched(previous => ({ ...previous, [result.id]: agent }));
    }
    const tree = treeOf(id);
    if (tree) { commitFor(id, mapLeaf(tree, id, () => ({ id: result.id, kind: 'terminal' }))); setFocusLeaf(result.id); }
    else await call('terminal/close', { id: result.id });
    await refresh();
  }
  // Terminal -> chat. The server agrees only while that Claude is completely at rest, then ends it and seeds the chat from its transcript (same session).
  async function terminalToChat(id: string) {
    if (switching.current.has(id)) return;
    switching.current.add(id);
    try { await terminalToChatNow(id); } finally { switching.current.delete(id); }
  }
  async function terminalToChatNow(id: string) {
    const leaf = chatLeaf(), { cwd } = await call<{ cwd: string }>('terminal/to-chat', { id, newId: leaf.id }), tree = treeOf(id);
    if (tree) commitFor(id, mapLeaf(tree, id, () => ({ ...leaf, cwd })));
    refs.pending.current.delete(id); bus.current.buffers.delete(id); bus.current.listeners.delete(id); bus.current.sizes.delete(id); bus.current.sizeListeners.delete(id);
    clearAttention(id); setWorking(previous => { const next = new Set(previous); next.delete(id); return next; });
    setFocusLeaf(leaf.id); await refresh();
  }
  // Chat -> terminal: the server ends the chat's child, then the same session opens in a terminal in the chat's place; the stored chat is dropped last.
  // An empty chat (nothing said yet) has no session to continue: it becomes a fresh CLI of the same provider, like a new tab would.
  async function chatToTerminal(id: string, fresh = false) {
    if (switching.current.has(id)) return;
    switching.current.add(id);
    try { await chatToTerminalNow(id, fresh); } finally { switching.current.delete(id); }
  }
  async function chatToTerminalNow(id: string, fresh: boolean) {
    const leafNow = findLeaf(treeOf(id), id), chosen: Agent = leafNow?.kind === 'chat' ? leafNow.agent ?? 'claude' : 'claude';
    const info = fresh
      ? { agent: chosen, restoreId: '', cwd: leafNow?.kind === 'chat' ? leafNow.cwd ?? '' : '', configDir: undefined as string | undefined }
      : await call<{ agent: Agent; restoreId: string; cwd: string; configDir?: string }>('chat/to-terminal', { id });
    const result = await call<{ id: string; command?: string }>('terminal/open', { ...(info.cwd ? { path: info.cwd } : {}), agent: info.agent, args: agentArgs(settings, info.agent), ...(info.restoreId ? { restoreId: info.restoreId } : {}), ...(info.configDir && { configDir: info.configDir }) });
    refs.pending.current.set(result.id, result.command || (info.agent === 'cursor' ? 'cursor-agent' : info.agent)); setLaunched(previous => ({ ...previous, [result.id]: info.agent }));
    const tree = treeOf(id);
    if (!tree) { await call('terminal/close', { id: result.id }); return; }
    commitFor(id, mapLeaf(tree, id, () => ({ id: result.id, kind: 'terminal' })));
    await call('chat/close', { id, forget: true }).catch(report);
    chatBus.current.delete(id); chatPrev.current.delete(id); clearAttention(id); setWorking(previous => { const next = new Set(previous); next.delete(id); return next; });
    setFocusLeaf(result.id); await refresh();
  }
  // A plain new tab opens empty, showing the launcher; a command or folder opens its terminal right away.
  async function newTab(command = '', path?: string) {
    const tab: PaneTab = { id: newId(), pane: null };
    commitTabs([...refs.paneTabs.current, tab]); refs.activeTab.current = tab.id; setActiveTab(tab.id); setZoom('');
    if (!command && !path) { setFocusLeaf(''); return; }
    await openTerminalLeaf('', 'row', path, command);
  }
  // Branch: the server seeds a new chat from an old one up to one message; it opens in its own tab and opens its session like any chat.
  async function branchChat(sourceId: string, uuid: string, cwd?: string) {
    const leaf = chatLeaf(cwd, findLeaf(treeOf(sourceId), sourceId)?.agent ?? 'claude');
    await call('chat/branch', { id: sourceId, uuid, newId: leaf.id });
    const tab: PaneTab = { id: newId(), pane: leaf };
    commitTabs([...refs.paneTabs.current, tab]); refs.activeTab.current = tab.id; setActiveTab(tab.id); setZoom(''); setFocusLeaf(leaf.id);
  }
  async function resumeChat(id: string, agent: Agent) {
    const existing = tabOf(id);
    if (existing) { selectTab(existing.id); setFocusLeaf(id); return; }
    if (refs.paneTabs.current.length >= 16) throw new Error('프로젝트당 최대 16개 탭을 열 수 있습니다.');
    // Open first: invalid or missing stored sessions must not create an empty tab.
    const sessions = await call<{ id: string }[]>('chat/sessions', { agent });
    if (!sessions.some(session => session.id === id)) throw new Error('저장된 대화를 찾을 수 없습니다.');
    await call('chat/open', { id, agent });
    const opened = tabOf(id);
    if (opened) { selectTab(opened.id); setFocusLeaf(id); return; }
    const tab: PaneTab = { id: newId(), pane: { id, kind: 'chat', agent } };
    commitTabs([...refs.paneTabs.current, tab]); refs.activeTab.current = tab.id; setActiveTab(tab.id); setZoom(''); setFocusLeaf(id);
  }
  // A conversation made with the plain `claude` CLI becomes a new chat tab; the server writes its transcript into the chat first.
  async function importCliChat(sessionId: string) {
    if (refs.paneTabs.current.length >= 16) throw new Error('프로젝트당 최대 16개 탭을 열 수 있습니다.');
    const leaf = chatLeaf(undefined, 'claude');
    await call('chat/import-cli', { sessionId, newId: leaf.id });
    const tab: PaneTab = { id: newId(), pane: leaf };
    commitTabs([...refs.paneTabs.current, tab]); refs.activeTab.current = tab.id; setActiveTab(tab.id); setZoom(''); setFocusLeaf(leaf.id);
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
    refs.pending.current.delete(id); bus.current.buffers.delete(id); bus.current.listeners.delete(id); bus.current.sizes.delete(id); bus.current.sizeListeners.delete(id);
    const owner = tabOf(id);
    if (owner) { commitTab(owner.id, compact(owner.pane && remove(owner.pane, id))); dropEmptyTab(owner.id); }
    if (refs.focus.current === id) setFocusLeaf(leaves(activePane())[0] || '');
    clearAttention(id);
    setWorking(previous => { const next = new Set(previous); next.delete(id); return next; });
  }
  // Start screen only: the same pane becomes a fresh chat of another provider. A chat with earlier (cleared) history keeps its transcript for /resume.
  async function switchChatAgent(id: string, agent: Agent, forget: boolean) {
    const tree = treeOf(id), old = findLeaf(tree, id);
    if (!tree || old?.kind !== 'chat' || old.agent === agent) return;
    await call('chat/close', { id, forget });
    chatBus.current.delete(id); chatPrev.current.delete(id);
    commitFor(id, mapLeaf(tree, id, leaf => leaf.kind === 'chat' ? { ...leaf, agent } : leaf)); setFocusLeaf(id);
  }
  // Closing a chat ends its child process and keeps the transcript for /resume.
  async function closeChat(id: string) {
    if (working.has(id) && settingsRef.current.confirmCloseChat && !(await ask.confirm('응답 중인 채팅을 닫을까요? 진행 중인 작업이 중단됩니다.'))) return;
    await call('chat/close', { id }).catch(report);
    chatBus.current.delete(id); chatPrev.current.delete(id);
    removeTerminalPane(id);
  }
  // Status of a chat for the sidebar: working while it answers, attention while it waits for an approval, done (once) when it finishes.
  function onChatState(id: string, state: ChatState) {
    const before = chatPrev.current.get(id); chatPrev.current.set(id, state.status);
    paneProps.onAgentWorking(id, state.status === 'working' || state.status === 'attention');
    if (state.status === 'attention' && before !== 'attention') paneProps.onAgentEvent(id, 'attention');
    else if (before === 'attention' && state.status !== 'attention') clearAttention(id);
    if (state.status === 'idle' && before === 'working') paneProps.onAgentEvent(id, 'done');
  }
  async function closeTerminal(id: string) {
    if (findLeaf(treeOf(id), id)?.kind === 'chat') return closeChat(id);
    const info = refs.project.current?.terminals.find(terminal => terminal.id === id);
    if (info && !info.exited && settingsRef.current.confirmClose && !(await ask.confirm('터미널 프로세스를 종료할까요?'))) return;
    if (info) await call('terminal/close', { id });
    removeTerminalPane(id);
    await refresh();
  }
  async function closePaneTab(tabId: string) {
    const tab = refs.paneTabs.current.find(item => item.id === tabId); if (!tab) return;
    const running = leafList(tab.pane).filter(leaf => leaf.kind !== 'editor' && refs.project.current?.terminals.some(terminal => terminal.id === leaf.id && !terminal.exited));
    const answering = leafList(tab.pane).filter(leaf => leaf.kind === 'chat' && working.has(leaf.id));
    if (((running.length && settingsRef.current.confirmClose) || (answering.length && settingsRef.current.confirmCloseChat)) && !(await ask.confirm(`이 탭을 닫을까요? 실행 중인 터미널 ${running.length}개, 응답 중인 채팅 ${answering.length}개가 종료됩니다.`))) return;
    for (const leaf of leafList(tab.pane)) if (leaf.kind === 'chat') { await call('chat/close', { id: leaf.id }).catch(report); chatBus.current.delete(leaf.id); chatPrev.current.delete(leaf.id); }
    for (const leaf of leafList(tab.pane)) if (leaf.kind !== 'editor' && refs.project.current?.terminals.some(terminal => terminal.id === leaf.id)) await call('terminal/close', { id: leaf.id });
    // The final tab stays open and empty, showing the launcher.
    if (refs.paneTabs.current.length < 2) { commitTab(tabId, null); setFocusLeaf(''); setZoom(''); await refresh(); return; }
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
  const withoutTerminals = (tree: Pane | null) => leafList(tree).filter(leaf => leaf.kind !== 'editor' && leaf.kind !== 'chat').reduce<Pane | null>((rest, leaf) => rest && remove(rest, leaf.id), tree);
  const join = (rest: Pane | null, grid: Pane): Pane => rest ? { direction: 'row', children: [rest, grid], sizes: [1, 2] } : grid;
  async function preset() {
    const terminalsInTree = leafList(activePane()).filter(leaf => leaf.kind !== 'editor' && leaf.kind !== 'chat');
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
  // The git poll already keeps the state fresh; the extra refresh waits out the slide-in so it does not re-render the workspace mid-animation.
  const showReview = () => { setErrorsOpen(false); setFeedbackOpen(false); preloadMonaco(); setRightVisible(true); setTimeout(() => run(refreshGit), 300); };
  const toggleReview = () => { if (errorsOpen || feedbackOpen) { showReview(); return; } if (rightVisible) setRightVisible(false); else showReview(); };
  const toggleErrors = () => { setFeedbackOpen(false); setErrorsOpen(value => !value); };
  // The feedback inbox shares the right panel slot: opening it closes the error list and covers the diff, like the error list does.
  const showFeedback = () => { setErrorsOpen(false); setFeedbackOpen(true); };
  const toggleFeedback = () => { setErrorsOpen(false); setFeedbackOpen(value => !value); };
  const startCapture = () => { if (!canCapture()) throw new Error('화면 캡쳐는 데스크톱 앱에서만 쓸 수 있습니다.'); requestCapture('element'); };
  // Text for an AI draft about what is on screen: app version, open panes, project, the last few errors of this project.
  const feedbackContext = async () => {
    if (!settingsRef.current.feedbackAiContext) return undefined;
    const desktop = (window as unknown as { adeDesktop?: { appInfo?(): Promise<{ version: string }> } }).adeDesktop;
    const appVersion = await desktop?.appInfo?.().then(info => info.version, () => undefined);
    const kinds: Record<string, string> = { terminal: '터미널', editor: 'diff 편집기', chat: '채팅', launcher: '새 창' };
    const paneName = (leaf: Leaf) => {
      if (leaf.kind === 'chat') return `${kinds.chat}(${leaf.agent ?? 'claude'})`;
      if (leaf.kind && leaf.kind !== 'terminal') return kinds[leaf.kind];
      const agent = agentOf(leaf.id); return agent ? `${kinds.terminal}(${agent})` : kinds.terminal;
    };
    const panes = refs.paneTabs.current.map((tab, index) => `${tab.id === refs.activeTab.current ? '*' : ''}탭${index + 1}[${leafList(tab.pane).map(paneName).join(' | ') || '빈 탭'}]`);
    return aiContext({ appVersion, project: basename((refs.project.current?.root ?? root).replace(/\\/g, '/')), panes, errors: errorLog(root).items.slice(0, 5).map(item => item.message) }) || undefined;
  };
  const hiddenAgents = useHiddenAgents(settings.agentsOff);
  const launchers = launchersFor(settings.defaultMode, shellLabel(shells, settings.terminalShell)).filter(item => !hiddenAgents.includes(item.id));
  async function pickLauncher(where: 'tab' | 'split') {
    const choice = await pick(where === 'tab' ? '새 탭에서 실행' : '오른쪽 pane에서 실행', launchers.map(item => ({ id: item.id, label: item.label, detail: item.detail })));
    const item = launchers.find(entry => entry.id === choice);
    if (item) await launch(item.command, where);
  }
  const allCommands: Command[] = [
    { id: 'newTab', label: '새 탭', run: () => newTab() },
    { id: 'newTab2', label: '새 탭', hidden: true, run: () => newTab() },
    ...launchers.filter(item => item.id !== 'shell').flatMap(item => [
      { id: `new${item.id}`, label: `새 탭에서 ${item.label} 실행`, run: () => launch(item.command, 'tab') },
      { id: `split${item.id}`, label: `오른쪽 pane에서 ${item.label} 실행`, run: () => launch(item.command, 'split') }
    ]),
    { id: 'launcher', label: '새 탭에서 실행…', run: () => pickLauncher('tab') },
    { id: 'closeTab', label: '탭 닫기', run: () => closePaneTab(refs.activeTab.current) },
    { id: 'renameTab', label: '탭 이름 바꾸기…', run: () => renamePaneTab(refs.activeTab.current) },
    { id: 'nextTab', label: '다음 탭', run: () => cyclePaneTab(1) },
    { id: 'prevTab', label: '이전 탭', run: () => cyclePaneTab(-1) },
    { id: 'moveTabUp', label: '탭을 위로 이동', run: () => moveTabBy(-1) },
    { id: 'moveTabDown', label: '탭을 아래로 이동', run: () => moveTabBy(1) },
    { id: 'detachPane', label: '포커스된 pane을 새 탭으로 분리', run: () => movePane(refs.activeTab.current, refs.focus.current, undefined, 'after') },
    { id: 'nextTab2', label: '다음 탭', hidden: true, run: () => cyclePaneTab(1) },
    { id: 'prevTab2', label: '이전 탭', hidden: true, run: () => cyclePaneTab(-1) },
    ...Array.from({ length: 9 }, (_, index) => ({ id: `tab${index + 1}`, label: `${index + 1}번 탭`, hidden: true, run: () => { const tab = refs.paneTabs.current[index === 8 ? refs.paneTabs.current.length - 1 : index]; if (tab) selectTab(tab.id); } })),
    { id: 'splitRight', label: '오른쪽으로 분할', run: () => splitTerminal(refs.focus.current, 'row') },
    { id: 'splitDown', label: '아래로 분할', run: () => splitTerminal(refs.focus.current, 'column') },
    { id: 'closePane', label: '포커스된 pane 닫기', run: closeFocused },
    { id: 'preset', label: '현재 탭을 터미널 2 × 3 그리드로', run: preset },
    { id: 'zoom', label: 'Pane 최대화 전환', run: () => setZoom(value => value ? '' : refs.focus.current) },
    { id: 'equalize', label: 'Pane 크기 균등화', run: () => { const tree = activePane(); if (tree) commitPane(equalize(tree)); } },
    { id: 'focusNext', label: '다음 pane으로 이동', run: () => moveFocus(1) },
    { id: 'focusPrev', label: '이전 pane으로 이동', run: () => moveFocus(-1) },
    { id: 'focusNext2', label: '다음 pane으로 이동', hidden: true, run: () => moveFocus(1) },
    { id: 'focusPrev2', label: '이전 pane으로 이동', hidden: true, run: () => moveFocus(-1) },
    { id: 'focusModright', label: '다음 pane으로 이동', hidden: true, run: () => moveFocus(1) },
    { id: 'focusModleft', label: '이전 pane으로 이동', hidden: true, run: () => moveFocus(-1) },
    { id: 'focusModdown', label: '다음 pane으로 이동', hidden: true, run: () => moveFocus(1) },
    { id: 'focusModup', label: '이전 pane으로 이동', hidden: true, run: () => moveFocus(-1) },
    { id: 'review', label: '변경사항(Diff) 패널 전환', run: toggleReview },
    { id: 'feedback', label: '피드백 창고', run: toggleFeedback },
    { id: 'feedbackCapture', label: '피드백: 화면 캡쳐', run: startCapture },
    { id: 'palette', label: '명령 팔레트', hidden: true, run: openPalette },
    { id: 'palette2', label: '명령 팔레트(F1)', hidden: true, run: openPalette },
    { id: 'branch', label: '브랜치 전환…', run: switchBranch },
    { id: 'theme', label: '색 테마 전환', run: () => setSettings(previous => ({ ...previous, theme: previous.theme === 'dark' ? 'light' : 'dark' })) },
    ...projectCommands
  ];
  // A hidden agent drops out of the palette too (ids: newClaude, splitCodex, …).
  const commands = allCommands.filter(command => !hiddenAgents.includes(command.id.replace(/^(?:new|split)/, '').replace(/Chat$/, '').toLowerCase())).map(command => ({ ...command, keys: appKey(settings.appKeys, command.id) }));
  refs.commands.current = commands;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!refs.project.current || !refs.active.current || event.isComposing) return;
      if (document.querySelector('.tour, .feedback-capture')) return; // the tutorial's practice keys must not touch real projects; a capture in progress owns the keys
      const inTerminal = event.target instanceof Element && event.target.closest('.xterm');
      const command = refs.commands.current.find(item => item.keys && matches(item.keys, event));
      if (!command) return;
      // A dialog keeps the keys to itself, except the feedback capture, which is how a dialog gets into a screenshot.
      if (document.querySelector('dialog[open]') && command.id !== 'feedbackCapture') return;
      // Preserve shell Ctrl bindings unless the user explicitly assigned one to an app action.
      if (inTerminal && !(event.metaKey || (event.ctrlKey && event.shiftKey) || event.altKey) && !['splitRight', 'splitDown'].includes(command.id) && !settingsRef.current.appKeys?.[command.id]) return;
      event.preventDefault(); event.stopPropagation(); run(async () => command.run());
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // ---- render ----
  const quickDialog = quick && <QuickInput key={quick.key} request={quick.request} onClose={() => setQuick(current => current?.key === quick.key ? null : current)} />;
  if (!project) return <main className="app loading" hidden={!active}><ErrorToast scope={root} active={active} />{openError && <div className="open-failed"><p>프로젝트를 열지 못했습니다: {openError}</p><button onClick={open}>다시 시도</button></div>}{quickDialog}</main>;

  const gitRepository = project.repositories.find(repo => repo.id === gitRepositoryId);
  const gitControls = project.multiRepo && <><label>Git 저장소<Dropdown label="Git 저장소" value={gitRepositoryId} options={[{ value: '', label: '저장소 선택' }, ...project.repositories.map(repo => ({ value: repo.id, label: repo.name }))]} onChange={selectGitRepository} /></label>{gitRepository && <div className="actions"><label className="check"><input type="checkbox" checked={gitRepository.worktreeEnabled} onChange={event => run(async () => { await call('git/worktree-setting', { enabled: event.target.checked }); await refresh(); await refreshGit(); })} /> worktree 사용</label>{gitRepository.worktreeEnabled && <button onClick={() => run(async () => { if (!(await ask.confirm(`${gitRepository.branch} 변경을 기본 저장소에 fast-forward 통합할까요?`))) return; await call('git/worktree/integrate', { confirm: gitRepository.branch }); await refreshGit(); })}>원본에 통합</button>}</div>}</>;
  const editorCtx: EditorCtx = {
    settings, gitVersion, loadDiff,
    onSelectTab: (group, path) => { commitFor(group, mapLeaf(treeOf(group)!, group, leaf => ({ ...leaf, active: path }))); setFocusLeaf(group); },
    onCloseTab: closeTab, onCloseGroup: closeGroup
  };
  const live = new Set(project.terminals.filter(terminal => !terminal.exited).map(terminal => terminal.id));
  const cwds = Object.fromEntries(project.terminals.filter(terminal => terminal.cwd).map(terminal => [terminal.id, terminal.cwd!]));
  const onModeChange = (defaultMode: AgentMode) => setSettings(previous => ({ ...previous, defaultMode }));
  const paneProps = {
    onModeChange,
    followUpInput: async (id: string, prompt: string, sequence: number, requestId: string) => (await call<{ accepted: boolean }>('terminal/follow-up', { id, prompt, sequence, requestId })).accepted,
    // "취소" comes first so it is the preselected entry: the Enter that triggered this must not also accept it.
    confirmSend: async (message: string) => (await pick(message, [{ id: 'no', label: '취소' }, { id: 'yes', label: '그래도 보내기' }])) === 'yes',
    send, bus: bus.current, live, cwds, titles, agentOf, onAgent: (id: string, agent: Agent) => setLaunched(previous => previous[id] === agent ? previous : { ...previous, [id]: agent }),
    onAgentResolved: clearAttention,
    ssh: sshSet, working, attention, caches, onAgentWorking: (id: string, on: boolean) => setWorking(previous => previous.has(id) === on ? previous : on ? new Set(previous).add(id) : new Set([...previous].filter(item => item !== id))),
    onAgentEvent: (id: string, kind: AgentEventKind) => {
      const owner = refs.paneTabs.current.find(tab => leaves(tab.pane).includes(id)), agent = findLeaf(owner?.pane ?? null, id)?.kind === 'chat' ? findLeaf(owner?.pane ?? null, id)?.agent ?? 'claude' : agentOf(id); if (!agent || !owner) return;
      const looking = refs.active.current && document.hasFocus() && refs.focus.current === id && refs.activeTab.current === owner.id;
      if (kind === 'done' && looking) return;
      setAttention(previous => previous[id] === kind || previous[id] === 'attention' ? previous : { ...previous, [id]: kind });
      // Needing an answer is worth a sound even while you watch the pane; the popup is only for when you are away.
      if (!looking || kind === 'attention') onAgentAlert(root, { kind, agent, tabId: owner.id, paneId: id, name: tabLabel(owner), looking: Boolean(looking) });
    }, focus, zoom, onFocus: (id: string) => { setFocusLeaf(id); if (attention[id] === 'done') clearAttention(id); }, onZoom: (id: string) => setZoom(value => value === id ? '' : id),
    onSplit: (id: string, direction: 'row' | 'column') => splitTerminal(id, direction), onLaunch: (id: string, command: string) => run(() => fillLauncher(id, command)), onClose: (id: string) => run(() => closeTerminal(id)), onToChat: (id: string) => run(() => terminalToChat(id)),
    onSize: (id: string, cols: number, rows: number) => setTermSizes(previous => previous[id] === `${cols}×${rows}` ? previous : { ...previous, [id]: `${cols}×${rows}` }),
    onTitle: (id: string, title: string) => setTitles(previous => previous[id] === title ? previous : { ...previous, [id]: title }), editor: editorCtx
  };
  // Dragging only moves a CSS variable on the panel; the width is saved to the settings once the pointer is released.
  const clampReview = (value: number) => Math.max(320, Math.min(1600, Math.round(value)));
  const startReviewResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget, panel = handle.parentElement!, startX = event.clientX, startWidth = panel.getBoundingClientRect().width; let width = clampReview(startWidth);
    handle.setPointerCapture(event.pointerId); handle.classList.add('dragging'); document.body.classList.add('resizing'); setReviewWide(false);
    const move = (e: PointerEvent) => { width = clampReview(startWidth + startX - e.clientX); panel.style.setProperty('--review-w', `${width}px`); };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); handle.classList.remove('dragging'); document.body.classList.remove('resizing'); setSettings(previous => previous.reviewWidth === width ? previous : { ...previous, reviewWidth: width }); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  };
  const reviewShown = rightVisible && !errorsOpen && !feedbackOpen;
  const rightPanel = <aside className={`right-panel ${reviewWide ? 'wide' : ''} ${feedbackOpen && !errorsOpen ? 'feedback-side' : ''}`} data-feedback-region={errorsOpen ? '오류 패널' : feedbackOpen ? '피드백 창고' : '변경사항 패널'} aria-label={errorsOpen ? '오류' : feedbackOpen ? '피드백 창고' : '변경사항'} style={{ '--review-w': `${settings.reviewWidth}px` } as CSSProperties}>
    <div className="review-resizer" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="변경사항 패널 너비 조절 (더블클릭: 넓게/기본)" onPointerDown={startReviewResize} onDoubleClick={() => setReviewWide(value => !value)}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setSettings(previous => ({ ...previous, reviewWidth: clampReview(previous.reviewWidth + (event.key === 'ArrowLeft' ? 32 : -32)) })); setReviewWide(false); } }} />
    {errorsOpen ? <ErrorPanel scope={root} wide={reviewWide} toggleWide={() => setReviewWide(value => !value)} />
      : feedbackOpen ? <FeedbackPanel ask={ask} fail={report} wide={reviewWide} toggleWide={() => setReviewWide(value => !value)} onClose={() => setFeedbackOpen(false)} aiContext={feedbackContext} />
      : <ReviewPanel git={git} gitVersion={gitVersion} settings={settings} controls={gitControls} fail={report} refresh={refreshGit} loadDiff={loadDiff}
        openDiffTab={path => openDiff(`diff:all:${path}`)} switchBranch={() => run(switchBranch)}
        hasRepository={project.repositories.length > 0} selectionRequired={project.multiRepo && !gitRepositoryId} wide={reviewWide} toggleWide={() => setReviewWide(value => !value)} />}
  </aside>;
  const shown = (id: string) => settings.statusItems.includes(id);
  const reviewCount = pendingReviewCount(feedback.items);
  const liveTerminals = project.terminals.filter(terminal => !terminal.exited).length;
  const layout = statusLayout(settings);
  const statusNodes: Record<string, ReactNode> = {
    connection: <span className={`conn ${connection === '연결됨' ? 'ok' : ''}`} title={connection}><Icon name="wifi" size={13} /></span>,
    path: <span className="stat" title={project.root}><Icon name="folder" size={13} />{shortPath(project.root)}</span>,
    branch: <button title="브랜치 전환" onClick={() => run(switchBranch)}><Icon name="branch" size={13} />{git.branch || '브랜치 없음'}</button>,
    changes: <button title="변경사항 열기" onClick={showReview}><Icon name="diff" size={13} />{git.changes.length}개 파일<ins>+{git.additions}</ins><del>−{git.deletions}</del></button>,
    terminals: <span className="stat" title="실행 중인 터미널"><Icon name="terminal" size={13} />{liveTerminals}</span>,
    size: termSizes[focus] && <span className="stat" title="포커스된 터미널 크기 (열 × 행)">{termSizes[focus]}</span>,
    // Only items that are shown get rendered, so the system poll runs only while one of these is on.
    cpu: <SystemStat kind="cpu" />,
    memory: <SystemStat kind="memory" />,
    claudeusage: <UsageStat provider="claude" colors={settings.usageColors} projectId={project.id} active={active} showSession={settings.claudeSession} refresh={settings.usageRefresh} />,
    codexusage: <UsageStat provider="codex" colors={settings.usageColors} projectId={project.id} active={active} showSession refresh={settings.usageRefresh} />,
    cursorusage: <UsageStat provider="cursor" colors={settings.usageColors} projectId={project.id} active={active} showSession refresh={settings.usageRefresh} />,
    wakatime: settings.wakatime && <WakaTimeStat />,
    clock: <Clock hour12={settings.clock12h} seconds={settings.clockSeconds} />,
    readiness: <details className="readiness"><summary title="에이전트·셸 준비 상태"><Icon name="info" size={13} /></summary><div>{Object.entries(health).map(([name, value]) => <p key={name}><b>{name}</b> {value.version} {value.message}</p>)}<button onClick={() => run(async () => setHealth(await call('readiness', { force: true })))}>다시 확인</button></div></details>,
    openproject: <button title={`프로젝트 열기 (${showAppKey(settings.appKeys, 'addProject')})`} aria-label="프로젝트 열기" onClick={onAddProject}><Icon name="folderPlus" size={14} /></button>
  };
  const chatCtx: ChatCtx = {
    call, settings, root: project.root, projectId: project.id, onState: onChatState, onTitle: (id, title) => setTitles(previous => previous[id] === title ? previous : { ...previous, [id]: title }), onClose: id => run(() => closeTerminal(id)), toTerminal: (id, fresh) => run(() => chatToTerminal(id, fresh)), onOpenSettings, onSettingsChange: setSettings, pick, fail: report, branchChat, resumeChat, importCliChat, switchAgent: (id, agent, forget) => run(() => switchChatAgent(id, agent, forget)),
    subscribe: (id, handler) => { chatBus.current.set(id, handler); return () => { if (chatBus.current.get(id) === handler) chatBus.current.delete(id); }; }
  };
  const center = <div className="tab-stack">{paneTabs.map(tab => <div key={tab.id} className="tab-page" hidden={tab.id !== activeTab}>
    {tab.pane ? <Panes pane={tab.pane} visible={active && tab.id === activeTab} onLayout={next => commitTab(tab.id, next)} {...paneProps} chat={chatCtx} zoom={tab.id === activeTab ? zoom : ''} />
      : <Launchers onModeChange={onModeChange} shell={settings.terminalShell} mode={settings.defaultMode} title="새 탭" autoFocus hidden={hiddenAgents} onLaunch={command => run(() => launch(command, 'split'))} />}
  </div>)}</div>;
  return <main className={`app ${settings.dimInactivePanes ? 'dim-inactive' : ''}`} hidden={!active}>
    <header className="tabbar" data-feedback-region="상단 바">
      <div className="split-button">
        <button className="bar-button new-tab" title={`새 터미널 탭 (${showAppKey(settings.appKeys, 'newTab')})`} aria-label="새 터미널 탭" onClick={() => run(() => newTab())}><Icon name="plus" /><span>새 탭</span></button>
        <button ref={launcherButton} className="bar-button caret" title="모드와 Provider를 선택해 새 탭 열기" aria-label="새 탭 종류 선택" aria-haspopup="dialog" aria-expanded={menuOpen} onPointerDown={event => { if (menuOpen) event.preventDefault(); }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setMenuOpen(true); } }} onClick={() => { if (menuOpen) closeLauncherMenu(); else setMenuOpen(true); }}><Icon name="chevronDown" size={14} /></button>
        {menuOpen && <><button className="context-dismiss" aria-label="메뉴 닫기" tabIndex={-1} onClick={closeLauncherMenu} />
          <LauncherMenu mode={settings.defaultMode} items={launchers} onModeChange={onModeChange} onClose={closeLauncherMenu} onLaunch={command => { closeLauncherMenu(); run(() => launch(command, 'tab')); }} /></>}
      </div>
      <span className="drag-space" />
      <button className="palette-button" onClick={() => run(openPalette)} title={`명령 팔레트 (${showAppKey(settings.appKeys, 'palette')})`}><Icon name="search" /><span>{basename(project.root.replace(/\\/g, '/'))}</span><kbd>{showAppKey(settings.appKeys, 'palette')}</kbd></button>
      <button className={`bar-button ${reviewShown ? 'on' : ''}`} title={`변경사항 Diff (${showAppKey(settings.appKeys, 'review')})`} aria-label="변경사항 Diff 패널" aria-pressed={reviewShown} onPointerEnter={preloadMonaco} onFocus={preloadMonaco} onClick={toggleReview}>
        <Icon name="diff" />{git.changes.length > 0 && <span className="diffstat"><ins>+{git.additions}</ins><del>−{git.deletions}</del></span>}</button>
      <button className={`bar-button ${feedbackOpen && !errorsOpen ? 'on' : ''}`} title={`피드백 창고 (${showAppKey(settings.appKeys, 'feedback')})`} aria-label="피드백 창고" aria-pressed={feedbackOpen && !errorsOpen} onClick={toggleFeedback}><Icon name="feedback" /></button>
      <ErrorTabButton scope={root} pressed={errorsOpen} onClick={toggleErrors} />
      <IconButton icon="settings" label="설정" keys={showAppKey(settings.appKeys, 'settings')} className="bar-icon" onClick={onOpenSettings} />
    </header>
    <ErrorToast scope={root} active={active} />
    {/* The review panel floats over the terminals instead of taking a column, so opening it never shrinks them. */}
    <div className="workbench">{center}{(rightVisible || errorsOpen || feedbackOpen) && rightPanel}</div>
    <footer className="statusbar" data-feedback-region="상태바">
      <div className="status-left">{layout.left.filter(shown).map(id => <Fragment key={id}>{statusNodes[id]}</Fragment>)}</div>
      <div className="status-right">{reviewCount > 0 && <button className="feedback-badge" title={`검토할 피드백 초안 ${reviewCount}개 · 피드백 창고 열기`} aria-label={`검토할 피드백 초안 ${reviewCount}개`} onClick={showFeedback}><Icon name="feedback" size={13} />{reviewCount}</button>}<PluginBadges onOpen={onOpenPlugins} />{layout.right.filter(shown).map(id => <Fragment key={id}>{statusNodes[id]}</Fragment>)}</div>
    </footer>
    {active && chatModeTipDue(settings, findLeaf(activePane(), focus)?.kind, live.has(focus) ? agentOf(focus) : undefined) && <aside className="chat-mode-tip" aria-label="새 Chat 모드 안내">
      <img src="/chat-mode-preview.png" alt="Chat 모드에서 요청과 응답, 코드 변경 내용을 대화로 보는 화면" width="480" height="300" />
      <div className="chat-mode-tip-body"><strong>새로운 Chat 모드를 만나보세요</strong><p>CLI 대신 대화 화면에서 요청하고 코드 변경을 확인해 보세요. 같은 Provider로 새 대화를 시작합니다.</p>
        <button className="primary" onClick={() => run(async () => {
          await launch(`ade:chat:${agentOf(focus)}`, 'tab');
          setSettings(previous => ({ ...previous, defaultMode: 'chat', chatTipPending: false }));
        })}>Chat 모드 사용하기<Icon name="arrowRight" size={14} /></button>
      </div>
      <IconButton icon="x" label="Chat 모드 안내 다시 보지 않기" onClick={() => setSettings(previous => ({ ...previous, chatTipPending: false }))} />
    </aside>}
    {active && feedback.capture && <FeedbackCapture mode={feedback.capture} fallbackZoom={settings.uiZoom / 100} onCancel={endCapture} onError={cause => { endCapture(); report(cause); }}
      onCaptured={async bytes => {
        endCapture();
        const item = await ensureDraft();
        await feedbackCall('feedback/image/add', { id: item.id, data: bytesToBase64(bytes), mime: 'image/png' });
        openFeedback(item.id); showFeedback();
      }} />}
    {quickDialog}
  </main>;
}));

