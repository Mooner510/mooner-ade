import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { Icon, IconButton, type IconName } from './Icon';
import { copyText } from './toast';

// Mirrors snapshot() in apps/desktop/src/plugin-core.js. Turning plugins on, approving one and installing a zip are
// confirmed by the desktop app in native dialogs; these calls only start them. What a plugin shows here is plain text, never markup.
type Tone = 'ok' | 'warn' | 'error' | 'info';
type ViewAction = { id: string; label: string; primary: boolean; danger?: boolean };
// How far one setup step got. `fields`, `info`, `actions` and `qr` name the parts of the view drawn inside the step.
export type SetupStatus = 'done' | 'todo' | 'active' | 'error';
export type ViewStep = { id: string; status: SetupStatus; label?: string; detail?: string; optional?: boolean; fields: string[]; info: string[]; actions: string[]; qr?: boolean };
export type ViewList = { id: string; title: string; empty: string; items: { id: string; label: string; detail: string; tag?: { text: string; tone: Tone }; actions: ViewAction[] }[] };
export type PluginView = {
  status: { tone: Tone; text: string } | null;
  info: { label: string; value: string; mono: boolean; copy: boolean; key?: string }[];
  // `type` is how the input is drawn; the value is always a string ('true' / 'false' for a switch).
  fields: { key: string; label: string; type?: 'text' | 'select' | 'switch' | 'number'; value: string; placeholder: string; hint: string; required?: boolean; options?: { value: string; label: string }[] }[];
  actions: ViewAction[];
  qr?: { label: string; value: string } | null;
  setup?: ViewStep[];
  lists?: ViewList[];
};
// plugin.json `setup`: the guide shown even before the plugin runs.
export type ManifestStep = { id: string; label: string; detail: string; optional?: boolean };
export type UpdateMode = 'auto' | 'notify' | 'manual';
export type PluginUpdate = {
  source: { github: string; asset: string } | null; mode: UpdateMode;
  status?: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'installing' | 'error';
  current?: string; latest?: string | null; available?: boolean; checkedAt?: number | null; error?: string | null; via?: string | null; viaLabel?: string; review?: string[];
};
export type GithubAccount = {
  available: boolean; login: string | null; via: 'pat' | 'oauth' | null; machine: 'gh' | 'git' | null; machineChecked: boolean; signIn: boolean; error: string | null;
  device: { userCode: string; verifyUrl: string; expiresAt: number } | null;
};
export type PluginBadge = { text: string; tone: Tone };
export type PluginTool = { name: string; title: string; description: string; readOnly: boolean; destructive: boolean; params: { name: string; required: boolean }[]; enabled: boolean };
// The plugin's MCP server: whether the user lets agents have it, whether the plugin offers it now, and what tools/list said.
export type PluginTools = { enabled: boolean; offered: boolean; status: 'idle' | 'loading' | 'ok' | 'error'; error: string | null; checkedAt: number | null; list: PluginTool[] | null; disabled: string[] };
export type PluginInfo = {
  folder: string; id: string | null; name: string; version: string | null; description: string; hash: string | null;
  state: 'invalid' | 'new' | 'changed' | 'off' | 'starting' | 'running' | 'error' | 'stopped';
  error: string | null; terminal: boolean; mcp: string | null; mcpChatOnly?: boolean; workspace?: boolean; view: PluginView | null; badge?: PluginBadge | null;
  // A plugin that ships with the app: no approval, no "plugins on" switch, only its own on/off (`builtinEnabled`).
  builtin?: boolean; builtinEnabled?: boolean;
  commands?: string[]; envPrefix?: string | null; env?: string[]; tools?: PluginTools | null;
  setup?: ManifestStep[]; update?: PluginUpdate | null;
};
export type PluginsState = { available: boolean; problem: 'unavailable' | 'unreadable' | null; error: string | null; enabled: boolean; dir: string; plugins: PluginInfo[]; github?: GithubAccount; message?: string | null };
type PluginsBridge = {
  state(): Promise<PluginsState>; onState(listener: (state: PluginsState) => void): () => void;
  setEnabled(on: boolean): Promise<PluginsState>; setBuiltin(id: string, on: boolean): Promise<PluginsState>; rescan(): Promise<PluginsState>; approve(folder: string): Promise<PluginsState>;
  revoke(id: string, options?: { forget?: boolean }): Promise<PluginsState>; restart(id: string): Promise<PluginsState>;
  action(id: string, action: string, values: Record<string, string>, item?: string): Promise<PluginsState>; openFolder(): Promise<PluginsState>;
  setMcp(id: string, change: { tool?: string; enabled: boolean }): Promise<PluginsState>; refreshTools(id: string): Promise<PluginsState>;
  pickZip(): Promise<PluginsState>; installZip(file: string): Promise<PluginsState>; onOpen?(listener: () => void): () => void;
  checkUpdates?(id?: string): Promise<PluginsState>; installUpdate?(id: string): Promise<PluginsState>; setUpdateMode?(id: string, mode: UpdateMode): Promise<PluginsState>;
  connectGithub?(token: string): Promise<PluginsState>; disconnectGithub?(): Promise<PluginsState>; signInGithub?(): Promise<PluginsState>; cancelSignIn?(): Promise<PluginsState>;
  probeGithub?(): Promise<PluginsState>; openSource?(id: string): Promise<PluginsState>; openTokenPage?(): Promise<PluginsState>;
};
const pathForFile = () => (window as unknown as { adeDesktop?: { pathForFile?(file: File): string } }).adeDesktop?.pathForFile;
const pluginsBridge = () => (window as unknown as { adeDesktop?: { plugins?: PluginsBridge } }).adeDesktop?.plugins;
const errorText = (error: Error) => error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// The plugin state for components outside the settings page (status bar, notification clicks).
export function usePluginsState() {
  const [state, setState] = useState<PluginsState | null>(null);
  useEffect(() => {
    const bridge = pluginsBridge();
    if (!bridge) return;
    let live = true;
    void bridge.state().then(value => { if (live) setState(value); }, () => {});
    const off = bridge.onState(value => setState(value));
    return () => { live = false; off(); };
  }, []);
  return state;
}
// A plugin's notification was clicked: the app asks for the plugins page.
export function onPluginsOpen(listener: () => void) { return pluginsBridge()?.onOpen?.(listener) ?? (() => {}); }

// Status-bar items of running plugins. Always shown (not part of the status bar layout) so that a plugin cannot work unseen.
export function PluginBadges({ onOpen }: { onOpen(): void }) {
  const state = usePluginsState();
  const badges = (state?.plugins ?? []).filter(plugin => plugin.state === 'running' && plugin.badge);
  return <>{badges.map(plugin => <button key={plugin.folder} className={`plugin-badge ${plugin.badge!.tone}`} title={`플러그인: ${plugin.name}`} onClick={onOpen}>
    <Icon name="plugin" size={13} />{plugin.badge!.text}
  </button>)}</>;
}

