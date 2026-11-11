import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import { captureRect, dragRect, type Box, type Point } from './feedback-model';
import { desktopCapture, type CaptureMode } from './feedback-store';

const modes: { id: CaptureMode; label: string; icon: IconName; hint: string }[] = [
  { id: 'element', label: '요소', icon: 'captureElement', hint: '캡쳐할 영역을 클릭하세요 · Alt: 커서 아래 요소 그대로' },
  { id: 'window', label: '창 전체', icon: 'captureWindow', hint: '창 전체를 캡쳐합니다' },
  { id: 'range', label: '범위', icon: 'captureRange', hint: '끌어서 범위를 정하세요' }
];
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const boxOf = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });

// Full-window overlay for picking what to capture. It lives in the top layer (a manual popover), inside the topmost open modal
// dialog if there is one, so it also works over the settings dialog and is not made inert by it.
// Picking hides the overlay, waits two frames so the screen no longer shows it, then asks the desktop app for the PNG.
export function FeedbackCapture({ mode: initial, fallbackZoom, onCaptured, onCancel, onError }: { mode: CaptureMode; fallbackZoom: number; onCaptured(bytes: Uint8Array): void | Promise<void>; onCancel(): void; onError(cause: unknown): void }) {
  const [mode, setMode] = useState(initial), [hidden, setHidden] = useState(false);
  const [hover, setHover] = useState<{ box: Box; label: string } | null>(null), [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const root = useRef<HTMLDivElement>(null), busy = useRef(false);
  const [host] = useState(() => [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].pop() ?? document.body);

  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    try { element.showPopover(); } catch { /* already shown */ }
    document.documentElement.classList.add('feedback-capturing');
    return () => document.documentElement.classList.remove('feedback-capturing');
  }, []);

  async function shoot(box: Box | null) {
    if (busy.current) return; busy.current = true;
    const bridge = desktopCapture();
    try {
      if (!bridge?.capture) throw new Error('화면 캡쳐는 데스크톱 앱에서만 쓸 수 있습니다.');
      const zoom = bridge.zoomFactor?.() || fallbackZoom || 1;
      const rect = box ? captureRect(box, zoom, { width: innerWidth, height: innerHeight }) : undefined;
      if (rect === null) { busy.current = false; setDrag(null); return; } // nothing on screen: keep picking
      setHidden(true); await frame(); await frame();
      const bytes = await bridge.capture(rect);
      await onCaptured(bytes);
    } catch (cause) { onError(cause); }
  }

  useEffect(() => { if (mode === 'window') void shoot(null); }, [mode]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy.current) onCancel(); }
      if (event.key === 'Alt') event.preventDefault(); // keeps Alt from focusing the menu bar
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  // The element under the pointer, ignoring this overlay: its nearest marked region, or with Alt the element itself.
  const pick = (x: number, y: number, exact: boolean) => {
    const under = document.elementsFromPoint(x, y).find(element => !root.current?.contains(element));
    if (!under) return null;
    const region = exact ? under : under.closest<HTMLElement>('[data-feedback-region]') ?? document.documentElement;
    const label = region.getAttribute('data-feedback-region') || (region === document.documentElement ? '창 전체' : region.getAttribute('aria-label') || region.tagName.toLowerCase());
    return { box: region === document.documentElement ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : boxOf(region.getBoundingClientRect()), label };
  };
  const onMove = (event: ReactPointerEvent) => {
    if (mode === 'element') setHover(pick(event.clientX, event.clientY, event.altKey));
    else if (mode === 'range' && drag) setDrag({ ...drag, to: { x: event.clientX, y: event.clientY } });
  };
  const onDown = (event: ReactPointerEvent) => {
    if (event.button !== 0 || (event.target as Element).closest('.feedback-capture-bar')) return;
    event.preventDefault();
    if (mode === 'element') { const target = pick(event.clientX, event.clientY, event.altKey); if (target) void shoot(target.box); }
    else if (mode === 'range') { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); setDrag({ from: { x: event.clientX, y: event.clientY }, to: { x: event.clientX, y: event.clientY } }); }
  };
  const onUp = () => {
    if (mode !== 'range' || !drag) return;
    const box = dragRect(drag.from, drag.to);
    if (box.width < 4 || box.height < 4) { setDrag(null); return; }
    void shoot(box);
  };
  const shown = mode === 'element' ? hover?.box : drag ? dragRect(drag.from, drag.to) : null;
  const current = modes.find(item => item.id === mode)!;
  return createPortal(<div ref={root} popover="manual" className={`feedback-capture mode-${mode}`} style={hidden ? { visibility: 'hidden' } : undefined}
    role="dialog" aria-label="피드백 화면 캡쳐" onPointerMove={onMove} onPointerDown={onDown} onPointerUp={onUp} onPointerLeave={() => setHover(null)}>
    {shown && <div className="feedback-capture-box" style={{ left: shown.left, top: shown.top, width: shown.width, height: shown.height }}>
      {mode === 'element' && hover && <span>{hover.label}</span>}
      {mode === 'range' && <span>{Math.round(shown.width)} × {Math.round(shown.height)}</span>}
    </div>}
    <div className="feedback-capture-bar" role="toolbar" aria-label="캡쳐 방식">
      {modes.map(item => <button key={item.id} type="button" aria-pressed={mode === item.id} onClick={() => { setHover(null); setDrag(null); setMode(item.id); }}><Icon name={item.icon} size={15} />{item.label}</button>)}
      <span className="feedback-capture-hint">{current.hint}</span>
      <button type="button" onClick={onCancel} title="취소 (Esc)"><Icon name="x" size={15} />취소</button>
    </div>
  </div>, host);
}
