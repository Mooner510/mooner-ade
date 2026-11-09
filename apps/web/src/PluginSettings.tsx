import { useEffect, useMemo, useState, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { Icon } from './Icon';
import { toastCopied } from './toast';

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
  pickZip(): Promise<PluginsState>; onOpen?(listener: () => void): () => void;
};
const pluginsBridge = () => (window as unknown as { adeDesktop?: { plugins?: PluginsBridge } }).adeDesktop?.plugins;
const writeClipboard = (text: string) => {
  const desktop = (window as unknown as { adeDesktop?: { writeClipboard?(text: string): void } }).adeDesktop;
  if (desktop?.writeClipboard) desktop.writeClipboard(text); else void navigator.clipboard?.writeText(text);
  toastCopied();
};
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

const stateLabel: Record<PluginInfo['state'], string> = {
  invalid: '읽을 수 없음', new: '승인 필요', changed: '파일이 바뀜 · 다시 승인 필요', off: '플러그인 꺼짐',
  starting: '시작하는 중…', running: '실행 중', error: '오류', stopped: '멈춤'
};

function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong>{hint && <small>{hint}</small>}</div><div className="setting-control">{children}</div></div>;
}

export function PluginSettings() {
  const bridge = pluginsBridge();
  const [state, setState] = useState<PluginsState | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.state().then(value => { if (live) setState(value); }, () => {});
    const off = bridge.onState(value => setState(value));
    return () => { live = false; off(); };
  }, [bridge]);
  if (!bridge) return <p className="setting-note">플러그인은 데스크톱 앱에서만 쓸 수 있습니다.</p>;
  if (!state) return <p className="setting-note">불러오는 중…</p>;
  const run = (step: () => Promise<PluginsState>) => {
    setBusy(true); setMessage(null);
    void step().then(value => { setState(value); if (value.message) setMessage({ text: value.message, error: false }); }, (error: Error) => setMessage({ text: errorText(error), error: true })).finally(() => setBusy(false));
  };

  const intro = <p className="setting-note">
    플러그인은 MoonerADE가 기본으로 갖고 있지 않은 기능을 더합니다. MoonerADE 릴리스에서 받은 플러그인 zip을 플러그인 폴더에 넣거나 “zip 파일 선택”으로 고르면, 확인 창에서 설치할 수 있습니다.
    플러그인은 이 컴퓨터에서 MoonerADE와 같은 권한으로 실행되므로, 믿을 수 있는 곳에서 받은 것만 승인하세요. 파일이 바뀐 플러그인은 다시 승인할 때까지 실행되지 않습니다.
  </p>;
  if (!state.available) return <>{intro}<p className="setting-note">이 컴퓨터에서는 설정을 안전하게 암호화할 수 없어 플러그인을 쓸 수 없습니다.</p></>;

  return <>
    {intro}
    {(message?.error || state.error) && <p className="setting-note setting-error" role="alert"><Icon name="alert" size={14} /> {message?.error ? message.text : state.error}</p>}
    {message && !message.error && <p className="setting-note plugin-message" role="status"><Icon name="check" size={14} /> {message.text}</p>}

    <Row title="플러그인 사용" hint="켤 때 확인 창이 뜹니다. 켜도 플러그인마다 따로 승인해야 실행됩니다.">
      <input type="checkbox" role="switch" aria-label="플러그인 사용" checked={state.enabled} disabled={busy} onChange={event => run(() => bridge.setEnabled(event.target.checked))} />
    </Row>
    <Row title="플러그인 폴더" hint={<span className="mono">{state.dir}</span>}>
      <button disabled={busy} onClick={() => run(bridge.pickZip)}><Icon name="archive" />zip 파일 선택</button>
      <button disabled={busy} onClick={() => run(bridge.openFolder)}><Icon name="folder" />열기</button>
      <button disabled={busy} onClick={() => run(bridge.rescan)}><Icon name="refresh" />다시 읽기</button>
    </Row>

    <h4 className="setting-group">설치된 플러그인</h4>
    {state.plugins.length === 0 && <p className="setting-note">플러그인 폴더가 비어 있습니다.</p>}
    {state.plugins.map(plugin => <PluginCard key={plugin.folder} plugin={plugin} enabled={state.enabled} busy={busy} run={run} bridge={bridge} />)}
  </>;
}

