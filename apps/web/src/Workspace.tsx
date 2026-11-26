import { appKey, appKeyInTerminal, keyBelongsToField, keyPlace, matches, showAppKey } from './shortcuts';
export { matches } from './shortcuts';
import { forwardRef, Fragment, memo, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { api, ApiError, basename, beside, chatLeaf, editorLeaf, equalize, findLeaf, isDiffTab, isLeaf, isTerminal, leafList, leaves, mapLeaf, newId, pruneDead, remove, split, type Leaf, type Pane } from './api';
import { agentArgs, defaultSettings, preloadMonaco, statusLayout, usageHue, type Settings } from './Editor';
import { nextTheme } from './themes';
import { createPortal } from 'react-dom';
import { useExit, useTipNotice } from './use-notice';
import { Spotlight } from './Spotlight';
import { PluginBadges, PluginIcon, PluginPanel, pluginUpdateCount, usePluginsState } from './PluginSettings';
import { accountSources, barWindows, CodexCreditRow, codexCreditsLabel, CreditRow, defaultAccountDir, defaultUsageMeters, headlinePercent, missingMeters, money, placeAbove, UsageRows, usageHueStyle, usageStatusShort, useUsage, type Usage, type UsageStyle } from './Usage';
import type { ChatCtx } from './ChatPane';
import { showCombo, type Block, type ChatState } from './chat-model';
import { Icon, IconButton, type IconName } from './Icon';
import { useHiddenAgents } from './installed-agents';
import { chatAgent, consolePlugin, Launchers, markSplit, Panes, type Agent, type AgentEventKind, type ClaudeCache, type EditorCtx, type TerminalBus } from './Panes';
import { useShells, shellLabel } from './shells';
import { LauncherMenu } from './LauncherMenu';
import { launchersFor, type AgentMode } from './launchers';
import { chatModeTipDue } from './tips';
import { detectAgent, resolveAgent } from './terminal-agent';
import { QuickInput, type QuickItem, type QuickRequest } from './QuickInput';
import { GIT_STATUS_RETRY_MS, errorText, gitStatusPause, notAGitRepository, pushError } from './errors';
import { ErrorPanel, ErrorTabButton, ErrorToast } from './error-ui';
import { GitLog } from './GitLog';
import { ProjectTree, type TreeHost } from './ProjectTree';
import { FileBuffer, type FileLocation } from './file-buffer';
import { loadSpec } from './git-graph';
import { Dropdown, Modal, type Ask, type GitState } from './views';
import { copyText } from './toast';
import { COLOR_COPY_EVENT, colorCopyFormats, type ColorCopyTarget } from './color-chip';
import { byLastUsed, FILE_EVENT, ideIcon, ideList, lastIde, rememberIde, type IdeInfo, type OpenTarget } from './ide-open';
import { errorLog } from './errors';
import { FeedbackPanel } from './FeedbackPanel';
import { FeedbackCapture } from './FeedbackCapture';
import { StatusMore, StatusSlot, useStatusFit } from './StatusFit';
import { statusLabels } from './Settings';
import { aiContext, bytesToBase64, pendingReviewCount, progressNews } from './feedback-model';
import { can, isRemote, readOnly } from './transport';
import { openUsageReview } from './usage-review-open';
import { setDrawer, useMobile } from './mobile';
import { canCapture, endCapture, ensureDraft, feedbackCall, openFeedback, requestCapture, useFeedback } from './feedback-store';
import { runPalette, type PaletteEntry, type PaletteHost } from './palette';
import { focusInPanes, focusPane } from './pane-focus';
import { pickChat } from './attention-nav';
import { swapLeaves } from './tree-nav';
import { sendToChat, setActiveRoots, type SendGet, type SendHost } from './send-to-chat';

// The app shell owns the single websocket; each open project subscribes to it and receives only its own messages.
export type Hub = { subscribe(projectId: string, handler: (message: any) => void): () => void; send(message: object): boolean };
export type AgentAlert = { kind: AgentEventKind; agent: Agent; tabId: string; paneId: string; name: string; looking?: boolean };
export type PaneInfo = { id: string; label: string; kind: 'terminal' | 'editor' | 'chat' | 'launcher'; agent?: Agent; attention: boolean; asking: boolean; working: boolean; focused: boolean; cache?: ClaudeCache };
export type TabInfo = { id: string; label: string; kind?: 'chat' | 'launcher'; count: number; panes: PaneInfo[]; agent?: Agent; attention: boolean; asking: boolean; working: boolean; cache?: ClaudeCache };
export type WorkspaceStatus = { id: string; name: string; loaded: boolean; attention: number; tabs: TabInfo[]; activeTab: string };
// The shell lists every project's tabs in its sidebar, so a project exposes them here instead of drawing its own tab strip.
// `forceAsk`: the sidebar X and Delete on a sidebar row always confirm. Shortcuts, middle-click and the pane's own close button still follow the confirm settings.
export type WorkspaceHandle = { requestClose(forceAsk?: boolean): Promise<boolean>; pickFile(): void; selectTab(id: string): void; selectPane(tabId: string, paneId: string): void; closePane(paneId: string, forceAsk?: boolean): void; moveTab(id: string, targetId: string, after: boolean): void; mergeTabs(id: string, targetId: string): void; movePane(tabId: string, paneId: string, targetId: string | undefined, mode: 'before' | 'after' | 'merge'): void; closeTab(id: string, forceAsk?: boolean): void; newTab(): void; renameTab(id: string): void; launcher(): void;
  // Selects a tab (and one of its panes) and moves the keyboard into it: the next-attention key and the palette's tab search.
  reveal(tabId: string, paneId?: string): void };
// when: the key only counts in that situation (Ctrl+Tab while an editor has the focus); otherwise it goes on to the field or the shell.
export type Command = { id: string; label: string; keys?: string; run(): void | Promise<unknown>; when?(event: KeyboardEvent): boolean } &
  ({ hidden?: false; icon: IconName } | { hidden: true; icon?: never });
export type SystemInfo = { cpu: number; cores: number; memory: { total: number; used: number }; uptime: number; platform: string; hostname: string };
type WorkspaceProps = {
  root: string; projectId?: string; active: boolean; hub: Hub; connection: string; settings: Settings; setSettings: Dispatch<SetStateAction<Settings>>; projectCommands: Command[];
  requestedFile?: { path: string; location: FileLocation }; onOpenExternalFile(folder: string, path: string, location: FileLocation): Promise<void>;
  onFileOpened(request: { path: string; location: FileLocation }): void;
  onLegacySettings(settings: Partial<Settings>): void; onStatus(root: string, status: WorkspaceStatus): void; onFailed(root: string, cause: unknown): void; onOpenSettings(): void; onOpenUsage(): void; onOpenRemotePc?(): void; onOpenPlugins(): void; onAgentAlert(root: string, alert: AgentAlert): void;
  paletteHost?: PaletteHost;
};

type Repository = { id: string; name: string; path: string; worktreeEnabled: boolean; worktreePath: string | null; branch: string | null };
type Snapshot = { id: string; root: string; multiRepo: boolean; repositories: Repository[]; terminals: { id: string; exited: boolean; cwd?: string }[]; ui: any };
// A Warp-style tab: one pane tree of terminals (and editor panes opened next to them).
type PaneTab = { id: string; title?: string; pane: Pane | null; focus?: string };
// This window's name on the server's layout broadcasts, so it skips its own echo (`ui/changed.from`).
const CLIENT = newId();
// Key order does not matter when two devices' versions of a pane tree are compared.
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : 1)) : item);
const emptyGit: GitState = { branch: '', changes: [], additions: 0, deletions: 0 };
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const formatBytes = (bytes: number) => bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)}GB` : `${Math.round(bytes / 2 ** 20)}MB`;
const shortPath = (path: string) => { const clean = path.replace(/\\/g, '/'), parts = clean.split('/').filter(Boolean); return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : clean; };
// The status bar items are memoized: the workspace re-renders on every pane and agent change, and formatting dates is not free.
const Clock = memo(function Clock({ hour12, seconds }: { hour12: boolean; seconds: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), seconds ? 1000 : 15000); return () => clearInterval(timer); }, [seconds]);
  return <span className="stat"><Icon name="clock" size={13} />{now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', ...(seconds && { second: '2-digit' }), hour12 })}</span>;
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
  return kind === 'cpu' ? <span className="stat" title={`CPU 사용률, ${system.cores}코어`}><Icon name="cpu" size={13} />{system.cpu}%</span>
    : <span className="stat" title={`메모리 전체 ${formatBytes(system.memory.total)}`}><Icon name="memory" size={13} />{formatBytes(system.memory.used)}</span>;
});
// "1 hr 29 mins" → "1h 29m".
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
  return <span className={`stat ${status.lastError ? 'warn' : ''}`} title={`WakaTime 오늘 기록\n${sent}${status.lastError ? '\n전송 오류' : ''}`}><Icon name="clock" size={13} />{status.today ? compactDuration(status.today) : '—'}</span>;
});
const usageNames = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
// The 5-hour and weekly plan limits of the login this project's agent CLI uses; clicking asks the server for a fresh reading.
const UsageStat = memo(function UsageStat({ provider, colors, projectId, active, showSession, refresh, meters, style = 'bar' }: { provider: Usage['provider']; colors: boolean; projectId: string; active: boolean; showSession: boolean; refresh: number; meters?: string[]; style?: UsageStyle }) {
  const { usage, loading, load } = useUsage(provider, projectId, active, refresh), panel = `usage-${useId()}`;
  const chosen = meters ?? defaultUsageMeters[provider];
  // Plans without a 5-hour window (Claude Ultra) still get a 0% reading from the API, so the setting hides it everywhere.
  const sessionOn = provider === 'cursor' || showSession;
  const allWindows = !usage ? [] : usage.windows.filter(item => item.key !== 'session' || sessionOn);
  const compact = barWindows(allWindows, chosen, true);
  // Not installed or not signed in here (no login found) and a failed first reading both leave no windows: show nothing instead of a dead "—".
  // The hook keeps polling, so the item appears by itself once a reading succeeds. The detail popover still lists every window the account returned.
  const credit = provider === 'claude' && chosen.includes('credit') ? usage?.credit : null;
  const codexCredits = provider === 'codex' && chosen.includes('credit') ? usage?.codexCredits : null;
  const detailCredit = provider === 'claude' ? usage?.credit : null;
  const detailCodex = provider === 'codex' ? usage?.codexCredits : null;
  if (!usage || (!compact.length && !credit && !codexCredits)) return null;
  const gone = missingMeters(provider, allWindows, chosen.filter(id => id !== 'session' || sessionOn));
  const peak = headlinePercent(compact, true, [credit?.percent, codexCredits?.limit?.percent]) ?? 0;
  const from = usage.source === 'log' ? `마지막 Codex 세션 기록 기준 (${new Date(usage.at).toLocaleString()})` : usage.at ? `갱신 ${new Date(usage.at).toLocaleTimeString()}` : '';
  const account = `${usage.account?.dir || defaultAccountDir[provider]} (${accountSources[usage.account?.from] ?? '앱 환경'} 기준)`;
  const level = colors ? '' : peak >= 95 ? 'full' : peak >= 80 ? 'warn' : '';
  const hue = usageHueStyle;
  return <>
    <button className={`stat usage ${level} ${usage.error && !compact.length ? 'warn' : ''}`} data-usage-style={style} popoverTarget={panel} aria-label={`${usageNames[provider]} 사용량 상세 보기`} aria-busy={loading} onClick={() => void load(true)}>
      <Icon name={provider} size={13} />
      {compact.map(item => <span key={item.key} className={`usage-window ${colors ? 'graded' : ''}`} style={colors ? hue(item.percent) : undefined}><small className={item.key === 'fable' ? 'fable' : undefined}>{usageStatusShort[item.key] ?? item.label}</small>{item.percent}%<i style={{ width: `${item.percent}%` }} /></span>)}
      {codexCredits && <span className={`usage-window ${colors && codexCredits.limit ? 'graded' : ''}`} style={colors && codexCredits.limit ? hue(codexCredits.limit.percent) : undefined}><small>크레딧</small>{codexCreditsLabel(codexCredits)}{codexCredits.limit && <i style={{ width: `${codexCredits.limit.percent}%` }} />}</span>}
      {credit && <span className={`usage-window ${colors && credit.percent !== null ? 'graded' : ''}`} style={colors && credit.percent !== null ? hue(credit.percent) : undefined}><small>크레딧</small>{credit.percent !== null ? `${credit.percent}%` : money(credit.used, credit.currency)}{credit.percent !== null && <i style={{ width: `${credit.percent}%` }} />}</span>}
    </button>
    <div id={panel} popover="auto" className="usage-detail" role="dialog" aria-label={`${usageNames[provider]} 사용량`} onToggle={placeAbove}>
      <header><Icon name={provider} size={14} /><strong>{usageNames[provider]} 사용량</strong>{usage.plan && <span className="plan">{usage.plan}</span>}
        <button className="icon-btn" aria-label="새로고침" aria-busy={loading} onClick={() => void load(true)}><Icon name="refresh" size={13} /></button></header>
      {allWindows.length > 0 && <UsageRows windows={allWindows} colors={colors} />}
      {detailCredit && <CreditRow credit={detailCredit} colors={colors} />}
      {detailCodex && <CodexCreditRow value={detailCodex} colors={colors} />}
      <dl><dt>계정</dt><dd>{account}</dd>{from && <><dt>기준</dt><dd>{from}</dd></>}</dl>
      {usage.error && <p className="usage-note warn">{usage.error}</p>}
      {usage.note && <p className="usage-note">{usage.note}</p>}
      {!usage.error && gone.length > 0 && <p className="usage-note">{gone.join(', ')} 한도는 이 계정에 없어 표시하지 않습니다.</p>}
      <button type="button" className="usage-more" onClick={() => { document.getElementById(panel)?.hidePopover(); openUsageReview(); }}>기록 보기</button>
    </div>
  </>;
});
// ---- phone status strip (mobile.css): the desktop bar's small items are hard to read on a phone, so it shows each agent's highest
// reading large and opens a sheet with every limit, its reset time and the account. ----
type UsageProvider = Usage['provider'];
const peakOf = (usage: Usage | null, sessionOn: boolean) => usage ? headlinePercent(usage.windows, sessionOn, [usage.credit?.percent, usage.codexCredits?.limit?.percent]) : null;
const MobileUsageChip = memo(function MobileUsageChip({ provider, projectId, active, refresh, sessionOn, colors }: { provider: UsageProvider; projectId: string; active: boolean; refresh: number; sessionOn: boolean; colors: boolean }) {
  const { usage } = useUsage(provider, projectId, active, refresh), peak = peakOf(usage, sessionOn);
  // Read but nothing to show (not installed, not signed in here): no chip, as on the desktop.
  if (usage && peak === null) return null;
  return <span className={`m-usage-chip ${peak !== null && peak >= 95 ? 'full' : peak !== null && peak >= 80 ? 'warn' : ''}`} style={colors && peak !== null ? usageHueStyle(peak) : undefined}>
    <Icon name={provider} size={14} /><b>{peak === null ? '…' : `${peak}%`}</b>
  </span>;
});
function MobileUsageSection({ provider, projectId, sessionOn, colors, onReview }: { provider: UsageProvider; projectId: string; sessionOn: boolean; colors: boolean; onReview(): void }) {
  const { usage, loading, load } = useUsage(provider, projectId, true, 60);
  const windows = usage?.windows.filter(item => item.key !== 'session' || sessionOn) ?? [];
  return <section className="m-usage-section" aria-label={`${usageNames[provider]} 사용량`}>
    <header><Icon name={provider} size={16} /><strong>{usageNames[provider]}</strong>{usage?.plan && <span className="plan">{usage.plan}</span>}
      <button className="icon-btn" aria-label={`${usageNames[provider]} 새로고침`} aria-busy={loading} onClick={() => void load(true)}><Icon name="refresh" size={15} /></button></header>
    {!usage ? <p className="usage-note">불러오는 중…</p> : <>
      <UsageRows windows={windows} colors={colors} />
      {provider === 'claude' && usage.credit && <CreditRow credit={usage.credit} colors={colors} />}
      {provider === 'codex' && usage.codexCredits && <CodexCreditRow value={usage.codexCredits} colors={colors} />}
      {usage.error && <p className="usage-note warn">{usage.error}</p>}
      <p className="usage-note">{usage.account?.dir || defaultAccountDir[provider]}, {usage.at ? `갱신 ${new Date(usage.at).toLocaleTimeString()}` : ''}</p>
      <button type="button" className="usage-more" onClick={onReview}>기록 보기</button>
    </>}
  </section>;
}
function MobileStatus({ settings, projectId, active, connection, branch, onBranch }: { settings: Settings; projectId: string; active: boolean; connection: string; branch: string; onBranch(): void }) {
  const [open, setOpen] = useState(false);
  const providers = (['claude', 'codex', 'cursor'] as const).filter(provider => settings.statusItems.includes(`${provider}usage`));
  const sessionOn = (provider: UsageProvider) => provider === 'cursor' || provider === 'codex' || settings.claudeSession;
  return <footer className="statusbar m-status" data-feedback-region="상태바">
    {connection !== '연결됨' && <span className="conn" role="status"><Icon name="wifi" size={13} />{connection}</span>}
    <button className="m-branch" onClick={onBranch} aria-label={`브랜치 ${branch || '없음'}, 전환`}><Icon name="branch" size={14} /><span>{branch || '브랜치 없음'}</span></button>
    {providers.length > 0 && <button className="m-usage" aria-label="사용량 자세히 보기" onClick={() => setOpen(true)}>
      {providers.map(provider => <MobileUsageChip key={provider} provider={provider} projectId={projectId} active={active} refresh={settings.usageRefresh} sessionOn={sessionOn(provider)} colors={settings.usageColors} />)}
    </button>}
    {open && <Modal className="m-usage-sheet" labelledBy="m-usage-title" onClose={() => setOpen(false)}>
      <header className="m-sheet-head"><h2 id="m-usage-title">사용량</h2><IconButton icon="x" label="닫기" onClick={() => setOpen(false)} /></header>
      <div className="m-sheet-body">{providers.map(provider => <MobileUsageSection key={provider} provider={provider} projectId={projectId} sessionOn={sessionOn(provider)} colors={settings.usageColors} onReview={() => { setOpen(false); openUsageReview(); }} />)}</div>
    </Modal>}
  </footer>;
}
export const showKeys = (keys: string) => showCombo(keys.replace('mod+', mac ? 'meta+' : 'ctrl+'));

export const Workspace = memo(forwardRef<WorkspaceHandle, WorkspaceProps>(function Workspace({ root, projectId, active, hub, connection, settings, setSettings, projectCommands, requestedFile, onOpenExternalFile, onFileOpened, onLegacySettings, onStatus, onFailed, onOpenSettings, onOpenUsage, onOpenRemotePc, onOpenPlugins, onAgentAlert, paletteHost }, handleRef) {
  const [project, setProject] = useState<Snapshot | null>(null), [openError, setOpenError] = useState('');
  const [health, setHealth] = useState<Record<string, any>>({});
  const [gitVersion, setGitVersion] = useState(0);
  const [gitOpen, setGitOpen] = useState(false), [errorsOpen, setErrorsOpen] = useState(false), [feedbackOpen, setFeedbackOpen] = useState(false), [pluginOpen, setPluginOpen] = useState(''), [reviewWide, setReviewWide] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const mobile = useMobile();
  const [treeExpanded, setTreeExpanded] = useState(() => new Set(['.']));
  const fileBuffers = useRef(new Map<string, FileBuffer>());
  const fileListeners = useRef(new Set<(paths: string[]) => void>());
  const watchFiles = useCallback((listener: (paths: string[]) => void) => {
    fileListeners.current.add(listener);
    return () => { fileListeners.current.delete(listener); };
  }, []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if ([...fileBuffers.current.values()].some(buffer => buffer.dirty)) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);
  const feedback = useFeedback();
  // Plugins that declare `header` add one button to the top bar; it opens the plugin's panel in the right-panel slot.
  const pluginsState = usePluginsState(), pluginUpdates = pluginUpdateCount(pluginsState);
  const headerPlugins = (pluginsState?.plugins ?? []).filter(plugin => plugin.header && plugin.state === 'running');
  const pluginShown = headerPlugins.find(plugin => plugin.id === pluginOpen) ?? null;
  const [menuOpen, setMenuOpen] = useState(false);
  const launcherButton = useRef<HTMLButtonElement>(null);
  const closeLauncherMenu = () => { setMenuOpen(false); launcherButton.current?.focus(); };
  const [git, setGit] = useState<GitState>(emptyGit), [gitRepositoryId, setGitRepositoryId] = useState('');
  const [paneTabs, setPaneTabs] = useState<PaneTab[]>([]), [activeTab, setActiveTab] = useState('');
  // The launcher entrance plays only the first time a tab is shown. Record a tab when we leave it (during render, so a
  // fast click still counts) — coming back must not fade the launcher up from opacity 0 again.
  const shownTabs = useRef(new Set<string>()), previousTab = useRef('');
  if (activeTab !== previousTab.current) { if (previousTab.current) shownTabs.current.add(previousTab.current); previousTab.current = activeTab; }
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
  // Monaco is several MB to parse; reading it while the app is idle keeps that cost out of the moment a diff opens.
  useEffect(() => {
    if (!('requestIdleCallback' in window)) return;
    const id = requestIdleCallback(preloadMonaco, { timeout: 8000 }); return () => cancelIdleCallback(id);
  }, []);
  const refs = {
    repository: useRef(''), paneTabs: useRef(paneTabs), activeTab: useRef(activeTab), focus: useRef(focus),
    project: useRef(project), lastEditor: useRef(''), commands: useRef<Command[]>([]), quickKey: useRef(0), quickRequest: useRef<QuickRequest | null>(null),
    tabFocus: useRef<Record<string, string>>({}), pending: useRef(new Map<string, string>()), active: useRef(active), started: useRef(false), onMessage: useRef<(message: any) => void>(() => {}),
    gitRefresh: useRef<{ running: Promise<void> | null; again: Promise<void> | null }>({ running: null, again: null }), fsRefresh: useRef(0),
    // A "not a repository" answer pauses polling for this repo list and selection. A different selection, a count change, or the retry delay starts it again.
    gitQuietUntil: useRef(0), gitQuietKey: useRef(''),
    // Layout shared with the other devices: set while a layout that came from one of them is being shown (it is not saved back),
    // the terminals known to have ended (a late layout must not bring them back) and whether this project's first snapshot is past.
    fromRemote: useRef(false), gone: useRef(new Set<string>()), snapshotSeen: useRef(false)
  };
  refs.active.current = active;
  const chatUsed = useRef(new Map<string, number>());
  refs.repository.current = gitRepositoryId; refs.paneTabs.current = paneTabs; refs.activeTab.current = activeTab;
  refs.focus.current = focus; refs.project.current = project;
  // Chat panes listen here for their own `chat/event` / `chat/state` messages; `chatPrev` remembers each chat's last status to tell "finished" from "started".
  const chatBus = useRef(new Map<string, (message: any) => void>()), chatPrev = useRef(new Map<string, ChatState['status']>()), bgChats = useRef(new Set<string>());
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
  // The question is drawn on document.body, so a project that is not on screen can still ask. Name that project when it is not the one being viewed.
  const projectLabel = () => basename((refs.project.current?.root ?? root).replace(/\\/g, '/'));
  const askClose = (message: string) => ask.confirm(refs.active.current ? message : `‘${projectLabel()}’ — ${message}`);
  const pick = (title: string, items: QuickItem[]) => new Promise<string | null>(resolve => openQuick({ kind: 'pick', title, items, resolve }));
  // A link clicked in a terminal: warn, then open in the default browser, copy the address, or cancel. Only the visible project answers.
  useEffect(() => {
    const onLink = (event: Event) => {
      const uri = (event as CustomEvent<string>).detail;
      if (!refs.active.current || typeof uri !== 'string') return;
      void pick(`외부 링크를 열까요? 신뢰할 수 있는 주소인지 확인하세요.\n${uri}`, [{ id: 'open', label: '기본 브라우저로 열기', icon: 'externalLink' }, { id: 'copy', label: '링크 복사', icon: 'copy' }, { id: 'cancel', label: '취소' }]).then(choice => {
        if (choice === 'open') window.open(uri, '_blank', 'noopener');
        else if (choice === 'copy') {
          copyText(uri);
        }
      });
    };
    window.addEventListener('ade:link', onLink);
    const onColor = (event: Event) => {
      const detail = (event as CustomEvent<ColorCopyTarget>).detail;
      if (!refs.active.current || typeof detail?.label !== 'string') return;
      const formats = detail.color ? colorCopyFormats(detail.color) : undefined;
      const options = [{ id: 'original', label: '원문', detail: detail.label, icon: 'copy' as const }];
      if (formats) options.push(
        { id: 'hex', label: 'HEX', detail: formats.hex, icon: 'copy' },
        { id: 'rgb', label: 'RGB (CSS)', detail: formats.rgb, icon: 'copy' },
      );
      void pick('어떤 형식으로 복사할까요?', [...options, { id: 'cancel', label: '취소' }]).then(choice => {
        const format = options.find(option => option.id === choice);
        if (format) copyText(format.detail);
      });
    };
    window.addEventListener(COLOR_COPY_EVENT, onColor);
    return () => {
      window.removeEventListener('ade:link', onLink);
      window.removeEventListener(COLOR_COPY_EVENT, onColor);
    };
  }, []);

  // Chat chips, the sidebar picker and the project tree share the same open menu.
  // Like a link, only the visible project answers a click.
  const askOpen = async (target: OpenTarget) => {
    const [{ ides, fileManager }, { path, editor }] = await Promise.all([
      ideList().catch(() => ({ ides: [] as IdeInfo[], fileManager: '파일 관리자' })),
      call<{ path: string; editor?: { file: string; folder?: string } }>('ide/resolve', { path: target.path, chatId: target.chatId, editor: !target.folder })
    ]);
    const inAde = editor?.file && !readOnly && can('files/read') && (!editor.folder || !isRemote) ? editor : undefined;
    const last = lastIde(), where = target.line ? `${path}:${target.line}` : path, kind = target.folder ? '폴더를' : '파일을';
    const choice = await pick(`${kind} 열까요?
