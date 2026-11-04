import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, basename } from './api';
import { defaultSettings, migrateSettings, type Settings } from './Editor';
import { playSound } from './sound';
import { Icon, IconButton, type IconName } from './Icon';
import { SettingsModal } from './Settings';
import { Modal } from './views';
import { Workspace, showKeys, type Command, type Hub, type SystemInfo, type AgentAlert, type WorkspaceHandle, type WorkspaceStatus } from './Workspace';
import '@material-symbols/font-400/outlined.css';
import './style.css';

type Entry = { root: string; id: string };
type Recent = { id?: string; root: string; pinned?: boolean };
type TabDropMode = 'before' | 'after' | 'merge';
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

type PickerProps = { ready: boolean; recent: Recent[]; open: Set<string>; error: string; onOpen(path: string): Promise<void>; onCreate(name: string, parent: string, git: boolean): Promise<void>; onClone(url: string, parent: string, name: string): Promise<void>; onPin(root: string, pinned: boolean): void; onRemove(root: string): Promise<void>; onDismissError(): void; onClose?(): void };
type PickerTab = 'open' | 'create' | 'clone';
const pickerTabs: { id: PickerTab; label: string; icon: IconName }[] = [
  { id: 'open', label: '기존 프로젝트 추가', icon: 'folder' },
  { id: 'create', label: '새 프로젝트 생성', icon: 'folderPlus' },
  { id: 'clone', label: 'GitHub에서 가져오기', icon: 'branch' }
];
// Where a create/clone will land, shown before it happens; the separator follows whatever the parent path already uses.
const joinPath = (parent: string, name: string) => !parent || !name ? '' : parent.replace(/[\\/]+$/, '') + (parent.includes('\\') ? '\\' : '/') + name;
const repoName = (url: string) => url.trim().replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop() || '';
// Paths are only ever chosen in the OS folder dialog, never typed: the desktop app uses Electron's, the browser asks the local server to open one.
type DesktopBridge = { pickFolder(options?: { title?: string; defaultPath?: string }): Promise<string | null> };
async function chooseFolder(title: string, defaultPath: string) {
  const desktop = (window as unknown as { adeDesktop?: DesktopBridge }).adeDesktop;
  if (desktop) return desktop.pickFolder({ title, defaultPath: defaultPath || undefined });
  return (await api<{ path: string | null }>('dialog/folder', { title, defaultPath })).path;
}
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
function PickerCard({ ready, recent, open, error, onOpen, onCreate, onClone, onPin, onRemove, onDismissError, onClose }: PickerProps) {
  const [tab, setTab] = useState<PickerTab>(() => { try { const saved = localStorage.getItem('ade-picker-tab'); return pickerTabs.some(item => item.id === saved) ? saved as PickerTab : 'open'; } catch { return 'open'; } });
  const [path, setPath] = useState(''), [url, setUrl] = useState(''), [parent, setParent] = useState(''), [name, setName] = useState(''), [folder, setFolder] = useState(''), [git, setGit] = useState(true), [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(''), [deleting, setDeleting] = useState(false), [removeError, setRemoveError] = useState(''), [pickError, setPickError] = useState('');
  const tabRefs = useRef<Partial<Record<PickerTab, HTMLButtonElement | null>>>({});
  useEffect(() => { try { localStorage.setItem('ade-picker-tab', tab); } catch {} }, [tab]);
  useEffect(() => { if (tab !== 'open' && !parent) void api<{ path: string }>('picker/parent').then(home => setParent(previous => previous || home.path)).catch(() => {}); }, [tab, parent]);
  const run = (work: () => Promise<void>) => { setBusy(true); void work().finally(() => setBusy(false)); };
  const fieldState = { disabled: !ready || busy, onError: setPickError };
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
    <button type="button" className="recent-remove" aria-label={`${shortName(item.root)} 최근 프로젝트에서 삭제`} title="최근 프로젝트에서 삭제" disabled={!ready} onClick={() => { setRemoveError(''); setRemoving(item.root); }}><Icon name="x" size={14} /></button></div>; };
  const submitLabel = tab === 'open' ? (busy ? '여는 중…' : '열기') : tab === 'create' ? (busy ? '만드는 중…' : '만들고 열기') : (busy ? '클론 중…' : '클론하고 열기');
  const createTarget = joinPath(parent.trim(), name.trim()), cloneTarget = joinPath(parent.trim(), folder.trim() || repoName(url));
  return <><div className="welcome-card picker"><h1 id="picker-title" className="picker-title">프로젝트 추가</h1>
    {error && <div role="alert" className="error">{error}<button onClick={onDismissError}>닫기</button></div>}
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
          {pickError && <div role="alert" className="error">{pickError}<button type="button" onClick={() => setPickError('')}>닫기</button></div>}
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
      {removeError && <p role="alert" className="error">{removeError}</p>}
      <div className="actions"><button autoFocus disabled={deleting} onClick={() => setRemoving('')}>취소</button>
        <button disabled={deleting} onClick={() => {
          setDeleting(true); setRemoveError('');
          void onRemove(removing).then(() => setRemoving('')).catch(cause => setRemoveError(cause instanceof Error ? cause.message : String(cause))).finally(() => setDeleting(false));
        }}>{deleting ? '삭제 중…' : '삭제'}</button></div>
    </Modal>}</>;
}

