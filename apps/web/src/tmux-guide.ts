// tmux key guide: which-key style help shown while the prefix (Ctrl+B) is pending.
// Nothing here imports React or xterm, so node tests can load it.

export type GuideItem = { keys: string; label: string };
export type GuideGroup = { title: string; items: GuideItem[] };

// The default key table, grouped the way people look for it. `keys` is what follows the prefix.
export const guideGroups: GuideGroup[] = [
  { title: '창 (window)', items: [
    { keys: 'c', label: '새 창' }, { keys: 'n / p', label: '다음 / 이전 창' }, { keys: '0–9', label: '번호로 이동' },
    { keys: 'w', label: '창 목록' }, { keys: ',', label: '창 이름 변경' }, { keys: '&', label: '창 닫기' }
  ] },
  { title: '분할 (pane)', items: [
    { keys: '%', label: '좌우 분할' }, { keys: '"', label: '상하 분할' }, { keys: '방향키', label: 'pane 이동' },
    { keys: 'o', label: '다음 pane' }, { keys: 'z', label: 'pane 확대/복원' }, { keys: 'x', label: 'pane 닫기' }, { keys: 'q', label: 'pane 번호 표시' }
  ] },
  { title: '세션 · 기타', items: [
    { keys: 'd', label: '세션에서 분리 (detach)' }, { keys: 's', label: '세션 목록' }, { keys: '$', label: '세션 이름 변경' },
    { keys: '[', label: '스크롤/복사 모드' }, { keys: ':', label: '명령 입력' }, { keys: '?', label: '전체 키 목록' }
  ] }
];

// A status line as read from the screen: its text, and whether (nearly) every cell shares one non-default background,
// which is how tmux paints its bar.
export type ScreenRow = { text: string; filled: boolean };

// `0:bash*`, `1:vim-`, `2:node#`: a window index, a name without spaces, and tmux's trailing flags. The lookbehind and the
// requirement that the name holds a non-digit keep clocks such as `12:30:45` and `15:44` from counting as windows.
const WINDOW = /(?<![\w:])\d{1,3}:(?=[^\s:]*[^\s:\d])[^\s:]+(?=\s|$)/;
const SESSION_THEN_WINDOW = /^\s*\[[^\]\n]{1,40}\]\s+\d{1,3}:(?=[^\s:]*[^\s:\d])[^\s:]+(?=\s|$)/;
// The default status-left is capped at 10 characters, so a long session name is cut and the first window follows it directly:
// `[guide-tes0:zsh*`. Only trusted on a filled bar, since it has no closing bracket to anchor on.
const CUT_SESSION_THEN_WINDOW = /^\s*\[[^\]\s]{1,12}?\d{1,3}:(?=[^\s:]*[^\s:\d])[^\s:]+(?=\s|$)/;

// Whether a screen row is a tmux status line. The default one reads `[session] 0:bash*   "host" 12:00 07-Nov-26` on a
// green bar. A customised bar keeps the window list and the filled background, and anything else can be forced with the
// "always" setting.
export function isTmuxStatusRow(row: ScreenRow | undefined): boolean {
  if (!row) return false;
  return SESSION_THEN_WINDOW.test(row.text) || row.filled && (WINDOW.test(row.text) || CUT_SESSION_THEN_WINDOW.test(row.text));
}

// tmux puts the bar on the last row by default and on the first with `status-position top`.
export const looksLikeTmux = (rows: (ScreenRow | undefined)[]): boolean => rows.some(isTmuxStatusRow);

// Whether `mode` lets the guide appear at all. "auto" needs the screen to look like tmux.
export type GuideMode = 'auto' | 'always' | 'off';
export const guideActive = (mode: GuideMode, onScreen: () => boolean): boolean => mode === 'always' || mode === 'auto' && onScreen();

// Only modifiers on their own leave the prefix pending; any other key is the command (or cancels it). `Process` (a key taken
// by a Korean/Japanese IME) and `Dead` are real keys, so they are not listed.
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Hyper', 'Super', 'OS']);
export const isModifierOnly = (key: string) => MODIFIER_KEYS.has(key);

export const PREFIX_LETTER = /^[a-z]$/;
export const normalizePrefix = (value: string, fallback = 'b') => PREFIX_LETTER.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : fallback;

export type KeyLike = { type: string; key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; repeat: boolean };
// Ctrl+<letter> with no other modifier, matched by physical key so a Korean IME (which reports `ㅠ` for B) still counts.
export const isPrefixKey = (event: KeyLike, letter: string) =>
  event.type === 'keydown' && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.code === `Key${normalizePrefix(letter).toUpperCase()}`;

// The guide's life cycle as a small machine so the pane code only forwards key events.
//   idle --prefix--> shown --any key / timeout / blur--> idle
// The guide appears the moment the prefix is pressed; the next key (the command itself) closes it again.
export function createPrefixGuide(options: { timeout: number; show(): void; hide(): void; timers?: { set(fn: () => void, ms: number): unknown; clear(id: unknown): void } }) {
  const timers = options.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>) };
  let state: 'idle' | 'shown' = 'idle', expire: unknown;
  const reset = () => { const was = state; timers.clear(expire); expire = undefined; state = 'idle'; if (was === 'shown') options.hide(); };
  return {
    get state() { return state; },
    // The prefix was pressed in a tmux pane. A second prefix (tmux's send-prefix) ends the wait like any other key.
    prefix() {
      if (state !== 'idle') { reset(); return; }
      state = 'shown'; options.show();
      expire = timers.set(reset, options.timeout);
    },
    // Any key that is not a bare modifier.
    key() { if (state !== 'idle') reset(); },
    cancel: reset
  };
}