// Drawn from the module grid as SVG elements, so nothing a plugin sends is injected as markup.
function QrCode({ text, label, size = 200 }: { text: string; label: string; size?: number }) {
  const cells = useMemo(() => {
    try {
      const code = qrcode(0, 'M');
      code.addData(text, 'Byte'); code.make();
      const count = code.getModuleCount(), path: string[] = [];
      for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (code.isDark(row, col)) path.push(`M${col + 4} ${row + 4}h1v1h-1z`);
      return { count: count + 8, path: path.join('') };
    } catch { return null; } // too long for a QR code
  }, [text]);
  if (!cells) return null;
  return <svg className="plugin-qr" width={size} height={size} viewBox={`0 0 ${cells.count} ${cells.count}`} role="img" aria-label={label || 'QR 코드'} shapeRendering="crispEdges">
    <rect width={cells.count} height={cells.count} fill="#fff" /><path d={cells.path} fill="#000" />
  </svg>;
}

type State = PluginInfo['state'];
const stateLabel: Record<State, string> = {
  invalid: '읽을 수 없음', new: '승인 필요', changed: '다시 승인 필요', off: '꺼짐',
  starting: '시작하는 중', running: '실행 중', error: '오류', stopped: '멈춤'
};
const stateTone = (state: State): Tone => state === 'running' ? 'ok' : ['invalid', 'error', 'changed'].includes(state) ? 'error' : state === 'new' ? 'warn' : 'info';
const toneIcon: Record<Tone, IconName> = { ok: 'check', warn: 'alert', error: 'alert', info: 'info' };
// Plugins that need the user come first; the rest keep the folder order.
const needsUser = (plugin: PluginInfo) => ['new', 'changed', 'error', 'invalid'].includes(plugin.state) || Boolean(plugin.update?.available) || setupLeft(plugin) > 0;

// ---- the setup guide ---------------------------------------------------------------------------------------------
// One list from what MoonerADE knows (approved, running) and what the plugin declared (plugin.json `setup`) and reports
// (view.setup). `pending`: the plugin is not running, so how far its own steps got is not known yet.
type GuideStatus = SetupStatus | 'pending';
type AdeStep = 'approve' | 'enable' | 'start' | 'restart' | 'builtin';
type GuideStep = { id: string; label: string; detail: string; status: GuideStatus; optional: boolean; view?: ViewStep; ade?: AdeStep };
export function guideSteps(plugin: PluginInfo): GuideStep[] {
  const steps: GuideStep[] = [], state = plugin.state, running = state === 'running';
  if (plugin.builtin) {
    const on = plugin.builtinEnabled !== false;
    steps.push({ id: 'ade-on', label: '켜기', detail: on ? '켜져 있습니다. 내장 플러그인이라 승인은 필요 없습니다.' : '꺼져 있습니다. 켜면 바로 실행됩니다.', status: on ? 'done' : 'todo', optional: false, ...(!on && { ade: 'builtin' as const }) });
  } else {
    const approved = !['new', 'changed'].includes(state);
    steps.push({
      id: 'ade-approve', label: 'MoonerADE에서 승인', optional: false,
      status: state === 'changed' ? 'error' : approved ? 'done' : 'todo',
      detail: state === 'changed' ? '승인한 뒤 플러그인 파일이 바뀌어 실행을 멈췄습니다. 직접 업데이트한 것이 맞다면 다시 승인하세요.'
        : approved ? '승인했습니다. 플러그인 파일이 바뀌면 다시 승인해야 실행됩니다.'
        : '아래 제공하는 기능(권한)을 확인하고, 믿을 수 있는 곳에서 받았다면 승인하세요. 승인 확인 창이 뜹니다.',
      ...(!approved && { ade: 'approve' as const })
    });
  }
  const run: GuideStep = { id: 'ade-run', label: '실행', optional: false, status: 'todo', detail: '승인하면 바로 실행됩니다.' };
  if (running) Object.assign(run, { status: 'done', detail: '실행 중입니다.' });
  else if (state === 'starting') Object.assign(run, { status: 'active', detail: '시작하는 중입니다…' });
  else if (state === 'error') Object.assign(run, { status: 'error', detail: plugin.error ?? '플러그인이 멈췄습니다.', ade: 'restart' });
  else if (state === 'off' && !plugin.builtin) Object.assign(run, { detail: '플러그인 사용이 꺼져 있어 실행하지 않습니다. 켜면 승인한 플러그인이 바로 실행됩니다.', ade: 'enable' });
  else if (state === 'stopped') Object.assign(run, { detail: '실행하고 있지 않습니다.', ade: 'start' });
  else if (state === 'off') run.detail = '켜면 실행됩니다.';
  steps.push(run);
  const reported = running ? plugin.view?.setup : undefined, byId = new Map((reported ?? []).map(step => [step.id, step]));
  const declared = plugin.setup ?? [];
  for (const step of declared) {
    const view = byId.get(step.id);
    steps.push({ id: `plugin:${step.id}`, label: view?.label ?? step.label, detail: view?.detail ?? step.detail, status: !running || !reported ? 'pending' : view?.status ?? 'todo', optional: view?.optional ?? step.optional === true, view });
  }
  for (const view of reported ?? []) if (view.label && !declared.some(step => step.id === view.id)) {
    steps.push({ id: `plugin:${view.id}`, label: view.label, detail: view.detail ?? '', status: view.status, optional: view.optional === true, view });
  }
  return steps;
}
const pluginSteps = (steps: GuideStep[]) => steps.filter(step => step.id.startsWith('plugin:'));
// Required steps of the plugin's own that are not done yet (0 while it is not running: nothing is known then).
function setupLeft(plugin: PluginInfo) {
  if (plugin.state !== 'running') return 0;
  return pluginSteps(guideSteps(plugin)).filter(step => !step.optional && step.status !== 'done' && step.status !== 'pending').length;
}
const currentStep = (steps: GuideStep[]) => steps.find(step => step.status === 'error')
  ?? steps.find(step => !step.optional && !['done', 'pending'].includes(step.status))
  ?? steps.find(step => !step.optional && step.status !== 'done');
const stepStateLabel = (step: GuideStep, current: boolean): string => step.status === 'done' ? '완료' : step.status === 'active' ? '진행 중' : step.status === 'error' ? '확인 필요'
  : step.status === 'pending' ? '실행 후 확인' : current ? '지금 할 일' : step.optional ? '선택' : '대기';
const ago = (at: number | null | undefined) => {
  if (!at) return '';
  const minutes = Math.round((Date.now() - at) / 60_000);
  return minutes < 1 ? '방금' : minutes < 60 ? `${minutes}분 전` : minutes < 60 * 24 ? `${Math.round(minutes / 60)}시간 전` : `${Math.round(minutes / 1440)}일 전`;
};

// `step` is the button that ran: a plugin's own form shows its result next to its buttons, everything else at the top.
type Notice = { text: string; error: boolean; step?: string };
// `key` is '<where>:<step>': where the result is shown ('global' or a plugin folder) and which button shows progress.
type Run = (key: string, step: () => Promise<PluginsState>) => void;

function Callout({ tone, children, action }: { tone: Tone; children: ReactNode; action?: ReactNode }) {
  return <div className="plugin-callout" data-tone={tone} role={tone === 'error' ? 'alert' : undefined}>
    <Icon name={toneIcon[tone]} size={15} /><div className="plugin-callout-text">{children}</div>{action && <div className="plugin-callout-action">{action}</div>}
  </div>;
}