function Shell() {
  const [ready, setReady] = useState(false), [booted, setBooted] = useState(false), [error, setError] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]), [activeRoot, setActiveRoot] = useState('');
  const [status, setStatus] = useState<Record<string, WorkspaceStatus>>({});
  const [recent, setRecent] = useState<Recent[]>([]), [picker, setPicker] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaultSettings), [settingsOpen, setSettingsOpen] = useState(false), [system, setSystem] = useState<SystemInfo | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  // Sidebar display is a per-browser preference: expanded folders with tabs, or a narrow strip of initials.
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem('ade-sidebar-compact') === '1'; } catch { return false; } });
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ root: string; id: string; pane?: string } | null>(null), [dropAt, setDropAt] = useState<{ id: string; mode: 'before' | 'after' | 'merge' } | null>(null);
  const dragSource = useRef<{ root: string; id: string; pane?: string; blocked: boolean; pointerId: number } | null>(null);
  useEffect(() => {
    const reset = (event: PointerEvent) => {
      const source = dragSource.current;
      if (!source || source.pointerId !== event.pointerId) return;
      dragSource.current = null;
    };
    window.addEventListener('pointerup', reset);
    window.addEventListener('pointercancel', reset);
    return () => { window.removeEventListener('pointerup', reset); window.removeEventListener('pointercancel', reset); };
  }, []);
  const [projectDrag, setProjectDrag] = useState(''), [projectDrop, setProjectDrop] = useState<{ root: string; after: boolean } | null>(null);
  useEffect(() => { try { localStorage.setItem('ade-sidebar-compact', compact ? '1' : '0'); } catch { /* storage can be blocked */ } }, [compact]);
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
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);

  // ---- boot: sign in, then reopen the projects that were open last time ----
  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    history.replaceState(null, '', location.pathname);
    api('auth', { token }).then(async () => {
      const [saved, list] = await Promise.all([api<{ openProjects: Entry[]; activeProjectId: string; settings: Settings | null }>('app/state'), api<Recent[]>('recent')]);
      setRecent(list);
      globalSettings.current = Boolean(saved.settings);
      if (saved.settings) setSettings(migrateSettings(saved.settings));
      const open: Entry[] = saved.openProjects || [], active = open.find(entry => entry.id === saved.activeProjectId)?.root ?? open[0]?.root ?? '';
      commit(open); setActiveRoot(active); setReady(true); setBooted(true);
    }).catch(report);
  }, [report]);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; }, [settings.theme]);
  // CPU and memory are only sampled while the status bar shows them.
  const wantsSystem = settings.statusItems.includes('cpu') || settings.statusItems.includes('memory');
  useEffect(() => {
    if (!ready || !wantsSystem) { setSystem(null); return; }
    let stopped = false;
    const tick = () => void api<SystemInfo>('system/info').then(value => { if (!stopped) setSystem(value); }).catch(() => {});
    tick(); const timer = setInterval(tick, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [ready, wantsSystem]);

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
    const wanted = !alert.looking && (alert.kind === 'done' ? settings.notifyDone : settings.notifyApproval);
    if (!wanted && !settings.notifySound) return;
    const project = statusRef.current[root]?.name || shortName(root), agent = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor CLI' }[alert.agent];
    const title = `${project} · ${agent} ${alert.kind === 'done' ? '작업 멈춤' : '입력 요청'}`;
    if (wanted && 'Notification' in window) {
      if (Notification.permission === 'default') void Notification.requestPermission();
      if (Notification.permission === 'granted') {
        const popup = new Notification(title, { body: `${alert.name} — ${alert.kind === 'done' ? '완료되었거나 입력을 기다리고 있습니다.' : '확인이 필요합니다.'}`, tag: `ade:agent:${alert.paneId}` });
        popup.onclick = () => { window.focus(); setActiveRoot(root); handles.current.get(root)?.selectPane(alert.tabId, alert.paneId); popup.close(); };
      }
    }
    if (settings.notifySound) playSound(alert.kind === 'done' ? settings.soundDone : settings.soundAttention, settings.soundVolume);
  }, [settings.notifyDone, settings.notifyApproval, settings.notifySound, settings.soundDone, settings.soundAttention, settings.soundVolume]);

  // ---- project list ----
  const addProject = useCallback((path: string) => openEntry('project/open', { path }), []);
  const cloneProject = useCallback((url: string, parent: string, name: string) => openEntry('project/clone', name ? { url, parent, name } : { url, parent }), []);
  const createProject = useCallback((name: string, parent: string, git: boolean) => openEntry('project/create', { name, parent, git }), []);
  async function openEntry(action: string, input: object) {
    setError('');
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
  const actions = useRef({ select: (_index: number) => {}, cycle: (_step: number) => {}, close: () => {}, add: () => {}, toggle: () => {}, settings: () => {} });
  actions.current = {
    select: index => { const entry = entriesRef.current[index === 8 ? entriesRef.current.length - 1 : index]; if (entry) setActiveRoot(entry.root); },
    cycle: step => { const list = entriesRef.current; if (list.length > 1) setActiveRoot(list[(Math.max(0, list.findIndex(entry => entry.root === current)) + step + list.length) % list.length].root); },
    close: () => void closeProject(current), add: () => setPicker(true), toggle: () => setCompact(value => !value), settings: () => setSettingsOpen(true)
  };
  // Stable identity, so a project that is not being shown does not re-render when another changes.
  const projectCommands = useMemo<Command[]>(() => [
    { id: 'addProject', label: '프로젝트 열기…', keys: 'mod+alt+o', run: () => actions.current.add() },
    { id: 'toggleProjects', label: '프로젝트 사이드바 접기/펼치기', keys: 'mod+alt+b', run: () => actions.current.toggle() },
    { id: 'settings', label: '설정 열기', keys: 'mod+,', run: () => actions.current.settings() },
    { id: 'closeProject', label: '프로젝트 닫기', keys: 'mod+alt+w', run: () => actions.current.close() },
    { id: 'nextProject', label: '다음 프로젝트', keys: 'mod+alt+]', run: () => actions.current.cycle(1) },
    { id: 'prevProject', label: '이전 프로젝트', keys: 'mod+alt+[', run: () => actions.current.cycle(-1) },
    ...Array.from({ length: 9 }, (_, index) => ({ id: `project${index + 1}`, label: `${index + 1}번 프로젝트`, keys: `mod+alt+${index + 1}`, hidden: true, run: () => actions.current.select(index) }))
  ], []);
  const onAddProject = useCallback(() => setPicker(true), []);
  const onOpenSettings = useCallback(() => setSettingsOpen(true), []);

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

  const shortcuts = [
    { label: '새 터미널 탭', keys: showKeys('mod+shift+t') }, { label: '탭 닫기', keys: showKeys('mod+shift+w') }, { label: '다음/이전 탭', keys: `${showKeys('alt+]')} / ${showKeys('alt+[')}` },
    { label: '탭 번호로 이동', keys: showKeys('alt+1') + '…9' }, { label: '좌우 분할', keys: 'Ctrl+D' }, { label: '상하 분할', keys: 'Ctrl+Shift+D' }, { label: 'Pane 최대화', keys: showKeys('mod+shift+enter') },
    { label: 'Pane 이동', keys: showKeys('alt+arrowleft') + ' / ' + showKeys('alt+arrowright') }, { label: '변경사항(Diff) 패널', keys: showKeys('mod+shift+g') },
    { label: '명령 팔레트', keys: showKeys('mod+shift+p') }, { label: '프로젝트 열기', keys: showKeys('mod+alt+o') }, { label: '사이드바 접기/펼치기', keys: showKeys('mod+alt+b') },
    { label: '다음/이전 프로젝트', keys: `${showKeys('mod+alt+]')} / ${showKeys('mod+alt+[')}` }, { label: '프로젝트 번호로 이동', keys: showKeys('mod+alt+1') + '…9' }, { label: '설정', keys: showKeys('mod+,') }
  ];
  const open = new Set(entries.map(entry => entry.root));
  const picking: PickerProps = { ready, recent, open, error, onOpen: addProject, onCreate: createProject, onClone: cloneProject, onPin: (root, pinned) => void api<Recent[]>('recent/pin', { root, pinned }).then(setRecent).catch(report), onRemove: async root => setRecent(await api<Recent[]>('recent/remove', { root })), onDismissError: () => setError('') };
  if (!entries.length) return booted ? <main className="welcome"><PickerCard {...picking} /></main> : <div className="shell" />;

  return <div ref={shell} className={`shell ${compact ? 'compact' : ''}`} style={{ '--rail-w': compact ? '52px' : `${settings.sidebarWidth}px` } as React.CSSProperties}>
    <nav className="projects" aria-label="프로젝트와 탭">
      <div className="projects-head">
        {!compact && <strong>프로젝트</strong>}<span className="spacer" />
        {!compact && <IconButton icon="folderPlus" label="프로젝트 열기" keys={showKeys('mod+alt+o')} onClick={onAddProject} />}
        <IconButton icon={compact ? 'chevronsRight' : 'chevronsLeft'} label={`사이드바 ${compact ? '펼치기' : '접기'}`} keys={showKeys('mod+alt+b')} onClick={() => setCompact(value => !value)} />
      </div>
      <div className="folders" role="tree">
        {entries.map((entry, index) => {
          const item = status[entry.root] || idle, name = item.name || shortName(entry.root), selected = entry.root === current, open = !folded.has(entry.root);
          const asking = item.tabs.some(tab => tab.asking);
          const owner = () => handles.current.get(entry.root);
          const hint = `${name}\n${entry.root}\n${showKeys(`mod+alt+${Math.min(index + 1, 9)}`)}`;
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
                <button aria-label={`${name}에 새 탭`} title={`새 터미널 탭 (${showKeys('mod+shift+t')})`} onClick={event => { event.stopPropagation(); setActiveRoot(entry.root); owner()?.newTab(); }}><Icon name="plus" size={14} /></button>
                <button aria-label={`${name} 프로젝트 닫기`} title={`프로젝트 닫기 (${showKeys('mod+alt+w')})`} onClick={event => { event.stopPropagation(); void closeProject(entry.root); }}><Icon name="x" size={14} /></button>
              </span>
            </div>
            {open && <ul className="folder-tabs" role="group" data-dragging={drag?.root === entry.root ? '' : undefined}>
              {item.tabs.map(tab => {
                const on = selected && tab.id === item.activeTab;
                const select = () => { setActiveRoot(entry.root); owner()?.selectTab(tab.id); };
                const row = <div role="treeitem" aria-selected={on} tabIndex={0} draggable className={`folder-tab ${on ? 'active' : ''}`} data-agent={tab.agent} data-agent-state={tab.asking ? 'attention' : tab.attention ? 'done' : tab.working ? 'working' : undefined} title={`${tab.label} · 더블클릭으로 이름 바꾸기`}
                  onClick={select} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') select(); }}
                  onDoubleClick={() => owner()?.renameTab(tab.id)} onAuxClick={event => { if (event.button === 1) owner()?.closeTab(tab.id); }}>
                  <span className="folder-tab-mark" aria-hidden="true"><Icon name={tab.agent || (tab.panes.length ? 'layers' : 'terminal')} size={13} /></span><span className="folder-tab-label">{tab.label}</span>
                  {tab.asking ? <span className="question-alert" role="img" aria-label="응답 필요"><Icon name="alert" size={15} /></span> : tab.attention && <i className="attn-dot" aria-label="확인 필요" />}
                  <button className="ptab-close" aria-label={`${tab.label} 탭 닫기`} title="탭 닫기" onClick={event => { event.stopPropagation(); owner()?.closeTab(tab.id); }}><Icon name="x" size={12} /></button>
                </div>;
                // Tabs can be dragged to reorder within their own project; a line shows where the tab will land.
                const dragging = drag?.root === entry.root && drag.id === tab.id && !drag.pane, over = dropAt?.id === tab.id && drag?.root === entry.root ? `drop-${dropAt.mode}` : '';
                const dnd = {
                  draggable: true,
                  onDragStart: (event: React.DragEvent) => {
                    const source = dragSource.current; dragSource.current = null;
                    if (source?.blocked || (event.target instanceof Element && event.target.closest('button'))) {
                      event.preventDefault();
                      return;
                    }
                    const pane = source?.root === entry.root && source.id === tab.id ? source.pane : undefined;
                    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', pane || tab.id);
                    if (!pane) event.dataTransfer.setDragImage(event.currentTarget as HTMLElement, 0, 0);
                    setDrag({ root: entry.root, id: tab.id, ...(pane ? { pane } : {}) });
                  },
                  onDragEnd: () => {
                    dragSource.current = null; setDrag(null); setDropAt(null);
                  },
                  onDragOver: (event: React.DragEvent<HTMLLIElement>) => {
                    if (!drag || drag.root !== entry.root) return;
                    if (drag.id === tab.id) { event.dataTransfer.dropEffect = 'none'; setDropAt(null); return; }
                    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
                    // Edges reorder; the middle of a tab merges the dragged one into it.
                    const mode = tabDropMode(event, drag.id, tab.id);
                    setDropAt(previous => previous?.id === tab.id && previous.mode === mode ? previous : { id: tab.id, mode });
                  },
                  onDrop: (event: React.DragEvent) => {
                    event.preventDefault(); event.stopPropagation();
                    if (drag && drag.root === entry.root && drag.id !== tab.id) {
                      const mode = tabDropMode(event, drag.id, tab.id);
                      if (drag.pane) owner()?.movePane(drag.id, drag.pane, tab.id, mode);
                      else if (mode === 'merge') owner()?.mergeTabs(drag.id, tab.id);
                      else owner()?.moveTab(drag.id, tab.id, mode === 'after');
                    }
                    setDrag(null); setDropAt(null);
                  }
                };
                if (!tab.panes.length) return <li key={tab.id} role="none" className={`${dragging ? 'dragging' : ''} ${over}`} {...dnd}>{row}</li>;
                // A split tab is one box holding its terminals.
                return <li key={tab.id} role="none" className={`folder-group ${on ? 'active' : ''} ${dragging ? 'dragging' : ''} ${over}`} {...dnd}
                  onPointerDownCapture={event => {
                    if (event.button !== 0 || !event.isPrimary) return;
                    const pane = event.target instanceof Element ? event.target.closest<HTMLElement>('.group-pane') : null;
                    const targetPaneId = pane?.dataset.paneId, paneId = event.shiftKey ? targetPaneId : undefined;
                    dragSource.current = { root: entry.root, id: tab.id, ...(paneId ? { pane: paneId } : {}), blocked: event.target instanceof Element && !!event.target.closest('button'), pointerId: event.pointerId };
                  }}
                  onAuxClick={event => { if (event.button === 1) owner()?.closeTab(tab.id); }}>
                  <ul className="group-panes" role="group" aria-label={`분할 ${tab.panes.length}개`}>
                    {tab.panes.map(pane => <li key={pane.id} role="treeitem" aria-selected={on && pane.focused} tabIndex={0} className={`group-pane ${on && pane.focused ? 'focused' : ''}`} data-agent={pane.agent} data-agent-state={pane.asking ? 'attention' : pane.attention ? 'done' : pane.working ? 'working' : undefined} title={`${pane.label} — Shift+드래그: 탭 목록 빈 공간에 놓아 단독 탭으로 분리`}
                      // Native drag hit-testing needs the row to be draggable before pointerdown, including its text and icons.
                      draggable data-pane-id={pane.id}
                      onClick={() => { setActiveRoot(entry.root); owner()?.selectPane(tab.id, pane.id); }}
                      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { setActiveRoot(entry.root); owner()?.selectPane(tab.id, pane.id); } }}>
                      <span className="folder-tab-mark" aria-hidden="true"><Icon name={pane.kind === 'editor' ? 'code' : pane.agent || 'terminal'} size={13} /></span><span className="folder-tab-label">{pane.label}</span>
                      {pane.asking ? <span className="question-alert" role="img" aria-label="응답 필요"><Icon name="alert" size={15} /></span> : pane.attention && <i className="attn-dot" aria-label="확인 필요" />}
                      <button className="ptab-close" aria-label={`${pane.label} 닫기`} title="이 터미널 닫기" onClick={event => { event.stopPropagation(); owner()?.closePane(pane.id); }}><Icon name="x" size={12} /></button>
                    </li>)}
                  </ul>
                </li>;
              })}
              {drag?.root === entry.root && drag.pane && <li className="pane-drop-zone" role="presentation"
                onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
                onDrop={event => { event.preventDefault(); event.stopPropagation(); owner()?.movePane(drag.id, drag.pane!, undefined, 'after'); setDrag(null); setDropAt(null); }}>
                여기에 놓으면 단독 탭으로 분리
              </li>}
              {item.loaded && !item.tabs.length && <li className="folder-empty">탭 없음 — <button onClick={() => owner()?.newTab()}>새 터미널</button></li>}
            </ul>}
          </section>;
        })}
      </div>
      <div className="projects-foot">
        {compact && <IconButton icon="folderPlus" label="프로젝트 열기" keys={showKeys('mod+alt+o')} onClick={onAddProject} />}
        <IconButton icon="settings" label="설정" keys={showKeys('mod+,')} onClick={onOpenSettings} />
        {!compact && <small className="foot-hint">{entries.length}개 프로젝트</small>}
      </div>
      {!compact && <div className="projects-resizer" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="사이드바 너비 조절 (더블클릭: 기본값)" aria-valuemin={160} aria-valuemax={480} aria-valuenow={settings.sidebarWidth}
        onPointerDown={startResize} onDoubleClick={() => setWidth(252)}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(clampWidth(settings.sidebarWidth + (event.key === 'ArrowLeft' ? -16 : 16))); } }} />}
    </nav>
    <div className="ws-stack">
      {entries.map(entry => <Workspace key={entry.root} ref={handle => { if (handle) handles.current.set(entry.root, handle); else handles.current.delete(entry.root); }}
        root={entry.root} active={entry.root === current} hub={hub} connection={connection} settings={settings} setSettings={setSettings} projectCommands={projectCommands}
        system={system} onLegacySettings={onLegacySettings} onStatus={onStatus} onFailed={onFailed} onAddProject={onAddProject} onOpenSettings={onOpenSettings} onAgentAlert={onAgentAlert} />)}
    </div>
    {error && !picker && <div role="alert" className="error shell-error">{error}<button onClick={() => setError('')}>닫기</button></div>}
    {settingsOpen && <SettingsModal settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} shortcuts={shortcuts} />}
    {picker && <Modal className="project-modal" labelledBy="picker-title" onClose={() => setPicker(false)}><PickerCard {...picking} onClose={() => setPicker(false)} /></Modal>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Shell />);
