import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { errorText } from './errors';
import { Modal } from './views';

// "다른 PC에 접속": opens the ADE of another PC of the same account in a window of its own (docs/REMOTE_UI.md, PC ↔ PC). The desktop app
// does the work (apps/desktop/src/remote.js); this dialog signs in, lists the account's PCs, pairs a new one from the link its owner made
// there, and opens one.
type Host = { hostId: string; name: string; self: boolean; platform: string; online: boolean; paired: boolean; scope: 'view' | 'control' | null; fingerprint: string | null; keyChanged: boolean; inAccount: boolean; canRequest?: boolean };
type Offer = { hostId: string; name: string; hostFingerprint: string; myFingerprint: string; alreadyPaired: boolean };
type RemoteState = { available: boolean; hubHost: string | null; signedIn: boolean; account: string | null; fingerprint: string | null; open: string[] };
export type RemoteBridge = {
  state(): Promise<RemoteState>; signInStart(): Promise<{ userCode: string; expiresAt: number }>; signInWait(): Promise<{ account: string }>; signInCancel(): Promise<void>; signOut(): Promise<void>;
  hosts(): Promise<Host[]>; offer(link: string): Promise<Offer>; pair(link: string): Promise<{ hostId: string; name: string; scope: 'view' | 'control' }>; requestStart(hostId: string, scope?: 'view' | 'control'): Promise<{ code: string; hostId: string }>; requestWait(): Promise<{ hostId: string; name: string; scope: 'view' | 'control' }>; requestCancel(): Promise<void>;
  forget(hostId: string): Promise<void>; open(hostId: string): Promise<{ reused: boolean }>;
};
export const remoteBridge = () => (window as unknown as { adeDesktop?: { remote?: RemoteBridge } }).adeDesktop?.remote;
const platformName = (platform: string) => ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' } as Record<string, string>)[platform] ?? platform;