function PluginCard({ plugin, enabled, busy, run, bridge }: { plugin: PluginInfo; enabled: boolean; busy: boolean; run(step: () => Promise<PluginsState>): void; bridge: PluginsBridge }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const view = plugin.view;
  // Fields start from what the plugin reports and keep the user's edits until the plugin sends a new value.
  useEffect(() => { setValues(Object.fromEntries((view?.fields ?? []).map(field => [field.key, field.value]))); }, [JSON.stringify(view?.fields?.map(field => [field.key, field.value]))]);
  const id = plugin.id;
  const grants = [plugin.terminal && '터미널 명령', plugin.mcp && `에이전트 MCP 도구(${plugin.mcp})`, plugin.workspace && '프로젝트·터미널 사용'].filter(Boolean).join(', ');
  const tone = plugin.state === 'running' ? 'ok' : ['invalid', 'error', 'changed'].includes(plugin.state) ? 'error' : 'warn';

  return <section className="plugin-card">
    <Row title={<>{plugin.name}{plugin.version && <span className="plugin-version"> {plugin.version}</span>}</>}
      hint={<>{plugin.description && <>{plugin.description}<br /></>}<span className={`plugin-state ${tone}`}>{stateLabel[plugin.state]}</span>{grants && ` · ${grants}`}</>}>
      {id && enabled && ['new', 'changed'].includes(plugin.state) && <button className="primary" disabled={busy} onClick={() => run(() => bridge.approve(plugin.folder))}><Icon name="check" />승인</button>}
      {id && plugin.state === 'error' && <button disabled={busy} onClick={() => run(() => bridge.restart(id))}><Icon name="refresh" />다시 시작</button>}
      {id && !['new', 'invalid'].includes(plugin.state) && <button disabled={busy} onClick={() => run(() => bridge.revoke(id))} title="승인을 거두고 멈춥니다. 플러그인이 저장한 키와 설정은 남습니다.">승인 취소</button>}
    </Row>
    {plugin.error && <p className="setting-note setting-error"><Icon name="alert" size={14} /> {plugin.error}</p>}
    {plugin.hash && ['new', 'changed'].includes(plugin.state) && <p className="setting-note">SHA-256 <span className="mono plugin-hash">{plugin.hash}</span></p>}

    {view && id && <div className="plugin-view">
      {view.status && <p className={`plugin-status ${view.status.tone}`}>{view.status.text}</p>}
      {view.qr && <div className="plugin-qr-row"><QrCode text={view.qr.value} label={view.qr.label} />{view.qr.label && <p>{view.qr.label}</p>}</div>}
      {view.info.map(item => <Row key={item.label} title={item.label} hint={<span className={item.mono ? 'mono plugin-value' : 'plugin-value'}>{item.value}</span>}>
        {item.copy && item.value && <button onClick={() => writeClipboard(item.value)}><Icon name="copy" />복사</button>}
      </Row>)}
      {view.fields.map(field => <Row key={field.key} title={field.label} hint={field.hint || undefined}>
        <input type="text" aria-label={field.label} value={values[field.key] ?? ''} placeholder={field.placeholder} spellCheck={false} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} />
      </Row>)}
      {view.actions.length > 0 && <div className="actions plugin-actions">
        {view.actions.map(action => <button key={action.id} className={action.primary ? 'primary' : undefined} disabled={busy} onClick={() => run(() => bridge.action(id, action.id, values))}>{action.label}</button>)}
      </div>}
    </div>}
  </section>;
}