${where}`, [
      ...byLastUsed(ides).map(ide => ({ id: `ide:${ide.id}`, label: `${ide.label}에서 열기`, icon: ideIcon(ide), ...(ide.id === last && { detail: '마지막 사용' }) })),
      ...(inAde ? [{ id: 'ade', label: 'ADE에서 열기', icon: 'fileOpen' as const }] : []),
      { id: 'files', label: `${fileManager}에서 ${target.folder ? '폴더' : '위치'} 열기`, icon: 'folderOpen' },
      { id: 'copy', label: '경로 복사', icon: 'copy' }, { id: 'cancel', label: '취소' }]);
    if (choice === 'ade' && inAde) {
      const location = { line: target.line, column: target.column };
      if (inAde.folder) await onOpenExternalFile(inAde.folder, inAde.file, location);
      else openProjectFile(inAde.file, location);
    } else if (choice === 'copy') copyText(path);
    else if (choice === 'files' || choice?.startsWith('ide:')) {
      const ide = choice === 'files' ? 'files' : choice.slice(4);
      if (ide !== 'files') rememberIde(ide);
      await call('ide/open', { ide, path, line: target.line, column: target.column, chatId: target.chatId });
    }
  };
  const askOpenRef = useRef(askOpen); askOpenRef.current = askOpen;
  useEffect(() => {
    const onFile = (event: Event) => {
      const target = (event as CustomEvent<OpenTarget>).detail;
      if (refs.active.current && target && typeof target.path === 'string') void askOpenRef.current(target).catch(report);
    };
    window.addEventListener(FILE_EVENT, onFile);
    return () => window.removeEventListener(FILE_EVENT, onFile);
  }, [report]);

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
    if (findLeaf(owner?.pane ?? null, id)?.kind === 'chat') chatUsed.current.set(id, Date.now()); // for the "back to the chat" key
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
  // Files and diffs share the editor group and can sit beside a terminal or chat.
  function openEditorTab(path: string) {
    const tree = activePane();
    const hasRoom = (leaf?: Leaf) => leaf?.kind === 'editor' && ((leaf.tabs?.length ?? 0) < 30 || leaf.tabs?.includes(path));
    const current = focusedLeaf(), target = hasRoom(current) ? current : leafList(tree).find(hasRoom);
    let id: string;
    if (target) { id = target.id; commitPane(mapLeaf(tree!, id, leaf => ({ ...leaf, tabs: (leaf.tabs || []).includes(path) ? leaf.tabs : [...(leaf.tabs || []), path], active: path }))); }
    else {
      const leaf = editorLeaf([path], path); id = leaf.id;
      const anchor = findLeaf(tree, refs.focus.current) || leafList(tree)[0];
      commitPane(!tree || !anchor ? leaf : split(tree, anchor.id, leaf, 'row'));
    }
    setFocusLeaf(id);
  }
  function openProjectFile(path: string, location?: FileLocation) {
    const spec = `file:${path}`;
    if (location) fileBuffer(path).requestLocation(location);
    setZoom('');
    for (const tab of refs.paneTabs.current) {
      const group = leafList(tab.pane).find(leaf => leaf.kind === 'editor' && leaf.tabs?.includes(spec));
      if (!group) continue;
      if (tab.id !== refs.activeTab.current) selectTab(tab.id);
      commitFor(group.id, mapLeaf(tab.pane!, group.id, leaf => ({ ...leaf, active: spec })));
      setFocusLeaf(group.id);
      return;
    }
    openEditorTab(spec);
  }
  useEffect(() => {
    if (!active || !project || restoring || !requestedFile) return;
    openProjectFile(requestedFile.path, requestedFile.location);
    onFileOpened(requestedFile);
  }, [active, project, restoring, requestedFile, onFileOpened]);
  function fileBuffer(path: string) {
    let buffer = fileBuffers.current.get(path);
    if (!buffer) { buffer = new FileBuffer(path, call); fileBuffers.current.set(path, buffer); }
    return buffer;
  }
  // Closing tabs with unsaved edits asks first, like VS Code: save, don't save (drop the edits), or cancel and keep the tab.
  async function saveBeforeClose(paths: string[]) {
    const dirty = [...new Set(paths)].filter(path => path.startsWith('file:')).map(path => fileBuffers.current.get(path.slice(5))).filter((buffer): buffer is FileBuffer => Boolean(buffer?.dirty));
    if (!dirty.length) return true;
    const choice = await pick(`저장하지 않은 변경 사항이 있습니다. 저장할까요?\n${dirty.map(buffer => basename(buffer.path)).join(', ')}`,
      [{ id: 'save', label: '저장', icon: 'save' }, { id: 'discard', label: '저장 안 함', icon: 'undo' }, { id: 'cancel', label: '취소' }]);
    if (choice === 'discard') { dirty.forEach(buffer => buffer.revert()); return true; }
    if (choice !== 'save') return false;
    await Promise.all(dirty.map(buffer => buffer.save()));
    const pending = dirty.find(buffer => buffer.dirty);
    if (pending) { openProjectFile(pending.path); return false; }
    return true;
  }
  // What the project tree needs from the editors: which open files have unsaved edits, tabs that follow a moved file, and a nudge for every tree listing to reload.
  const treeHost: TreeHost = {
    confirm: ask.confirm, input: ask.input,
    dirty: paths => [...fileBuffers.current.values()].filter(buffer => buffer.dirty && paths.some(path => path === '.' || buffer.path === path || buffer.path.startsWith(`${path}/`))).map(buffer => buffer.path),
    moved(moves) {
      const remap = (spec: string) => {
        const path = spec.startsWith('file:') ? spec.slice(5) : '', hit = moves.find(({ from }) => path === from || path.startsWith(`${from}/`));
        return hit ? `file:${hit.to}${path.slice(hit.from.length)}` : spec;
      };
      const retarget = (pane: Pane): Pane => isLeaf(pane) ? (pane.kind === 'editor' ? { ...pane, tabs: pane.tabs?.map(remap), active: pane.active && remap(pane.active) } : pane) : { ...pane, children: pane.children.map(retarget) };
      commitTabs(refs.paneTabs.current.map(tab => ({ ...tab, pane: tab.pane && retarget(tab.pane) })));
    },
    changed: paths => { for (const listener of fileListeners.current) listener(paths); },
    openWith: (path, folder) => { void askOpen({ path, folder }).catch(report); }
  };
  async function closeTab(groupId: string, path: string) {
    // The same file open in another group keeps its buffer (and edits), so only the last tab for it asks.
    const elsewhere = refs.paneTabs.current.flatMap(tab => leafList(tab.pane)).some(other => other.id !== groupId && other.tabs?.includes(path));
    if (!elsewhere && !(await saveBeforeClose([path]))) return;
    const leaf = findLeaf(treeOf(groupId), groupId); if (!leaf) return;
    const list = leaf.tabs || [], index = list.indexOf(path), rest = list.filter(item => item !== path);
    commitFor(groupId, compact(mapLeaf(treeOf(groupId)!, groupId, item => ({ ...item, tabs: rest, active: item.active === path ? rest[index] ?? rest[index - 1] ?? '' : item.active }))));
  }
  async function closeGroup(groupId: string) {
    if (!(await saveBeforeClose(findLeaf(treeOf(groupId), groupId)?.tabs ?? []))) return;
    if (findLeaf(treeOf(groupId), groupId)) commitFor(groupId, remove(treeOf(groupId)!, groupId));
  }
  // One git/status at a time: each costs several git processes, and file events arrive every 150 ms while an agent writes.
  // Requests made during a run share a single follow-up run, which still sees every change made before it started.
  // A non-repo answers `git status` with a fatal line. Remember it and do not toast. Polling pauses for this selection, then tries again.
  const gitKey = () => `${refs.project.current?.repositories.length ?? 0}:${refs.repository.current}`;
  function silenceNotGit(cause: unknown) {
    if (!notAGitRepository(errorText(cause))) return false;
    refs.gitQuietUntil.current = Date.now() + GIT_STATUS_RETRY_MS;
    refs.gitQuietKey.current = gitKey();
    setGit(emptyGit);
    return true;
  }
  function refreshGit(): Promise<void> {
    const count = refs.project.current?.repositories.length ?? 0;
    const decision = gitStatusPause(refs.gitQuietUntil.current, refs.gitQuietKey.current, Date.now(), count, gitKey());
    refs.gitQuietUntil.current = decision.quietUntil;
    refs.gitQuietKey.current = decision.quietKey;
    if (!decision.poll) { if (count === 0) setGit(emptyGit); return Promise.resolve(); }
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
    try {
      const next = await call<GitState>('git/status');
      refs.gitQuietUntil.current = 0;
      setGit(previous => { if (JSON.stringify(previous) === JSON.stringify(next)) return previous; setGitVersion(value => value + 1); return next; });
    } catch (cause) {
      if (silenceNotGit(cause)) return;
      throw cause;
    }
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
  // Dropping a tab onto another folds its panes into it, side by side.
  function mergeTabs(id: string, targetId: string) {
    const list = refs.paneTabs.current, source = list.find(tab => tab.id === id), target = list.find(tab => tab.id === targetId);
    if (!source?.pane || !target?.pane || id === targetId) return;
    const merged = beside(target.pane, source.pane), first = leafList(source.pane)[0]?.id || '';
    commitTabs(list.filter(tab => tab.id !== id).map(tab => tab.id === targetId ? { ...tab, pane: merged } : tab));
    delete refs.tabFocus.current[id];
    selectTab(targetId); if (first) setFocusLeaf(first);
  }
  // Swaps the active tab with its neighbour (sidebar order).
  function moveTabBy(step: number) {
    const list = refs.paneTabs.current, at = list.findIndex(tab => tab.id === refs.activeTab.current), to = at + step;
    if (at < 0 || to < 0 || to >= list.length) return;
    const next = [...list]; [next[at], next[to]] = [next[to], next[at]]; commitTabs(next);
  }
  useImperativeHandle(handleRef, () => ({
    // The sidebar's "파일 열기": pick one of the project's files by name, then choose how to open it.
    pickFile: () => run(async () => {
      const files = ((await call<{ files: string[] }>('files/list')).files ?? []).filter(file => !file.endsWith('/'));
      if (!files.length) throw new Error('열 수 있는 파일이 없습니다.');
      const chosen = await pick('열 파일을 고르세요', files.map(file => ({ id: file, label: file, icon: 'file' })));
      if (chosen) await askOpen({ path: chosen });
    }),
    selectTab: id => selectTab(id), closePane: (id, forceAsk) => run(() => closeTerminal(id, forceAsk)),
    // Reordering only changes the list order; the saved layout follows it.
    mergeTabs,
    movePane, reveal: revealPane,
    moveTab: (id, targetId, after) => {
      const list = refs.paneTabs.current, moving = list.find(tab => tab.id === id); if (!moving || id === targetId) return;
      const rest = list.filter(tab => tab.id !== id), at = rest.findIndex(tab => tab.id === targetId); if (at < 0) return;
      const next = [...rest.slice(0, at + (after ? 1 : 0)), moving, ...rest.slice(at + (after ? 1 : 0))];
      if (next.every((tab, index) => tab === list[index])) return;
      commitTabs(next);
    },
    selectPane: (tabId, paneId) => { selectTab(tabId); setFocusLeaf(paneId); }, closeTab: (id, forceAsk) => run(() => closePaneTab(id, forceAsk)), newTab: () => run(() => newTab()), renameTab: id => run(() => renamePaneTab(id)), launcher: () => run(() => pickLauncher('tab')),
    async requestClose(forceAsk = false) {
      const projectId = refs.project.current?.id; if (!projectId) return true; // not loaded yet: nothing runs, and this branch never draws the confirm dialog
      const paneLeaves = refs.paneTabs.current.flatMap(tab => leafList(tab.pane));
      // Background subagents are asked about whatever the setting says; the terminals' own question below still follows the setting.
      const background = paneLeaves.filter(leaf => leaf.kind === 'chat' && bgChats.current.has(leaf.id)).length;
      // The sidebar X asks once, whatever is running, and that one question covers the ones below. A phone only takes the project off its own list, so it is not asked.
      if (forceAsk && !isRemote) {
        const liveCount = refs.project.current?.terminals.filter(terminal => !terminal.exited).length ?? 0;
        const chatCount = paneLeaves.filter(leaf => leaf.kind === 'chat').length;
        const busy = paneLeaves.filter(leaf => leaf.kind === 'chat' && (working.has(leaf.id) || bgChats.current.has(leaf.id))).length;
        const parts = [busy && `응답 중이거나 백그라운드 작업이 있는 채팅 ${busy}개`, liveCount && `실행 중인 터미널 ${liveCount}개`].filter(Boolean);
        const resume = chatCount ? ' 닫은 채팅은 /resume으로 다시 열 수 있습니다.' : '';
        const message = parts.length ? `${parts.join('와 ')}가 있습니다. 모두 종료하고 프로젝트를 닫을까요?${resume}` : chatCount ? `이 프로젝트를 닫을까요? 채팅 ${chatCount}개가 닫힙니다.${resume}` : '이 프로젝트를 닫을까요?';
        if (!(await askClose(message))) return false;
      }
      if (!(await saveBeforeClose([...fileBuffers.current.keys()].map(path => `file:${path}`)))) return false;
      // A phone only takes the project off its own list: the PC keeps it open, with its terminals and chats running.
      if (isRemote) return true;
      if (background && !forceAsk && !(await askClose(`백그라운드 작업이 있는 채팅 ${background}개가 있습니다. 프로젝트를 닫으면 작업이 종료됩니다. 닫을까요?`))) return false;
      try { await api('project/close', { projectId }); }
      catch (cause) {
        if (!(cause instanceof ApiError)) throw cause;
        if (cause.code === 'PROJECT_BUSY') {
          // Skipped only when the background question covered every reason: no live terminal, no chat answering right now.
          const asked = background > 0 && !working.size && !refs.project.current?.terminals.some(terminal => !terminal.exited);
          if (!asked && !forceAsk && settingsRef.current.confirmCloseProject && !(await askClose(`${cause.message} 모두 종료하고 프로젝트를 닫을까요?`))) return false;
          await api('project/close', { projectId, force: true });
        } else if (cause.code !== 'NOT_FOUND') throw cause;
      }
      return true;
    }
  }));
  const leafLabel = (leaf: Leaf, fallbackTitle?: string) => {
    if (leaf.kind === 'editor') return leaf.active ? basename(leaf.active.startsWith('file:') ? leaf.active.slice(5) : leaf.active.split(':').pop() || leaf.active) : '편집기';
    if (leaf.kind === 'launcher') return '새 창';
    if (leaf.kind === 'chat') return titles[leaf.id] || `${leaf.agent === 'codex' ? 'Codex' : leaf.agent === 'cursor' ? 'Cursor' : 'Claude'} 채팅`;
    if (leaf.kind === 'console') return pluginsState?.plugins.find(plugin => plugin.id === leaf.plugin)?.name ?? '콘솔';
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
  const cacheOf = (id: string) => agentOf(id) === 'claude' || chatPrev.current.has(id) ? caches[id] : undefined;
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
    // A phone paired for viewing may not open projects; it reads the ones the PC already has open.
    const state = readOnly && projectId ? await api<Snapshot>('snapshot', { projectId }) : await api<Snapshot>('project/open', { path: root });
    setRestoring(true); refs.snapshotSeen.current = false;
    refs.project.current = state; setProject(state); bus.current.buffers.clear(); setProcessAgents({}); setLaunched({}); setWorking(new Set()); setAttention({}); setSshSet(new Set()); setTitles({});
    const ui = state.ui || {};
    const nextRepoId = state.repositories.some(repo => repo.id === ui.gitRepositoryId) ? ui.gitRepositoryId : state.repositories[0]?.id || '';
    refs.repository.current = nextRepoId; setGitRepositoryId(nextRepoId);
    setZoom('');
    // Settings used to live in each project's layout; the shell adopts them once and keeps its own copy from then on.
    if (ui.settings) onLegacySettings(ui.settings);
    // `rightVisible` is the saved name of "the Git drawer is open" (it used to be the changes panel on the right).
    // Not for a project without a repository (a plain folder whose old changes panel was open): the drawer would only say there is nothing to show.
    setGitOpen((ui.rightVisible ?? false) && state.repositories.length > 0);
    setTreeExpanded(new Set(Array.isArray(ui.projectTreeExpanded) ? ui.projectTreeExpanded.filter((path: unknown) => typeof path === 'string') : ['.']));
    // Restore project files and commit diffs. Older working-tree diff tabs reference a retired view.
    const clean = (tree: Pane | null): Pane | null => {
      let next = tree; for (const leaf of leafList(tree)) if (leaf.kind === 'editor') next = next && mapLeaf(next, leaf.id, item => { const list = (item.tabs || []).filter(tab => tab.startsWith('file:') || (isDiffTab(tab) && !/^diff:(all|staged|unstaged):/.test(tab))); return { id: item.id, kind: 'editor', tabs: list, active: list.includes(item.active || '') ? item.active : list[0] || '' }; });
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
          if (message.type === 'ui/changed') { if (message.from !== CLIENT && !restoring && Array.isArray(message.paneTabs)) applyLayout(message.paneTabs); }
          else if (message.type === 'snapshot') {
            // After a dropped link the layout may have changed meanwhile; the first snapshot of a project is the one loadProject already used.
            if (refs.snapshotSeen.current && !restoring && Array.isArray(message.snapshot?.ui?.paneTabs)) applyLayout(message.snapshot.ui.paneTabs); else refs.snapshotSeen.current = true;
            setProject(message.snapshot); for (const listener of chatBus.current.values()) listener({ type: 'reconnect' }); for (const listener of fileListeners.current) listener([]); }
          else if (message.type === 'chat/event' || message.type === 'chat/state') {
            chatBus.current.get(message.id)?.(message);
            // Codex delivers async questions as live messages while its turn keeps working.
            const event = message.event;
            if (message.type === 'chat/event' && event?.kind === 'message' && event.blocks?.some((block: Block) => block.type === 'text' && block.questions?.length)) {
              onAgentEvent(message.id, 'asyncQuestion');
            }
          }
          // A plugin started a chat in this project (a header plugin's work): it shows up as a tab.
          else if (message.type === 'plugin/chat') { if (!tabOf(message.id)) void takeOver(undefined, { ...chatLeaf(message.cwd, message.agent), id: message.id }); }
          // A stream of file events (an agent at work) refreshes Git at most twice a second; a hidden window catches up when it shows (visibilitychange).
          else if (message.type === 'fs') {
            for (const listener of fileListeners.current) listener(message.paths || []);
            if (refs.active.current && !document.hidden && !refs.fsRefresh.current) refs.fsRefresh.current = window.setTimeout(() => { refs.fsRefresh.current = 0; void refreshGit().catch(cause => { if (!silenceNotGit(cause)) report(cause); }); }, 500);
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
            if (!message.lost) refs.gone.current.add(message.id);
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
    if (leaf.kind === 'editor' || leaf.kind === 'chat' || leaf.kind === 'console' || !next) return next;
    const cwd = cwds[leaf.id] ?? leaf.cwd, agent = savedAgent(leaf.id);
    return mapLeaf(next, leaf.id, item => ({ ...item, ...(cwd ? { cwd } : {}), agent }));
  }, tree);
  const agentKey = paneTabs.flatMap(tab => leafList(tab.pane)).map(leaf => leaf.kind === 'editor' || leaf.kind === 'chat' ? '' : savedAgent(leaf.id) ?? '').join(',');
  useEffect(() => {
    const opened = new Set(refs.paneTabs.current.flatMap(tab => leafList(tab.pane)).flatMap(leaf => leaf.tabs ?? []));
    for (const [path, buffer] of fileBuffers.current) {
      if (!buffer.dirty && !opened.has(`file:${path}`)) fileBuffers.current.delete(path);
    }
  }, [paneTabs]);
  useEffect(() => {
    // The tabs are one layout for every device: what this device changes is saved (the server tells the others), and what the
    // others changed is shown here without being sent back (`fromRemote`). A phone saves only the tabs; a view-only phone, or one
    // whose PC plugin predates `ui/layout`, saves nothing and just follows.
    if (refs.fromRemote.current) { refs.fromRemote.current = false; return; }
    if (!project?.id || restoring || (isRemote && !can('ui/layout'))) return;
    const timer = setTimeout(() => {
      const savedTabs = paneTabs.map(tab => ({ id: tab.id, pane: remember(tab.pane), ...(tab.title ? { title: tab.title } : {}), ...(refs.tabFocus.current[tab.id] ? { focus: refs.tabFocus.current[tab.id] } : {}) }));
      void (isRemote ? call('ui/layout', { paneTabs: savedTabs, clientId: CLIENT })
        : call('ui', { ui: { gitRepositoryId, paneTabs: savedTabs, activeTab, focus, rightVisible: gitOpen, projectTreeExpanded: [...treeExpanded] }, clientId: CLIENT })).catch(report);
    }, 400);
    return () => clearTimeout(timer);
  }, [project?.id, gitRepositoryId, restoring, paneTabs, activeTab, focus, gitOpen, treeExpanded, agentKey, call, report]);
  // Polling only runs for the project being shown and while the window is visible; coming back refreshes immediately.
  useEffect(() => {
    if (!project?.id || !active) return;
    const tick = () => { if (!document.hidden) void refreshGit().catch(cause => { if (!silenceNotGit(cause)) report(cause); }); };
    tick(); const timer = setInterval(tick, settings.diffRefresh * 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [project?.id, gitRepositoryId, active, settings.diffRefresh]);
  useEffect(() => { if (zoom && !findLeaf(activePane(), zoom)) setZoom(''); }, [paneTabs, activeTab, zoom]);
  // A maximize that starts or ends re-parents the panes (Panes.tsx): the maximized pane's node moves, which drops the DOM focus, and the other
  // panes mount again, where one taking the focus (a launcher used to) made itself the focused pane. The pane that was or is maximized keeps
  // the focus, and the keyboard goes back into it, unless it was somewhere else (the sidebar, a dialog).
  const zoomSeen = useRef(zoom);
  useEffect(() => {
    const keep = zoom || zoomSeen.current; zoomSeen.current = zoom;
    if (!keep || !refs.active.current || !findLeaf(activePane(), keep)) return;
    if (!focusInPanes(document.querySelector('main.app:not([hidden]) .tab-stack'))) return;
    if (refs.focus.current !== keep) setFocusLeaf(keep);
    focusPane(keep);
  }, [zoom]);

  // ---- layout from the other devices ----
  // Another device changed the tabs: show the same ones. A tab that already matches stays as it is (a launcher not yet chosen,
  // a pane being dragged); this device's own selected tab and focused pane stay unless they are gone.
  function applyLayout(incoming: PaneTab[]) {
    const mine = refs.paneTabs.current, have = new Map(mine.map(tab => [tab.id, tab]));
    let next: PaneTab[] = incoming.map(tab => {
      const pane = leafList(tab.pane).filter(leaf => isTerminal(leaf) && refs.gone.current.has(leaf.id)).reduce<Pane | null>((tree, leaf) => tree && remove(tree, leaf.id), tab.pane);
      const kept = have.get(tab.id);
      return kept && kept.title === tab.title && canonical(remember(kept.pane)) === canonical(pane) ? kept : { id: tab.id, title: tab.title, focus: tab.focus, pane };
    });
    if (!next.length) next = [{ id: newId(), title: undefined, focus: undefined, pane: null }];
    if (next.length === mine.length && next.every((tab, index) => tab === mine[index])) return;
    refs.fromRemote.current = true;
    const focuses: Record<string, string> = {};
    for (const tab of next) { const at = [refs.tabFocus.current[tab.id], tab.focus].find(id => id && findLeaf(tab.pane, id)); if (at) focuses[tab.id] = at; }
    refs.tabFocus.current = focuses;
    const was = refs.activeTab.current, wanted = next.some(tab => tab.id === was) ? was : next[Math.min(Math.max(mine.findIndex(tab => tab.id === was), 0), next.length - 1)].id;
    commitTabs(next);
    if (wanted !== was) selectTab(wanted);
    else if (!findLeaf(next.find(tab => tab.id === wanted)?.pane ?? null, refs.focus.current)) setFocusLeaf(focuses[wanted] || leaves(next.find(tab => tab.id === wanted)?.pane ?? null)[0] || '');
    void refresh().catch(report);
  }

  // ---- terminals ----
  // A chat leaf has no server-side process of its own: the pane asks the server to open its session (chat/open) when it mounts.
  function addChatLeaf(anchorId: string, direction: 'row' | 'column', path?: string, agent: Agent = 'claude') {
    const leaf = chatLeaf(path, agent), current = activePane();
    const anchor = leaves(current).includes(anchorId) ? anchorId : leaves(current)[0];
    commitPane(!current || !anchor ? leaf : split(current, anchor, leaf, direction)); setFocusLeaf(leaf.id);
  }
  async function openTerminalLeaf(anchorId: string, direction: 'row' | 'column' = 'row', path?: string, command = '') {
    if (chatAgent(command)) return addChatLeaf(anchorId, direction, path, chatAgent(command));
    if (consolePlugin(command)) {
      const leaf: Leaf = { id: newId(), kind: 'console', plugin: consolePlugin(command) }, current = activePane();
      const anchor = leaves(current).includes(anchorId) ? anchorId : leaves(current)[0];
      commitPane(!current || !anchor ? leaf : split(current, anchor, leaf, direction)); setFocusLeaf(leaf.id); return;
    }
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
    markSplit(leaf.id); commitPane(!current || !anchor ? leaf : split(current, anchor, leaf, direction)); setFocusLeaf(leaf.id);
  }
  async function fillLauncher(id: string, command: string) {
    if (chatAgent(command) || consolePlugin(command)) {
      const tree = treeOf(id), leaf: Leaf = consolePlugin(command) ? { id: newId(), kind: 'console', plugin: consolePlugin(command) } : chatLeaf(undefined, chatAgent(command));
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
    const chosen = agentOf(id), stop = chosen !== 'claude';
    let sessionId: string | undefined;
    if (chosen === 'cursor') {
      const sessions = await call<{ sessionId: string; title: string; updatedAt: number }[]>('terminal/chat-sessions', { id });
      if (!sessions.length) throw new Error('이 폴더의 Cursor 대화 기록이 없습니다. Cursor에서 응답을 완료한 뒤 다시 시도하세요.');
      sessionId = (await pick('Chat으로 이어갈 Cursor 대화를 선택하세요. 원본은 보존하고 복사본으로 이어갑니다.', sessions.map(item => ({ id: item.sessionId, label: item.title, icon: 'chat', detail: new Date(item.updatedAt).toLocaleString('ko-KR') })))) ?? undefined;
      if (!sessionId) return;
    }
    if (!(await ask.confirm(stop ? '진행 중인 작업과 터미널의 미전송 입력을 중단하고 같은 대화를 Chat으로 이어갈까요?' : '터미널의 미전송 입력은 사라집니다. 같은 대화를 Chat으로 이어갈까요?'))) return;
    const leaf = chatLeaf(), { cwd, agent } = await call<{ cwd: string; agent: Agent }>('terminal/to-chat', { id, newId: leaf.id, stop, ...(sessionId && { sessionId }) }), tree = treeOf(id);
    if (tree) commitFor(id, mapLeaf(tree, id, () => ({ ...leaf, cwd, agent })));
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
    const background = !fresh && bgChats.current.has(id);
    if (background && !(await ask.confirm('백그라운드 작업이 실행 중입니다. 터미널로 전환하면 작업이 종료됩니다. 전환할까요?'))) return;
    const info = fresh
      ? { agent: chosen, restoreId: '', cwd: leafNow?.kind === 'chat' ? leafNow.cwd ?? '' : '', configDir: undefined as string | undefined }
      : await call<{ agent: Agent; restoreId: string; cwd: string; configDir?: string }>('chat/to-terminal', { id, ...(background && { force: true }) });
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
  // Resume / 이전 대화 불러오기 takes over the pane it was asked from; the chat that was there ends but stays saved.
  async function takeOver(from: string | undefined, leaf: Leaf) {
    const tree = from ? treeOf(from) : null;
    if (!from || !tree) {
      const tab: PaneTab = { id: newId(), pane: leaf };
      commitTabs([...refs.paneTabs.current, tab]); refs.activeTab.current = tab.id; setActiveTab(tab.id); setZoom(''); setFocusLeaf(leaf.id); return;
    }
    await call('chat/close', { id: from }).catch(report);
    chatBus.current.delete(from); chatPrev.current.delete(from); clearAttention(from);
    commitFor(from, mapLeaf(tree, from, () => leaf)); setFocusLeaf(leaf.id);
  }
  async function resumeChat(id: string, agent: Agent, from?: string) {
    const existing = tabOf(id);
    if (existing) { selectTab(existing.id); setFocusLeaf(id); return; }
    if (!from && refs.paneTabs.current.length >= 16) throw new Error('프로젝트당 최대 16개 탭을 열 수 있습니다.');
    // Open first: invalid or missing stored sessions must not create an empty tab.
    const sessions = await call<{ id: string }[]>('chat/sessions', { agent });
    if (!sessions.some(session => session.id === id)) throw new Error('저장된 대화를 찾을 수 없습니다.');
    await call('chat/open', { id, agent });
    const opened = tabOf(id);
    if (opened) { selectTab(opened.id); setFocusLeaf(id); return; }
    await takeOver(from, { id, kind: 'chat', agent });
  }
  // A conversation made with the plain CLI becomes a new chat tab. Claude reads its transcript; Cursor copies the session and does not change the original.
  async function importCliChat(sessionId: string, from?: string, agent: Agent = 'claude') {
    if (!from && refs.paneTabs.current.length >= 16) throw new Error('프로젝트당 최대 16개 탭을 열 수 있습니다.');
    const leaf = chatLeaf(undefined, agent);
    await call(agent === 'cursor' ? 'chat/import-cursor' : 'chat/import-cli', { sessionId, newId: leaf.id });
    await takeOver(from, leaf);
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
  // One switch per chat at a time (rapid clicks must not race the close with the other agent's open). Earlier history moves to another id: this id would
  // otherwise keep the old agent in its stored meta and the new agent's open would be refused.
  const switchingChats = useRef(new Set<string>());
  async function switchChatAgent(id: string, agent: Agent, forget: boolean) {
    if (switchingChats.current.has(id)) return false;
    const old = findLeaf(treeOf(id), id);
    if (old?.kind !== 'chat' || old.agent === agent) return false;
    switchingChats.current.add(id);
    try {
      await call('chat/close', { id, forget, ...(forget ? {} : { archiveAs: newId() }) });
      chatBus.current.delete(id); chatPrev.current.delete(id);
      const tree = treeOf(id); if (!tree) return false;
      commitFor(id, mapLeaf(tree, id, leaf => leaf.kind === 'chat' ? { ...leaf, agent } : leaf)); setFocusLeaf(id);
      return true;
    } finally { switchingChats.current.delete(id); }
  }
  // Closing a chat ends its child process and keeps the transcript for /resume.
  async function closeChat(id: string, forceAsk = false) {
    // A background subagent is always asked about: closing ends it silently otherwise. Sidebar X also asks before an idle chat disappears.
    const question = bgChats.current.has(id) ? '백그라운드 작업이 실행 중인 채팅을 닫을까요? 작업이 종료됩니다.' : working.has(id) && (forceAsk || settingsRef.current.confirmCloseChat) ? '응답 중인 채팅을 닫을까요? 진행 중인 작업이 중단됩니다.' : forceAsk ? '이 채팅을 닫을까요?' : '';
    if (question && !(await askClose(question))) return;
    await call('chat/close', { id }).catch(report);
    chatBus.current.delete(id); chatPrev.current.delete(id);
    removeTerminalPane(id);
  }
  function onAgentEvent(id: string, event: AgentEventKind | 'asyncQuestion') {
    const owner = tabOf(id), leaf = findLeaf(owner?.pane ?? null, id);
    const agent = leaf?.kind === 'chat' ? leaf.agent ?? 'claude' : agentOf(id);
    if (!agent || !owner) return;
    const kind = event === 'asyncQuestion' ? 'attention' : event;
    const looking = refs.active.current && document.hasFocus() && refs.focus.current === id && refs.activeTab.current === owner.id;
    if (kind === 'done' && looking) return;
    if (event !== 'asyncQuestion') setAttention(previous => previous[id] === kind || previous[id] === 'attention' ? previous : { ...previous, [id]: kind });
    onAgentAlert(root, { kind, agent, tabId: owner.id, paneId: id, name: tabLabel(owner), looking: Boolean(looking) });
  }
  // Status of a chat for the sidebar: working while it answers, attention while it waits for an approval, done (once) when it finishes.
  function onChatState(id: string, state: ChatState) {
    const before = chatPrev.current.get(id); chatPrev.current.set(id, state.status);
    if (state.liveTasks?.length) bgChats.current.add(id); else bgChats.current.delete(id);
    paneProps.onAgentWorking(id, state.status === 'working' || state.status === 'attention');
    // The chat's prompt cache feeds the sidebar timer like a terminal Claude's does; only changed values re-render.
    const cache = state.cache;
    if (!cache) dropCache(id);
    else setCaches(previous => { const old = previous[id]; return old && old.at === cache.at && old.ttl === cache.ttl && old.tokens === cache.tokens && old.compactAt === cache.compactAt && old.compacted?.at === cache.compacted?.at ? previous : { ...previous, [id]: cache }; });
    if (state.status === 'attention' && before !== 'attention') onAgentEvent(id, 'attention');
    else if (before === 'attention' && state.status !== 'attention') clearAttention(id);
    if (state.status === 'idle' && before === 'working') onAgentEvent(id, 'done');
  }
  async function closeTerminal(id: string, forceAsk = false) {
    const leaf = findLeaf(treeOf(id), id);
    if (leaf?.kind === 'chat') return closeChat(id, forceAsk);
    if (leaf?.kind === 'editor') {
      if (forceAsk && !(await askClose('이 편집기를 닫을까요?'))) return;
      return closeGroup(id);
    }
    const info = refs.project.current?.terminals.find(terminal => terminal.id === id);
    const running = Boolean(info && !info.exited);
    if (running && (forceAsk || settingsRef.current.confirmClose)) {
      if (!(await askClose('터미널 프로세스를 종료할까요?'))) return;
    } else if (forceAsk && !(await askClose(leaf?.kind === 'launcher' ? '이 창을 닫을까요?' : '이 터미널을 닫을까요?'))) return;
    if (info) await call('terminal/close', { id });
    removeTerminalPane(id);
    await refresh();
  }
  async function closePaneTab(tabId: string, forceAsk = false) {
    const tab = refs.paneTabs.current.find(item => item.id === tabId); if (!tab) return;
    if (!(await saveBeforeClose(leafList(tab.pane).flatMap(leaf => leaf.tabs ?? [])))) return;
    const running = leafList(tab.pane).filter(leaf => leaf.kind !== 'editor' && refs.project.current?.terminals.some(terminal => terminal.id === leaf.id && !terminal.exited));
    const chats = leafList(tab.pane).filter(leaf => leaf.kind === 'chat');
    // Busy: answering, waiting for an approval, or running a background subagent. Background work is asked about whatever the setting says.
    const busy = chats.filter(leaf => working.has(leaf.id) || bgChats.current.has(leaf.id)).length, background = chats.some(leaf => bgChats.current.has(leaf.id));
    if (forceAsk || (running.length && settingsRef.current.confirmClose) || (chats.length && settingsRef.current.confirmCloseChat) || background) {
      const closing = [running.length && `실행 중인 터미널 ${running.length}개`, chats.length && `채팅 ${chats.length}개`].filter(Boolean).join('와 ');
      const detail = [busy && `응답 중이거나 백그라운드 작업이 있는 채팅 ${busy}개는 작업이 중단됩니다.`, chats.length && '닫은 채팅은 /resume으로 다시 열 수 있습니다.'].filter(Boolean).join(' ');
      const head = `‘${tabLabel(tab)}’ 탭을 닫을까요?`;
      if (!(await askClose(closing ? `${head} ${closing}가 닫힙니다.${detail ? ` ${detail}` : ''}` : head))) return;
    }
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
    const ids = leaves(activePane()); if (!ids.length) return;
    const next = ids[(Math.max(0, ids.indexOf(refs.focus.current)) + step + ids.length) % ids.length];
    setFocusLeaf(next);
    // While a pane is maximized the maximize moves with the focus (like tmux), so the focus never lands on a pane that is off screen.
    setZoom(value => value ? next : value);
    focusPane(next, { force: true }); // an editor, diff, launcher or console does not take the keyboard by itself
  }
  async function closeFocused() {
    const leaf = findLeaf(activePane(), refs.focus.current); if (!leaf) return;
    if (leaf.kind === 'editor') { if (leaf.active) await closeTab(leaf.id, leaf.active); }
    else await closeTerminal(leaf.id);
  }

  // ---- keyboard: moving between tabs and panes without the mouse (shortcuts.ts workspaceKeyDefs) ----
  // Selects a tab and one of its panes (the remembered one when none is named) and moves the keyboard into it. A maximized pane hands the maximize over, like moveFocus.
  function revealPane(tabId: string, paneId?: string) {
    const tab = refs.paneTabs.current.find(item => item.id === tabId); if (!tab) return;
    if (tabId !== refs.activeTab.current) selectTab(tabId);
    const target = paneId && findLeaf(tab.pane, paneId) ? paneId : findLeaf(tab.pane, refs.focus.current) ? refs.focus.current : leaves(tab.pane)[0];
    if (!target) { requestAnimationFrame(() => document.querySelector<HTMLElement>('main.app:not([hidden]) .tab-page:not([hidden]) .launchers button')?.focus()); return; }
    setFocusLeaf(target); setZoom(value => value && value !== target ? target : value);
    focusPane(target, { force: true });
  }
  // Alt+Shift+1…9: the panes of this tab in layout order (left to right, top to bottom); the ninth is the last.
  function focusPaneAt(index: number) {
    const ids = leaves(activePane()), id = ids[index === 8 ? ids.length - 1 : index];
    if (id) revealPane(refs.activeTab.current, id);
  }
  // Back to the chat from anywhere: the chat used last in this tab, else in the project. With no chat open, offer to start one.
  async function focusChat() {
    const tabs = refs.paneTabs.current.map(tab => ({ id: tab.id, chats: leafList(tab.pane).filter(leaf => leaf.kind === 'chat').map(leaf => leaf.id) }));
    const found = pickChat(tabs, refs.activeTab.current, chatUsed.current);
    if (found) { revealPane(found.tabId, found.chatId); return; }
    const chats = launchersFor('chat').filter(item => item.id !== 'shell' && !hiddenAgents.includes(item.id));
    const choice = await pick('이 프로젝트에 열린 채팅이 없습니다. 새 채팅을 열까요?', [...chats.map(item => ({ id: item.command, label: `새 탭에서 ${item.label} 채팅`, icon: item.icon })), { id: 'cancel', label: '취소' }]);
    if (choice && choice !== 'cancel') await launch(choice, 'tab');
  }
  // Ctrl+Tab / Ctrl+Shift+Tab: the next or previous file of the focused editor group.
  const editorFocused = () => findLeaf(activePane(), refs.focus.current)?.kind === 'editor';
  function cycleEditorTab(step: number) {
    const tree = activePane(), leaf = findLeaf(tree, refs.focus.current); if (!tree || leaf?.kind !== 'editor' || !leaf.tabs?.length) return;
    const list = leaf.tabs, at = Math.max(0, list.indexOf(leaf.active || '')), next = list[(at + step + list.length) % list.length];
    commitPane(mapLeaf(tree, leaf.id, item => ({ ...item, active: next })));
    focusPane(leaf.id, { force: true });
  }
  // The other tabs of this project, to move a pane into or merge with.
  const otherTabs = () => refs.paneTabs.current.filter(tab => tab.id !== refs.activeTab.current && tab.pane).map(tab => ({ id: tab.id, label: tabLabel(tab), icon: 'layers' as const, detail: `pane ${leafList(tab.pane).length}개` }));
  async function movePaneTo() {
    const tabId = refs.activeTab.current, paneId = refs.focus.current, tab = refs.paneTabs.current.find(item => item.id === tabId);
    if (!tab?.pane || !findLeaf(tab.pane, paneId)) return;
    const alone = leafList(tab.pane).length < 2, others = otherTabs();
    const choice = await pick('포커스된 pane을 어느 탭으로 옮길까요?', [...others, ...(alone ? [] : [{ id: 'new', label: '새 탭으로 분리', icon: 'externalLink' as const }]), { id: 'cancel', label: '취소' }]);
    if (!choice || choice === 'cancel') return;
    if (choice === 'new') movePane(tabId, paneId, undefined, 'after');
    else if (alone) mergeTabs(tabId, choice); // the only pane: the whole tab joins the other one
    else movePane(tabId, paneId, choice, 'merge');
    focusPane(paneId, { force: true });
  }
  async function mergeTabInto() {
    const choice = await pick('현재 탭을 어느 탭에 합칠까요?', [...otherTabs(), { id: 'cancel', label: '취소' }]);
    if (choice && choice !== 'cancel') { mergeTabs(refs.activeTab.current, choice); focusPane(refs.focus.current, { force: true }); }
  }
  // The focused pane trades places with the next one in layout order (the last with the first).
  function swapPane() {
    const tree = activePane(), ids = leaves(tree), at = ids.indexOf(refs.focus.current);
    if (!tree || ids.length < 2 || at < 0) return;
    commitPane(swapLeaves(tree, ids[at], ids[(at + 1) % ids.length]));
    focusPane(ids[at], { force: true });
  }

  // ---- workspace / git ----
  const selectGitRepository = (id: string) => {
    refs.repository.current = id; setGitRepositoryId(id);
    if (refs.project.current?.multiRepo && id) void call('git/status', { repositoryId: id }).then(next => { refs.gitQuietUntil.current = 0; setGit(next); }).catch(cause => { if (!silenceNotGit(cause)) report(cause); }); else { refs.gitQuietUntil.current = 0; setGit(emptyGit); }
  };
  // A diff tab is `diff:<revision>:<path>[\t<old path>]`: one commit against its parent, `a..b` between two commits, `a..` against the working tree.
  async function loadDiff(kind: string, path: string) {
    const { original, modified } = await loadSpec(call, `diff:${kind}:${path}`);
    return { original, modified };
  }
  async function switchBranch() {
    const { branches } = await call<{ branches: string[] }>('git/branches');
    const choice = await pick('브랜치 전환', branches.map(name => ({ id: name, label: name, icon: 'branch', detail: name === git.branch ? '현재' : '' })));
    if (!choice || choice === git.branch) return;
    await call('git/checkout', { branch: choice }); await refreshGit();
  }

  // ---- quick input / commands ----
  // palette.ts: this project's commands and files, and from the shell every project's tabs and chats, the projects and the settings sections.
  async function openPalette(initial = '') {
    const commands = refs.commands.current.filter(command => !command.hidden).map((command): PaletteEntry => ({ id: `cmd:${command.id}`, kind: 'command', label: command.label, icon: command.icon!, ...(command.keys ? { keys: showKeys(command.keys) } : {}), run: command.run }));
    const editable = !readOnly && can('files/read');
    await runPalette({
      initial, entries: [...commands, ...(paletteHost?.entries() ?? [])],
      pick: ({ source, placeholder, initial: typed }) => new Promise<string | null>(resolve => openQuick({ kind: 'pick', title: '명령 팔레트', items: [], source, placeholder, initial: typed, resolve })),
      files: async () => ((await call<{ files: string[] }>('files/list')).files ?? []).filter(file => !file.endsWith('/')),
      // Straight into the ADE editor like VS Code's quick open; a window that cannot edit files asks how to open it instead.
      openFile: path => editable ? openProjectFile(path) : askOpen({ path })
    });
  }
  // The Git drawer rises from the bottom and lives beside the right panel (errors, feedback, plugins), so both can be open.
  const toggleGit = () => {
    // No repository: never open the drawer. A drawer restored from the layout can still be closed.
    if ((refs.project.current?.repositories.length ?? 0) === 0) { setGitOpen(false); return; }
    preloadMonaco(); setGitOpen(value => !value); if (settingsRef.current.gitTipPending) setSettings(previous => ({ ...previous, gitTipPending: false }));
  };
  const toggleErrors = () => { setFeedbackOpen(false); setPluginOpen(''); setErrorsOpen(value => !value); };
  // The feedback inbox shares the right panel slot: opening it closes the error list and covers the diff, like the error list does.
  const showFeedback = () => { setErrorsOpen(false); setPluginOpen(''); setFeedbackOpen(true); };
  const toggleFeedback = () => { setErrorsOpen(false); setPluginOpen(''); setFeedbackOpen(value => !value); };
  const togglePlugin = (id: string) => { setErrorsOpen(false); setFeedbackOpen(false); setPluginOpen(value => value === id ? '' : id); };
  const startCapture = () => { if (!canCapture()) throw new Error('이 브라우저는 화면 캡쳐를 지원하지 않습니다. 이미지를 붙여넣거나 파일로 추가하세요.'); requestCapture('element'); };
  // Text for an AI draft about what is on screen: app version, open panes, project, the last few errors of this project.
  const feedbackContext = async () => {
    if (!settingsRef.current.feedbackAiContext) return undefined;
    const desktop = (window as unknown as { adeDesktop?: { appInfo?(): Promise<{ version: string }> } }).adeDesktop;
    const appVersion = await desktop?.appInfo?.().then(info => info.version, () => undefined);
    const kinds: Record<string, string> = { terminal: '터미널', editor: 'diff 편집기', chat: '채팅', launcher: '새 창', console: '플러그인 콘솔' };
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
    const choice = await pick(where === 'tab' ? '새 탭에서 실행' : '오른쪽 pane에서 실행', launchers.map(item => ({ id: item.id, label: item.label, icon: item.icon, detail: item.detail })));
    const item = launchers.find(entry => entry.id === choice);
    if (item) await launch(item.command, where);
  }
  const navCommands: Command[] = [
    { id: 'focusChat', label: '채팅 입력창으로 돌아가기', icon: 'chat', run: focusChat },
    ...Array.from({ length: 9 }, (_, index): Command => ({ id: `pane${index + 1}`, label: index === 8 ? '마지막 pane' : `${index + 1}번 pane`, hidden: true, run: () => focusPaneAt(index) })),
    { id: 'nextEditorTab', label: '편집기의 다음 파일 탭', icon: 'arrowRight', run: () => cycleEditorTab(1), when: editorFocused },
    { id: 'prevEditorTab', label: '편집기의 이전 파일 탭', icon: 'arrowLeft', run: () => cycleEditorTab(-1), when: editorFocused },
    { id: 'movePaneTo', label: '포커스된 pane을 다른 탭으로 옮기기…', icon: 'layers', run: movePaneTo },
    { id: 'mergeTab', label: '현재 탭을 다른 탭에 합치기…', icon: 'merge', run: mergeTabInto },
    { id: 'swapPane', label: '포커스된 pane을 다음 pane과 맞바꾸기', icon: 'sync', run: swapPane },
    { id: 'openFile', label: '파일 열기…', icon: 'fileOpen', run: () => openPalette('@') },
    { id: 'toggleTree', label: '파일 트리 열기/닫기', icon: 'folderOpen', run: () => setTreeOpen(value => !value) },
    { id: 'errors', label: '오류 패널 열기/닫기', icon: 'error', run: toggleErrors },
    { id: 'usage', label: '사용 기록 보기', icon: 'chart', run: openUsageReview },
    { id: 'plugins', label: '플러그인 설정 열기', icon: 'plugin', run: onOpenPlugins },
    ...headerPlugins.map((plugin): Command => ({ id: `plugin:${plugin.id}`, label: `플러그인 패널: ${plugin.name}`, icon: 'plugin', run: () => togglePlugin(plugin.id!) })),
  ];
  // ---- 채팅으로 보내기 (send-to-chat.ts): the key, the palette and the context menus all end here ----
  const sendRoots = () => { const current = refs.project.current; return { project: current?.root ?? root, repo: (current?.repositories.find(repo => repo.id === refs.repository.current) ?? current?.repositories[0])?.path }; };
  const sendHost: SendHost = {
    tabs: () => refs.paneTabs.current, activeTab: () => refs.activeTab.current, focus: () => refs.focus.current, roots: sendRoots,
    reveal: (tabId, chatId) => { if (refs.activeTab.current !== tabId) selectTab(tabId); setZoom(value => value && value !== chatId ? '' : value); setFocusLeaf(chatId); },
    // No chat yet: a new one with the first agent that is not hidden, beside the pane the selection came from (the selection stays in view).
    openChat: () => { setZoom(''); addChatLeaf(refs.focus.current, 'row', undefined, (['claude', 'codex', 'cursor'] as const).find(agent => !hiddenAgents.includes(agent)) ?? 'claude'); return refs.focus.current; }
  };
  const sendHostRef = useRef(sendHost); sendHostRef.current = sendHost;
  useEffect(() => { if (active) setActiveRoots(sendRoots()); }, [active, project, gitRepositoryId]);
  useEffect(() => {
    const onSend = (event: Event) => { if (refs.active.current) run(() => sendToChat(sendHostRef.current, (event as CustomEvent<{ get: SendGet }>).detail.get)); };
    window.addEventListener('ade:send-to-chat', onSend);
    return () => window.removeEventListener('ade:send-to-chat', onSend);
  }, []);
  const allCommands: Command[] = [
    { id: 'newTab', label: '새 탭', icon: 'plus', run: () => newTab() },
    ...launchers.filter(item => item.id !== 'shell').flatMap(item => [
      { id: `new${item.id}`, label: `새 탭에서 ${item.label} 실행`, icon: item.icon, run: () => launch(item.command, 'tab') },
      { id: `split${item.id}`, label: `오른쪽 pane에서 ${item.label} 실행`, icon: item.icon, run: () => launch(item.command, 'split') }
    ]),
    { id: 'launcher', label: '새 탭에서 실행…', icon: 'terminal', run: () => pickLauncher('tab') },
    { id: 'closeTab', label: '탭 닫기', icon: 'x', run: () => closePaneTab(refs.activeTab.current) },
    { id: 'renameTab', label: '탭 이름 바꾸기…', icon: 'edit', run: () => renamePaneTab(refs.activeTab.current) },
    { id: 'nextTab', label: '다음 탭', icon: 'arrowRight', run: () => cyclePaneTab(1) },
    { id: 'prevTab', label: '이전 탭', icon: 'arrowLeft', run: () => cyclePaneTab(-1) },
    { id: 'moveTabUp', label: '탭을 위로 이동', icon: 'arrowUp', run: () => moveTabBy(-1) },
    { id: 'moveTabDown', label: '탭을 아래로 이동', icon: 'arrowDown', run: () => moveTabBy(1) },
    { id: 'detachPane', label: '포커스된 pane을 새 탭으로 분리', icon: 'externalLink', run: () => movePane(refs.activeTab.current, refs.focus.current, undefined, 'after') },
    { id: 'nextTab2', label: '다음 탭', hidden: true, run: () => cyclePaneTab(1) },
    { id: 'prevTab2', label: '이전 탭', hidden: true, run: () => cyclePaneTab(-1) },
    ...Array.from({ length: 9 }, (_, index): Command => ({ id: `tab${index + 1}`, label: index === 8 ? '마지막 탭' : `${index + 1}번 탭`, hidden: true, run: () => { const tab = refs.paneTabs.current[index === 8 ? refs.paneTabs.current.length - 1 : index]; if (tab) selectTab(tab.id); } })),
    { id: 'splitRight', label: '오른쪽으로 분할', icon: 'splitH', run: () => splitTerminal(refs.focus.current, 'row') },
    { id: 'splitDown', label: '아래로 분할', icon: 'splitV', run: () => splitTerminal(refs.focus.current, 'column') },
    { id: 'sendEof', label: '터미널에 ^D(EOF) 보내기', icon: 'terminal', run: () => { const leaf = findLeaf(activePane(), refs.focus.current); if (leaf && isTerminal(leaf)) send({ type: 'terminal/input', id: leaf.id, data: '' }); } },
    { id: 'closePane', label: '포커스된 pane 닫기', icon: 'x', run: closeFocused },
    { id: 'preset', label: '현재 탭을 터미널 2 × 3 그리드로', icon: 'layers', run: preset },
    { id: 'zoom', label: 'Pane 최대화 전환', icon: 'maximize', run: () => setZoom(value => value ? '' : refs.focus.current) },
    { id: 'equalize', label: 'Pane 크기 균등화', icon: 'layers', run: () => { const tree = activePane(); if (tree) commitPane(equalize(tree)); } },
    { id: 'focusNext', label: '다음 pane으로 이동', icon: 'arrowRight', run: () => moveFocus(1) },
    { id: 'focusPrev', label: '이전 pane으로 이동', icon: 'arrowLeft', run: () => moveFocus(-1) },
    { id: 'gitLog', label: 'Git 로그(커밋 그래프) 전환', icon: 'graph', run: toggleGit },
    { id: 'feedback', label: '피드백 요청', icon: 'feedback', run: toggleFeedback },
    { id: 'feedbackCapture', label: '피드백: 화면 캡쳐', icon: 'captureWindow', run: startCapture },
    { id: 'sendToChat', label: '선택 영역을 채팅으로 보내기', icon: 'send', run: () => sendToChat(sendHostRef.current) },
    { id: 'palette', label: '명령 팔레트', hidden: true, run: openPalette },
    { id: 'palette2', label: '명령 팔레트(F1)', hidden: true, run: openPalette },
    { id: 'branch', label: '브랜치 전환…', icon: 'branch', run: switchBranch },
    { id: 'theme', label: `색 테마 전환 (${nextTheme(settings.theme).label})`, icon: 'palette', run: () => setSettings(previous => ({ ...previous, theme: nextTheme(previous.theme).id })) },
    ...navCommands,
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
      const command = refs.commands.current.find(item => item.keys && matches(item.keys, event) && (!item.when || item.when(event)));
      if (!command) return;
      // A dialog keeps the keys to itself, except the feedback capture, which is how a dialog gets into a screenshot.
      if ((document.querySelector('dialog[open]') || document.querySelector('.quick')) && command.id !== 'feedbackCapture') return;
      // In a terminal, plain Ctrl+key stays with the shell unless the key is meant to work there or the user said so (settings.termKeys, per key).
      if (inTerminal && !appKeyInTerminal(settingsRef.current, command.id, event)) return;
      // In the editor (and in any text field on macOS) a plain Ctrl+letter is the field's own key, e.g. Monaco's Ctrl+D.
      if (!inTerminal && keyBelongsToField(event, keyPlace(event.target), mac)) return;
      event.preventDefault(); event.stopPropagation(); run(async () => command.run());
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // ---- render ----
  // Portaled out of the project: an inactive project stays `hidden`, and a dialog inside it does not appear until that project is shown.
  const quickDialog = quick && createPortal(<QuickInput key={quick.key} request={quick.request} onClose={() => setQuick(current => current?.key === quick.key ? null : current)} />, document.body);
  // Git 저장소가 없는 프로젝트에서 흐린 Git 버튼을 누르면 이유를 잠깐 보여 준다(툴팁은 올려 둬야만 보인다).
  const [gitNote, setGitNote] = useState(false);
  useEffect(() => { if (!gitNote) return; const timer = setTimeout(() => setGitNote(false), 4000); return () => clearTimeout(timer); }, [gitNote]);
  // 상태바 접기: 훅이라 아래의 `!project` 조기 반환보다 위에 둔다(프로젝트가 열려 상태바가 생기면 그때 붙는다).
  const statusBar = useRef<HTMLElement>(null), foldedStatus = useStatusFit(statusBar, statusLayout(settings).right.filter(id => settings.statusItems.includes(id)), Boolean(project));
  // The one-time cards wait their turn (notices.ts) and are drawn in the dock strip below the workspaces (main.tsx): none covers a button or another card.
  // One id per project (the id's part before ":" is its place in the order): every open project has its own Workspace, and a shared id would let an inactive one withdraw what the active one asked for.
  const gitCardOn = useTipNotice(`git:${root}`, [['gitgraph', active && project && project.repositories.length > 0 && settings.tips && settings.gitTipPending && settings.onboarded]]);
  const chatCardOn = useTipNotice(`chat-mode:${root}`, [['chatmode', active && project && chatModeTipDue(settings, findLeaf(activePane(), focus)?.kind, project.terminals.some(terminal => terminal.id === focus && !terminal.exited) ? agentOf(focus) : undefined)]]);
  const gitCard = useExit(Boolean(gitCardOn)), chatCard = useExit(Boolean(chatCardOn)), gitSheet = useExit(gitOpen);
  if (!project) return <main className="app loading" hidden={!active}><ErrorToast scope={root} active={active} />{openError && <div className="open-failed"><p>프로젝트를 열지 못했습니다: {openError}</p><button onClick={open}>다시 시도</button></div>}{quickDialog}</main>;

  const noGit = project.repositories.length === 0;
  const gitRepository = project.repositories.find(repo => repo.id === gitRepositoryId);
  // A plain folder is `multiRepo` with no repositories at all: nothing to pick, and the empty drawer just says so (the dropdown made its header overflow).
  const gitControls = project.multiRepo && !noGit && <><label>Git 저장소<Dropdown label="Git 저장소" value={gitRepositoryId} options={[{ value: '', label: '저장소 선택' }, ...project.repositories.map(repo => ({ value: repo.id, label: repo.name }))]} onChange={selectGitRepository} /></label>{gitRepository && <div className="actions"><label className="check"><input type="checkbox" checked={gitRepository.worktreeEnabled} onChange={event => run(async () => { await call('git/worktree-setting', { enabled: event.target.checked }); await refresh(); await refreshGit(); })} /> worktree 사용</label>{gitRepository.worktreeEnabled && <button onClick={() => run(async () => { if (!(await ask.confirm(`${gitRepository.branch} 브랜치의 변경을 원본 저장소에 통합할까요? (fast-forward)`))) return; await call('git/worktree/integrate', { confirm: gitRepository.branch }); await refreshGit(); })}>원본에 통합</button>}</div>}</>;
  const editorCtx: EditorCtx = {
    settings, gitVersion, loadDiff, fileBuffer, watchFiles,
    onDiffLayoutChange: diffLayout => setSettings(previous => ({ ...previous, diffLayout })),
    onSelectTab: (group, path) => { commitFor(group, mapLeaf(treeOf(group)!, group, leaf => ({ ...leaf, active: path }))); setFocusLeaf(group); },
    onCloseTab: (group, path) => run(() => closeTab(group, path)), onCloseGroup: group => run(() => closeGroup(group))
  };
  const live = new Set(project.terminals.filter(terminal => !terminal.exited).map(terminal => terminal.id));
  const cwds = Object.fromEntries(project.terminals.filter(terminal => terminal.cwd).map(terminal => [terminal.id, terminal.cwd!]));
  const onModeChange = (defaultMode: AgentMode) => setSettings(previous => ({ ...previous, defaultMode }));
  const paneProps = {
    onModeChange,
    followUpInput: async (id: string, prompt: string, sequence: number, requestId: string) => (await call<{ accepted: boolean }>('terminal/follow-up', { id, prompt, sequence, requestId })).accepted,
    // "취소" comes first so it is the preselected entry: the Enter that triggered this must not also accept it.
    confirmSend: async (message: string) => (await pick(message, [{ id: 'no', label: '취소' }, { id: 'yes', label: '그래도 보내기', icon: 'send' }])) === 'yes',
    send, bus: bus.current, live, cwds, titles, agentOf, onAgent: (id: string, agent: Agent) => setLaunched(previous => previous[id] === agent ? previous : { ...previous, [id]: agent }),
    onAgentResolved: clearAttention,
    ssh: sshSet, working, attention, caches, onAgentWorking: (id: string, on: boolean) => setWorking(previous => previous.has(id) === on ? previous : on ? new Set(previous).add(id) : new Set([...previous].filter(item => item !== id))),
    onAgentEvent, focus, zoom, onFocus: (id: string) => { setFocusLeaf(id); if (attention[id] === 'done') clearAttention(id); }, onZoom: (id: string) => setZoom(value => value === id ? '' : id),
    onSplit: (id: string, direction: 'row' | 'column') => splitTerminal(id, direction), onLaunch: (id: string, command: string) => run(() => fillLauncher(id, command)), onClose: (id: string) => run(() => closeTerminal(id)), onToChat: (id: string) => run(() => terminalToChat(id)),
    onTitle: (id: string, title: string) => setTitles(previous => previous[id] === title ? previous : { ...previous, [id]: title }), editor: editorCtx
  };
  // The drawer's top edge: dragging moves a CSS variable, the height is saved once the pointer is released. Double-click: half / default.
  const clampGit = (value: number) => Math.max(160, Math.min(Math.round(window.innerHeight - 120), Math.round(value)));
  const startGitResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget, drawer = handle.parentElement!, startY = event.clientY, startHeight = drawer.getBoundingClientRect().height; let height = clampGit(startHeight);
    handle.setPointerCapture(event.pointerId); handle.classList.add('dragging'); document.body.classList.add('resizing-row');
    const move = (e: PointerEvent) => { height = clampGit(startHeight + startY - e.clientY); drawer.style.setProperty('--git-h', `${height}px`); };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); handle.classList.remove('dragging'); document.body.classList.remove('resizing-row'); setSettings(previous => previous.gitLogHeight === height ? previous : { ...previous, gitLogHeight: Math.min(2000, height) }); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
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
  const rightOpen = errorsOpen || feedbackOpen || Boolean(pluginShown);
  const rightPanel = <aside className={`right-panel ${reviewWide ? 'wide' : ''} ${feedbackOpen && !errorsOpen ? 'feedback-side' : ''}`} data-feedback-region={errorsOpen ? '오류 패널' : pluginShown ? `플러그인 ${pluginShown.name}` : '피드백 요청'} aria-label={errorsOpen ? '오류' : pluginShown ? pluginShown.name : '피드백 요청'} style={{ '--review-w': `${settings.reviewWidth}px` } as CSSProperties}>
    <div className="review-resizer" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="오른쪽 패널 너비 조절 (더블클릭: 넓게/기본)" onPointerDown={startReviewResize} onDoubleClick={() => setReviewWide(value => !value)}
      data-tip={'끌기: 너비 조절\n더블클릭: 넓게/기본 (Enter)\n기본 너비 (Home)'}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setSettings(previous => ({ ...previous, reviewWidth: clampReview(previous.reviewWidth + (event.key === 'ArrowLeft' ? 32 : -32)) })); setReviewWide(false); }
        else if (event.key === 'Enter') { event.preventDefault(); setReviewWide(value => !value); }
        else if (event.key === 'Home') { event.preventDefault(); setReviewWide(false); setSettings(previous => ({ ...previous, reviewWidth: defaultSettings.reviewWidth })); }
      }} />
    {errorsOpen ? <ErrorPanel scope={root} wide={reviewWide} toggleWide={() => setReviewWide(value => !value)} />
      : pluginShown ? <PluginPanel key={pluginShown.id} plugin={pluginShown} wide={reviewWide} toggleWide={() => setReviewWide(value => !value)} onSettings={onOpenPlugins} onClose={() => setPluginOpen('')} />
      : <FeedbackPanel ask={ask} fail={report} wide={reviewWide} toggleWide={() => setReviewWide(value => !value)} onClose={() => setFeedbackOpen(false)} aiContext={feedbackContext} aiModel={settings.feedbackAiModel} aiEffort={settings.feedbackAiEffort} onAiChange={patch => setSettings(previous => ({ ...previous, ...patch }))} />}
  </aside>;
  const gitDrawer = gitSheet.mounted && <div className={`git-drawer ${settings.gitLogDock ? 'docked' : 'floating'}`} data-closing={gitSheet.closing || undefined} inert={gitSheet.closing || undefined} style={{ '--git-h': `${settings.gitLogHeight}px` } as CSSProperties}>
    <div className="git-resizer" role="separator" tabIndex={0} aria-orientation="horizontal" aria-label="Git 패널 높이 조절 (더블클릭: 절반/기본)" onPointerDown={startGitResize}
      onDoubleClick={() => setSettings(previous => ({ ...previous, gitLogHeight: previous.gitLogHeight === 380 ? clampGit(window.innerHeight / 2) : 380 }))}
      data-tip={'끌기: 높이 조절\n더블클릭: 절반/기본 (Enter)\n기본 높이 (Home)'}
      onKeyDown={event => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setSettings(previous => ({ ...previous, gitLogHeight: clampGit(previous.gitLogHeight + (event.key === 'ArrowUp' ? 32 : -32)) })); }
        else if (event.key === 'Enter') { event.preventDefault(); setSettings(previous => ({ ...previous, gitLogHeight: previous.gitLogHeight === 380 ? clampGit(window.innerHeight / 2) : 380 })); }
        else if (event.key === 'Home') { event.preventDefault(); setSettings(previous => ({ ...previous, gitLogHeight: 380 })); }
      }} />
    <GitLog call={call} settings={settings} setSettings={setSettings} visible={active && gitOpen} ask={ask} fail={report} onClose={() => setGitOpen(false)} onChanged={() => run(refreshGit)}
      openDiff={openEditorTab} repoKey={`${project.id}:${gitRepositoryId}`} controls={gitControls || undefined}
      unavailable={!project.repositories.length ? 'Git 저장소가 없습니다.' : project.multiRepo && !gitRepositoryId ? '위에서 Git 저장소를 선택하세요.' : undefined} />
  </div>;
  const shown = (id: string) => settings.statusItems.includes(id);
  const reviewCount = pendingReviewCount(feedback.items), newsCount = progressNews(feedback.items).length;
  const layout = statusLayout(settings);
  const statusNodes: Record<string, ReactNode> = {
    // Healthy is the normal case, so it shows nothing; only a dropped server connection appears, with words.
    connection: connection !== '연결됨' && <span className="conn" role="status"><Icon name="wifi" size={13} />{connection}</span>,
    path: <span className="stat stat-path" title={project.root} data-tip-nowrap><Icon name="folder" size={13} /><span className="stat-text">{shortPath(project.root)}</span></span>,
    branch: <button title="브랜치 전환" onClick={() => run(switchBranch)}><Icon name="branch" size={13} />{git.branch || '브랜치 없음'}</button>,
    // Only items that are shown get rendered, so the system poll runs only while one of these is on.
    cpu: <SystemStat kind="cpu" />,
    memory: <SystemStat kind="memory" />,
    claudeusage: <UsageStat provider="claude" colors={settings.usageColors} projectId={project.id} active={active} showSession={settings.claudeSession} refresh={settings.usageRefresh} meters={settings.usageShown.claude} style={settings.usageStyle} />,
    codexusage: <UsageStat provider="codex" colors={settings.usageColors} projectId={project.id} active={active} showSession refresh={settings.usageRefresh} meters={settings.usageShown.codex} style={settings.usageStyle} />,
    cursorusage: <UsageStat provider="cursor" colors={settings.usageColors} projectId={project.id} active={active} showSession refresh={settings.usageRefresh} meters={settings.usageShown.cursor} style={settings.usageStyle} />,
    // Only the project on screen: every open project keeps its status bar mounted (hidden), and each would otherwise poll and tick.
    wakatime: settings.wakatime && active && <WakaTimeStat />,
    clock: active && <Clock hour12={settings.clock12h} seconds={settings.clockSeconds} />,
    readiness: <details className="readiness"><summary title="에이전트/셸 준비 상태"><Icon name="info" size={13} /></summary><div>{Object.entries(health).map(([name, value]) => <p key={name}><b>{name}</b> {value.version} {value.message}</p>)}<button onClick={() => run(async () => setHealth(await call('readiness', { force: true })))}>다시 확인</button></div></details>
  };
  const chatCtx: ChatCtx = {
    call, settings, root: project.root, projectId: project.id, onState: onChatState, onTitle: (id, title) => setTitles(previous => previous[id] === title ? previous : { ...previous, [id]: title }), onClose: id => run(() => closeTerminal(id)), toTerminal: (id, fresh) => run(() => chatToTerminal(id, fresh)), onOpenSettings, onSettingsChange: setSettings, pick, fail: report, branchChat, resumeChat, importCliChat, switchAgent: (id, agent, forget) => switchChatAgent(id, agent, forget).catch(cause => { report(cause); return false; }),
    subscribe: (id, handler) => { chatBus.current.set(id, handler); return () => { if (chatBus.current.get(id) === handler) chatBus.current.delete(id); }; }
  };
  // A phone shows one pane of a tab at a time: the focused one, through the same zoom the desktop uses to maximize a pane.
  const mobileZoom = (tab: PaneTab) => {
    if (!mobile || !tab.pane) return tab.id === activeTab ? zoom : '';
    const wanted = tab.id === activeTab ? focus : refs.tabFocus.current[tab.id];
    return findLeaf(tab.pane, wanted || '') ? wanted : leaves(tab.pane)[0] ?? '';
  };
  const center = <div className="tab-stack">{paneTabs.map(tab => <div key={tab.id} className="tab-page" hidden={tab.id !== activeTab} data-shown={shownTabs.current.has(tab.id) ? '' : undefined}>
    {tab.pane ? <Panes pane={tab.pane} visible={active && tab.id === activeTab} onLayout={next => commitTab(tab.id, next)} {...paneProps} chat={chatCtx} zoom={mobileZoom(tab)} />
      : <Launchers onModeChange={onModeChange} shell={settings.terminalShell} mode={settings.defaultMode} title="새 탭" autoFocus hidden={hiddenAgents} nudge={settings.chatTipPending} onLaunch={command => run(() => launch(command, 'split'))} />}
  </div>)}</div>;
  return <main className={`app ${settings.dimInactivePanes ? 'dim-inactive' : ''}`} hidden={!active}>
    <header className="tabbar" data-feedback-region="상단 바">
      {mobile && <IconButton icon="panelLeft" className="bar-icon mobile-menu" label="프로젝트와 탭" tip="header" dot={false} onClick={() => setDrawer(open => !open)} />}
      <div className="split-button">
        <button className="bar-button new-tab" aria-label="새 터미널 탭" onClick={() => run(() => newTab())}><Icon name="plus" /><span>새 탭</span></button>
        <button ref={launcherButton} className="bar-button caret" data-tip={`새 탭 종류 선택 (${showAppKey(settings.appKeys, 'launcher')})`} aria-label="새 탭 종류 선택" aria-haspopup="dialog" aria-expanded={menuOpen} onPointerDown={event => { if (menuOpen) event.preventDefault(); }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setMenuOpen(true); } }} onClick={() => { if (menuOpen) closeLauncherMenu(); else setMenuOpen(true); }}><Icon name="chevronDown" size={14} /></button>
        {menuOpen && <><button className="context-dismiss" aria-label="메뉴 닫기" tabIndex={-1} onClick={closeLauncherMenu} />
          <LauncherMenu mode={settings.defaultMode} items={launchers} nudge={settings.chatTipPending} consoles={pluginsState?.plugins.filter(plugin => plugin.console && plugin.id).map(plugin => ({ id: plugin.id!, name: plugin.name, icon: <PluginIcon plugin={plugin} size={18} /> }))} onModeChange={onModeChange} onClose={closeLauncherMenu} onLaunch={command => { closeLauncherMenu(); run(() => launch(command, 'tab')); }} /></>}
      </div>
      <button type="button" className="icon-btn bar-icon" data-tip="프로젝트 파일 트리" aria-label="프로젝트 파일 트리" aria-pressed={treeOpen} onClick={() => setTreeOpen(value => !value)}>
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19V6a1 1 0 0 1 1-1h4l3 3m0 3V4h5l3 3v4m-5-3h2M3 19l3-8h15l-3 8Z" /></svg>
      </button>
      <span className="drag-space" />
      {mobile
        // A phone has no room for a search field and no title bar: the project's name, branch and folder sit here, and tapping them searches.
        ? <button className="palette-button m-title" onClick={() => run(openPalette)} aria-label={`${basename(project.root.replace(/\\/g, '/'))}, 명령 팔레트`}>
          <span className="m-title-name">{basename(project.root.replace(/\\/g, '/'))}</span>
          <span className="m-title-sub"><Icon name="branch" size={11} />{git.branch || '브랜치 없음'}<i aria-hidden="true">, </i>{shortPath(project.root)}</span>
        </button>
        : <button className="palette-button" onClick={() => run(openPalette)} aria-label="명령 팔레트"><Icon name="search" /><span>{basename(project.root.replace(/\\/g, '/'))}</span><kbd>{showAppKey(settings.appKeys, 'palette')}</kbd></button>}
      {/* One joined group like the split button on the left: each tool reads as its own button, with no loose gaps between them. */}
      <div className="bar-tools" role="group" aria-label="패널과 설정">
      <button className={`bar-button ${!noGit && gitOpen ? 'on' : ''}`} data-tip={noGit ? 'Git 저장소가 없습니다.' : `Git 커밋 그래프 (${showAppKey(settings.appKeys, 'gitLog')})`} aria-label="Git 커밋 그래프" aria-disabled={noGit || undefined} aria-pressed={noGit ? undefined : gitOpen} style={noGit ? { opacity: 0.4, cursor: 'default', background: 'transparent', color: 'var(--muted)' } : undefined} onPointerEnter={noGit ? undefined : preloadMonaco} onFocus={noGit ? undefined : preloadMonaco} onClick={() => { if (noGit) setGitNote(true); else toggleGit(); }}>
        <Icon name="graph" />{(git.additions > 0 || git.deletions > 0) && <span className="diffstat"><ins>+{git.additions}</ins><del>−{git.deletions}</del></span>}</button>{gitNote && noGit && <span className="bar-note" role="status">Git 저장소가 없는 폴더예요. 터미널에서 git init 을 하면 커밋 그래프를 쓸 수 있어요.</span>}
      <button className={`bar-button ${feedbackOpen && !errorsOpen ? 'on' : ''}`} data-tip={`피드백 요청 (${showAppKey(settings.appKeys, 'feedback')})${newsCount ? ', 처리 상태가 바뀐 피드백이 있어요' : ''}`} aria-label="피드백 요청" aria-pressed={feedbackOpen && !errorsOpen} onClick={toggleFeedback}><Icon name="feedback" />{newsCount > 0 && <i className="feedback-dot bar-news" aria-hidden="true" />}</button>
      {onOpenRemotePc && <button className="bar-button" data-tip="다른 PC에 접속" aria-label="다른 PC에 접속" onClick={onOpenRemotePc}><Icon name="laptop" /></button>}
      {headerPlugins.map(plugin => <button key={plugin.id} className={`bar-button ${pluginShown?.id === plugin.id ? 'on' : ''}`} data-tip={`플러그인: ${plugin.name}`} aria-label={plugin.name} aria-pressed={pluginShown?.id === plugin.id} onClick={() => togglePlugin(plugin.id!)}><PluginIcon plugin={plugin} /></button>)}
      <ErrorTabButton scope={root} pressed={errorsOpen} onClick={toggleErrors} />
      <IconButton icon="chart" tip="header" label="사용 기록" className="bar-icon" onClick={onOpenUsage} />
      <IconButton icon="settings" tip="header" label={pluginUpdates ? `설정 (플러그인 업데이트 ${pluginUpdates}개)` : '설정'} dot={pluginUpdates > 0} keys={showAppKey(settings.appKeys, 'settings')} className="bar-icon" onClick={onOpenSettings} />
      </div>
    </header>
    <ErrorToast scope={root} active={active} />
    <div className="workbench">
      <ProjectTree key={project.root} projectId={project.id} root={project.root} visible={active} open={treeOpen} expanded={treeExpanded} setExpanded={setTreeExpanded}
        onClose={() => setTreeOpen(false)} call={call} watch={watchFiles} onOpen={openProjectFile} host={treeHost} />
      {center}{rightOpen && rightPanel}{!settings.gitLogDock && gitDrawer}
    </div>
    {settings.gitLogDock && gitDrawer}
{mobile ? <MobileStatus settings={settings} projectId={project.id} active={active} connection={connection} branch={git.branch} onBranch={() => run(switchBranch)} />
      : <footer className="statusbar" data-feedback-region="상태바" ref={statusBar}>
      <div className="status-left">{layout.left.filter(shown).map(id => <Fragment key={id}>{statusNodes[id]}</Fragment>)}</div>
      <div className="status-right">{reviewCount > 0 && <button className="feedback-badge" title="검토할 피드백 초안, 피드백 요청 열기" aria-label={`검토할 피드백 초안 ${reviewCount}개`} onClick={showFeedback}><Icon name="feedback" size={13} />{reviewCount}</button>}<PluginBadges onOpen={onOpenPlugins} />{layout.right.filter(shown).map(id => <StatusSlot key={id} id={id}>{statusNodes[id]}</StatusSlot>)}<StatusMore ids={foldedStatus} labels={statusLabels} nodes={statusNodes} /></div>
    </footer>}
    {/* Until Chat was opened once: a low, compact card beside the focused agent CLI. Opening a chat (ChatPane) or "괜찮아요" ends it for good. */}
    {chatCard.mounted && <Spotlight target=".terminal-pane.focused" closing={chatCard.closing} />}
    {chatCard.mounted && createPortal(<aside className="chat-mode-tip notice-card" aria-label="Chat 모드 안내" data-closing={chatCard.closing || undefined}>
      <img src="/chat-mode-preview.png" alt="Chat 모드에서 도구 실행, 코드 변경 diff, 결과 요약이 대화로 정리된 화면" width="960" height="632" />
      <div className="chat-mode-tip-body">
        <strong>{{ claude: 'Claude', codex: 'Codex', cursor: 'Cursor' }[agentOf(focus) ?? 'claude']}를 Chat으로 써 보세요</strong>
        <p>요청과 코드 변경을 대화 화면에서 한눈에 봐요. CLI로는 언제든 돌아올 수 있어요.</p>
        <div className="chat-mode-tip-actions">
          <button className="primary" onClick={() => run(() => launch(`ade:chat:${agentOf(focus)}`, 'tab'))}>Chat으로 열기<Icon name="arrowRight" size={14} /></button>
          <button onClick={() => setSettings(previous => ({ ...previous, chatTipPending: false }))}>괜찮아요</button>
        </div>
      </div>
    </aside>, document.body)}
    {/* Once, for people who knew the changes panel: it is now the Git graph. Opening the graph or "확인" ends it for good. */}
    {gitCard.mounted && <Spotlight target='button[aria-label="Git 커밋 그래프"]' closing={gitCard.closing} />}
    {gitCard.mounted && createPortal(<aside className="chat-mode-tip git-graph-tip notice-card" aria-label="Git 그래프 안내" data-closing={gitCard.closing || undefined}>
      {/* Same metrics as the real graph (GitLog.tsx): a row is 22px, a lane 16px, a commit dot r4, the HEAD dot a ring r6, lines 1.5px. Chips sit centred on their row. */}
      <svg className="git-tip-art" viewBox="0 0 144 88" aria-hidden="true">
        <path d="M12 0V88" fill="none" strokeWidth="1.5" style={{ stroke: 'var(--git-ref-local)' }} />
        <path d="M44 11L28 33" fill="none" strokeWidth="1.5" strokeLinecap="round" style={{ stroke: 'var(--git-ref-head)' }} />
        <path d="M28 33V55L12 77" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'var(--git-ref-remote)' }} />
        <circle cx="44" cy="11" r="6" style={{ fill: 'var(--git-ref-head)' }} /><circle cx="44" cy="11" r="4" style={{ fill: 'var(--surface)' }} /><circle cx="44" cy="11" r="2" style={{ fill: 'var(--git-ref-head)' }} />
        <circle cx="28" cy="33" r="4" style={{ fill: 'var(--git-ref-remote)' }} /><circle cx="28" cy="55" r="4" style={{ fill: 'var(--git-ref-remote)' }} /><circle cx="12" cy="77" r="4" style={{ fill: 'var(--git-ref-local)' }} />
        {([[11, 'main', 49, 'var(--git-ref-head)'], [55, 'origin/dev', 78, 'var(--git-ref-remote)'], [77, 'dev', 43, 'var(--git-ref-local)']] as const).map(([y, name, width, color]) => <g key={name}>
          <rect x="60" y={y - 8.5} width={width} height="17" rx="6" style={{ fill: 'var(--fg)' }} fillOpacity=".08" />
          <circle cx="68" cy={y} r="3" style={{ fill: color }} />
          <text x="76" y={y} dominantBaseline="central" fontSize="11.5" style={{ fill: 'var(--fg)' }}>{name}</text>
        </g>)}
      </svg>
      <div className="chat-mode-tip-body">
        <strong>변경사항 패널이 Git 그래프로 바뀌었어요</strong>
        <p>상단 Git 버튼에는 커밋하지 않은 <span className="diffstat"><ins>+</ins><del>−</del></span> 줄 수만 보여요. 누르면 아래에서 커밋 그래프가 올라와 브랜치, 체크아웃, 머지, 리베이스, 체리픽을 IntelliJ처럼 바로 할 수 있어요. ({showAppKey(settings.appKeys, 'gitLog')})</p>
        <div className="chat-mode-tip-actions">
          <button className="primary" onClick={() => { setGitOpen(true); setSettings(previous => ({ ...previous, gitTipPending: false })); }}>Git 그래프 열기<Icon name="arrowRight" size={14} /></button>
          <button onClick={() => setSettings(previous => ({ ...previous, gitTipPending: false }))}>확인</button>
        </div>
      </div>
    </aside>, document.body)}
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

