import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { Icon, IconButton, type IconName } from './Icon';
import { copyText } from './toast';

// Mirrors snapshot() in apps/desktop/src/plugin-core.js. Turning plugins on, approving one and installing a zip are
// confirmed by the desktop app in native dialogs; these calls only start them. What a plugin shows here is plain text, never markup.
type Tone = 'ok' | 'warn' | 'error' | 'info';
export type PluginView = {
  status: { tone: Tone; text: string } | null;
  info: { label: string; value: string; mono: boolean; copy: boolean }[];
  // `type` is how the input is drawn; the value is always a string ('true' / 'false' for a switch).
  fields: { key: string; label: string; type?: 'text' | 'select' | 'switch' | 'number'; value: string; placeholder: string; hint: string; options?: { value: string; label: string }[] }[];
  actions: { id: string; label: string; primary: boolean }[];
  qr?: { label: string; value: string } | null;
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
};
export type PluginsState = { available: boolean; problem: 'unavailable' | 'unreadable' | null; error: string | null; enabled: boolean; dir: string; plugins: PluginInfo[]; message?: string | null };
type PluginsBridge = {
  state(): Promise<PluginsState>; onState(listener: (state: PluginsState) => void): () => void;
  setEnabled(on: boolean): Promise<PluginsState>; setBuiltin(id: string, on: boolean): Promise<PluginsState>; rescan(): Promise<PluginsState>; approve(folder: string): Promise<PluginsState>;
  revoke(id: string, options?: { forget?: boolean }): Promise<PluginsState>; restart(id: string): Promise<PluginsState>;
  action(id: string, action: string, values: Record<string, string>): Promise<PluginsState>; openFolder(): Promise<PluginsState>;
  setMcp(id: string, change: { tool?: string; enabled: boolean }): Promise<PluginsState>; refreshTools(id: string): Promise<PluginsState>;
  pickZip(): Promise<PluginsState>; installZip(file: string): Promise<PluginsState>; onOpen?(listener: () => void): () => void;
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
const needsUser = (plugin: PluginInfo) => ['new', 'changed', 'error', 'invalid'].includes(plugin.state);

type Notice = { text: string; error: boolean };
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

// What a plugin adds, in a few words for the list (the detail page spells each one out).
function provides(plugin: PluginInfo) {
  const items: { icon: IconName; text: string }[] = [];
  if (plugin.terminal) items.push({ icon: 'terminal', text: plugin.commands?.length ? `명령 ${plugin.commands.join(', ')}` : '터미널 명령' });
  if (plugin.mcp) {
    const tools = plugin.tools, list = tools?.list;
    const off = tools && !tools.enabled;
    const on = list ? list.filter(tool => tool.enabled).length : 0;
    items.push({ icon: 'bot', text: off ? 'MCP 도구 꺼짐' : list ? `MCP 도구 ${on === list.length ? list.length : `${on}/${list.length}`}개` : 'MCP 도구' });
  }
  if (plugin.workspace) items.push({ icon: 'layers', text: '프로젝트·터미널 사용' });
  return items;
}

export function PluginSettings({ query = '' }: { query?: string }) {
  const bridge = pluginsBridge();
  const [state, setState] = useState<PluginsState | null>(null);
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState<(Notice & { where: string }) | null>(null);
  const [dropOver, setDropOver] = useState(false);
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
    const where = key.slice(0, key.lastIndexOf(':'));
    setBusy(key); setNotice(null);
    void step().then(value => { setState(value); if (value.message) setNotice({ where, text: value.message, error: false }); },
      (error: Error) => setNotice({ where, text: errorText(error), error: true })).finally(() => setBusy(''));
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
    run('global:zip', () => installPaths(paths));
  };

  return <div ref={rootRef} className={`plugins${dropOver ? ' plugin-drop-target' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    {dropOver && !filtering && <p className="plugin-drop-hint" aria-live="polite">zip을 놓으면 설치 확인 창이 뜹니다</p>}
    {!filtering && <p className="setting-note plugins-lead">MoonerADE에 없는 기능을 더합니다. 플러그인은 이 컴퓨터에서 MoonerADE와 같은 권한으로 실행되니, 믿을 수 있는 곳에서 받은 것만 설치하세요.</p>}
    {!filtering && state.error && !global?.error && <Callout tone="error">{state.error}</Callout>}
    {!filtering && global && <Callout tone={global.error ? 'error' : 'ok'}>{global.text}</Callout>}

    <Row query={query} title="플러그인 사용" hint={`${state.enabled ? '승인한 플러그인만 실행됩니다.' : '꺼져 있으면 설치한 플러그인이 실행되지 않습니다.'} 내장 플러그인은 각자 켜고 끕니다.`}>
      <input type="checkbox" role="switch" aria-label="플러그인 사용" checked={state.enabled} disabled={working} onChange={event => { const on = event.target.checked; run('global:enable', () => bridge.setEnabled(on)); }} />
    </Row>

    {(!filtering || shown.length > 0) && <>
    <div className="plugin-list-head">
      <h4 className="setting-group">설치된 플러그인{state.plugins.length > 0 && <span className="plugin-count">{state.plugins.length}</span>}</h4>
      <div className="plugin-toolbar">
        <IconButton icon="refresh" label="플러그인 폴더 다시 읽기" disabled={working} onClick={() => run('global:rescan', bridge.rescan)} />
        <IconButton icon="folder" label="플러그인 폴더 열기" disabled={working} onClick={() => run('global:folder', bridge.openFolder)} />
        <BusyButton className="primary" busy={working} running={busy === 'global:zip'} icon="plus" onClick={() => run('global:zip', bridge.pickZip)}>zip으로 설치</BusyButton>
      </div>
    </div>

    {shown.length === 0
      ? <div className="plugin-empty">
          <Icon name="plugin" size={28} />
          <strong>설치된 플러그인이 없습니다</strong>
          <p>MoonerADE 릴리스에서 받은 플러그인 zip을 여기로 끌어다 놓거나 <b>zip으로 설치</b>로 고르세요. 확인 창에서 설치하면 바로 실행됩니다.</p>
        </div>
      : <ul className="plugin-list">{shown.map(plugin => <li key={plugin.folder}><PluginRow plugin={plugin} onOpen={() => setSelected(plugin.folder)} /></li>)}</ul>}
    </>}

    {!filtering && <details className="plugin-about">
      <summary><Icon name="chevronRight" size={14} />설치 방법과 보안 안내</summary>
      <ul>
        <li>확인 창에서 <b>설치</b>를 누르기 전에는 아무것도 실행되지 않습니다. 이미 있는 플러그인은 업데이트되고 저장된 데이터는 남습니다.</li>
        <li>압축을 푼 폴더(안에 <span className="mono">plugin.json</span>이 있는 폴더)를 직접 넣었다면 플러그인을 열어 <b>승인하고 실행</b>을 누르세요.</li>
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
  const items = provides(plugin);
  return <button type="button" className="plugin-row setting-hit" data-tone={stateTone(plugin.state)} onClick={onOpen} aria-label={`${plugin.name} 열기`}>
    <span className="plugin-mark"><Icon name="plugin" size={18} /></span>
    <span className="plugin-row-text">
      <span className="plugin-row-name"><strong>{plugin.name}</strong>{plugin.version && <span className="plugin-version">v{plugin.version}</span>}{plugin.builtin && <span className="plugin-tag" data-tone="info">내장</span>}</span>
      {plugin.description && <span className="plugin-row-desc">{plugin.description}</span>}
      {items.length > 0 && <span className="plugin-row-provides">{items.map(item => <span key={item.icon}><Icon name={item.icon} size={12} />{item.text}</span>)}</span>}
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

  let callout: ReactNode = null;
  if (plugin.state === 'invalid') callout = <Callout tone="error">{plugin.error ?? '플러그인을 읽을 수 없습니다.'}<small>plugin.json과 폴더 구성을 고친 뒤 목록의 다시 읽기를 누르세요.</small></Callout>;
  else if (plugin.state === 'new' && id) callout = <Callout tone="warn" action={button('approve', enabled ? '승인하고 실행' : '켜고 승인', approve, { primary: true, icon: 'check' })}>
    아직 승인하지 않은 플러그인입니다. 아래 <b>제공하는 기능</b>을 확인하고, 믿을 수 있는 곳에서 받았다면 승인하세요.
  </Callout>;
  else if (plugin.state === 'changed' && id) callout = <Callout tone="error" action={button('approve', enabled ? '다시 승인' : '켜고 다시 승인', approve, { primary: true, icon: 'check' })}>
    승인한 뒤 파일이 바뀌어 실행을 멈췄습니다. 직접 업데이트한 것이 맞다면 다시 승인하세요.
  </Callout>;
  else if (plugin.state === 'error' && id) callout = <Callout tone="error" action={button('restart', '다시 시작', () => bridge.restart(id), { icon: 'refresh' })}>{plugin.error ?? '플러그인이 멈췄습니다.'}</Callout>;
  else if (plugin.state === 'stopped' && id) callout = <Callout tone="info" action={button('restart', '시작', () => bridge.restart(id), { icon: 'refresh' })}>실행하고 있지 않습니다.</Callout>;
  else if (plugin.state === 'off' && plugin.builtin) callout = <Callout tone="info" action={id ? button('builtin', '켜기', () => bridge.setBuiltin(id, true), { primary: true, icon: 'check' }) : undefined}>꺼져 있어 실행하지 않습니다. 켜면 새로 시작하는 채팅부터 적용됩니다.</Callout>;
  else if (plugin.state === 'off') callout = <Callout tone="info">플러그인 사용이 꺼져 있어 실행하지 않습니다. 목록 위의 <b>플러그인 사용</b>을 켜면 바로 실행됩니다.</Callout>;

  const view = plugin.view && id && hasContent(plugin.view) ? plugin.view : null;
  return <>
    <nav className="plugin-nav">
      <button ref={backRef} type="button" className="plugin-back" onClick={onBack}><Icon name="arrowLeft" size={16} />플러그인</button>
    </nav>
    <header className="plugin-detail-head" data-tone={tone}>
      <span className="plugin-mark large"><Icon name="plugin" size={24} /></span>
      <div className="plugin-title">
        <div><strong>{plugin.name}</strong>{plugin.version && <span className="plugin-version">v{plugin.version}</span>}</div>
        {plugin.description && <p>{plugin.description}</p>}
      </div>
      <StatePill state={plugin.state} />
    </header>
    {callout}
    {notice && <Callout tone={notice.error ? 'error' : 'ok'}>{notice.text}</Callout>}

    {plugin.state !== 'invalid' && <Section title="제공하는 기능" hint="이 플러그인이 더하는 기능과 권한입니다.">
      <Provides plugin={plugin} busy={busy} run={run} bridge={bridge} />
    </Section>}

    {view && id && <Section title="설정" hint="플러그인이 보여 주는 설정입니다.">
      <PluginBody view={view} id={id} busy={busy} where={plugin.folder} run={run} bridge={bridge} />
    </Section>}
    {!view && id && ['off', 'stopped', 'error'].includes(plugin.state) && <Section title="설정">
      <p className="plugin-muted">플러그인이 실행 중일 때 설정이 여기에 나옵니다.</p>
    </Section>}

    {plugin.builtin && id && <Section title="사용" hint="내장 플러그인이라 승인 없이 실행됩니다. 끄면 멈추고 에이전트에 주던 도구도 빠집니다. 설정은 남습니다.">
      <label className="plugin-switch-row">
        <span>{plugin.name} 사용</span>
        <input type="checkbox" role="switch" aria-label={`${plugin.name} 사용`} checked={plugin.builtinEnabled !== false} disabled={Boolean(busy)}
          onChange={event => run(`${plugin.folder}:builtin`, () => bridge.setBuiltin(id, event.target.checked))} />
      </label>
    </Section>}

    <Section title="정보">
      <PluginFacts plugin={plugin} />
    </Section>

    {id && !plugin.builtin && !['new', 'invalid'].includes(plugin.state) && <Section title="사용 중지" hint="플러그인을 멈추고 승인을 취소합니다. 저장된 키와 설정은 남고, 다시 쓰려면 승인해야 합니다.">
      <div>{button('revoke', '사용 중지', () => bridge.revoke(id), { icon: 'stop', className: 'danger' })}</div>
    </Section>}
  </>;
}

const hasContent = (view: PluginView) => Boolean(view.status || view.qr || view.info.length || view.fields.length || view.actions.length);

// Each thing the plugin adds, spelled out: its commands, its MCP tools (each can be turned off) and what it may do.
function Provides({ plugin, busy, run, bridge }: { plugin: PluginInfo; busy: string; run: Run; bridge: PluginsBridge }) {
  const blocks: ReactNode[] = [];
  if (plugin.terminal) {
    const env = plugin.env ?? [];
    blocks.push(<div key="terminal" className="plugin-cap">
      <span className="plugin-cap-icon"><Icon name="terminal" size={16} /></span>
      <div className="plugin-cap-text">
        <strong>터미널 명령</strong>
        <p>새로 여는 ADE 터미널에서 쓸 수 있는 명령을 더합니다.</p>
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
      <p>{plugin.builtin ? '열려 있는 채팅의 목록을 읽고 채팅에 메시지를 보냅니다.' : '이 PC의 프로젝트와 터미널을 열고 조작합니다. 원격 접속 같은 기능에 쓰입니다.'}</p>
    </div>
  </div>);
  blocks.push(<div key="process" className="plugin-cap">
    <span className="plugin-cap-icon"><Icon name="cpu" size={16} /></span>
    <div className="plugin-cap-text">
      <strong>별도 프로세스</strong>
      <p>{plugin.builtin ? '플러그인이 자기 프로세스로 실행됩니다.' : '승인하면 플러그인이 자기 프로세스로 실행됩니다.'}{plugin.badge ? ' 실행 중에는 상태바에 표시가 나옵니다.' : ''}</p>
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
  else if (!running) body = <p className="plugin-muted">플러그인이 실행되면 MCP 서버에 물어 도구 목록을 보여 줍니다.</p>;
  else if (!tools?.offered) body = <p className="plugin-muted">플러그인이 아직 에이전트에 도구를 주고 있지 않습니다. 아래 <b>설정</b>을 마치면 도구 목록이 나옵니다.</p>;
  else body = <p className="plugin-muted">도구 목록을 아직 불러오지 않았습니다.</p>;

  return <div className="plugin-cap plugin-cap-mcp">
    <span className="plugin-cap-icon"><Icon name="bot" size={16} /></span>
    <div className="plugin-cap-text">
      <div className="plugin-cap-head">
        <div>
          <strong>에이전트 도구 (MCP)</strong>
          <p>{plugin.mcpChatOnly ? <>ADE 채팅의 AI 에이전트에 MCP 서버 <code>{plugin.mcp}</code>를 줍니다(터미널에는 주지 않습니다).</> : <>ADE 터미널과 채팅에서 실행한 Claude Code·Codex에 MCP 서버 <code>{plugin.mcp}</code>를 줍니다.</>} 바꾼 설정은 새로 시작하는 에이전트부터 적용됩니다.</p>
        </div>
        <div className="plugin-cap-controls">
          {running && tools?.offered && <IconButton icon="refresh" label="도구 목록 다시 불러오기" disabled={working || tools.status === 'loading'} onClick={() => run(`${plugin.folder}:tools`, () => bridge.refreshTools(id))} />}
          <input type="checkbox" role="switch" aria-label="MCP 서버 사용" checked={serverOn} disabled={working} onChange={event => set({ enabled: event.target.checked }, 'mcp')} />
        </div>
      </div>
      {!serverOn && <p className="plugin-muted">꺼져 있어 에이전트에 이 서버를 주지 않습니다.</p>}
      {serverOn && list && list.length > 0 && <p className="plugin-muted">도구 {list.length}개 중 {onCount}개 사용{onCount < list.length ? ' · 끈 도구가 있으면 Cursor 채팅에는 이 서버를 주지 않습니다' : ''}</p>}
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

// What a running plugin shows: status, QR code, read-only values, inputs and its buttons. Enter in an input runs the primary button.
function PluginBody({ view, id, busy, where, run, bridge }: { view: PluginView; id: string; busy: string; where: string; run: Run; bridge: PluginsBridge }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState('');
  // Fields start from what the plugin reports and keep the user's edits until the plugin sends a new value.
  useEffect(() => { setValues(Object.fromEntries(view.fields.map(field => [field.key, field.value]))); }, [JSON.stringify(view.fields.map(field => [field.key, field.value]))]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(''), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const act = (action: string) => run(`${where}:action-${action}`, () => bridge.action(id, action, values));
  const primary = view.actions.filter(action => action.primary);

  return <div className="plugin-body">
    {view.status && <p className="plugin-status" data-tone={view.status.tone}><Icon name={toneIcon[view.status.tone]} size={14} />{view.status.text}</p>}
    {view.qr && <div className="plugin-qr-row"><QrCode text={view.qr.value} label={view.qr.label} size={168} />{view.qr.label && <p>{view.qr.label}</p>}</div>}
    {view.info.length > 0 && <dl className="plugin-info">{view.info.map(item => <div key={item.label}>
      <dt>{item.label}</dt>
      <dd><span className={item.mono ? 'mono' : undefined}>{item.value || '—'}</span>
        {item.copy && item.value && <IconButton icon={copied === item.label ? 'check' : 'copy'} label={copied === item.label ? '복사했습니다' : `${item.label} 복사`} onClick={() => { copyText(item.value); setCopied(item.label); }} />}
      </dd>
    </div>)}</dl>}
    {(view.fields.length > 0 || view.actions.length > 0) && <form className="plugin-form" onSubmit={event => { event.preventDefault(); if (primary.length === 1 && !busy) act(primary[0].id); }}>
      {view.fields.map(field => {
        const value = values[field.key] ?? '', set = (next: string) => setValues(current => ({ ...current, [field.key]: next }));
        if (field.type === 'switch') return <label key={field.key} className="plugin-field plugin-field-switch">
          <span>{field.label}</span>
          <input type="checkbox" role="switch" aria-label={field.label} checked={value === 'true'} onChange={event => set(String(event.target.checked))} />
          {field.hint && <small>{field.hint}</small>}
        </label>;
        return <label key={field.key} className="plugin-field">
          <span>{field.label}</span>
          {field.type === 'select' && field.options
            ? <select value={value} onChange={event => set(event.target.value)}>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            : <input type={field.type === 'number' ? 'number' : 'text'} inputMode={field.type === 'number' ? 'numeric' : undefined} value={value} placeholder={field.placeholder} spellCheck={false} onChange={event => set(event.target.value)} />}
          {field.hint && <small>{field.hint}</small>}
        </label>;
      })}
      {view.actions.length > 0 && <div className="plugin-actions">
        {view.actions.map(action => <BusyButton key={action.id} className={action.primary ? 'primary' : undefined} busy={Boolean(busy)} running={busy === `${where}:action-${action.id}`} onClick={() => act(action.id)}>{action.label}</BusyButton>)}
      </div>}
    </form>}
  </div>;
}