function BusyButton({ busy, running, className, onClick, icon, children, title }: { busy: boolean; running: boolean; className?: string; onClick(): void; icon?: IconName; children: ReactNode; title?: string }) {
  return <button type="button" className={`plugin-button ${className ?? ''}`} disabled={busy} aria-busy={running || undefined} title={title} onClick={onClick}>
    {running ? <span className="plugin-spinner" aria-hidden="true" /> : icon && <Icon name={icon} />}{children}
  </button>;
}

function Row({ title, hint, query = '', children }: { title: ReactNode; hint?: ReactNode; query?: string; children?: ReactNode }) {
  const text = `${typeof title === 'string' ? title : ''} ${typeof hint === 'string' ? hint : ''}`;
  if (query.trim() && !text.toLowerCase().includes(query.trim().toLowerCase())) return null;
  return <div className="setting-row"><div><strong>{title}</strong>{hint && <small>{hint}</small>}</div><div className="setting-control">{children}</div></div>;
}

export function PluginSettings({ query = '' }: { query?: string }) {
  const bridge = pluginsBridge();
  const [state, setState] = useState<PluginsState | null>(null);
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState<(Notice & { where: string }) | null>(null);
  const [dropOver, setDropOver] = useState(false);
  // Which list the tabs show; null until the user picks one (then installed plugins if there are any, else built-in ones).
  const [tab, setTab] = useState<'installed' | 'builtin' | null>(null);
  // The plugin whose detail page is open (its folder); null shows the list.
  const [selected, setSelected] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const matches = (text: string) => !query.trim() || text.toLowerCase().includes(query.trim().toLowerCase());
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.state().then(value => { if (live) setState(value); }, () => {});
    const off = bridge.onState(value => setState(value));
    return () => { live = false; off(); };
  }, [bridge]);
  // Searching shows the matching plugins, not a detail page left open.
  useEffect(() => { if (query.trim()) setSelected(null); }, [query]);
  // Going to a detail page or back starts at the top of the scrolling settings body (not on the first render).
  const shownOnce = useRef(false);
  useEffect(() => {
    if (!shownOnce.current) { shownOnce.current = true; return; }
    let scroller = rootRef.current?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    scroller?.scrollTo({ top: 0 });
  }, [selected]);
  if (!bridge) {
    const text = '플러그인은 데스크톱 앱에서만 쓸 수 있습니다.';
    return matches(text) ? <p className="setting-note setting-hit">{text}</p> : null;
  }
  if (!state) {
    const text = '불러오는 중…';
    return matches(text) ? <p className="setting-note setting-hit">{text}</p> : null;
  }
  if (!state.available) {
    const text = '이 컴퓨터에서는 설정을 안전하게 암호화할 수 없어 플러그인을 쓸 수 없습니다.';
    return matches(text) ? <div className="setting-hit"><Callout tone="error">{text}</Callout></div> : null;
  }

  const run: Run = (key, step) => {
    const where = key.slice(0, key.lastIndexOf(':')), stepName = key.slice(key.lastIndexOf(':') + 1);
    setBusy(key); setNotice(null);
    void step().then(value => { setState(value); if (value.message) setNotice({ where, step: stepName, text: value.message, error: false }); },
      (error: Error) => setNotice({ where, step: stepName, text: errorText(error), error: true })).finally(() => setBusy(''));
  };
  const noticeFor = (where: string) => notice?.where === where ? notice : null;
  const open = selected === null ? null : state.plugins.find(plugin => plugin.folder === selected) ?? null;
  if (open) return <div className="plugins plugin-page" ref={rootRef}>
    <PluginDetail plugin={open} enabled={state.enabled} busy={busy} notice={noticeFor(open.folder)} run={run} bridge={bridge} onBack={() => setSelected(null)} />
  </div>;

  const global = noticeFor('global');
  const plugins = [...state.plugins].sort((a, b) => Number(needsUser(b)) - Number(needsUser(a)));
  const shown = plugins.filter(plugin => matches([plugin.name, plugin.description, ...(plugin.commands ?? []), plugin.mcp ?? '', ...(plugin.tools?.list ?? []).map(tool => `${tool.name} ${tool.title}`)].join(' ')));
  const filtering = query.trim() !== '';
  const working = Boolean(busy);
  const canDrop = Boolean(pathForFile());
  const installPaths = (paths: string[]) => {
    if (!paths.length) return Promise.resolve(state!);
    return paths.reduce((chain, file) => chain.then(() => bridge.installZip(file)), Promise.resolve(state!) as Promise<PluginsState>);
  };
  const onDragOver = (event: DragEvent) => {
    if (!canDrop || working || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDropOver(true);
  };
  const onDragLeave = (event: DragEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropOver(false);
  };
  const onDrop = (event: DragEvent) => {
    setDropOver(false);
    if (!canDrop || working) return;
    event.preventDefault(); event.stopPropagation();
    const resolve = pathForFile()!;
    const zips = Array.from(event.dataTransfer.files).filter(file => /\.zip$/i.test(file.name));
    if (!zips.length) { setNotice({ where: 'global', text: '플러그인 zip 파일만 놓을 수 있습니다.', error: true }); return; }
    const paths = zips.map(file => resolve(file)).filter(Boolean);
    if (!paths.length) return;
    setTab('installed');
    run('global:zip', () => installPaths(paths));
  };

  const builtins = shown.filter(plugin => plugin.builtin), installed = shown.filter(plugin => !plugin.builtin);
  const shownTab = tab ?? (installed.length || !builtins.length ? 'installed' : 'builtin');
  const list = (items: PluginInfo[]) => <ul className="plugin-list">{items.map(plugin => <li key={plugin.folder}><PluginRow plugin={plugin} onOpen={() => setSelected(plugin.folder)} /></li>)}</ul>;

  return <div ref={rootRef} className={`plugins${dropOver ? ' plugin-drop-target' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    {dropOver && !filtering && <p className="plugin-drop-hint" aria-live="polite">zip을 놓으면 설치 확인 창이 뜹니다</p>}
    {!filtering && state.error && !global?.error && <Callout tone="error">{state.error}</Callout>}
    {!filtering && global && <Callout tone={global.error ? 'error' : 'ok'}>{global.text}</Callout>}

    {!filtering && <div className="plugin-tabbar">
      <div className="plugin-tabs" role="tablist" aria-label="플러그인 종류">
        {([['installed', '설치한 플러그인', installed], ['builtin', '내장 플러그인', builtins]] as const).map(([id, label, items]) =>
          <button key={id} type="button" role="tab" aria-selected={shownTab === id} onClick={() => setTab(id)}>
            {label}<small>{items.length}</small>{shownTab !== id && items.some(needsUser) && <i className="plugin-tab-alert" title="확인이 필요한 플러그인이 있습니다" />}
          </button>)}
      </div>
      {shownTab === 'installed' && <div className="plugin-toolbar">
        {bridge.checkUpdates && installed.some(plugin => plugin.update?.source) && <IconButton icon="update" label="모든 플러그인 업데이트 확인" disabled={working} onClick={() => run('global:updates', () => bridge.checkUpdates!())} />}
        <IconButton icon="refresh" label="플러그인 폴더 다시 읽기" disabled={working} onClick={() => run('global:rescan', bridge.rescan)} />
        <IconButton icon="folder" label="플러그인 폴더 열기" disabled={working} onClick={() => run('global:folder', bridge.openFolder)} />
        <BusyButton className="primary" busy={working} running={busy === 'global:zip'} icon="plus" onClick={() => run('global:zip', bridge.pickZip)}>zip으로 설치</BusyButton>
      </div>}
    </div>}

    {(filtering ? builtins.length > 0 : shownTab === 'builtin') && <>
      {filtering
        ? <div className="plugin-list-head"><h4 className="setting-group">내장 플러그인</h4></div>
        : <p className="setting-note plugin-tab-note">MoonerADE에 포함된 플러그인입니다. 승인 없이 실행되고, 각자 켜고 끌 수 있습니다.</p>}
      {list(builtins)}
    </>}

    {!filtering && state.github?.available && <GithubSection github={state.github} busy={busy} run={run} bridge={bridge} notice={noticeFor('github')} />}

    {(filtering || shownTab === 'installed') && <>
    {filtering && installed.length > 0 && <div className="plugin-list-head"><h4 className="setting-group">설치한 플러그인</h4></div>}
    <Row query={query} title="설치한 플러그인 실행" hint="MoonerADE와 같은 권한으로 실행됩니다. 믿을 수 있는 것만 설치하세요.">
      <input type="checkbox" role="switch" aria-label="설치한 플러그인 실행" checked={state.enabled} disabled={working} onChange={event => { const on = event.target.checked; run('global:enable', () => bridge.setEnabled(on)); }} />
    </Row>
    {installed.length === 0
      ? !filtering && <div className="plugin-empty">
          <Icon name="plugin" size={24} />
          <p>플러그인 zip을 여기로 끌어다 놓거나 <b>zip으로 설치</b>를 누르세요.</p>
        </div>
      : list(installed)}
    </>}

    {!filtering && shownTab === 'installed' && <details className="plugin-about">
      <summary><Icon name="chevronRight" size={14} />설치 방법과 보안 안내</summary>
      <ul>
        <li>확인 창에서 <b>설치</b>를 누르기 전에는 아무것도 실행되지 않습니다. 이미 있는 플러그인은 업데이트되고 저장된 데이터는 남습니다.</li>
        <li>업데이트 출처(GitHub 저장소)를 알려 주는 플러그인은 그 저장소의 릴리스에서 업데이트를 받습니다. 받은 파일은 릴리스의 체크섬과 맞춰 보고, 새 권한을 요청하는 업데이트는 자동 업데이트여도 물어봅니다.</li>
        <li>압축을 푼 폴더(안에 <span className="mono">plugin.json</span>이 있는 폴더)를 직접 넣었다면 플러그인을 열어 승인하세요.</li>
        <li>승인은 그때의 파일 내용에 묶입니다. 파일이 바뀌면 다시 승인해야 실행됩니다.</li>
        <li>확인 창의 SHA-256을 배포처의 <span className="mono">SHA256SUMS</span>와 맞춰 보면 받은 파일이 그대로인지 알 수 있습니다.</li>
      </ul>
      <p>플러그인 폴더 <span className="mono">{state.dir}</span></p>
    </details>}
  </div>;
}

function StatePill({ state }: { state: State }) {
  return <span className="plugin-pill" data-tone={stateTone(state)}>{state === 'starting' ? <span className="plugin-spinner" aria-hidden="true" /> : <i aria-hidden="true" />}{stateLabel[state]}</span>;
}

// One line per plugin in the list: what it is, what it adds and whether it runs. Everything else is on its detail page.
function PluginRow({ plugin, onOpen }: { plugin: PluginInfo; onOpen(): void }) {
  const left = setupLeft(plugin);
  return <button type="button" className="plugin-row setting-hit" data-tone={stateTone(plugin.state)} onClick={onOpen} aria-label={`${plugin.name} 열기`}>
    <span className="plugin-mark" data-builtin={plugin.builtin || undefined}><Icon name={plugin.builtin ? 'sparkles' : 'plugin'} size={18} /></span>
    <span className="plugin-row-text">
      <span className="plugin-row-name"><strong>{plugin.name}</strong>{plugin.version && <span className="plugin-version">v{plugin.version}</span>}
        {left > 0 && <span className="plugin-tag" data-tone="warn">설정 {left}단계 남음</span>}
        {plugin.update?.available && <span className="plugin-tag" data-tone="info">업데이트 v{plugin.update.latest}</span>}</span>
      {plugin.description && <span className="plugin-row-desc">{plugin.description}</span>}
    </span>
    <StatePill state={plugin.state} />
    <Icon name="chevronRight" size={16} />
  </button>;
}

function Section({ title, hint, action, children }: { title: string; hint?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return <section className="plugin-section">
    <header><div><h4>{title}</h4>{hint && <p>{hint}</p>}</div>{action}</header>
    {children}
  </section>;
}

function PluginDetail({ plugin, enabled, busy, notice, run, bridge, onBack }: { plugin: PluginInfo; enabled: boolean; busy: string; notice: Notice | null; run: Run; bridge: PluginsBridge; onBack(): void }) {
  const id = plugin.id, tone = stateTone(plugin.state);
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { backRef.current?.focus(); }, []);
  const button = (step: string, label: string, action: () => Promise<PluginsState>, options: { primary?: boolean; icon?: IconName; title?: string; className?: string } = {}) =>
    <BusyButton className={[options.primary ? 'primary' : '', options.className ?? ''].join(' ')} busy={Boolean(busy)} running={busy === `${plugin.folder}:${step}`} icon={options.icon} title={options.title}
      onClick={() => run(`${plugin.folder}:${step}`, action)}>{label}</BusyButton>;
  // Approving needs the plugin feature on; when it is off, turn it on first (two native dialogs, either can be cancelled).
  const approve = async () => {
    if (!enabled) { const next = await bridge.setEnabled(true); if (!next.enabled) return next; }
    return bridge.approve(plugin.folder);
  };

  // The header switch: a built-in plugin's own on/off; an installed one is on while approved (and plugins run), off revokes the approval.
  const on = plugin.builtin ? plugin.builtinEnabled !== false : ['starting', 'running', 'error', 'stopped'].includes(plugin.state);
  const toggle = (next: boolean) => {
    if (!id) return;
    if (plugin.builtin) run(`${plugin.folder}:switch`, () => bridge.setBuiltin(id, next));
    else if (!next) run(`${plugin.folder}:switch`, () => bridge.revoke(id));
    else run(`${plugin.folder}:switch`, plugin.state === 'off' ? () => bridge.setEnabled(true) : approve);
  };

  // What MoonerADE's own steps do, as buttons inside the guide.
  const adeButton = (step: AdeStep) => {
    if (!id) return null;
    if (step === 'approve') return button('approve', plugin.state === 'changed' ? (enabled ? '다시 승인' : '켜고 다시 승인') : (enabled ? '승인하고 실행' : '켜고 승인'), approve, { primary: true, icon: 'check' });
    if (step === 'enable') return button('enable', '플러그인 사용 켜기', () => bridge.setEnabled(true), { primary: true, icon: 'check' });
    if (step === 'builtin') return button('builtin', '켜기', () => bridge.setBuiltin(id, true), { primary: true, icon: 'check' });
    return button('restart', step === 'start' ? '시작' : '다시 시작', () => bridge.restart(id), { icon: 'refresh' });
  };

  const view = plugin.view && id && hasContent(plugin.view) ? plugin.view : null;
  const [values, setValue] = useFieldValues(view);
  const act = (action: string, item?: string) => { if (id) run(`${plugin.folder}:action-${action}${item ? `-${item}` : ''}`, () => bridge.action(id, action, values, item)); };
  const steps = plugin.state === 'invalid' ? [] : guideSteps(plugin);
  const complete = steps.every(step => step.optional || step.status === 'done');
  // While setting up, what a step names is drawn inside that step; once everything is done it is all ordinary settings.
  const inSteps = complete ? null : stepParts(steps);

  return <>
    <nav className="plugin-nav">
      <button ref={backRef} type="button" className="plugin-back" onClick={onBack}><Icon name="arrowLeft" size={16} />플러그인</button>
    </nav>
    <header className="plugin-detail-head" data-tone={tone}>
      <span className="plugin-mark large" data-builtin={plugin.builtin || undefined}><Icon name={plugin.builtin ? 'sparkles' : 'plugin'} size={24} /></span>
      <div className="plugin-title">
        <div>
          <strong>{plugin.name}</strong>{plugin.version && <span className="plugin-version">v{plugin.version}</span>}
          <span className="plugin-tag" data-tone={plugin.builtin ? 'info' : undefined}>{plugin.builtin ? '내장' : '설치함'}</span>
          <StatePill state={plugin.state} />
        </div>
        {plugin.description && <p>{plugin.description}</p>}
      </div>
      {id && plugin.state !== 'invalid' && <input type="checkbox" role="switch" className="plugin-master" aria-label={`${plugin.name} 사용`} title={on ? '끄기' : '켜기'} checked={on} disabled={Boolean(busy)} onChange={event => toggle(event.target.checked)} />}
    </header>
    {plugin.state === 'invalid' && <Callout tone="error">{plugin.error ?? '플러그인을 읽을 수 없습니다.'}<small>plugin.json과 폴더 구성을 고친 뒤 목록의 다시 읽기를 누르세요.</small></Callout>}
    {notice && <Callout tone={notice.error ? 'error' : 'ok'}>{notice.text}</Callout>}
    {view?.status && <p className="plugin-status plugin-status-line" data-tone={view.status.tone}><Icon name={toneIcon[view.status.tone]} size={14} />{view.status.text}</p>}

    {steps.length > 0 && <SetupGuide key={plugin.folder} steps={steps} complete={complete} adeButton={adeButton}
      content={step => step.view && view ? <ViewParts view={view} parts={step.view} values={values} setValue={setValue} busy={busy} where={plugin.folder} act={act} /> : null} />}

    {view && id && <SettingsSection view={view} hide={inSteps} values={values} setValue={setValue} busy={busy} where={plugin.folder} act={act} />}
    {!view && id && ['off', 'stopped', 'error'].includes(plugin.state) && <Section title="설정">
      <p className="plugin-muted">플러그인이 실행 중일 때 바꿀 수 있는 설정이 여기에 나옵니다.</p>
    </Section>}

    {plugin.state !== 'invalid' && <Section title="제공하는 기능">
      <Provides plugin={plugin} busy={busy} run={run} bridge={bridge} />
    </Section>}

    {id && plugin.update && <UpdateSection plugin={plugin} update={plugin.update} busy={busy} run={run} bridge={bridge} />}

    <details className="plugin-about">
      <summary><Icon name="chevronRight" size={14} />자세한 정보</summary>
      <PluginFacts plugin={plugin} />
    </details>
  </>;
}

const hasContent = (view: PluginView) => Boolean(view.status || view.qr || view.info.length || view.fields.length || view.actions.length || view.setup?.length || view.lists?.length);
type Parts = { fields: Set<string>; info: Set<string>; actions: Set<string>; qr: boolean };
// Everything the plugin's steps draw themselves.
function stepParts(steps: GuideStep[]): Parts {
  const parts: Parts = { fields: new Set(), info: new Set(), actions: new Set(), qr: false };
  for (const step of steps) if (step.view) {
    step.view.fields.forEach(key => parts.fields.add(key)); step.view.info.forEach(key => parts.info.add(key)); step.view.actions.forEach(key => parts.actions.add(key));
    if (step.view.qr) parts.qr = true;
  }
  return parts;
}
// Field values start from what the plugin reports and keep the user's edits until the plugin sends a new value.
function useFieldValues(view: PluginView | null): [Record<string, string>, (key: string, value: string) => void] {
  const [values, setValues] = useState<Record<string, string>>({});
  const reported = JSON.stringify((view?.fields ?? []).map(field => [field.key, field.value]));
  useEffect(() => { setValues(Object.fromEntries((view?.fields ?? []).map(field => [field.key, field.value]))); }, [reported]);
  return [values, (key, value) => setValues(current => ({ ...current, [key]: value }))];
}

// "시작하기": every step from installing to the plugin's own setup, the one to do now open. Once done it folds into one
// line that can be opened again.
function SetupGuide({ steps, complete, adeButton, content }: { steps: GuideStep[]; complete: boolean; adeButton(step: AdeStep): ReactNode; content(step: GuideStep): ReactNode }) {
  const current = currentStep(steps);
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  // The step to do now opens by itself as the plugin moves on.
  useEffect(() => { setOpen(null); }, [current?.id, current?.status]);
  const own = pluginSteps(steps);
  if (complete && own.length === 0) return null;
  const required = steps.filter(step => !step.optional), done = required.filter(step => step.status === 'done').length;
  if (complete && !shown) return <div className="plugin-guide-done">
    <span className="plugin-step-mark" data-status="done"><Icon name="check" size={14} /></span>
    <span><strong>설정을 마쳤습니다</strong><small>{own.length}개 단계 완료 · 아래에서 설정을 바꿀 수 있습니다</small></span>
    <button type="button" className="plugin-link" onClick={() => setShown(true)}>단계 보기</button>
  </div>;
  return <section className="plugin-guide" aria-label="시작하기">
    <header>
      <div>
        <h4>{complete ? '설정 단계' : '시작하기'}</h4>
        <p>{complete ? '모든 단계를 마쳤습니다.' : current ? <>지금 할 일: <b>{current.label}</b></> : '플러그인이 실행되면 남은 단계를 확인합니다.'}</p>
      </div>
      <div className="plugin-guide-progress">
        <span>{done}/{required.length}</span>
        <span className="plugin-progress" role="progressbar" aria-valuemin={0} aria-valuemax={required.length} aria-valuenow={done} aria-label="설정 진행"><i style={{ width: `${required.length ? (done / required.length) * 100 : 100}%` }} /></span>
        {complete && <button type="button" className="plugin-link" onClick={() => setShown(false)}>접기</button>}
      </div>
    </header>
    <ol className="plugin-steps">
      {steps.map((step, index) => {
        const isCurrent = step === current, expanded = open === null ? isCurrent : open === step.id;
        const body = expanded ? content(step) : null, action = expanded && step.ade ? adeButton(step.ade) : null;
        return <li key={step.id} className="plugin-step" data-status={step.status} data-current={isCurrent || undefined}>
          <button type="button" className="plugin-step-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? '' : step.id)}>
            <span className="plugin-step-mark" data-status={step.status}>{step.status === 'done' ? <Icon name="check" size={14} /> : step.status === 'error' ? '!' : step.status === 'active' ? <span className="plugin-spinner" aria-hidden="true" /> : index + 1}</span>
            <span className="plugin-step-label">{step.label}{step.optional && <span className="plugin-tag">선택</span>}</span>
            <span className="plugin-step-state">{stepStateLabel(step, isCurrent)}</span>
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={16} />
          </button>
          {expanded && (step.detail || body || action) && <div className="plugin-step-body">
            {step.detail && <p className="plugin-step-detail">{step.detail}</p>}
            {step.status === 'pending' && <p className="plugin-muted">플러그인이 실행되면 이 단계를 여기서 진행합니다.</p>}
            {body}
            {action && <div className="plugin-actions">{action}</div>}
          </div>}
        </li>;
      })}
    </ol>
  </section>;
}

// The parts of the view a step names (`parts`), or everything else (`hide`). Enter in an input runs the one primary button.
function ViewParts({ view, parts, hide, values, setValue, busy, where, act }: { view: PluginView; parts?: ViewStep; hide?: Parts | null; values: Record<string, string>; setValue(key: string, value: string): void; busy: string; where: string; act(action: string, item?: string): void }) {
  const [copied, setCopied] = useState('');
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(''), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  // In a step: what it names, in its order. Otherwise: everything the steps do not show.
  const pick = <T,>(items: T[], key: (item: T) => string | undefined, from: 'fields' | 'info' | 'actions') => parts
    ? parts[from].map(name => items.find(item => key(item) === name)).filter((item): item is T => item !== undefined)
    : items.filter(item => { const name = key(item); return !hide || !name || !hide[from].has(name); });
  const fields = pick(view.fields, field => field.key, 'fields'), info = pick(view.info, item => item.key, 'info'), actions = pick(view.actions, item => item.id, 'actions');
  const qr = view.qr && (parts ? parts.qr === true : !hide?.qr) ? view.qr : null;
  const primary = actions.filter(action => action.primary);
  if (!fields.length && !info.length && !actions.length && !qr) return null;
  return <div className="plugin-parts">
    {qr && <div className="plugin-qr-row"><QrCode text={qr.value} label={qr.label} size={168} />{qr.label && <p>{qr.label}</p>}</div>}
    {info.length > 0 && <dl className="plugin-info">{info.map(item => <div key={item.label}>
      <dt>{item.label}</dt>
      <dd><span className={item.mono ? 'mono' : undefined}>{item.value || '—'}</span>
        {item.copy && item.value && <IconButton icon={copied === item.label ? 'check' : 'copy'} label={copied === item.label ? '복사했습니다' : `${item.label} 복사`} onClick={() => { copyText(item.value); setCopied(item.label); }} />}
      </dd>
    </div>)}</dl>}
    {(fields.length > 0 || actions.length > 0) && <form className="plugin-form" onSubmit={event => { event.preventDefault(); if (primary.length === 1 && !busy) act(primary[0].id); }}>
      {fields.map(field => {
        const value = values[field.key] ?? '', set = (next: string) => setValue(field.key, next);
        const label = <span>{field.label}{field.required && <em className="plugin-required">필수</em>}</span>;
        if (field.type === 'switch') return <label key={field.key} className="plugin-field plugin-field-switch">
          {label}
          <input type="checkbox" role="switch" aria-label={field.label} checked={value === 'true'} onChange={event => set(String(event.target.checked))} />
          {field.hint && <small>{field.hint}</small>}
        </label>;
        return <label key={field.key} className="plugin-field">
          {label}
          {field.type === 'select' && field.options
            ? <select value={value} onChange={event => set(event.target.value)}>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            : <input type={field.type === 'number' ? 'number' : 'text'} inputMode={field.type === 'number' ? 'numeric' : undefined} value={value} placeholder={field.placeholder} spellCheck={false} aria-required={field.required || undefined} onChange={event => set(event.target.value)} />}
          {field.hint && <small>{field.hint}</small>}
        </label>;
      })}
      {actions.length > 0 && <div className="plugin-actions">
        {actions.map(action => <BusyButton key={action.id} className={action.primary ? 'primary' : action.danger ? 'danger' : undefined} busy={Boolean(busy)} running={busy === `${where}:action-${action.id}`} onClick={() => act(action.id)}>{action.label}</BusyButton>)}
      </div>}
    </form>}
  </div>;
}

// What can be changed while the plugin runs: what the setup steps do not show, and the plugin's lists.
function SettingsSection({ view, hide, values, setValue, busy, where, act }: { view: PluginView; hide: Parts | null; values: Record<string, string>; setValue(key: string, value: string): void; busy: string; where: string; act(action: string, item?: string): void }) {
  const parts = <ViewParts view={view} hide={hide} values={values} setValue={setValue} busy={busy} where={where} act={act} />;
  const lists = view.lists ?? [];
  const rest = Boolean(hide ? view.fields.some(field => !hide.fields.has(field.key)) || view.actions.some(action => !hide.actions.has(action.id)) || view.info.some(item => !item.key || !hide.info.has(item.key)) || (view.qr && !hide.qr)
    : view.fields.length || view.actions.length || view.info.length || view.qr);
  if (!rest && !lists.length) return null;
  return <Section title="설정" hint={hide ? '설정 단계 밖에서 바꿀 수 있는 것입니다.' : '바꿀 수 있는 설정입니다. 바꾼 뒤 저장 버튼을 누르세요.'}>
    {rest && <div className="plugin-body">{parts}</div>}
    {lists.map(list => <div key={list.id} className="plugin-list-group">
      <h5>{list.title}{list.items.length > 0 && <span className="plugin-count">{list.items.length}</span>}</h5>
      {list.items.length === 0 ? <p className="plugin-muted plugin-list-empty">{list.empty || '없습니다.'}</p>
        : <ul className="plugin-items">{list.items.map(item => <li key={item.id}>
          <div className="plugin-item-text">
            <span><strong>{item.label}</strong>{item.tag && <span className="plugin-tag" data-tone={item.tag.tone}>{item.tag.text}</span>}</span>
            {item.detail && <small>{item.detail}</small>}
          </div>
          {item.actions.length > 0 && <div className="plugin-item-actions">{item.actions.map(action =>
            <BusyButton key={action.id} className={action.primary ? 'primary' : action.danger ? 'danger' : undefined} busy={Boolean(busy)} running={busy === `${where}:action-${action.id}-${item.id}`} onClick={() => act(action.id, item.id)}>{action.label}</BusyButton>)}</div>}
        </li>)}</ul>}
    </div>)}
  </Section>;
}

const MODES: { mode: UpdateMode; label: string; hint: string }[] = [
  { mode: 'auto', label: '자동', hint: '새 버전을 확인 창 없이 설치합니다. 새 권한이 필요하면 묻습니다.' },
  { mode: 'notify', label: '알림 후 설치', hint: '새 버전이 나오면 알리고, 설치는 확인 창에서 합니다.' },
  { mode: 'manual', label: '수동', hint: '직접 확인할 때만 새 버전을 찾습니다.' }
];
// Where updates come from, how they are taken, and the newest version found.
function UpdateSection({ plugin, update, busy, run, bridge }: { plugin: PluginInfo; update: PluginUpdate; busy: string; run: Run; bridge: PluginsBridge }) {
  const id = plugin.id!, key = (step: string) => `${plugin.folder}:${step}`;
  if (!update.source || !bridge.checkUpdates) return <Section title="업데이트">
    <p className="plugin-muted">이 플러그인은 업데이트 출처(GitHub 저장소)를 알려 주지 않습니다. 새 버전의 zip을 설치하면 업데이트됩니다.</p>
  </Section>;
  const status = update.status ?? 'idle', working = Boolean(busy);
  const spinning = ['checking', 'downloading', 'installing'].includes(status);
  const tone: Tone = status === 'available' ? 'info' : status === 'error' ? 'error' : status === 'latest' ? 'ok' : 'info';
  const text = status === 'checking' ? '새 버전을 확인하는 중…' : status === 'downloading' ? `v${update.latest}을(를) 받는 중…` : status === 'installing' ? `v${update.latest}을(를) 설치하는 중…`
    : status === 'available' ? `새 버전 v${update.latest}이(가) 있습니다` : status === 'latest' ? `최신 버전입니다 (v${update.current})` : status === 'error' ? update.error ?? '확인하지 못했습니다.' : '아직 확인하지 않았습니다.';
  return <Section title="업데이트" hint={<>출처 <button type="button" className="plugin-link plugin-source" onClick={() => run(key('source'), () => bridge.openSource!(id))}><Icon name="externalLink" size={12} />github.com/{update.source.github}</button> 릴리스</>}>
    <div className="plugin-update" data-tone={tone}>
      <div className="plugin-update-status">
        {spinning ? <span className="plugin-spinner" aria-hidden="true" /> : <Icon name={status === 'available' ? 'download' : status === 'error' ? 'alert' : status === 'latest' ? 'check' : 'update'} size={16} />}
        <div>
          <strong>{text}</strong>
          <small>{[status === 'available' && `지금 v${update.current}`, update.checkedAt && `${ago(update.checkedAt)} 확인`, update.checkedAt && status !== 'error' && update.viaLabel && `${update.viaLabel}으로 접속`].filter(Boolean).join(' · ')}</small>
        </div>
        <div className="plugin-update-actions">
          {status === 'available' && <BusyButton className="primary" busy={working} running={busy === key('install')} icon="download" onClick={() => run(key('install'), () => bridge.installUpdate!(id))}>설치</BusyButton>}
          <BusyButton busy={working || spinning} running={busy === key('check')} icon="refresh" onClick={() => run(key('check'), () => bridge.checkUpdates!(id))}>지금 확인</BusyButton>
        </div>
      </div>
      {(update.review?.length ?? 0) > 0 && <Callout tone="warn">이 업데이트는 전에 없던 것을 요청해 자동으로 설치하지 않았습니다. 확인하고 설치하세요.
        <ul className="plugin-review">{update.review!.map(line => <li key={line}>{line}</li>)}</ul></Callout>}
      <div className="plugin-modes" role="radiogroup" aria-label="업데이트 방식">
        {MODES.map(option => <label key={option.mode} className="plugin-mode" data-checked={update.mode === option.mode || undefined}>
          <input type="radio" name={`update-mode-${id}`} value={option.mode} checked={update.mode === option.mode} disabled={working}
            onChange={() => run(key('mode'), () => bridge.setUpdateMode!(id, option.mode))} />
          <span><strong>{option.label}{option.mode === 'notify' && <em className="plugin-default">기본</em>}</strong><small>{option.hint}</small></span>
        </label>)}
      </div>
    </div>
  </Section>;
}

// The GitHub account for plugins from private repositories: connected in MoonerADE, or this PC's gh / git login.
function GithubSection({ github, busy, run, bridge, notice }: { github: GithubAccount; busy: string; run: Run; bridge: PluginsBridge; notice: Notice | null }) {
  const [token, setToken] = useState('');
  const working = Boolean(busy);
  // Which login this PC has is looked up once when the page opens (it runs `gh`), not on every render.
  useEffect(() => { if (!github.login && !github.machineChecked && bridge.probeGithub) void bridge.probeGithub().catch(() => {}); }, []);
  const connect = () => { const value = token.trim(); if (!value) return; run('github:connect', async () => { const next = await bridge.connectGithub!(value); if (next.github?.login) setToken(''); return next; }); };
  let status: ReactNode;
  if (github.login) status = <><Icon name="check" size={15} /><span><strong>{github.login}</strong> 계정이 연결되어 있습니다<small>{github.via === 'oauth' ? 'GitHub 로그인' : '개인 액세스 토큰'} · 비공개 저장소의 플러그인 업데이트에 씁니다</small></span></>;
  else if (github.machine) status = <><Icon name="check" size={15} /><span><strong>이 PC의 {github.machine === 'gh' ? 'gh' : 'git'} 로그인</strong>을 씁니다<small>MoonerADE에 따로 연결하지 않아도 그 계정이 볼 수 있는 저장소에서 업데이트를 받습니다.</small></span></>;
  else status = <><Icon name="info" size={15} /><span><strong>연결된 계정이 없습니다</strong><small>{github.machineChecked ? '공개 저장소의 플러그인만 업데이트를 확인합니다.' : '이 PC의 GitHub 로그인을 확인하는 중…'}</small></span></>;
  return <section className="plugin-github" aria-label="GitHub 연결">
    <h4 className="setting-group">GitHub 연결</h4>
    <p className="plugin-muted">비공개 저장소에서 받는 플러그인을 업데이트할 때 씁니다. 공개 저장소의 플러그인은 연결하지 않아도 됩니다.</p>
    {notice && <Callout tone={notice.error ? 'error' : 'ok'}>{notice.text}</Callout>}
    {github.error && !notice && <Callout tone="error">{github.error}</Callout>}
    <div className="plugin-github-card">
      <div className="plugin-github-status" data-tone={github.login || github.machine ? 'ok' : 'info'}>{status}
        {github.login && <BusyButton className="danger" busy={working} running={busy === 'github:disconnect'} onClick={() => run('github:disconnect', () => bridge.disconnectGithub!())}>연결 해제</BusyButton>}
      </div>
      {github.device && <Callout tone="info" action={<BusyButton busy={working} running={busy === 'github:cancel'} onClick={() => run('github:cancel', () => bridge.cancelSignIn!())}>취소</BusyButton>}>
        브라우저에서 GitHub 페이지가 열렸습니다. 코드 <b className="mono">{github.device.userCode}</b>를 입력하고 승인하세요.
        <button type="button" className="plugin-link" onClick={() => copyText(github.device!.userCode)}>코드 복사</button>
      </Callout>}
      {!github.login && <div className="plugin-github-connect">
        {github.signIn && bridge.signInGithub && <BusyButton className="primary" busy={working} running={busy === 'github:signin'} icon="person" onClick={() => run('github:signin', () => bridge.signInGithub!())}>GitHub로 로그인</BusyButton>}
        <form className="plugin-token" onSubmit={event => { event.preventDefault(); if (!working) connect(); }}>
          <label className="plugin-field">
            <span>{github.signIn ? '또는 토큰으로 연결' : '토큰으로 연결'}</span>
            <div className="plugin-token-row">
              <input type="password" value={token} placeholder="github_pat_…" autoComplete="off" spellCheck={false} aria-label="GitHub 토큰" onChange={event => setToken(event.target.value)} />
              <BusyButton className={github.signIn ? undefined : 'primary'} busy={working || !token.trim()} running={busy === 'github:connect'} icon="key" onClick={connect}>연결</BusyButton>
            </div>
            <small>Fine-grained 토큰에서 플러그인 저장소만 고르고 <b>Contents: Read-only</b> 권한만 주세요. 토큰은 이 PC에 암호화해 저장하고 GitHub에만 보냅니다.
              {bridge.openTokenPage && <button type="button" className="plugin-link" onClick={() => run('github:token-page', () => bridge.openTokenPage!())}>토큰 만들기<Icon name="externalLink" size={12} /></button>}</small>
          </label>
        </form>
      </div>}
    </div>
  </section>;
}

// Each thing the plugin adds, spelled out: its commands, its MCP tools (each can be turned off) and what it may do.
function Provides({ plugin, busy, run, bridge }: { plugin: PluginInfo; busy: string; run: Run; bridge: PluginsBridge }) {
  const blocks: ReactNode[] = [];
  if (plugin.terminal) {
    const env = plugin.env ?? [];
    blocks.push(<div key="terminal" className="plugin-cap">
      <span className="plugin-cap-icon"><Icon name="terminal" size={16} /></span>
      <div className="plugin-cap-text">
        <strong>터미널 명령</strong>
        {(plugin.commands?.length ?? 0) > 0 && <div className="plugin-chips">{plugin.commands!.map(command => <code key={command}>{command}</code>)}</div>}
        {(env.length > 0 || plugin.envPrefix) && <p className="plugin-muted">환경 변수 {env.length ? env.map(name => <code key={name}>{name}</code>) : <code>{plugin.envPrefix}*</code>}</p>}
      </div>
    </div>);
  }
  if (plugin.mcp) blocks.push(<McpTools key="mcp" plugin={plugin} busy={busy} run={run} bridge={bridge} />);
  if (plugin.workspace) blocks.push(<div key="workspace" className="plugin-cap">
    <span className="plugin-cap-icon"><Icon name="layers" size={16} /></span>
    <div className="plugin-cap-text">
      <strong>프로젝트·터미널 사용</strong>
      <p>{plugin.builtin ? '열린 채팅을 읽고 메시지를 보냅니다.' : '이 PC의 프로젝트와 터미널을 열고 조작합니다.'}</p>
    </div>
  </div>);
  return <div className="plugin-caps">{blocks}</div>;
}

function McpTools({ plugin, busy, run, bridge }: { plugin: PluginInfo; busy: string; run: Run; bridge: PluginsBridge }) {
  const id = plugin.id!, tools = plugin.tools;
  const serverOn = tools?.enabled !== false;
  const list = tools?.list ?? null;
  const working = Boolean(busy);
  const set = (change: { tool?: string; enabled: boolean }, step: string) => run(`${plugin.folder}:${step}`, () => bridge.setMcp(id, change));
  const onCount = list ? list.filter(tool => tool.enabled).length : 0;
  const running = plugin.state === 'running';

  let body: ReactNode;
  if (list && list.length > 0) body = <ul className={`plugin-tools${serverOn ? '' : ' off'}`}>{list.map(tool => <li key={tool.name} className="plugin-tool">
    <div className="plugin-tool-text">
      <div className="plugin-tool-name">
        <code>{tool.name}</code>
        {tool.title && <span>{tool.title}</span>}
        {tool.readOnly && <span className="plugin-tag" data-tone="ok">읽기 전용</span>}
        {tool.destructive && <span className="plugin-tag" data-tone="warn">변경 작업</span>}
      </div>
      {tool.description && <ToolDescription text={tool.description} />}
      {tool.params.length > 0 && <p className="plugin-tool-params">인자 {tool.params.map(param => <code key={param.name} title={param.required ? '필수' : '선택'}>{param.name}{param.required ? '' : '?'}</code>)}</p>}
    </div>
    <input type="checkbox" role="switch" aria-label={`${tool.name} 도구 사용`} checked={tool.enabled} disabled={working || !serverOn}
      onChange={event => set({ tool: tool.name, enabled: event.target.checked }, `tool-${tool.name}`)} />
  </li>)}</ul>;
  else if (list) body = <p className="plugin-muted">MCP 서버가 도구를 하나도 알려 주지 않았습니다.</p>;
  else if (tools?.status === 'loading') body = <p className="plugin-muted plugin-loading"><span className="plugin-spinner" aria-hidden="true" />도구 목록을 불러오는 중…</p>;
  else if (tools?.status === 'error') body = null;
  else if (!running) body = <p className="plugin-muted">실행하면 도구 목록이 나옵니다.</p>;
  else if (!tools?.offered) body = <p className="plugin-muted">설정을 마치면 도구 목록이 나옵니다.</p>;
  else body = <p className="plugin-muted">도구 목록을 아직 불러오지 않았습니다.</p>;

  return <div className="plugin-cap plugin-cap-mcp">
    <span className="plugin-cap-icon"><Icon name="bot" size={16} /></span>
    <div className="plugin-cap-text">
      <div className="plugin-cap-head">
        <div>
          <strong>에이전트 도구 (MCP)</strong>
          <p>{plugin.mcpChatOnly ? '채팅' : '터미널과 채팅'}의 AI 에이전트에 <code>{plugin.mcp}</code> 서버를 줍니다. 새로 시작하는 에이전트부터 적용됩니다.</p>
        </div>
        <div className="plugin-cap-controls">
          {running && tools?.offered && <IconButton icon="refresh" label="도구 목록 다시 불러오기" disabled={working || tools.status === 'loading'} onClick={() => run(`${plugin.folder}:tools`, () => bridge.refreshTools(id))} />}
          <input type="checkbox" role="switch" aria-label="MCP 서버 사용" checked={serverOn} disabled={working} onChange={event => set({ enabled: event.target.checked }, 'mcp')} />
        </div>
      </div>
      {serverOn && list && onCount < list.length && <p className="plugin-muted">도구 {list.length}개 중 {onCount}개 사용 · 끈 도구가 있으면 Cursor 채팅에는 이 서버를 주지 않습니다</p>}
      {tools?.status === 'error' && <Callout tone="error">{tools.error ?? '도구 목록을 불러오지 못했습니다.'}</Callout>}
      {body}
    </div>
  </div>;
}

// Long descriptions start folded to two lines.
function ToolDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 140 || text.includes('\n');
  return <p className={`plugin-tool-desc${long && !open ? ' folded' : ''}`}>
    {text}
    {long && <button type="button" className="plugin-link" onClick={() => setOpen(value => !value)}>{open ? '접기' : '더 보기'}</button>}
  </p>;
}

function PluginFacts({ plugin }: { plugin: PluginInfo }) {
  const [copied, setCopied] = useState('');
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(''), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const rows: { label: string; value: string; copy?: boolean }[] = [
    { label: 'id', value: plugin.id ?? '—' },
    { label: '버전', value: plugin.version ?? '—' },
    { label: '폴더', value: plugin.builtin ? 'MoonerADE에 포함됨' : plugin.folder },
    ...(plugin.hash ? [{ label: 'SHA-256', value: plugin.hash, copy: true }] : [])
  ];
  return <dl className="plugin-info">{rows.map(row => <div key={row.label}>
    <dt>{row.label}</dt>
    <dd><span className="mono">{row.value}</span>
      {row.copy && <IconButton icon={copied === row.label ? 'check' : 'copy'} label={copied === row.label ? '복사했습니다' : `${row.label} 복사`} onClick={() => { copyText(row.value); setCopied(row.label); }} />}
    </dd>
  </div>)}</dl>;
}
