import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import { captureRect, dragRect, type Box, type Point } from './feedback-model';
import { canCapture, desktopCapture, openBrowserShare, type BrowserShare, type CaptureMode } from './feedback-store';

const modes: { id: CaptureMode; label: string; icon: IconName; hint: string }[] = [
  { id: 'element', label: '요소', icon: 'captureElement', hint: '클릭해서 캡쳐 · ↑ ↓ 또는 휠로 부모·자식 선택 · Alt: 가장 안쪽' },
  { id: 'window', label: '창 전체', icon: 'captureWindow', hint: '창 전체를 캡쳐합니다' },
  { id: 'range', label: '범위', icon: 'captureRange', hint: '끌어서 범위를 정하세요' }
];
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
// A browser that cannot start a share because the page is not shown (a hidden or covered window) says only "Invalid state".
const readable = (cause: unknown) => cause instanceof DOMException && cause.name === 'InvalidStateError' ? new Error('화면 공유를 시작하지 못했습니다. 이 창이 앞에 보이는 상태에서 다시 시도하세요.') : cause;
const boxOf = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
const boxOfElement = (element: Element): Box => element === document.documentElement ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : boxOf(element.getBoundingClientRect());
const sameBox = (a: DOMRect, b: DOMRect) => Math.abs(a.left - b.left) < .5 && Math.abs(a.top - b.top) < .5 && Math.abs(a.width - b.width) < .5 && Math.abs(a.height - b.height) < .5;

// What an element is called on screen: its marked region, its aria-label, the text of a button/link/heading, else tag#id.class.
export function elementLabel(element: Element): string {
  if (element === document.documentElement) return '창 전체';
  const named = element.getAttribute('data-feedback-region') || element.getAttribute('aria-label');
  if (named) return named;
  const tag = element.tagName.toLowerCase();
  if (/^(button|a|h[1-6]|label|summary|th|td|li|option)$/.test(tag)) {
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) return `${tag} “${text.length > 18 ? `${text.slice(0, 18)}…` : text}”`;
  }
  const id = element.id ? `#${element.id.slice(0, 20)}` : '';
  const classes = typeof element.className === 'string' ? element.className.split(/\s+/).filter(Boolean).slice(0, 2).map(name => `.${name.slice(0, 20)}`).join('') : '';
  return `${tag}${id}${classes}`;
}

// The element under the pointer and all of its ancestors up to the window, innermost first. Elements that draw nothing (display: contents,
// zero size) are left out, and an ancestor with exactly the same box as its child replaces it, so every ↑/↓ step changes what would be captured.
export function selectionChain(leaf: Element): Element[] {
  const chain: Element[] = []; let last: DOMRect | null = null;
  for (let element: Element | null = leaf; element; element = element.parentElement) {
    if (getComputedStyle(element).display === 'contents') continue;
    const rect = element.getBoundingClientRect();
    if (element !== document.documentElement && (rect.width < 1 || rect.height < 1)) continue;
    if (last && sameBox(last, rect)) chain[chain.length - 1] = element; else chain.push(element);
    last = rect;
  }
  if (chain[chain.length - 1] !== document.documentElement) chain.push(document.documentElement);
  return chain;
}
// Where picking starts: the nearest marked region (as before; the whole window if there is none), or with Alt the innermost element.
const startDepth = (chain: Element[], leaf: Element, exact: boolean) => {
  if (exact) return 0;
  const region = leaf.closest('[data-feedback-region]');
  if (!region) return chain.length - 1;
  return Math.max(0, chain.findIndex(element => element === region || element.contains(region)));
};
type Pick = { leaf: Element; chain: Element[]; depth: number; x: number; y: number };

