import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { errorText, pushError } from './errors';

const countdownPositionLabels = {
  'top-left': '왼쪽 위', 'middle-left': '왼쪽 중앙', 'bottom-left': '왼쪽 아래',
  'top-center': '중앙 위', 'middle-center': '중앙', 'bottom-center': '중앙 아래',
  'top-right': '오른쪽 위', 'middle-right': '오른쪽 중앙', 'bottom-right': '오른쪽 아래',
};
export type CountdownPosition = keyof typeof countdownPositionLabels;
export const countdownPositionOptions = Object.entries(countdownPositionLabels).map(([value, label]) => ({ value, label }));

type UpdateStatus =
  | { kind: 'progress'; text: string; fraction: number | null }
  | { kind: 'ready'; version: string; onQuit: boolean }
  | { kind: 'countdown'; restartAt: number; position?: CountdownPosition }
  | null;

type UpdatesBridge = {
  getAutoDownload(): Promise<boolean>;
  setAutoDownload(enabled: boolean): Promise<boolean>;
  getCountdownPosition(): Promise<CountdownPosition>;
  setCountdownPosition(position: CountdownPosition): Promise<CountdownPosition>;
  status(): Promise<UpdateStatus>;
  onStatus(listener: (status: UpdateStatus) => void): () => void;
  apply(): Promise<string>;
};

export const updatesBridge = () => (window as unknown as { adeDesktop?: { updates?: UpdatesBridge } }).adeDesktop?.updates;

function RestartCountdown({ restartAt, position = 'middle-center' }: { restartAt: number; position?: CountdownPosition }) {
  const card = useRef<HTMLDivElement>(null);
  const [vertical, horizontal] = position.split('-');
  const readSeconds = () => Math.max(0, Math.ceil((restartAt - Date.now()) / 1000));
  const [seconds, setSeconds] = useState(readSeconds);
  useEffect(() => {
    const element = card.current!;
    element.showPopover();
    const timer = window.setInterval(() => setSeconds(readSeconds()), 100);
    return () => { window.clearInterval(timer); element.hidePopover(); };
  }, [restartAt]);
  return <div ref={card} popover="manual" className="update-countdown" id="ade-update-countdown" data-vertical={vertical} data-horizontal={horizontal}>
    <div key={seconds} className="update-countdown-number" role="timer" aria-label={`${seconds}초`}>{seconds}</div>
    <span role="status">업데이트를 적용하기 위해 앱을 다시 시작합니다.</span>
  </div>;
}

export function AppUpdate({ compact }: { compact: boolean }) {
  const updates = updatesBridge();
  const [status, setStatus] = useState<UpdateStatus>(null), [applying, setApplying] = useState(false);
  useEffect(() => {
    if (!updates) return;
    let received = false;
    const unsubscribe = updates.onStatus(value => { received = true; setStatus(value); });
    void updates.status().then(value => { if (!received) setStatus(value); }, () => {});
    return () => { received = true; unsubscribe(); };
  }, [updates]);
  if (!updates || !status) return null;
  if (status.kind === 'countdown') return <RestartCountdown restartAt={status.restartAt} position={status.position} />;
  if (status.kind === 'ready') {
    const label = `v${status.version} 업데이트 준비 완료${status.onQuit ? ' · 종료 시 적용' : ''}`;
    return <div className="sidebar-update ready" id="ade-update-ready">
      {!compact && <span role="status">{label}</span>}
      <button type="button" className="sidebar-update-apply" aria-label="업데이트 지금 적용" data-tip={compact ? `${label}\n지금 적용` : undefined} disabled={applying} onClick={() => {
        setApplying(true);
        void updates.apply().catch(error => pushError('shell', errorText(error))).finally(() => setApplying(false));
      }}><Icon name="update" size={16} />{!compact && '지금 적용'}</button>
    </div>;
  }
  const { fraction } = status;
  const value = fraction !== null && Number.isFinite(fraction) ? Math.round(Math.max(0, Math.min(1, fraction)) * 100) : null;
  return <div className="sidebar-update" id="ade-update-progress" data-tip={compact ? status.text : undefined}>
    <div className="sidebar-update-label">
      {compact ? <Icon name="download" size={16} /> : <span title={status.text}>{status.text}</span>}
      {value !== null && <span className="sidebar-update-percent" aria-hidden="true">{value}%</span>}
    </div>
    <div className="sidebar-update-track" role="progressbar" aria-label={status.text} aria-valuenow={value ?? undefined}>
      <div style={value === null ? undefined : { width: `${value}%` }} />
    </div>
  </div>;
}
