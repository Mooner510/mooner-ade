import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Dropdown } from './views';

// Mirrors snapshot() in apps/desktop/src/remote.js. The page never sees keys or tokens; every step that grants access is
// confirmed by the desktop app in a native dialog, so these calls only start things.
export type RemoteSession = { sessionId: string; deviceId: string; name: string; scope: 'view' | 'control'; transport: string; since: number };
export type RemoteState = {
  available: boolean; problem: 'unavailable' | 'unreadable' | null; error: string | null;
  enabled: boolean; linked: boolean; account: { name: string; email: string } | null; hostId: string | null; fingerprint: string | null;
  devices: { id: string; name: string; scope: 'view' | 'control'; addedAt: number; lastSeenAt: number | null }[];
  enrolling: { userCode: string; verifyUrl: string; expiresAt: number } | null;
  pairing: { uri: string; expiresAt: number } | null;
  hub: 'off' | 'connecting' | 'online'; sessions: RemoteSession[];
};
type RemoteBridge = {
  state(): Promise<RemoteState>; onState(listener: (state: RemoteState) => void): () => void;
  connect(): Promise<RemoteState>; cancelConnect(): Promise<RemoteState>; unlink(): Promise<RemoteState>;
  setEnabled(on: boolean): Promise<RemoteState>; startPairing(): Promise<RemoteState>; cancelPairing(): Promise<RemoteState>;
  setScope(id: string, scope: 'view' | 'control'): Promise<RemoteState>; removeDevice(id: string): Promise<RemoteState>;
  endSession(id: string): Promise<RemoteState>; rotateKey(): Promise<RemoteState>;
};
export const remoteBridge = () => (window as unknown as { adeDesktop?: { remote?: RemoteBridge } }).adeDesktop?.remote;

// Live state from the desktop app; null outside it (a browser tab on the local server has no remote access settings).
export function useRemoteState() {
  const [state, setState] = useState<RemoteState | null>(null);
  useEffect(() => {
    const bridge = remoteBridge();
    if (!bridge) return;
    let live = true;
    void bridge.state().then(value => { if (live) setState(value); }, () => {});
    const off = bridge.onState(value => setState(value));
    return () => { live = false; off(); };
  }, []);
  return [state, setState] as const;
}