// Full-window overlay for picking what to capture. It lives in the top layer (a manual popover), inside the topmost open modal
// dialog if there is one, so it also works over the settings dialog and is not made inert by it.
// Picking hides the overlay, waits two frames so the screen no longer shows it, then asks the desktop app for the PNG. Without the desktop app the
// browser's tab share is started when the overlay opens (so the region is picked on the settled layout) and the frame is taken from it.
export function FeedbackCapture({ mode: initial, fallbackZoom, onCaptured, onCancel, onError }: { mode: CaptureMode; fallbackZoom: number; onCaptured(bytes: Uint8Array): void | Promise<void>; onCancel(): void; onError(cause: unknown): void }) {
  const [mode, setMode] = useState(initial), [hidden, setHidden] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null), [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const root = useRef<HTMLDivElement>(null), busy = useRef(false), share = useRef<Promise<BrowserShare> | null>(null);
  const [host] = useState(() => [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].pop() ?? document.body);

  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    try { element.showPopover(); } catch { /* already shown */ }
    document.documentElement.classList.add('feedback-capturing');
    return () => document.documentElement.classList.remove('feedback-capturing');
  }, []);

  // Declared before the 'window' effect below, which shoots at once and waits for this share.
  useEffect(() => {
    if (desktopCapture()?.capture || !canCapture()) return;
    const started = openBrowserShare(onCancel); share.current = started;
    started.catch(cause => { if (cause instanceof DOMException && cause.name === 'NotAllowedError') onCancel(); else onError(readable(cause)); });
    return () => { void started.then(opened => opened.stop(), () => {}); };
  }, []);

  async function shoot(box: Box | null) {
    if (busy.current) return; busy.current = true;
    const bridge = desktopCapture();
    try {
      if (!canCapture()) throw new Error('이 브라우저는 화면 캡쳐를 지원하지 않습니다. 이미지를 붙여넣거나 파일로 추가하세요.');
      // The desktop app captures in zoomed DIPs; a browser shares at CSS-pixel scale (browserCapture rescales by the frame size).
      const zoom = bridge?.capture ? bridge.zoomFactor?.() || fallbackZoom || 1 : 1;
      const rect = box ? captureRect(box, zoom, { width: innerWidth, height: innerHeight }) : undefined;
      if (rect === null) { busy.current = false; setDrag(null); return; } // nothing on screen: keep picking
      setHidden(true); await frame(); await frame();
      if (bridge?.capture) await onCaptured(await bridge.capture(rect));
      else {
        const opened = await share.current!.catch(() => null); // a failed share was already reported by the effect above
        if (!opened) return;
        await onCaptured(await opened.grab(rect));
      }
    } catch (cause) {
      // Closing the browser's share dialog is a cancel, not an error.
      if (cause instanceof DOMException && cause.name === 'NotAllowedError') onCancel(); else onError(readable(cause));
    }
  }

  useEffect(() => { if (mode === 'window') void shoot(null); }, [mode]);
  // ↑ / ↓ (or the wheel) walk the picked element's ancestors: one step up is the parent, one step down goes back toward the element under the pointer.
  const step = (by: 1 | -1) => setPick(previous => previous && { ...previous, depth: Math.max(0, Math.min(previous.chain.length - 1, previous.depth + by)) });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy.current) onCancel(); }
      if (event.key === 'Alt') { event.preventDefault(); if (mode === 'element') setPick(previous => previous && { ...previous, depth: 0 }); } // keeps Alt from focusing the menu bar
      if (mode === 'element' && !busy.current && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); event.stopPropagation(); step(event.key === 'ArrowUp' ? 1 : -1); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel, mode]);

  // The element under the pointer, ignoring this overlay. Staying on the same element keeps the depth chosen with the keys.
  const resolve = (x: number, y: number, exact: boolean, previous: Pick | null): Pick | null => {
    const leaf = document.elementsFromPoint(x, y).find(element => !root.current?.contains(element));
    if (!leaf) return null;
    if (previous?.leaf === leaf) return { ...previous, x, y };
    const chain = selectionChain(leaf);
    return { leaf, chain, depth: startDepth(chain, leaf, exact), x, y };
  };
  const wheelAt = useRef(0);
  const onWheel = (event: ReactWheelEvent) => {
    if (mode !== 'element' || !event.deltaY || Date.now() - wheelAt.current < 90) return; // a trackpad's momentum would otherwise run through every level
    wheelAt.current = Date.now(); step(event.deltaY < 0 ? 1 : -1);
  };
  const onMove = (event: ReactPointerEvent) => {
    if (mode === 'element') setPick(previous => resolve(event.clientX, event.clientY, event.altKey, previous));
    else if (mode === 'range' && drag) setDrag({ ...drag, to: { x: event.clientX, y: event.clientY } });
  };
  const onDown = (event: ReactPointerEvent) => {
    if (event.button !== 0 || (event.target as Element).closest('.feedback-capture-bar')) return;
    event.preventDefault();
    if (mode === 'element') { const target = resolve(event.clientX, event.clientY, event.altKey, pick); if (target) void shoot(boxOfElement(target.chain[target.depth])); }
    else if (mode === 'range') { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); setDrag({ from: { x: event.clientX, y: event.clientY }, to: { x: event.clientX, y: event.clientY } }); }
  };
  const onUp = () => {
    if (mode !== 'range' || !drag) return;
    const box = dragRect(drag.from, drag.to);
    if (box.width < 4 || box.height < 4) { setDrag(null); return; }
    void shoot(box);
  };
  const picked = mode === 'element' && pick ? pick.chain[pick.depth] : null;
  const shown = picked ? boxOfElement(picked) : mode === 'range' && drag ? dragRect(drag.from, drag.to) : null;
  const current = modes.find(item => item.id === mode)!;
  const parent = pick ? pick.chain[pick.depth + 1] : null, child = pick && pick.depth > 0 ? pick.chain[pick.depth - 1] : null;
  // The tip rides next to the pointer and flips to the other side before it would leave the window.
  const flipX = !!pick && pick.x > innerWidth - 300, flipY = !!pick && pick.y > innerHeight - 130;
  return createPortal(<div ref={root} popover="manual" className={`feedback-capture mode-${mode}`} style={hidden ? { visibility: 'hidden' } : undefined}
    role="dialog" aria-label="피드백 화면 캡쳐" onPointerMove={onMove} onPointerDown={onDown} onPointerUp={onUp} onPointerLeave={() => setPick(null)} onWheel={onWheel}>
    {shown && <div className={`feedback-capture-box${shown.top < 28 ? ' label-in' : ''}`} style={{ left: shown.left, top: shown.top, width: shown.width, height: shown.height }}>
      {picked && <span>{elementLabel(picked)}</span>}
      {mode === 'range' && <span>{Math.round(shown.width)} × {Math.round(shown.height)}</span>}
    </div>}
    {picked && pick && shown && <div className={`feedback-capture-tip${flipX ? ' flip-x' : ''}${flipY ? ' flip-y' : ''}`} style={{ left: pick.x + (flipX ? -16 : 16), top: pick.y + (flipY ? -16 : 20) }} aria-hidden="true">
      <b>{elementLabel(picked)}<small>{Math.round(shown.width)} × {Math.round(shown.height)} · {pick.chain.length - pick.depth}/{pick.chain.length}</small></b>
      <span className={parent ? '' : 'off'}><kbd>↑</kbd>부모<em>{parent ? elementLabel(parent) : '없음'}</em></span>
      <span className={child ? '' : 'off'}><kbd>↓</kbd>자식<em>{child ? elementLabel(child) : '없음'}</em></span>
      <small className="keys"><kbd>Alt</kbd>가장 안쪽 · 클릭 캡쳐</small>
    </div>}
    <div className="feedback-capture-bar" role="toolbar" aria-label="캡쳐 방식">
      {modes.map(item => <button key={item.id} type="button" aria-pressed={mode === item.id} onClick={() => { setPick(null); setDrag(null); setMode(item.id); }}><Icon name={item.icon} size={15} />{item.label}</button>)}
      <span className="feedback-capture-hint">{current.hint}</span>
      <button type="button" onClick={onCancel} title="취소 (Esc)"><Icon name="x" size={15} />취소</button>
    </div>
  </div>, host);
}
