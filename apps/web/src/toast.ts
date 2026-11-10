import { tipDue, type TipHistory } from './tips';
// Icon-only toast that rises a short way from the pointer (after a mouse action) or the focused terminal's cursor (after a key press) and fades.
type Point = { x: number; y: number; selected?: boolean } | undefined;
let x = innerWidth / 2, y = innerHeight / 2, last = 0, lastKey = 0, lastClick = 0, lastDrag: Point, down: Point, anchor: (() => Point) | undefined;
// A focused terminal registers its selection end (else text cursor) here; with no anchor the toast rises from the mouse pointer.
export const setToastAnchor = (get: () => Point, on = true) => { if (on) anchor = get; else if (anchor === get) anchor = undefined; };
document.addEventListener('pointermove', event => { x = event.clientX; y = event.clientY; }, true);
// Whichever came last decides the origin: a mouse action (Claude Code's own selection, copy-on-select) rises from the pointer; after a key press it rises from the
// xterm selection, else from where the last mouse drag ended (a TUI's own selection is invisible to xterm), else from the terminal cursor.
document.addEventListener('keydown', event => {
  lastKey = Date.now();
  if (!/^(Meta|Control|Shift|Alt)$/.test(event.key) && !((event.metaKey || event.ctrlKey) && event.code === 'KeyC')) lastDrag = undefined; // typing ends that selection
}, true);
document.addEventListener('pointerdown', event => { lastClick = Date.now(); down = { x: event.clientX, y: event.clientY }; lastDrag = undefined; }, true);
document.addEventListener('pointerup', event => {
  lastClick = Date.now();
  if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) lastDrag = { x: event.clientX, y: event.clientY };
}, true);

// One element per call, so quick repeats overlap; each leans in its own random direction.
export function toast(icon: string, text: string, count?: number) {
  if (Date.now() - last < 300) return; last = Date.now(); // copy-on-select fires on every drag step
  const el = document.body.appendChild(document.createElement('div')), rand = (min: number, max: number) => min + Math.random() * (max - min);
  el.className = 'toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-label', text);
  const glyph = el.appendChild(document.createElement('span')); glyph.className = 'material-symbols-outlined'; glyph.textContent = icon;
  if (count) el.appendChild(document.createElement('small')).textContent = count > 999 ? '999+' : String(count); // how much was copied/pasted/attached
  const cursor = anchor?.(), at = lastClick > lastKey ? { x, y } : cursor?.selected ? cursor : lastDrag ?? cursor ?? { x, y };
  el.style.left = `${Math.max(4, Math.min(at.x - 12, innerWidth - 28))}px`; el.style.top = `${Math.max(4, Math.min(at.y - 12, innerHeight - 28))}px`;
  el.style.setProperty('--dx', `${rand(-22, 22)}px`); el.style.setProperty('--dy', `${-rand(28, 44)}px`);
  setTimeout(() => el.remove(), 1300); // matches the 1.2s animation
}
export const toastCopied = (text = '') => toast('content_copy', '복사되었습니다', text.length);
export const toastPasted = (text = '') => toast('content_paste_go', '붙여넣었습니다', text.length);
export const toastFailed = () => toast('error', '복사하지 못했습니다');
export const toastAttached = (files: number) => toast('attach_file', `파일 ${files}개를 붙여넣었습니다`, files);

// The one way to put text on the clipboard: the toast follows the real result, so a refused write never claims "복사되었습니다".
// `count: false` for copy-on-select, which writes on every drag step (the first toast would show a partial length).
export function copyText(text: string, { count = true }: { count?: boolean } = {}) {
  const desktop = (window as unknown as { adeDesktop?: { writeClipboard?(text: string): void } }).adeDesktop;
  const done = () => toastCopied(count ? text : '');
  if (desktop?.writeClipboard) { try { desktop.writeClipboard(text); done(); } catch { toastFailed(); } return; }
  if (!navigator.clipboard) return toastFailed();
  navigator.clipboard.writeText(text).then(done, toastFailed);
}

// Native Cmd/Ctrl+C and V, menu items and xterm's own copy all fire these; programmatic clipboard writes call toastCopied() directly.
// Copy runs in the bubble phase so xterm's handler has already put its selection on the event; with nothing selected (or nothing in
// the data) no text is copied, so no toast.
const copiedText = (event: ClipboardEvent) => {
  const data = event.clipboardData?.getData('text/plain');
  if (data) return data;
  const field = document.activeElement;
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) return (field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0));
  return getSelection()?.toString() ?? '';
};
document.addEventListener('copy', event => { const text = copiedText(event); if (text) toastCopied(text); });
document.addEventListener('paste', event => toastPasted(event.clipboardData?.getData('text/plain') ?? ''), true);

// Tip pacing: true (and recorded) when the tip may be shown now. The pane draws it itself, in its own header, so it never covers the terminal.
// History lives in localStorage so a tip does not nag across restarts; `gap` is the minimum time between showings and `max` the lifetime cap.
const TIPS = 'ade:tips';
export const resetTips = () => { try { localStorage.removeItem(TIPS); } catch { /* storage blocked: nothing was kept */ } };
const tipHistory = (): TipHistory => { try { return JSON.parse(localStorage.getItem(TIPS) || '{}'); } catch { return {}; } };
export function claimTip(id: string, { gap = 864e5, max = 2 }: { gap?: number; max?: number } = {}) {
  const history = tipHistory(), now = Date.now();
  if (!tipDue(history, id, now, gap, max)) return false;
  try { history[id] = { n: (history[id]?.n ?? 0) + 1, at: now }; localStorage.setItem(TIPS, JSON.stringify(history)); } catch { /* private mode: the tip just may repeat */ }
  return true;
}