function Row({ title, hint, children }: { title: string; hint?: ReactNode; children?: ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong>{hint && <small>{hint}</small>}</div><div className="setting-control">{children}</div></div>;
}

// Drawn from the module grid as SVG elements, so nothing is injected as markup.
function QrCode({ text, size = 220 }: { text: string; size?: number }) {
  const cells = useMemo(() => {
    const code = qrcode(0, 'M');
    code.addData(text, 'Byte'); code.make();
    const count = code.getModuleCount(), path: string[] = [];
    for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (code.isDark(row, col)) path.push(`M${col + 4} ${row + 4}h1v1h-1z`);
    return { count: count + 8, path: path.join('') };
  }, [text]);
  return <svg className="remote-qr" width={size} height={size} viewBox={`0 0 ${cells.count} ${cells.count}`} role="img" aria-label="폰 페어링 QR 코드" shapeRendering="crispEdges">
    <rect width={cells.count} height={cells.count} fill="#fff" /><path d={cells.path} fill="#000" />
  </svg>;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  return now;
}
const left = (until: number, now: number) => { const seconds = Math.max(0, Math.round((until - now) / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
const date = (value: number | null) => value ? new Date(value).toLocaleString() : '아직 없음';
const scopeLabel = { view: '보기만', control: '제어' } as const;
const hubLabel = { off: '꺼짐', connecting: '연결 중…', online: '연결됨' } as const;

export function RemoteSettings() {
  const bridge = remoteBridge(), [state, setState] = useRemoteState();
  const [busy, setBusy] = useState(false), [shown, setShown] = useState(false), [message, setMessage] = useState('');
  const now = useNow(Boolean(state?.pairing || state?.enrolling));
  useEffect(() => { if (!state?.pairing) setShown(false); }, [state?.pairing?.uri]);
  if (!bridge) return <p className="setting-note">원격 접속은 데스크톱 앱에서만 설정할 수 있습니다.</p>;
  if (!state) return <p className="setting-note">불러오는 중…</p>;
  const run = (step: () => Promise<RemoteState>) => {
    setBusy(true); setMessage('');
    void step().then(setState, (error: Error) => setMessage(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))).finally(() => setBusy(false));
  };

  const intro = <p className="setting-note">
    MoonerADE 원격 접속 권한이 있는 계정을 연결하면, 그 계정으로 로그인한 Android 앱에서 이 PC의 프로젝트와 터미널에 접속할 수 있습니다.
    기본으로 꺼져 있고, 켜도 이 PC에서 QR로 직접 페어링하고 승인한 폰만 접속합니다. 연결은 폰과 이 PC 사이에서 끝단 암호화되어 중계 서버도 내용을 볼 수 없습니다.
  </p>;
  if (!state.available) return <>{intro}<p className="setting-note">이 컴퓨터에서는 설정을 안전하게 암호화할 수 없어 원격 접속을 쓸 수 없습니다.</p></>;

  return <>
    {intro}
    {(state.error || message) && <p className="setting-note remote-error" role="alert"><Icon name="alert" size={14} /> {message || state.error}</p>}

    <h4 className="setting-group">계정</h4>
    {state.linked ? <Row title="연결된 계정" hint={state.account?.email || undefined}>
      <span>{state.account?.name || state.account?.email}</span>
      <button disabled={busy} onClick={() => run(bridge.unlink)}>연결 해제</button>
    </Row> : state.enrolling ? <Row title="브라우저에서 로그인하세요" hint={<>열린 브라우저 창에서 로그인하고 아래 코드가 같은지 확인한 뒤 승인하세요. 창이 열리지 않았으면 <span className="mono">{state.enrolling.verifyUrl}</span> 을 여세요. 남은 시간 {left(state.enrolling.expiresAt, now)}</>}>
      <code className="remote-code">{state.enrolling.userCode}</code>
      <button disabled={busy} onClick={() => run(bridge.cancelConnect)}>취소</button>
    </Row> : <Row title="계정 연결" hint="브라우저에서 mooner510 계정으로 로그인합니다. 계정이 없거나 원격 접속 권한이 없으면 이 기능은 쓸 수 없습니다.">
      <button disabled={busy} onClick={() => run(bridge.connect)}><Icon name="externalLink" />계정 연결</button>
    </Row>}

    {state.linked && <>
      <h4 className="setting-group">이 PC</h4>
      <Row title="원격 접속" hint={state.enabled ? `중계 서버: ${hubLabel[state.hub]}` : '켜면 페어링한 폰이 이 PC에 접속할 수 있습니다. 켤 때 확인 창이 뜹니다.'}>
        <input type="checkbox" role="switch" aria-label="원격 접속" checked={state.enabled} disabled={busy} onChange={event => run(() => bridge.setEnabled(event.target.checked))} />
      </Row>
      {state.fingerprint && <Row title="PC 키 지문" hint="폰 앱이 보여 주는 PC 지문과 같아야 합니다. 키가 유출되었다고 의심되면 새로 만드세요. 페어링한 폰은 모두 해제됩니다.">
        <span className="mono">{state.fingerprint}</span>
        <button disabled={busy} onClick={() => run(bridge.rotateKey)}>키 새로 만들기</button>
      </Row>}
    </>}

    {state.enabled && <>
      <h4 className="setting-group">폰</h4>
      {state.pairing ? <div className="remote-pairing">
        {shown ? <QrCode text={state.pairing.uri} /> : <button className="remote-qr-cover" onClick={() => setShown(true)}><Icon name="info" />QR 보기<small>화면을 다른 사람이 보고 있지 않을 때 여세요</small></button>}
        <div>
          <p>MoonerADE Android 앱에서 <strong>PC 추가</strong>를 누르고 이 QR을 스캔하세요. 스캔하면 이 PC에 승인 창이 뜹니다.</p>
          <p className="setting-note">한 번만 쓸 수 있고 {left(state.pairing.expiresAt, now)} 뒤에 만료됩니다. QR에는 페어링 비밀이 들어 있으니 찍어서 공유하지 마세요.</p>
          <div className="actions"><button onClick={() => run(bridge.cancelPairing)}>취소</button></div>
        </div>
      </div> : <Row title="폰 추가" hint="5분 동안 쓸 수 있는 1회용 QR을 만듭니다.">
        <button disabled={busy} onClick={() => run(bridge.startPairing)}><Icon name="plus" />폰 추가</button>
      </Row>}
      {state.devices.length === 0 && <p className="setting-note">페어링한 폰이 없습니다.</p>}
      {state.devices.map(device => <Row key={device.id} title={device.name || '이름 없는 폰'} hint={`추가 ${date(device.addedAt)} · 마지막 접속 ${date(device.lastSeenAt)} · 90일 동안 쓰지 않으면 해제됩니다.`}>
        <Dropdown label={`${device.name || '폰'} 권한`} value={device.scope} options={[{ value: 'view', label: '보기만' }, { value: 'control', label: '제어' }]}
          onChange={value => run(() => bridge.setScope(device.id, value as 'view' | 'control'))} />
        <button disabled={busy} onClick={() => run(() => bridge.removeDevice(device.id))}>해제</button>
      </Row>)}

      <h4 className="setting-group">접속 중</h4>
      {state.sessions.length === 0 ? <p className="setting-note">지금 접속한 폰이 없습니다.</p> : state.sessions.map(session =>
        <Row key={session.sessionId} title={session.name} hint={`${scopeLabel[session.scope]} · ${session.transport === 'direct' ? '직접 연결' : '중계'} · ${new Date(session.since).toLocaleTimeString()}부터`}>
          <button onClick={() => run(() => bridge.endSession(session.sessionId))}><Icon name="x" />끊기</button>
        </Row>)}
    </>}
  </>;
}

// Always in the status bar while a phone is connected (not one of the items that can be hidden), so remote use is never silent.
export function RemoteStat({ onOpen }: { onOpen(): void }) {
  const [state] = useRemoteState();
  if (!state?.enabled) return null;
  const sessions = state.sessions, names = [...new Set(sessions.map(item => item.name))].join(', ');
  if (sessions.length === 0) return <span className="stat remote-stat" title={`원격 접속 켜짐 · 중계 서버 ${hubLabel[state.hub]}`}><Icon name="wifi" size={13} /></span>;
  return <button className="remote-stat live" title={`원격 접속 중: ${names}${sessions.some(item => item.scope === 'control') ? ' (제어)' : ' (보기만)'}`} onClick={onOpen}>
    <Icon name="wifi" size={13} />{names}
  </button>;
}
