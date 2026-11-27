import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';

// The phone layout (docs/REMOTE_UI.md): the same components, arranged for a narrow touch screen. The project sidebar becomes a drawer,
// a tab shows one pane at a time (the focused one, through the existing zoom), side panels cover the workbench, and terminals get a
// row of keys a phone keyboard lacks. A desktop window made this narrow gets the same layout.
export const MOBILE_QUERY = '(max-width: 760px)';
const media = typeof matchMedia === 'function' ? matchMedia(MOBILE_QUERY) : null;
export const isMobile = () => Boolean(media?.matches);
export function useMobile() {
  const [mobile, setMobile] = useState(isMobile);
  useEffect(() => {
    if (!media) return;
    const change = () => setMobile(media.matches);
    media.addEventListener('change', change); change();
    return () => media.removeEventListener('change', change);
  }, []);
  return mobile;
}

// The sidebar drawer: opened from any project's top bar, closed by the shell.
let drawerOpen = false;
const drawerListeners = new Set<() => void>();
export function setDrawer(open: boolean | ((open: boolean) => boolean)) {
  const next = typeof open === 'function' ? open(drawerOpen) : open;
  if (next === drawerOpen) return;
  drawerOpen = next; drawerListeners.forEach(listener => listener());
}
export const closeDrawer = () => setDrawer(false);
export const useDrawer = () => useSyncExternalStore(listener => { drawerListeners.add(listener); return () => drawerListeners.delete(listener); }, () => drawerOpen);

// Swiping the open drawer to the left (on the drawer or the scrim beside it) drags it along and closes it past a third of its width or a quick flick.
// Plain functions of two elements, so the gesture can be tested without a browser.
export function swipeClose(root: HTMLElement, nav: HTMLElement, close: () => void) {
  let id = -1, x0 = 0, y0 = 0, t0 = 0, dx = 0, dragging = false;
  const down = (event: PointerEvent) => { if (event.pointerType === 'mouse' || id >= 0) return; id = event.pointerId; x0 = event.clientX; y0 = event.clientY; t0 = event.timeStamp; dx = 0; dragging = false; };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== id) return;
    dx = Math.min(0, event.clientX - x0);
    if (!dragging) {
      const dy = event.clientY - y0;
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { id = -1; return; } // a vertical scroll of the list
      if (-dx < 12) return;
      dragging = true; root.setPointerCapture(id); nav.style.transition = 'none';
    }
    nav.style.transform = `translateX(${dx}px)`;
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== id) return;
    id = -1;
    if (!dragging) return;
    dragging = false; nav.style.transition = ''; nav.style.transform = '';
    if (-dx > nav.offsetWidth / 3 || dx / Math.max(1, event.timeStamp - t0) < -0.5) close();
  };
  root.addEventListener('pointerdown', down); root.addEventListener('pointermove', move); root.addEventListener('pointerup', up); root.addEventListener('pointercancel', up);
  return () => { root.removeEventListener('pointerdown', down); root.removeEventListener('pointermove', move); root.removeEventListener('pointerup', up); root.removeEventListener('pointercancel', up); nav.style.transition = ''; nav.style.transform = ''; };
}
export function useSwipeClose(shell: RefObject<HTMLElement | null>, enabled: boolean, close: () => void) {
  useEffect(() => {
    const root = shell.current, nav = root?.querySelector<HTMLElement>(':scope > .projects');
    if (!enabled || !root || !nav) return;
    return swipeClose(root, nav, close);
  }, [shell, enabled, close]);
}

// Keys for the terminal key row. `ctrl` is sticky: it changes the next key typed (on the row or the phone keyboard).
export type TerminalKey = { id: string; label: string; data?: string; ctrl?: true; aria?: string };
export const TERMINAL_KEYS: TerminalKey[] = [
  { id: 'esc', label: 'Esc', data: '\x1b' },
  { id: 'tab', label: 'Tab', data: '\t' },
  { id: 'ctrl', label: 'Ctrl', ctrl: true },
  { id: 'up', label: '↑', data: '\x1b[A', aria: '위' },
  { id: 'down', label: '↓', data: '\x1b[B', aria: '아래' },
  { id: 'left', label: '←', data: '\x1b[D', aria: '왼쪽' },
  { id: 'right', label: '→', data: '\x1b[C', aria: '오른쪽' },
  { id: 'ctrl-c', label: '^C', data: '\x03', aria: 'Ctrl+C' },
  { id: 'pipe', label: '|', data: '|' },
  { id: 'slash', label: '/', data: '/' },
  { id: 'dash', label: '-', data: '-' },
  { id: 'tilde', label: '~', data: '~' },
  { id: 'shift-tab', label: '⇤', data: '\x1b[Z', aria: 'Shift+Tab' }
];
// Ctrl plus one character, as a terminal sends it: letters and @[\]^_ map to 0-31, space to NUL, ? to DEL. Anything else goes as typed.
export function withCtrl(data: string) {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  if (data === ' ') return '\x00';
  if (data === '?') return '\x7f';
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  return data;
}
