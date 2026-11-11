import { showAppKey } from './shortcuts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, basename, chooseFolder } from './api';
import { agentNames, defaultSettings, migrateSettings, type Settings } from './Editor';
import { playSound } from './sound';
import { Icon, IconButton, type IconName } from './Icon';
import { SettingsModal } from './Settings';
import { onPluginsOpen } from './PluginSettings';
import { AppVersion, Modal } from './views';
import { CacheTimer } from './Panes';
import { Tutorial } from './Tutorial';
import { Splash } from './Splash';
import { Workspace, showKeys, type Command, type Hub, type AgentAlert, type WorkspaceHandle, type WorkspaceStatus } from './Workspace';
import { errorText, pushError } from './errors';
import { ErrorCorner } from './error-ui';
import '@material-symbols/font-400/outlined.css';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/noto-sans-kr/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';

// Comet tail: 18 overlapping dashes sharing one head stack into a smooth fade (~45% of the outline); the short extras brighten the tip.
const TRAIL: [number, number][] = [[1.5, .7], [4, .35], ...Array.from({ length: 18 }, (_, i): [number, number] => [2.5 * (i + 1), .11])];
import './style.css';

type Entry = { root: string; id: string };
type Recent = { id?: string; root: string; pinned?: boolean };
type TabDropMode = 'before' | 'after' | 'merge';
type TabMenuTarget = { x: number; y: number; root: string; tabId: string; paneId?: string };
function tabDropMode(event: React.DragEvent<Element>, sourceId: string, targetId: string): TabDropMode {
  const box = event.currentTarget.getBoundingClientRect(), ratio = (event.clientY - box.top) / box.height;
  if (sourceId === targetId) return ratio < 0.5 ? 'before' : 'after';
  if (ratio < 0.25) return 'before';
  if (ratio > 0.75) return 'after';
  return 'merge';
}
const idle: WorkspaceStatus = { id: '', name: '', loaded: false, attention: 0, tabs: [], activeTab: '' };
const sameStatus = (a: WorkspaceStatus, b: WorkspaceStatus) => (Object.keys(a) as (keyof WorkspaceStatus)[]).every(key => key === 'tabs' ? JSON.stringify(a.tabs) === JSON.stringify(b.tabs) : a[key] === b[key]);
// First and last character, so projects that start alike (app-web, app-api) stay distinguishable.
const initials = (name: string) => (name.length > 1 ? name[0] + name[name.length - 1] : name).toUpperCase();
const shortName = (root: string) => basename(root.replace(/\\/g, '/'));

// One websocket serves every open project. Each project subscribes by id and only receives messages tagged with it.
function useHub(enabled: boolean) {
  const [connection, setConnection] = useState('연결 대기');
  const state = useRef({ ws: null as WebSocket | null, subs: new Map<string, (message: any) => void>() });
  const hub = useMemo<Hub>(() => ({
    subscribe(projectId, handler) {
      const { subs, ws } = state.current;
      subs.set(projectId, handler);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', projectId }));
      return () => {
        if (subs.get(projectId) !== handler) return;
        subs.delete(projectId);
        const socket = state.current.ws;
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'unsubscribe', projectId }));
      };
    },
    send(message) { const socket = state.current.ws; if (socket?.readyState !== WebSocket.OPEN) return false; socket.send(JSON.stringify(message)); return true; }
  }), []);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false, retry: ReturnType<typeof setTimeout>;
    function connect() {
      const ws = new WebSocket(`ws://${location.host}/ws`); state.current.ws = ws;
      ws.onopen = () => {
        setConnection('연결됨');
        for (const projectId of state.current.subs.keys()) ws.send(JSON.stringify({ type: 'subscribe', projectId }));
      };
      ws.onmessage = event => {
        if (stopped) return;
        let message: any;
        try { message = JSON.parse(event.data); } catch { return; }
        // Errors that name no project are shown by every project; everything else goes to its owner.
        if (typeof message.projectId === 'string') state.current.subs.get(message.projectId)?.(message);
        else for (const handler of state.current.subs.values()) handler(message);
      };
      ws.onclose = () => { setConnection('연결 끊김 · 재연결 중'); if (!stopped) retry = setTimeout(connect, 1500); };
    }
    connect();
    return () => { stopped = true; clearTimeout(retry); state.current.ws?.close(); };
  }, [enabled]);
  return { hub, connection };
}

