import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { Icon, IconButton, type IconName } from './Icon';
import { copyText } from './toast';

// Mirrors snapshot() in apps/desktop/src/plugin-core.js. Turning plugins on, approving one and installing a zip are
// confirmed by the desktop app in native dialogs; these calls only start them. What a plugin shows here is plain text, never markup.
type Tone = 'ok' | 'warn' | 'error' | 'info';
export type PluginView = {
  status: { tone: Tone; text: string } | null;
  info: { label: string; value: string; mono: boolean; copy: boolean }[];
  fields: { key: string; label: string; value: string; placeholder: string; hint: string }[];
  actions: { id: string; label: string; primary: boolean }[];
  qr?: { label: string; value: string } | null;
};
export type PluginBadge = { text: string; tone: Tone };
export type PluginInfo = {
  folder: string; id: string | null; name: string; version: string | null; description: string; hash: string | null;
  state: 'invalid' | 'new' | 'changed' | 'off' | 'starting' | 'running' | 'error' | 'stopped';
  error: string | null; terminal: boolean; mcp: string | null; workspace?: boolean; view: PluginView | null; badge?: PluginBadge | null;
};
export type PluginsState = { available: boolean; problem: 'unavailable' | 'unreadable' | null; error: string | null; enabled: boolean; dir: string; plugins: PluginInfo[]; message?: string | null };
type PluginsBridge = {
  state(): Promise<PluginsState>; onState(listener: (state: PluginsState) => void): () => void;
  setEnabled(on: boolean): Promise<PluginsState>; rescan(): Promise<PluginsState>; approve(folder: string): Promise<PluginsState>;
  revoke(id: string, options?: { forget?: boolean }): Promise<PluginsState>; restart(id: string): Promise<PluginsState>;
  action(id: string, action: string, values: Record<string, string>): Promise<PluginsState>; openFolder(): Promise<PluginsState>;
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

export function PluginSettings({ query = '' }: { query?: string }) {
  const bridge = pluginsBridge();
  const [state, setState] = useState<PluginsState | null>(null);
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState<(Notice & { where: string }) | null>(null);
  const [dropOver, setDropOver] = useState(false);
  const matches = (text: string) => !query.trim() || text.toLowerCase().includes(query.trim().toLowerCase());
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.state().then(value => { if (live) setState(value); }, () => {});
    const off = bridge.onState(value => setState(value));
    return () => { live = false; off(); };
  }, [bridge]);
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
  const global = noticeFor('global');
  const plugins = [...state.plugins].sort((a, b) => Number(needsUser(b)) - Number(needsUser(a)));
  const shown = plugins.filter(plugin => matches(`${plugin.name} ${plugin.description ?? ''}`));
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

  return <div className={`plugins${dropOver ? ' plugin-drop-target' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    {dropOver && !filtering && <p className="plugin-drop-hint" aria-live="polite">zip을 놓으면 설치 확인 창이 뜹니다</p>}
    {!filtering && <p className="setting-note plugins-lead">MoonerADE에 없는 기능을 더합니다. 플러그인은 이 컴퓨터에서 MoonerADE와 같은 권한으로 실행되니, 믿을 수 있는 곳에서 받은 것만 설치하세요.</p>}
    {!filtering && state.error && !global?.error && <Callout tone="error">{state.error}</Callout>}
    {!filtering && global && <Callout tone={global.error ? 'error' : 'ok'}>{global.text}</Callout>}

    <Row query={query} title="플러그인 사용" hint={state.enabled ? '승인한 플러그인만 실행됩니다.' : '꺼져 있으면 어떤 플러그인도 실행되지 않습니다. 켤 때 확인 창이 뜹니다.'}>
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
      : <div className="plugin-list">{shown.map(plugin => <PluginCard key={plugin.folder} plugin={plugin} enabled={state.enabled} busy={busy} notice={noticeFor(plugin.folder)} run={run} bridge={bridge} />)}</div>}
    </>}

    {!filtering && <details className="plugin-about">
      <summary><Icon name="chevronRight" size={14} />설치 방법과 보안 안내</summary>
      <ul>
        <li>zip을 플러그인 폴더에 넣어도 확인 창에서 <b>설치</b>를 누르기 전에는 아무것도 실행되지 않습니다. 이미 있는 플러그인이면 업데이트되고, 저장된 데이터는 남습니다.</li>
        <li>압축을 푼 폴더(안에 <span className="mono">plugin.json</span>이 있는 폴더)를 직접 넣었다면 카드의 <b>승인하고 실행</b>을 누르세요.</li>
        <li>승인은 그때의 파일 내용에 고정됩니다. 파일이 바뀌면 다시 승인할 때까지 실행되지 않습니다.</li>
        <li>확인 창의 SHA-256을 배포처의 <span className="mono">SHA256SUMS</span>와 맞춰 보면 받은 파일이 그대로인지 알 수 있습니다.</li>
      </ul>
      <p>플러그인 폴더 <span className="mono">{state.dir}</span></p>
    </details>}
  </div>;
}

function PluginCard({ plugin, enabled, busy, notice, run, bridge }: { plugin: PluginInfo; enabled: boolean; busy: string; notice: Notice | null; run: Run; bridge: PluginsBridge }) {
  const id = plugin.id, tone = stateTone(plugin.state);
  const grants: { icon: IconName; text: string }[] = [];
  if (plugin.terminal) grants.push({ icon: 'terminal', text: '터미널 명령' });
  if (plugin.mcp) grants.push({ icon: 'bot', text: `에이전트 도구 · ${plugin.mcp}` });
  if (plugin.workspace) grants.push({ icon: 'layers', text: '프로젝트·터미널 사용' });
  const button = (step: string, label: string, action: () => Promise<PluginsState>, options: { primary?: boolean; icon?: IconName; title?: string } = {}) =>
    <BusyButton className={options.primary ? 'primary' : undefined} busy={Boolean(busy)} running={busy === `${plugin.folder}:${step}`} icon={options.icon} title={options.title}
      onClick={() => run(`${plugin.folder}:${step}`, action)}>{label}</BusyButton>;
  // Approving needs the plugin feature on; when it is off, turn it on first (two native dialogs, either can be cancelled).
  const approve = async () => {
    if (!enabled) { const next = await bridge.setEnabled(true); if (!next.enabled) return next; }
    return bridge.approve(plugin.folder);
  };
  const hash = plugin.hash && <details className="plugin-hash"><summary>SHA-256 보기</summary><span className="mono">{plugin.hash}</span></details>;

  let callout: ReactNode = null;
  if (plugin.state === 'invalid') callout = <Callout tone="error">{plugin.error ?? '플러그인을 읽을 수 없습니다.'}<small>plugin.json과 폴더 구성을 고친 뒤 위의 다시 읽기를 누르세요.</small></Callout>;
  else if (plugin.state === 'new' && id) callout = <Callout tone="warn" action={button('approve', enabled ? '승인하고 실행' : '켜고 승인', approve, { primary: true, icon: 'check' })}>
    아직 승인하지 않은 플러그인입니다. 믿을 수 있는 곳에서 받았다면 승인하세요.{hash}
  </Callout>;
  else if (plugin.state === 'changed' && id) callout = <Callout tone="error" action={button('approve', enabled ? '다시 승인' : '켜고 다시 승인', approve, { primary: true, icon: 'check' })}>
    승인한 뒤 파일이 바뀌어 실행을 멈췄습니다. 직접 업데이트한 것이 맞다면 다시 승인하세요.{hash}
  </Callout>;
  else if (plugin.state === 'error' && id) callout = <Callout tone="error" action={button('restart', '다시 시작', () => bridge.restart(id), { icon: 'refresh' })}>{plugin.error ?? '플러그인이 멈췄습니다.'}</Callout>;
  else if (plugin.state === 'stopped' && id) callout = <Callout tone="info" action={button('restart', '시작', () => bridge.restart(id), { icon: 'refresh' })}>실행하고 있지 않습니다.</Callout>;
  else if (plugin.state === 'off') callout = <Callout tone="info">플러그인 사용이 꺼져 있어 실행하지 않습니다. 위의 <b>플러그인 사용</b>을 켜면 바로 실행됩니다.</Callout>;

  return <article className="plugin-card setting-hit" data-tone={tone} aria-label={plugin.name}>
    <header className="plugin-head">
      <span className="plugin-mark"><Icon name="plugin" size={18} /></span>
      <div className="plugin-title">
        <div><strong>{plugin.name}</strong>{plugin.version && <span className="plugin-version">v{plugin.version}</span>}</div>
        {plugin.description && <p>{plugin.description}</p>}
      </div>
      <span className="plugin-pill" data-tone={tone}>{plugin.state === 'starting' ? <span className="plugin-spinner" aria-hidden="true" /> : <i aria-hidden="true" />}{stateLabel[plugin.state]}</span>
    </header>
    {grants.length > 0 && <ul className="plugin-grants" aria-label="권한">{grants.map(grant => <li key={grant.text} className="chip" title="이 플러그인이 받는 권한"><Icon name={grant.icon} size={12} />{grant.text}</li>)}</ul>}
    {callout}
    {plugin.view && id && <PluginBody view={plugin.view} id={id} busy={busy} where={plugin.folder} run={run} bridge={bridge} />}
    {notice && <Callout tone={notice.error ? 'error' : 'ok'}>{notice.text}</Callout>}
    {id && !['new', 'invalid'].includes(plugin.state) && <footer className="plugin-foot">
      {button('revoke', '사용 중지', () => bridge.revoke(id), { icon: 'stop', title: '플러그인을 멈추고 승인을 거둡니다. 다시 쓰려면 승인해야 하고, 플러그인이 저장한 키와 설정은 남습니다.' })}
    </footer>}
  </article>;
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
  if (!view.status && !view.qr && view.info.length === 0 && view.fields.length === 0 && view.actions.length === 0) return null;
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
      {view.fields.map(field => <label key={field.key} className="plugin-field">
        <span>{field.label}</span>
        <input type="text" value={values[field.key] ?? ''} placeholder={field.placeholder} spellCheck={false} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} />
        {field.hint && <small>{field.hint}</small>}
      </label>)}
      {view.actions.length > 0 && <div className="plugin-actions">
        {view.actions.map(action => <BusyButton key={action.id} className={action.primary ? 'primary' : undefined} busy={Boolean(busy)} running={busy === `${where}:action-${action.id}`} onClick={() => act(action.id)}>{action.label}</BusyButton>)}
      </div>}
    </form>}
  </div>;
}
