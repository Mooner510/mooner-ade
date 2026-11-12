import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { clearErrors, dismissError, errorLog, subscribeErrors, type AppError } from './errors';
import { Icon, IconButton } from './Icon';

const useLog = (scope: string) => useSyncExternalStore(fn => subscribeErrors(scope, fn), () => errorLog(scope), () => errorLog(scope));

function errorButton(scope: string) {
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(scope) : scope.replace(/"/g, '\\"');
  return document.querySelector<HTMLElement>(`.app:not([hidden]) [data-error-scope="${esc}"]`) ?? document.querySelector<HTMLElement>(`[data-error-scope="${esc}"]`);
}

// Fixed just under the header. Leaving shrinks into the header button (translate + scale only).
export function ErrorToast({ scope, active = true }: { scope: string; active?: boolean }) {
  const log = useLog(scope);
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef(0);
  const [view, setView] = useState<{ id: number; message: string; phase: 'in' | 'out' } | null>(null);

  useLayoutEffect(() => {
    if (!active || !log.toastId) { setView(null); return; }
    if (shown.current === log.toastAt || Date.now() - log.toastAt >= 10_000) return;
    const item = errorLog(scope).items.find(entry => entry.id === log.toastId);
    if (!item) return;
    shown.current = log.toastAt;
    setView({ id: item.id, message: item.message, phase: 'in' });
    const hide = window.setTimeout(() => setView(current => current && current.id === item.id ? { ...current, phase: 'out' } : current), 10_000);
    return () => clearTimeout(hide);
  }, [active, scope, log.toastId, log.toastAt]);

  useLayoutEffect(() => {
    if (view?.phase !== 'out') return;
    const hide = window.setTimeout(() => setView(current => current?.phase === 'out' ? null : current), 420);
    return () => clearTimeout(hide);
  }, [view?.phase, view?.id]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !view) return;
    try { if (!el.matches(':popover-open')) el.showPopover(); } catch { /* closed before it connected */ }
    const btn = errorButton(scope);
    if (!btn || view.phase !== 'in') return;
    const box = btn.getBoundingClientRect();
    el.style.top = `${box.bottom + 8}px`;
    el.style.right = `${Math.max(8, window.innerWidth - box.right)}px`;
    el.style.left = 'auto';
    el.style.bottom = 'auto';
  }, [view, scope]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || view?.phase !== 'out') return;
    const btn = errorButton(scope);
    if (!btn) return;
    const from = el.getBoundingClientRect(), to = btn.getBoundingClientRect();
    el.style.setProperty('--dx', `${to.left + to.width / 2 - (from.left + from.width / 2)}px`);
    el.style.setProperty('--dy', `${to.top + to.height / 2 - (from.top + from.height / 2)}px`);
  }, [view?.phase, scope]);

  if (!view) return null;
  return <div ref={ref} popover="manual" role="alert" className={`error-toast ${view.phase}`} onAnimationEnd={event => { if (event.target === event.currentTarget && view.phase === 'out') setView(null); }}>
    <Icon name="siren" size={16} /><p>{view.message}</p>
    <IconButton icon="x" label="닫기" onClick={() => setView(current => current ? { ...current, phase: 'out' } : current)} />
  </div>;
}

export function ErrorTabButton({ scope, pressed, onClick, className = '' }: { scope: string; pressed: boolean; onClick(): void; className?: string }) {
  const { items } = useLog(scope);
  return <button type="button" data-error-scope={scope} className={`bar-button error-tab ${pressed ? 'on' : ''} ${items.length ? 'hot' : ''} ${className}`} title="오류" aria-label={items.length ? `오류 ${items.length}개` : '오류'} aria-pressed={pressed} onClick={onClick}>
    <Icon name="siren" />{items.length > 0 && <span className="error-count">{items.length}</span>}
  </button>;
}

export function ErrorPanel({ scope, wide, toggleWide }: { scope: string; wide: boolean; toggleWide(): void }) {
  const { items } = useLog(scope);
  const when = (item: AppError) => new Date(item.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return <div className="review-panel error-panel">
    <header className="panel-head">
      <Icon name="siren" /><strong>오류</strong>
      <span className="spacer" />
      {items.length > 0 && <button type="button" onClick={() => clearErrors(scope)}>모두 지우기</button>}
      <IconButton icon={wide ? 'minimize' : 'maximize'} tip="header" label={wide ? '패널 크기 줄이기' : '패널 넓게 보기'} onClick={toggleWide} />
    </header>
    <div className="review-list">
      {!items.length && <div className="review-empty"><Icon name="check" size={22} /><strong>오류 없음</strong><p>문제가 생기면 여기에 남습니다.</p></div>}
      {items.map(item => <article key={item.id} className="error-row">
        <Icon name="siren" size={15} />
        <div><p>{item.message}</p><time dateTime={new Date(item.at).toISOString()}>{when(item)}</time></div>
        <IconButton icon="x" label="이 오류 지우기" onClick={() => dismissError(scope, item.id)} />
      </article>)}
    </div>
  </div>;
}

// Welcome screen: there is no project header yet, so the button floats at the top-right once something fails.
export function ErrorCorner({ scope }: { scope: string }) {
  const log = useLog(scope);
  const [open, setOpen] = useState(false), [wide, setWide] = useState(false);
  return <>
    <ErrorToast scope={scope} />
    {log.items.length > 0 && <ErrorTabButton scope={scope} pressed={open} className="floating-error-tab" onClick={() => setOpen(value => !value)} />}
    {open && log.items.length > 0 && <aside className={`right-panel floating-errors ${wide ? 'wide' : ''}`} aria-label="오류">
      <ErrorPanel scope={scope} wide={wide} toggleWide={() => setWide(value => !value)} />
    </aside>}
  </>;
}
