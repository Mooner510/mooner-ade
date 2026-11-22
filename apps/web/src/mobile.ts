import { useEffect, useState, useSyncExternalStore } from 'react';

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
export const useDrawer = () => useSyncExternalStore(listener => { drawerListeners.add(listener); return () => drawerListeners.delete(listener); }, () => drawerOpen);

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