type PickerProps = { ready: boolean; recent: Recent[]; open: Set<string>; errorScope: string; onOpen(path: string): Promise<void>; onCreate(name: string, parent: string, git: boolean): Promise<void>; onClone(url: string, parent: string, name: string): Promise<void>; onPin(root: string, pinned: boolean): void; onRemove(root: string): Promise<void>; onClose?(): void };
type PickerTab = 'open' | 'create' | 'clone';
const pickerTabs: { id: PickerTab; label: string; icon: IconName }[] = [
  { id: 'open', label: '기존 프로젝트 추가', icon: 'folder' },
  { id: 'create', label: '새 프로젝트 생성', icon: 'folderPlus' },
  { id: 'clone', label: 'GitHub에서 가져오기', icon: 'branch' }
];
// Where a create/clone will land, shown before it happens; the separator follows whatever the parent path already uses.
const joinPath = (parent: string, name: string) => !parent || !name ? '' : parent.replace(/[\\/]+$/, '') + (parent.includes('\\') ? '\\' : '/') + name;
const repoName = (url: string) => url.trim().replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop() || '';
type FolderFieldProps = { label: string; ariaLabel: string; title: string; value: string; placeholder: string; disabled: boolean; onChange(path: string): void; onError(message: string): void };
function FolderField({ label, ariaLabel, title, value, placeholder, disabled, onChange, onError }: FolderFieldProps) {
  const [picking, setPicking] = useState(false);
  const pick = () => {
    if (disabled || picking) return;
    setPicking(true); onError('');
    void chooseFolder(title, value).then(picked => { if (picked) onChange(picked); }).catch(cause => onError(cause instanceof Error ? cause.message : String(cause))).finally(() => setPicking(false));
  };
  // Read-only: a click (or Enter/Space) opens the dialog. onChange stays only so scripted tests can still fill it.
  return <div className="field"><span className="field-label">{label}</span><div className="folder-field">
    <input readOnly aria-label={ariaLabel} className="folder-path" value={value} title={value} placeholder={picking ? '폴더 선택 창에서 고르는 중…' : placeholder} disabled={disabled}
      onClick={pick} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); } }} onChange={event => onChange(event.target.value)} />
    <button type="button" className={value ? '' : 'primary'} disabled={disabled || picking} onClick={pick}><Icon name="folder" size={15} />{picking ? '선택 중…' : value ? '변경…' : '폴더 선택…'}</button>
  </div></div>;
}
function PickerCard({ ready, recent, open, errorScope, onOpen, onCreate, onClone, onPin, onRemove, onClose }: PickerProps) {
  const [tab, setTab] = useState<PickerTab>(() => { try { const saved = localStorage.getItem('ade-picker-tab'); return pickerTabs.some(item => item.id === saved) ? saved as PickerTab : 'open'; } catch { return 'open'; } });
  const [path, setPath] = useState(''), [url, setUrl] = useState(''), [parent, setParent] = useState(''), [name, setName] = useState(''), [folder, setFolder] = useState(''), [git, setGit] = useState(true), [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(''), [deleting, setDeleting] = useState(false);
  const fail = (message: string) => pushError(errorScope, message);
  const tabRefs = useRef<Partial<Record<PickerTab, HTMLButtonElement | null>>>({});
  useEffect(() => { try { localStorage.setItem('ade-picker-tab', tab); } catch {} }, [tab]);
  useEffect(() => { if (tab !== 'open' && !parent) void api<{ path: string }>('picker/parent').then(home => setParent(previous => previous || home.path)).catch(() => {}); }, [tab, parent]);
  const run = (work: () => Promise<void>) => { setBusy(true); void work().finally(() => setBusy(false)); };
  const fieldState = { disabled: !ready || busy, onError: fail };
  const onTabKey = (event: React.KeyboardEvent) => {
    const index = pickerTabs.findIndex(item => item.id === tab);
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? pickerTabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = pickerTabs[(next + pickerTabs.length) % pickerTabs.length].id;
    setTab(target); tabRefs.current[target]?.focus();
  };
  const favorites = recent.filter(item => item.pinned), others = recent.filter(item => !item.pinned);
  // Already-open projects stand out; choosing one just switches to it.
  const row = (item: Recent) => { const isOpen = open.has(item.root); return <div className={`recent${item.pinned ? ' pinned' : ''}${isOpen ? ' open' : ''}`} key={item.root}>
    <button type="button" className="recent-open" title={isOpen ? `${item.root}
열려 있음 · 누르면 이 프로젝트로 이동` : item.root} onClick={() => void onOpen(item.root)}><strong><span className="recent-name">{shortName(item.root)}</span>{isOpen && <span className="open-badge">열림</span>}</strong><small>{item.root}</small></button>
    <button type="button" className="recent-pin" aria-pressed={!!item.pinned} aria-label={item.pinned ? '즐겨찾기 해제' : '즐겨찾기에 추가'} title={item.pinned ? '즐겨찾기 해제' : '즐겨찾기에 추가'} onClick={() => onPin(item.root, !item.pinned)}>{item.pinned ? '★' : '☆'}</button>
    <button type="button" className="recent-remove" aria-label={`${shortName(item.root)} 최근 프로젝트에서 삭제`} title="최근 프로젝트에서 삭제" disabled={!ready} onClick={() => setRemoving(item.root)}><Icon name="x" size={14} /></button></div>; };
  const submitLabel = tab === 'open' ? (busy ? '여는 중…' : '열기') : tab === 'create' ? (busy ? '만드는 중…' : '만들고 열기') : (busy ? '클론 중…' : '클론하고 열기');
  const createTarget = joinPath(parent.trim(), name.trim()), cloneTarget = joinPath(parent.trim(), folder.trim() || repoName(url));
  return <><div className="welcome-card picker"><h1 id="picker-title" className="picker-title">프로젝트 추가</h1>
    <div className="picker-split">
      <aside className="picker-side" aria-label="즐겨찾기와 최근 프로젝트">
        <h2>즐겨찾기</h2>
        {favorites.length ? <div className="recent-list">{favorites.map(row)}</div> : <p className="hint">최근 프로젝트의 ☆를 눌러 고정하세요.</p>}
        <h2>최근 프로젝트</h2>
        {others.length ? <div className="recent-list">{others.map(row)}</div> : <p className="hint">{recent.length ? '모두 즐겨찾기에 있습니다.' : '아직 연 프로젝트가 없습니다.'}</p>}
      </aside>
      <section className="picker-main">
        <div role="tablist" aria-label="프로젝트 추가 방법" className="picker-tabs" onKeyDown={onTabKey}>
          {pickerTabs.map(item => <button key={item.id} ref={element => { tabRefs.current[item.id] = element; }} type="button" role="tab" id={`picker-tab-${item.id}`} aria-controls="picker-panel" aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><Icon name={item.icon} size={15} />{item.label}</button>)}
        </div>
        <div role="tabpanel" id="picker-panel" aria-labelledby={`picker-tab-${tab}`} className="picker-panel">
          {tab === 'open' && <form id="picker-form" className="picker-form" onSubmit={event => { event.preventDefault(); if (path) run(() => onOpen(path)); }}>
            <p className="hint">이미 있는 폴더를 프로젝트로 엽니다.</p>
            <FolderField label="프로젝트 폴더" ariaLabel="프로젝트 절대 경로" title="프로젝트 폴더 선택" value={path} placeholder="열 프로젝트 폴더를 선택하세요" onChange={setPath} {...fieldState} /></form>}
          {tab === 'create' && <form id="picker-form" className="picker-form" onSubmit={event => { event.preventDefault(); if (parent) run(() => onCreate(name.trim(), parent, git)); }}>
            <p className="hint">선택한 위치에 빈 폴더를 만들고 바로 엽니다.</p>
            <FolderField label="만들 위치" ariaLabel="새 프로젝트를 만들 위치" title="새 프로젝트를 만들 위치 선택" value={parent} placeholder="프로젝트를 만들 상위 폴더를 선택하세요" onChange={setParent} {...fieldState} />
            <div className="field"><span className="field-label">프로젝트 이름</span>
              <input aria-label="새 프로젝트 이름" value={name} onChange={event => setName(event.target.value)} placeholder="my-project" pattern="[A-Za-z0-9_.\-]+" title="영문, 숫자, . _ - 만 쓸 수 있습니다." required disabled={busy} autoFocus /></div>
            <label className="check"><input type="checkbox" checked={git} onChange={event => setGit(event.target.checked)} disabled={busy} />git 저장소로 초기화 (git init)</label>
            {createTarget && <p className="picker-target">만들 경로 <code>{createTarget}</code></p>}</form>}
          {tab === 'clone' && <form id="picker-form" className="picker-form" onSubmit={event => { event.preventDefault(); if (parent) run(() => onClone(url.trim(), parent, folder.trim())); }}>
            <p className="hint">GitHub 저장소를 클론해서 엽니다. 비공개 저장소는 git 인증이 필요합니다.</p>
            <div className="field"><span className="field-label">GitHub 저장소</span>
              <input aria-label="GitHub 저장소" value={url} onChange={event => setUrl(event.target.value)} placeholder="owner/repo 또는 https://github.com/owner/repo" required disabled={busy} autoFocus /></div>
            <FolderField label="클론할 위치" ariaLabel="클론할 위치(루트 경로)" title="클론할 위치 선택" value={parent} placeholder="저장소를 받을 상위 폴더를 선택하세요" onChange={setParent} {...fieldState} />
            <div className="field"><span className="field-label">폴더 이름 <small>(선택)</small></span>
              <input aria-label="클론할 폴더 이름" value={folder} onChange={event => setFolder(event.target.value)} placeholder={repoName(url) || '저장소 이름'} pattern="[A-Za-z0-9_.\-]+" title="영문, 숫자, . _ - 만 쓸 수 있습니다." disabled={busy} /></div>
            {cloneTarget && <p className="picker-target">클론 경로 <code>{cloneTarget}</code></p>}</form>}
        </div>
      </section>
    </div>
    {!ready && <p className="hint">서버 터미널에 표시된 접속 링크를 여세요.</p>}
    <div className="picker-actions">
      {onClose && <button type="button" onClick={onClose}>닫기</button>}
      <button type="submit" form="picker-form" className="primary" disabled={!ready || busy || (tab === 'open' ? !path : !parent)}>{submitLabel}</button>
    </div></div>
    {removing && <Modal className="recent-remove-modal" labelledBy="recent-remove-title" onClose={() => { if (!deleting) setRemoving(''); }}>
      <h2 id="recent-remove-title">최근 프로젝트에서 삭제할까요?</h2>
      <p><strong>{shortName(removing)}</strong></p><p className="hint">{removing}</p>
      <p>목록에서만 제거하며 실제 폴더와 파일, 열려 있는 프로젝트는 유지됩니다.</p>
      <div className="actions"><button autoFocus disabled={deleting} onClick={() => setRemoving('')}>취소</button>
        <button disabled={deleting} onClick={() => {
          setDeleting(true);
          void onRemove(removing).then(() => setRemoving('')).catch(cause => fail(errorText(cause))).finally(() => setDeleting(false));
        }}>{deleting ? '삭제 중…' : '삭제'}</button></div>
    </Modal>}</>;
}

// Right-click menu for a sidebar tab or split terminal: every drag gesture has a plain menu item here, with its key.
function TabMenu({ target, tabs, handle, onClose }: { target: TabMenuTarget; tabs: WorkspaceStatus['tabs']; handle?: WorkspaceHandle; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, []);
  const index = tabs.findIndex(tab => tab.id === target.tabId), tab = tabs[index];
  if (!tab || !handle) return null;
  const above = tabs[index - 1], below = tabs[index + 1], pane = tab.panes.find(item => item.id === target.paneId);
  const item = (icon: IconName, label: string, run: () => void, keys?: string, disabled?: boolean) =>
    <button role="menuitem" disabled={disabled} onClick={() => { onClose(); run(); }}><Icon name={icon} size={15} /><span className="menu-label">{label}</span>{keys && <kbd>{keys}</kbd>}</button>;
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])], at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };
  return <><button className="context-dismiss" aria-label="메뉴 닫기" onClick={onClose} onContextMenu={event => { event.preventDefault(); onClose(); }} />
    <div ref={ref} className="menu tab-menu" role="menu" aria-label={`${pane?.label ?? tab.label} 메뉴`} onKeyDown={onKey}
      style={{ left: Math.min(target.x, innerWidth - 250), top: Math.min(target.y, innerHeight - (pane ? 340 : 260)) }}>
      {pane && <>
        <small className="menu-title">{pane.label}</small>
        {item('externalLink', '새 탭으로 분리', () => handle.movePane(tab.id, pane.id, undefined, 'after'))}
        {item('arrowUp', '위 탭으로 옮기기', () => handle.movePane(tab.id, pane.id, above.id, 'merge'), undefined, !above)}
        {item('arrowDown', '아래 탭으로 옮기기', () => handle.movePane(tab.id, pane.id, below.id, 'merge'), undefined, !below)}
        {item('x', '이 터미널 닫기', () => handle.closePane(pane.id), 'Del')}
        <hr />
      </>}
      <small className="menu-title">{pane ? `탭: ${tab.label}` : tab.label}</small>
      {item('edit', '이름 바꾸기', () => handle.renameTab(tab.id), 'F2')}
      {item('arrowUp', '위로 이동', () => handle.moveTab(tab.id, above.id, false), showKeys('alt+↑'), !above)}
      {item('arrowDown', '아래로 이동', () => handle.moveTab(tab.id, below.id, true), showKeys('alt+↓'), !below)}
      {item('merge', '위 탭과 분할로 합치기', () => handle.mergeTabs(tab.id, above.id), undefined, !above)}
      {item('merge', '아래 탭과 분할로 합치기', () => handle.mergeTabs(tab.id, below.id), undefined, !below)}
      {item('x', '탭 닫기', () => handle.closeTab(tab.id), pane ? undefined : 'Del')}
    </div></>;
}