export function RemotePcDialog({ onClose }: { onClose(): void }) {
  const bridge = remoteBridge()!;
  const [state, setState] = useState<RemoteState | null>(null), [hosts, setHosts] = useState<Host[] | null>(null), [error, setError] = useState('');
  const [code, setCode] = useState<string | null>(null), [link, setLink] = useState(''), [offer, setOffer] = useState<Offer | null>(null), [busy, setBusy] = useState('');
  const [asking, setAsking] = useState<{ hostId: string; code: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; void bridge.signInCancel().catch(() => {}); void bridge.requestCancel?.().catch(() => {}); }, [bridge]);
  const run = useCallback(async <T,>(what: string, work: () => Promise<T>): Promise<T | undefined> => {
    setError(''); setBusy(what);
    try { return await work(); } catch (cause) { if (alive.current) setError(errorText(cause)); return undefined; } finally { if (alive.current) setBusy(''); }
  }, []);
  const load = useCallback(async () => {
    const next = await run('load', () => bridge.state());
    if (!next || !alive.current) return;
    setState(next);
    if (next.signedIn) { const list = await run('load', () => bridge.hosts()); if (list && alive.current) setHosts(list); }
  }, [bridge, run]);
  useEffect(() => { void load(); }, [load]);

  const signIn = () => void run('sign-in', async () => {
    const started = await bridge.signInStart();
    setCode(started.userCode);
    try { await bridge.signInWait(); } finally { if (alive.current) setCode(null); }
    await load();
  });
  const check = () => void run('offer', async () => setOffer(await bridge.offer(link)));
  const pair = () => void run('pair', async () => { await bridge.pair(link); setLink(''); setOffer(null); await load(); });
  const open = (host: Host) => void run(`open-${host.hostId}`, async () => { await bridge.open(host.hostId); onClose(); });
  // Asking without a link: the PC's owner approves on that PC or on a phone paired there; both show the same code.
  const request = (host: Host) => void run('request', async () => {
    const started = await bridge.requestStart(host.hostId);
    setAsking({ hostId: host.hostId, code: started.code });
    try { await bridge.requestWait().catch((error: { code?: string }) => { if (error.code !== 'CANCELLED') throw error; }); } finally { if (alive.current) setAsking(null); }
    await load();
  });
  const forget = (host: Host) => void run('forget', async () => { await bridge.forget(host.hostId); await load(); });

  return <Modal onClose={onClose} className="remote-pc" labelledBy="remote-pc-title" region="다른 PC에 접속">
    <header><h2 id="remote-pc-title"><Icon name="laptop" /> 다른 PC에 접속</h2></header>
    <div className="remote-pc-body">
      {state && !state.available && <p role="alert" className="remote-pc-error">Hub 주소가 올바르지 않습니다.</p>}
      {state?.available && !state.signedIn && <>
        <p>같은 계정으로 로그인한 PC의 무너에이드를 이 PC에서 엽니다.</p>
        {code ? <>
          <p>브라우저에서 아래 코드가 같은지 확인하고 승인하세요.</p>
          <p className="remote-pc-code" aria-live="polite">{code}</p>
          <button type="button" onClick={() => void bridge.signInCancel()}>취소</button>
        </> : <button type="button" className="primary" disabled={Boolean(busy)} onClick={signIn}>로그인</button>}
      </>}
      {state?.signedIn && <>
        <p className="remote-pc-account"><span>{state.account}</span><button type="button" onClick={() => void run('sign-out', async () => { await bridge.signOut(); setHosts(null); setOffer(null); await load(); })}>로그아웃</button></p>
        <ul className="remote-pc-list" aria-label="내 PC">
          {hosts?.map(host => <li key={host.hostId}>
            <div><strong>{host.name}</strong> <small>{platformName(host.platform)}</small>
              <small className={host.online ? 'remote-pc-on' : ''}>{host.online ? '켜짐' : '꺼짐'}</small>
              {host.self && <small title="접속할 PC와 이 PC의 이름이 같습니다">이 PC와 이름이 같음</small>}
              {host.paired && <small>{host.scope === 'control' ? '제어' : '보기만'}</small>}
              {host.keyChanged && <small role="alert" className="remote-pc-warn">키가 바뀌었습니다. 연결을 해제하고 다시 연결하세요.</small>}
              {!host.paired && <small>연결 필요</small>}</div>
            <div>
              {host.paired && <button type="button" onClick={() => forget(host)} disabled={Boolean(busy)}>연결 해제</button>}
              {!host.paired && host.canRequest && asking?.hostId !== host.hostId && <button type="button" className="primary" disabled={Boolean(busy) || !host.online} onClick={() => request(host)}>연결 요청</button>}
              {asking?.hostId === host.hostId && <button type="button" onClick={() => void bridge.requestCancel()}>취소</button>}
              {host.paired && <button type="button" className="primary" disabled={Boolean(busy) || !host.online || host.keyChanged} onClick={() => open(host)}>접속</button>}
            </div>
            {asking?.hostId === host.hostId && <div className="remote-pc-asking">
              <p>폰이나 그 PC에서 승인하세요. 승인 화면의 코드가 아래와 같은지 확인하세요.</p>
              <p className="remote-pc-code" aria-live="polite">{asking.code}</p>
            </div>}
          </li>)}
          {hosts && !hosts.length && <li className="remote-pc-empty">이 계정에 켜진 PC가 없습니다. 접속할 PC에서 원격 접속을 켜세요.</li>}
        </ul>
        <section aria-label="새 PC 연결">
          <label htmlFor="remote-pc-link">연결할 PC에서 만든 링크</label>
          <div className="remote-pc-row">
            <input id="remote-pc-link" value={link} placeholder="moonerade://pair?…" spellCheck={false} autoComplete="off" onChange={event => { setLink(event.target.value); setOffer(null); }} />
            <button type="button" disabled={!link.trim() || Boolean(busy)} onClick={check}>확인</button>
          </div>
          {offer && <div className="remote-pc-offer">
            <p><strong>{offer.name}</strong>에 연결합니다. 그 PC에 뜬 확인 창의 지문이 아래 이 PC 지문과 같은지 확인하세요.</p>
            <p>이 PC <code>{offer.myFingerprint}</code>, 그 PC <code>{offer.hostFingerprint}</code></p>
            <button type="button" className="primary" disabled={Boolean(busy)} onClick={pair}>{busy === 'pair' ? '그 PC에서 승인하세요…' : '연결 요청'}</button>
          </div>}
        </section>
      </>}
      {error && <p role="alert" className="remote-pc-error">{error}</p>}
    </div>
    <footer><button type="button" onClick={onClose}>닫기</button></footer>
  </Modal>;
}
