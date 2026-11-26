import { createContext, useContext } from 'react';
import { comboOf, showCombo } from './chat-model';

// The user's app-key overrides, provided once at the root so a button anywhere can show its shortcut without the settings being passed down to it.
export const AppKeysContext = createContext<Record<string, string> | undefined>(undefined);
export const useActionKeys = (action?: string) => { const overrides = useContext(AppKeysContext); return action ? showAppKey(overrides, action) : undefined; };

// term: the key reaches the app even when a plain Ctrl combo is typed in a terminal; the user can flip it per key (settings.termKeys).
export const appKeyDefs: { id: string; group: string; label: string; keys: string; term?: boolean }[] = [
  { id: 'newTab', group: '탭', label: '새 탭', keys: 'mod+shift+t' },
  { id: 'launcher', group: '탭', label: '새 탭에서 실행…', keys: 'mod+shift+n' },
  { id: 'closeTab', group: '탭', label: '탭 닫기', keys: 'mod+shift+w' },
  { id: 'nextTab', group: '탭', label: '다음 탭', keys: 'alt+]' },
  { id: 'prevTab', group: '탭', label: '이전 탭', keys: 'alt+[' },
  { id: 'nextTab2', group: '탭', label: '다음 탭 (Page Down)', keys: 'ctrl+pagedown', term: true },
  { id: 'prevTab2', group: '탭', label: '이전 탭 (Page Up)', keys: 'ctrl+pageup', term: true },
  { id: 'sendEof', group: '분할/Pane', label: '터미널에 ^D(EOF) 보내기', keys: 'ctrl+alt+d' },
  { id: 'closePane', group: '분할/Pane', label: '포커스된 pane 닫기', keys: 'mod+alt+shift+w' },
  { id: 'zoom', group: '분할/Pane', label: 'Pane 최대화 전환', keys: 'mod+shift+enter' },
  { id: 'focusNext', group: '분할/Pane', label: '다음 pane으로 이동', keys: 'alt+shift+]' },
  { id: 'focusPrev', group: '분할/Pane', label: '이전 pane으로 이동', keys: 'alt+shift+[' },
  { id: 'gitLog', group: '화면/도구', label: 'Git 로그(커밋 그래프) 전환', keys: 'mod+shift+g' },
  { id: 'palette', group: '화면/도구', label: '명령 팔레트', keys: 'mod+shift+p' },
  { id: 'palette2', group: '화면/도구', label: '명령 팔레트(F1)', keys: 'f1' },
  // Ids are camelCase like the rest: the server's appKeys validation only accepts [a-zA-Z][a-zA-Z0-9]*.
  { id: 'feedback', group: '화면/도구', label: '피드백 요청', keys: 'mod+alt+f' },
  { id: 'feedbackCapture', group: '화면/도구', label: '피드백 화면 캡쳐', keys: 'mod+alt+shift+f' },
  { id: 'addProject', group: '프로젝트', label: '프로젝트 열기…', keys: 'mod+alt+o' },
  { id: 'toggleProjects', group: '화면/도구', label: '프로젝트 사이드바 접기/펼치기', keys: 'mod+alt+b' },
  { id: 'settings', group: '화면/도구', label: '설정 열기', keys: 'mod+,' },
  { id: 'closeProject', group: '프로젝트', label: '프로젝트 닫기', keys: 'mod+alt+w' },
  { id: 'nextProject', group: '프로젝트', label: '다음 프로젝트', keys: 'mod+alt+]' },
  { id: 'prevProject', group: '프로젝트', label: '이전 프로젝트', keys: 'mod+alt+[' },
  { id: 'splitRight', group: '분할/Pane', label: '좌우 분할', keys: 'ctrl+d', term: true },
  { id: 'splitDown', group: '분할/Pane', label: '상하 분할', keys: 'ctrl+shift+d', term: true },
  // The ninth key goes to the last tab/project (like browsers), whatever the count; the id stays `tab9`/`project9` so saved overrides keep working.
  ...Array.from({ length: 9 }, (_, i) => ({ id: `tab${i + 1}`, group: '탭', label: i === 8 ? '마지막 탭으로 이동' : `${i + 1}번 탭으로 이동`, keys: `alt+${i + 1}` })),
  ...Array.from({ length: 9 }, (_, i) => ({ id: `project${i + 1}`, group: '프로젝트', label: i === 8 ? '마지막 프로젝트로 이동' : `${i + 1}번 프로젝트로 이동`, keys: `mod+alt+${i + 1}` })),
];
// Does this key belong to ADE (true) or the shell (false) while a terminal has focus? An explicit termKeys choice wins; otherwise only
// plain Ctrl+key is left to the shell, unless the key is a default that must work there or the user rebound it themselves.
export function appKeyInTerminal(settings: { appKeys?: Record<string, string>; termKeys?: Record<string, boolean> } | undefined, id: string, event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  const chosen = settings?.termKeys?.[id];
  if (chosen !== undefined) return chosen;
  return event.metaKey || (event.ctrlKey && event.shiftKey) || event.altKey || !!settings?.appKeys?.[id] || !!appKeyDefs.find(def => def.id === id)?.term;
}
// Where a key was typed, for keyBelongsToField: inside a Monaco editor, in a plain text field (chat box, input), or anywhere else.
export type KeyPlace = 'editor' | 'text' | 'other';
export function keyPlace(target: EventTarget | null): KeyPlace {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return 'other';
  if (target.closest('.monaco-editor')) return 'editor';
  const textInput = target instanceof HTMLInputElement && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(target.type);
  return target instanceof HTMLTextAreaElement || textInput || (target instanceof HTMLElement && target.isContentEditable) ? 'text' : 'other';
}
// Does a plain Ctrl+letter (no Shift, Alt or ⌘) stay with the field instead of running an app key? In the editor it is Monaco's own key
// (Ctrl+D adds the next match to the selection). On macOS every text field uses it for Cocoa editing (Ctrl+D deletes forward, Ctrl+A/E
// line start/end), and the app's mod there is ⌘, so only Ctrl-bound keys are given up. Elsewhere, Windows' chat box included, the app keeps it.
export function keyBelongsToField(event: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, place: KeyPlace, mac: boolean): boolean {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !/^Key[A-Z]$/.test(event.code)) return false;
  return place === 'editor' || (place === 'text' && mac);
}
// The same decision for the settings list, which has no event: a combo that is just Ctrl+key is the shell's by default.
export function appKeyInTerminalByDefault(settings: { appKeys?: Record<string, string> } | undefined, id: string): boolean {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const combo = normalizeCombo(appKey(settings?.appKeys, id) ?? '').replace('mod+', mac ? 'meta+' : 'ctrl+');
  return !/^ctrl\+[^+]+$/.test(combo) || !!settings?.appKeys?.[id] || !!appKeyDefs.find(def => def.id === id)?.term;
}
export const appKey = (overrides: Record<string, string> | undefined, id: string) => overrides?.[id] || appKeyDefs.find(def => def.id === id)?.keys;
const keyNames: Record<string, string> = { backquote: '`', backslash: '\\', comma: ',', period: '.', slash: '/', semicolon: ';', quote: "'", equal: '=', minus: '-', bracketleft: '[', bracketright: ']' };
export function normalizeCombo(combo: string): string {
  const parts = combo.toLowerCase().split('+'), key = parts.pop()!;
  return [...['meta', 'ctrl', 'mod', 'alt', 'shift'].filter(mod => parts.includes(mod)), keyNames[key] ?? key].join('+');
}
export function matches(keys: string, event: { code: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  const actual = normalizeCombo(comboOf(event)), expected = normalizeCombo(keys);
  return expected.includes('mod+') ? ['ctrl', 'meta'].some(mod => normalizeCombo(expected.replace('mod+', `${mod}+`)) === actual) : actual === expected;
}
export function combosOverlap(a: string, b: string): boolean {
  const expand = (value: string) => ['ctrl', 'meta'].map(mod => normalizeCombo(value.replace('mod+', `${mod}+`)));
  return expand(a).some(value => expand(b).includes(value));
}
export function showAppKey(overrides: Record<string, string> | undefined, id: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return showCombo(normalizeCombo(appKey(overrides, id) ?? '').replace('mod+', mac ? 'meta+' : 'ctrl+'));
}