function Shell() {
  const [ready, setReady] = useState(false), [booted, setBooted] = useState(false), [bootError, setBootError] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]), [activeRoot, setActiveRoot] = useState('');
  const [status, setStatus] = useState<Record<string, WorkspaceStatus>>({});
  const [recent, setRecent] = useState<Recent[]>([]), [picker, setPicker] = useState(false);
  // splash: the launch animation, on every start once onboarded and when the tour ends.
  const [splash, setSplash] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaultSettings), [settingsOpen, setSettingsOpen] = useState<false | 'default' | 'plugins'>(false);
  const shell = useRef<HTMLDivElement>(null);
  // Sidebar display: expanded folders with tabs, or a narrow strip of initials. Saved with the other settings.
  const compact = settings.sidebarCompact, setCompact = (update: (value: boolean) => boolean) => setSettings(all => ({ ...all, sidebarCompact: update(all.sidebarCompact) }));
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ root: string; id: string; pane?: string } | null>(null), [dropAt, setDropAt] = useState<{ id: string; mode: 'before' | 'after' | 'merge' } | null>(null);
  const [menu, setMenu] = useState<TabMenuTarget | null>(null);
  const [projectDrag, setProjectDrag] = useState(''), [projectDrop, setProjectDrop] = useState<{ root: string; after: boolean } | null>(null);
  const { hub, connection } = useHub(ready);
  const entriesRef = useRef(entries); entriesRef.current = entries;
  const handles = useRef(new Map<string, WorkspaceHandle>());
  const statusRef = useRef(status); statusRef.current = status;
  const globalSettings = useRef(false);
  const current = entries.some(entry => entry.root === activeRoot) ? activeRoot : entries[0]?.root ?? '';
  const commit = (next: Entry[]) => { entriesRef.current = next; setEntries(next); };
  const moveProject = (root: string, targetRoot: string, after: boolean) => {
    const list = entriesRef.current, from = list.findIndex(entry => entry.root === root), target = list.findIndex(entry => entry.root === targetRoot);
    if (from < 0 || target < 0 || from === target) return;
    const next = [...list], [entry] = next.splice(from, 1), index = next.findIndex(item => item.root === targetRoot);
    next.splice(index + (after ? 1 : 0), 0, entry);
    commit(next);
  };
  const scopeRef = useRef('shell');
  scopeRef.current = current || 'shell';
  const report = useCallback((cause: unknown) => pushError(scopeRef.current, errorText(cause)), []);

  // ---- boot: sign in, then reopen the projects that were open last time ----
  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    history.replaceState(null, '', location.pathname);
    api('auth', { token }).then(async () => {
      const [saved, list] = await Promise.all([api<{ openProjects: Entry[]; activeProjectId: string; settings: Settings | null }>('app/state'), api<Recent[]>('recent')]);
      setRecent(list);
      globalSettings.current = Boolean(saved.settings);
      const loaded = saved.settings ? migrateSettings(saved.settings) : null;
      // The rail state used to live only in this browser's localStorage; carry it over once.
      const wasCompact = saved.settings?.sidebarCompact === undefined && (() => { try { return localStorage.getItem('ade-sidebar-compact') === '1'; } catch { return false; } })();
      if (loaded) setSettings(wasCompact ? { ...loaded, sidebarCompact: true } : loaded);
      else if (wasCompact) setSettings(all => ({ ...all, sidebarCompact: true }));
      setSplash(Boolean(loaded?.onboarded));
      const open: Entry[] = saved.openProjects || [], active = open.find(entry => entry.id === saved.activeProjectId)?.root ?? open[0]?.root ?? '';
      commit(open); setActiveRoot(active); setReady(true); setBooted(true);
    }).catch(cause => setBootError(errorText(cause)));
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; }, [settings.theme]);
  // Whole-window zoom through Electron (same as browser zoom, so terminal and diff coordinates stay right). A plain browser has its own Ctrl +/-.
  useEffect(() => { (window as unknown as { adeDesktop?: { setZoom?(percent: number): void } }).adeDesktop?.setZoom?.(settings.uiZoom); }, [settings.uiZoom]);
  // A custom accent replaces the theme's accent family inline; an empty one removes the override so the stylesheet applies again.
  useEffect(() => {
    const style = document.documentElement.style, color = settings.accentColor, names = ['--accent', '--accent-strong', '--accent-fg', '--accent-soft', '--selected', '--focus'];
    if (!/^#[0-9a-f]{6}$/i.test(color)) { names.forEach(name => style.removeProperty(name)); return; }
    const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    style.setProperty('--accent', color); style.setProperty('--focus', color);
    style.setProperty('--accent-strong', `color-mix(in srgb, ${color}, black 18%)`);
    style.setProperty('--accent-soft', `${color}1f`); style.setProperty('--selected', `${color}26`);
    style.setProperty('--accent-fg', (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#06141a' : '#ffffff');
  }, [settings.accentColor]);

  // The open list, the active project and shared settings survive restarts.
  useEffect(() => {
    if (!booted) return;
    const timer = setTimeout(() => {
      const open = entries.filter((entry, index) => entry.id && entries.findIndex(other => other.id === entry.id) === index).map(({ root, id }) => ({ root, id }));
      const activeId = entries.find(entry => entry.root === current)?.id ?? '';
      globalSettings.current = true;
      void api('app/state', { state: { openProjects: open, activeProjectId: open.some(entry => entry.id === activeId) ? activeId : '', settings } }).catch(report);
    }, 400);
    return () => clearTimeout(timer);
  }, [booted, entries, current, settings, report]);

  const onLegacySettings = useCallback((legacy: Partial<Settings>) => {
    if (globalSettings.current) return;
    globalSettings.current = true; setSettings(migrateSettings(legacy));
  }, []);
  const onStatus = useCallback((root: string, next: WorkspaceStatus) => {
    setStatus(all => all[root] && sameStatus(all[root], next) ? all : { ...all, [root]: next });
    const mine = entriesRef.current.find(entry => entry.root === root);
    if (mine && next.id && mine.id !== next.id) commit(entriesRef.current.map(entry => entry.root === root ? { ...entry, id: next.id } : entry));
  }, []);
  // A project that fails to open stays listed and shows a retry in its own workspace.
  const onFailed = useCallback((_root: string, _cause: unknown) => {}, []);

  // ---- background activity: a project you are not looking at can still need you ----
  // Terminal agents (Claude Code, Codex, Cursor CLI) that stopped or asked something: a notification plus a short sound, unless you are already watching.
  const onAgentAlert = useCallback((root: string, alert: AgentAlert) => {
    if (settings.agentsMuted.includes(alert.agent)) return;
    const wanted = (!alert.looking || settings.notifyLooking) && (alert.kind === 'done' ? settings.notifyDone : settings.notifyApproval);
    if (!wanted && !settings.notifySound) return;
    const project = statusRef.current[root]?.name || shortName(root), agent = agentNames[alert.agent];
    const title = `${project} · ${agent} ${alert.kind === 'done' ? '작업 멈춤' : '입력 요청'}`;
    if (wanted && 'Notification' in window) {
      if (Notification.permission === 'default') void Notification.requestPermission();
      if (Notification.permission === 'granted') {
        const popup = new Notification(title, { body: `${alert.name} — ${alert.kind === 'done' ? '완료되었거나 입력을 기다리고 있습니다.' : '확인이 필요합니다.'}`, tag: `ade:agent:${alert.paneId}` });
        popup.onclick = () => { window.focus(); setActiveRoot(root); handles.current.get(root)?.selectPane(alert.tabId, alert.paneId); popup.close(); };
      }
    }
    if (settings.notifySound) playSound(alert.kind === 'done' ? settings.soundDone : settings.soundAttention, settings.soundVolume);
  }, [settings.agentsMuted, settings.notifyLooking, settings.notifyDone, settings.notifyApproval, settings.notifySound, settings.soundDone, settings.soundAttention, settings.soundVolume]);

  // ---- project list ----
  const addProject = useCallback((path: string) => openEntry('project/open', { path }), []);
  const cloneProject = useCallback((url: string, parent: string, name: string) => openEntry('project/clone', name ? { url, parent, name } : { url, parent }), []);
  const createProject = useCallback((name: string, parent: string, git: boolean) => openEntry('project/create', { name, parent, git }), []);
  async function openEntry(action: string, input: object) {
    try {
      const opened = await api<{ id: string; root: string }>(action, input);
      // The same project can be reached through different paths (worktrees, symlinks); the id decides.
      const existing = entriesRef.current.find(entry => entry.id === opened.id || entry.root === opened.root);
      if (existing) setActiveRoot(existing.root);
      else { commit([...entriesRef.current, { root: opened.root, id: opened.id }]); setActiveRoot(opened.root); }
      setPicker(false);
      void api<Recent[]>('recent').then(setRecent).catch(() => {});
      if ('Notification' in window && Notification.permission === 'default' && entriesRef.current.length > 1) void Notification.requestPermission();
    } catch (cause) { report(cause); }
  }
  const closeProject = useCallback(async (root: string) => {
    const handle = handles.current.get(root); if (!handle) return;
    setActiveRoot(root); // the confirmation dialogs belong to the project, so it must be on screen
    await new Promise(resolve => setTimeout(resolve, 0));
    let closed = false;
    try { closed = await handle.requestClose(); } catch (cause) { report(cause); }
    if (!closed) return;
    const list = entriesRef.current, index = list.findIndex(entry => entry.root === root), rest = list.filter(entry => entry.root !== root);
    commit(rest); setStatus(all => { const { [root]: _gone, ...others } = all; return others; });
    setActiveRoot(rest[Math.min(index, rest.length - 1)]?.root ?? '');
    void api<Recent[]>('recent').then(setRecent).catch(() => {});
  }, [report]);
  const actions = useRef({ select: (_index: number) => {}, cycle: (_step: number) => {}, close: () => {}, add: () => {}, toggle: () => {}, settings: () => {}, tutorial: () => {} });
  actions.current = {
    select: index => { const entry = entriesRef.current[index === 8 ? entriesRef.current.length - 1 : index]; if (entry) setActiveRoot(entry.root); },
    cycle: step => { const list = entriesRef.current; if (list.length > 1) setActiveRoot(list[(Math.max(0, list.findIndex(entry => entry.root === current)) + step + list.length) % list.length].root); },
    close: () => void closeProject(current), add: () => setPicker(true), toggle: () => setCompact(value => !value), settings: () => setSettingsOpen('default'),
    tutorial: () => setSettings(previous => ({ ...previous, onboarded: false }))
  };
  // Stable identity, so a project that is not being shown does not re-render when another changes.
  const projectCommands = useMemo<Command[]>(() => [
    { id: 'addProject', label: '프로젝트 열기…', run: () => actions.current.add() },
    { id: 'toggleProjects', label: '프로젝트 사이드바 접기/펼치기', run: () => actions.current.toggle() },
    { id: 'settings', label: '설정 열기', run: () => actions.current.settings() },
    { id: 'closeProject', label: '프로젝트 닫기', run: () => actions.current.close() },
    { id: 'tutorial', label: '튜토리얼 다시 보기', run: () => actions.current.tutorial() },
    { id: 'nextProject', label: '다음 프로젝트', run: () => actions.current.cycle(1) },
    { id: 'prevProject', label: '이전 프로젝트', run: () => actions.current.cycle(-1) },
    ...Array.from({ length: 9 }, (_, index) => ({ id: `project${index + 1}`, label: `${index + 1}번 프로젝트`, hidden: true, run: () => actions.current.select(index) }))
  ], []);
  const onAddProject = useCallback(() => setPicker(true), []);
  const onOpenSettings = useCallback(() => setSettingsOpen('default'), []);
  const onOpenPlugins = useCallback(() => setSettingsOpen('plugins'), []);
  useEffect(() => onPluginsOpen(onOpenPlugins), [onOpenPlugins]);

  // Dragging only moves a CSS variable; the width is committed to the settings (and saved) once the pointer is released.
  const clampWidth = (value: number) => Math.max(160, Math.min(480, Math.round(value)));
  const setWidth = (value: number) => setSettings(previous => previous.sidebarWidth === value ? previous : { ...previous, sidebarWidth: value });
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault(); const handle = event.currentTarget, startX = event.clientX, startWidth = settings.sidebarWidth; let width = startWidth;
    handle.setPointerCapture(event.pointerId); handle.classList.add('dragging'); document.body.classList.add('resizing');
    const move = (e: PointerEvent) => { width = clampWidth(startWidth + e.clientX - startX); shell.current?.style.setProperty('--rail-w', `${width}px`); };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); handle.classList.remove('dragging'); document.body.classList.remove('resizing'); setWidth(width); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  };

  const open = new Set(entries.map(entry => entry.root));
  const picking: PickerProps = { ready, recent, open, errorScope: current || 'shell', onOpen: addProject, onCreate: createProject, onClone: cloneProject, onPin: (root, pinned) => void api<Recent[]>('recent/pin', { root, pinned }).then(setRecent).catch(report), onRemove: async root => setRecent(await api<Recent[]>('recent/remove', { root })) };
  // Shown on first run (and again on request) as a full-screen practice copy of the app over the real screen, which stays inert until it
  // fades away onto it; finishing or skipping saves `onboarded` with the other settings.
  const touring = booted && !settings.onboarded;
  // A replay (book button, palette, settings) skips the theme and font screen; only a user who was never onboarded sees it.
  const onboardedOnce = useRef(false); if (settings.onboarded) onboardedOnce.current = true;
  // Ending the tour plays the launch animation over it; the tour is removed once the splash has covered it.
  const finishTour = () => { setSplash(true); setTimeout(() => setSettings(previous => ({ ...previous, onboarded: true })), 450); };
  const tutorial = <>{touring && <Tutorial settings={settings} onSettings={setSettings} setup={!onboardedOnce.current} onDone={finishTour} />}{splash && <Splash onDone={() => setSplash(false)} />}</>;
  if (!entries.length) return booted ? <><main className="welcome" inert={touring}><PickerCard {...picking} /></main><ErrorCorner scope="shell" />{tutorial}</> : <div className="shell">{bootError && <div role="alert" className="boot-error"><b>시작하지 못했습니다</b><p>{bootError}</p><button type="button" onClick={() => location.reload()}>다시 시도</button></div>}</div>;

  return <><div ref={shell} inert={touring} className={`shell ${compact ? 'compact' : ''}`} style={{ '--rail-w': compact ? '52px' : `${settings.sidebarWidth}px` } as React.CSSProperties}>
    <nav className="projects" aria-label="프로젝트와 탭">
      <div className="projects-head">
        {!compact && <strong>프로젝트</strong>}<span className="spacer" />
        {!compact && <IconButton icon="folderPlus" label="프로젝트 열기" keys={showAppKey(settings.appKeys, 'addProject')} onClick={onAddProject} />}
        <IconButton icon={compact ? 'chevronsRight' : 'chevronsLeft'} label={`사이드바 ${compact ? '펼치기' : '접기'}`} keys={showAppKey(settings.appKeys, 'toggleProjects')} onClick={() => setCompact(value => !value)} />
      </div>
      <div className="folders" role="tree">
        {entries.map((entry, index) => {
          const item = status[entry.root] || idle, name = item.name || shortName(entry.root), selected = entry.root === current, open = !folded.has(entry.root);
          const asking = item.tabs.some(tab => tab.asking);
          const owner = () => handles.current.get(entry.root);
          const hint = `${name}\n${entry.root}\n${showAppKey(settings.appKeys, `project${Math.min(index + 1, 9)}`)}`;
          const projectDnd = {
            draggable: true,
            onDragStart: (event: React.DragEvent<HTMLElement>) => { if ((event.target as HTMLElement).closest('button')) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', `project:${entry.root}`); setProjectDrag(entry.root); },
            onDragEnd: () => { setProjectDrag(''); setProjectDrop(null); },
            onDragOver: (event: React.DragEvent<HTMLElement>) => {
              if (!projectDrag || projectDrag === entry.root) return;
              event.preventDefault(); event.dataTransfer.dropEffect = 'move';
              const box = event.currentTarget.getBoundingClientRect(), after = event.clientY >= box.top + box.height / 2;
              setProjectDrop(previous => previous?.root === entry.root && previous.after === after ? previous : { root: entry.root, after });
            },
            onDrop: (event: React.DragEvent<HTMLElement>) => { if (!projectDrag || projectDrag === entry.root) return; event.preventDefault(); event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); moveProject(projectDrag, entry.root, event.clientY >= box.top + box.height / 2); setProjectDrag(''); setProjectDrop(null); }
          };
          if (compact) return <div key={entry.root} role="treeitem" aria-selected={selected} tabIndex={0} className={`rail-item ${selected ? 'active' : ''} ${projectDrag === entry.root ? 'project-dragging' : ''} ${projectDrop?.root === entry.root ? `project-drop-${projectDrop.after ? 'after' : 'before'}` : ''}`} title={hint} {...projectDnd}
            onClick={() => setActiveRoot(entry.root)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setActiveRoot(entry.root); }} onAuxClick={event => { if (event.button === 1) void closeProject(entry.root); }}>
            <span className="rail-initial">{initials(name)}</span>
            {asking ? <span className="question-alert rail-alert" role="img" aria-label="응답 필요"><Icon name="alert" size={15} /></span> : item.attention > 0 ? <i className="rail-dot attn" aria-label="확인 필요" /> : null}
          </div>;
          return <section key={entry.root} className={`folder ${selected ? 'active' : ''} ${projectDrag === entry.root ? 'project-dragging' : ''} ${projectDrop?.root === entry.root ? `project-drop-${projectDrop.after ? 'after' : 'before'}` : ''}`}>
            <div role="treeitem" aria-expanded={open} aria-selected={selected} tabIndex={0} className="folder-head" title={hint} {...projectDnd}
              onClick={() => setActiveRoot(entry.root)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setActiveRoot(entry.root); }} onAuxClick={event => { if (event.button === 1) void closeProject(entry.root); }}>
              <button className="folder-chevron" aria-label={open ? `${name} 접기` : `${name} 펼치기`} onClick={event => { event.stopPropagation(); setFolded(previous => { const next = new Set(previous); if (!next.delete(entry.root)) next.add(entry.root); return next; }); }}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} /></button>
              <span className="folder-icon"><Icon name="folder" size={15} /></span>
              <span className="folder-name">{name}</span>
              {asking ? <span className="question-alert" role="img" aria-label="응답 필요" title="질문 또는 승인을 처리해 주세요"><Icon name="alert" size={15} /></span> : item.attention > 0 && <i className="attn-dot" aria-label="확인 필요" title={`확인이 필요한 터미널 ${item.attention}개`} />}
              <span className="folder-actions">
                <button aria-label={`${name}에 새 탭`} title={`새 터미널 탭 (${showAppKey(settings.appKeys, 'newTab')})`} onClick={event => { event.stopPropagation(); setActiveRoot(entry.root); owner()?.newTab(); }}><Icon name="plus" size={14} /></button>
                <button aria-label={`${name} 프로젝트 닫기`} title={`프로젝트 닫기 (${showAppKey(settings.appKeys, 'closeProject')})`} onClick={event => { event.stopPropagation(); void closeProject(entry.root); }}><Icon name="x" size={14} /></button>
              </span>
            </div>
            {open && <ul className="folder-tabs" role="group" data-dragging={drag?.root === entry.root ? '' : undefined}>
              {item.tabs.map((tab, tabIndex) => {
                const on = selected && tab.id === item.activeTab;
                const select = () => { setActiveRoot(entry.root); owner()?.selectTab(tab.id); };
                const openMenu = (event: React.MouseEvent | React.KeyboardEvent, paneId?: string) => {
                  event.preventDefault(); event.stopPropagation();
                  const box = (event.currentTarget as HTMLElement).getBoundingClientRect(), mouse = 'clientX' in event && event.clientX ? event : null;
                  setMenu({ x: mouse ? mouse.clientX : box.left + 24, y: mouse ? mouse.clientY : box.bottom, root: entry.root, tabId: tab.id, paneId });
                };
                // Keys on a focused sidebar row: F2 rename, Delete close, Alt+↑/↓ move, Shift+F10 / menu key opens the menu.
                const rowKeys = (event: React.KeyboardEvent, onEnter: () => void, onDelete: () => void, paneId?: string) => {
                  const neighbour = item.tabs[tabIndex + (event.key === 'ArrowUp' ? -1 : 1)];
                  if (event.key === 'Enter' || event.key === ' ') onEnter();
                  else if (event.key === 'F2') owner()?.renameTab(tab.id);
                  else if (event.key === 'Delete') onDelete();
                  else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && neighbour) owner()?.moveTab(tab.id, neighbour.id, event.key === 'ArrowDown');
                  else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event, paneId);
                  else return;
                  event.preventDefault();
                };
                const close = <button className="ptab-close" aria-label={`${tab.label} 탭 닫기`} title="탭 닫기" onClick={event => { event.stopPropagation(); owner()?.closeTab(tab.id); }}><Icon name="x" size={12} /></button>;
                // Edges of a row reorder (a line shows where); the middle merges, labelled so it is never a surprise.
                const dragging = drag?.root === entry.root && drag.id === tab.id && !drag.pane, mode = dropAt?.id === tab.id && drag?.root === entry.root ? dropAt.mode : null;
                const dropHint = mode === 'merge' && <span className="drop-hint" aria-hidden="true">{drag?.pane ? '이 탭으로 옮기기' : '분할로 합치기'}</span>;
                const startDrag = (event: React.DragEvent, pane?: string) => {
                  if (event.target instanceof Element && event.target.closest('button')) { event.preventDefault(); return; }
                  event.stopPropagation(); setMenu(null);
                  event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', pane || tab.id);
                  setDrag({ root: entry.root, id: tab.id, ...(pane ? { pane } : {}) });
                };
                const endDrag = () => { setDrag(null); setDropAt(null); };
                const dnd = {
                  draggable: true,
                  onDragStart: (event: React.DragEvent) => startDrag(event),
                  onDragEnd: endDrag,
                  onDragOver: (event: React.DragEvent<HTMLLIElement>) => {
                    if (!drag || drag.root !== entry.root) return;
                    if (drag.id === tab.id) { event.dataTransfer.dropEffect = 'none'; setDropAt(null); return; }
                    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
                    const next = tabDropMode(event, drag.id, tab.id);
                    setDropAt(previous => previous?.id === tab.id && previous.mode === next ? previous : { id: tab.id, mode: next });
                  },
                  onDrop: (event: React.DragEvent) => {
                    event.preventDefault(); event.stopPropagation();
                    if (drag && drag.root === entry.root && drag.id !== tab.id) {
                      const next = tabDropMode(event, drag.id, tab.id);
                      if (drag.pane) owner()?.movePane(drag.id, drag.pane, tab.id, next);
                      else if (next === 'merge') owner()?.mergeTabs(drag.id, tab.id);
                      else owner()?.moveTab(drag.id, tab.id, next === 'after');
                    }
                    endDrag();
                  }
                };
                const state = (pane: { asking: boolean; attention: boolean; working: boolean }) => pane.asking ? 'attention' : pane.attention ? 'done' : pane.working ? 'working' : undefined;
                const trail = (pane: { id: string; asking: boolean; attention: boolean; working: boolean }) => { if (state(pane) !== 'working') return null; const h = [...pane.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0); /* per-row lap time and phase, stable across renders */ return <svg className="agent-trail" aria-hidden="true" style={{ '--lap': `${3.8 + (h % 5) * .35}s`, '--phase': `${-(h % 7) * .7}s` } as React.CSSProperties}>{TRAIL.map(([len, opacity]) => <rect key={len} pathLength={100} strokeDasharray={`${len} ${100 - len}`} strokeOpacity={opacity} style={{ '--from': len, '--to': len - 100 } as React.CSSProperties} />)}</svg>; };
                const alert = (pane: { asking: boolean; attention: boolean }) => pane.asking ? <span className="question-alert" role="img" aria-label="응답 필요"><Icon name="alert" size={15} /></span> : pane.attention && <i className="attn-dot" aria-label="확인 필요" />;
                if (!tab.panes.length) return <li key={tab.id} role="none" className={`${dragging ? 'dragging' : ''} ${mode ? `drop-${mode}` : ''}`} {...dnd}>
                  <div role="treeitem" aria-selected={on} tabIndex={0} className={`folder-tab ${on ? 'active' : ''}`} data-kind={tab.kind} data-agent={tab.agent} data-agent-state={state(tab)} title={`${tab.label}\n끌어서 순서 변경 · 다른 탭 가운데에 놓으면 분할로 합치기\n우클릭: 메뉴 · 더블클릭/F2: 이름 바꾸기`}
                    onClick={select} onKeyDown={event => rowKeys(event, select, () => owner()?.closeTab(tab.id))} onContextMenu={event => openMenu(event)}
                    onDoubleClick={() => owner()?.renameTab(tab.id)} onAuxClick={event => { if (event.button === 1) owner()?.closeTab(tab.id); }}>
                    <span className="folder-tab-mark" aria-hidden="true"><Icon name={tab.kind === 'launcher' ? 'plus' : tab.agent || (tab.kind === 'chat' ? 'claude' : 'terminal')} size={13} />{tab.kind === 'chat' && <span className="mark-chat"><Icon name="chat" size={9} /></span>}</span><span className="folder-tab-label">{tab.label}</span>{trail(tab)}
                    {!on && settings.cacheTimer && tab.cache && <CacheTimer cache={tab.cache} working={tab.working} warn={settings.cacheWarn} />}
                    {alert(tab)}{close}
                  </div>{dropHint}</li>;
                // A split tab: a header that drags the whole tab, and one row per terminal that drags just that terminal.
                return <li key={tab.id} role="none" className={`folder-group ${on ? 'active' : ''} ${dragging ? 'dragging' : ''} ${mode ? `drop-${mode}` : ''}`} {...dnd}
                  onAuxClick={event => { if (event.button === 1) owner()?.closeTab(tab.id); }}>
                  <div role="treeitem" aria-selected={on} aria-expanded tabIndex={0} className="group-head" title={`${tab.label} · 분할 ${tab.panes.length}개\n여기를 끌면 탭 전체 이동 · 아래 터미널을 끌면 그 터미널만 이동\n우클릭: 메뉴 · 더블클릭/F2: 이름 바꾸기`}
                    onClick={select} onKeyDown={event => rowKeys(event, select, () => owner()?.closeTab(tab.id))} onContextMenu={event => openMenu(event)} onDoubleClick={() => owner()?.renameTab(tab.id)}>
                    <span className="folder-tab-mark" aria-hidden="true"><Icon name="layers" size={13} /></span><span className="folder-tab-label">{tab.label}</span><small className="group-count">{tab.panes.length}</small>{close}
                  </div>
                  <ul className="group-panes" role="group" aria-label={`분할 ${tab.panes.length}개`}>
                    {tab.panes.map(pane => { const focus = () => { setActiveRoot(entry.root); owner()?.selectPane(tab.id, pane.id); }; return <li key={pane.id} role="treeitem" aria-selected={on && pane.focused} tabIndex={0} className={`group-pane ${on && pane.focused ? 'focused' : ''} ${drag?.pane === pane.id ? 'dragging' : ''}`} data-kind={pane.kind === 'chat' ? 'chat' : undefined} data-agent={pane.agent} data-agent-state={state(pane)} data-pane-id={pane.id}
                      title={`${pane.label}\n끌어서 다른 탭으로 옮기거나 탭 사이·아래 빈칸에 놓아 새 탭으로 분리\n우클릭: 메뉴`}
                      draggable onDragStart={event => startDrag(event, pane.id)} onDragEnd={endDrag}
                      onClick={focus} onKeyDown={event => rowKeys(event, focus, () => owner()?.closePane(pane.id), pane.id)} onContextMenu={event => openMenu(event, pane.id)}>
                      <span className="folder-tab-mark" aria-hidden="true"><Icon name={pane.kind === 'launcher' ? 'plus' : pane.kind === 'editor' ? 'code' : pane.agent || (pane.kind === 'chat' ? 'claude' : 'terminal')} size={13} />{pane.kind === 'chat' && <span className="mark-chat"><Icon name="chat" size={9} /></span>}</span><span className="folder-tab-label">{pane.label}</span>{trail(pane)}
                      {!(on && pane.focused) && pane.cache && <CacheTimer cache={pane.cache} working={pane.working} />}
                      {alert(pane)}
                      <button className="ptab-close" aria-label={`${pane.label} 닫기`} title="이 터미널 닫기" onClick={event => { event.stopPropagation(); owner()?.closePane(pane.id); }}><Icon name="x" size={12} /></button>
                    </li>; })}
                  </ul>{dropHint}
                </li>;
              })}
              {drag?.root === entry.root && drag.pane && <li className="pane-drop-zone" role="presentation"
                onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
                onDrop={event => { event.preventDefault(); event.stopPropagation(); owner()?.movePane(drag.id, drag.pane!, undefined, 'after'); setDrag(null); setDropAt(null); }}>
                <Icon name="plus" size={13} />여기에 놓으면 새 탭으로 분리
              </li>}
              {item.loaded && !item.tabs.length && <li className="folder-empty">탭 없음 — <button onClick={() => owner()?.newTab()}>새 터미널</button></li>}
            </ul>}
          </section>;
        })}
      </div>
      <div className="projects-foot">
        {compact && <IconButton icon="folderPlus" label="프로젝트 열기" keys={showAppKey(settings.appKeys, 'addProject')} onClick={onAddProject} />}
        <IconButton icon="settings" label="설정" keys={showAppKey(settings.appKeys, 'settings')} onClick={onOpenSettings} />
        <span className="spacer" /><AppVersion /><span className="spacer" />
        <IconButton icon="book" label="튜토리얼 보기" onClick={() => actions.current.tutorial()} />
      </div>
      {!compact && <div className="projects-resizer" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="사이드바 너비 조절 (더블클릭: 기본값)" aria-valuemin={160} aria-valuemax={480} aria-valuenow={settings.sidebarWidth}
        onPointerDown={startResize} onDoubleClick={() => setWidth(252)}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(clampWidth(settings.sidebarWidth + (event.key === 'ArrowLeft' ? -16 : 16))); } }} />}
    </nav>
    <div className="ws-stack">
      {entries.map(entry => <Workspace key={entry.root} ref={handle => { if (handle) handles.current.set(entry.root, handle); else handles.current.delete(entry.root); }}
        root={entry.root} active={entry.root === current} hub={hub} connection={connection} settings={settings} setSettings={setSettings} projectCommands={projectCommands}
        onLegacySettings={onLegacySettings} onStatus={onStatus} onFailed={onFailed} onAddProject={onAddProject} onOpenSettings={onOpenSettings} onOpenPlugins={onOpenPlugins} onAgentAlert={onAgentAlert} />)}
    </div>
    {menu && <TabMenu target={menu} tabs={status[menu.root]?.tabs ?? []} handle={handles.current.get(menu.root)} onClose={() => setMenu(null)} />}
    {settingsOpen && <SettingsModal key={settingsOpen} initialSection={settingsOpen === 'plugins' ? 'plugins' : undefined} settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />}
    {picker && <Modal className="project-modal" labelledBy="picker-title" onClose={() => setPicker(false)}><PickerCard {...picking} onClose={() => setPicker(false)} /></Modal>}
  </div>{tutorial}</>;
}
// xterm and Monaco measure glyphs once when they are created, so the bundled fonts are loaded (local files, so quick) before the first render.
const fontsReady = Promise.all([['Inter Variable', 'Aa'], ['Noto Sans KR Variable', '가'], ['JetBrains Mono Variable', 'Aa']].map(([font, sample]) => document.fonts.load(`13px "${font}"`, sample).catch(() => [])));
void Promise.race([fontsReady, new Promise(resolve => setTimeout(resolve, 1500))]).then(() => createRoot(document.getElementById('root')!).render(<Shell />));
