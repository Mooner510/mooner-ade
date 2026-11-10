import { comboOf, showCombo } from './chat-model';

export const appKeyDefs = [
  { id: 'newTab', group: '탭', label: '새 탭', keys: 'mod+shift+t' },
  { id: 'newTab2', group: '탭', label: '새 탭 (대체)', keys: 'alt+t' },
  { id: 'launcher', group: '탭', label: '새 탭에서 실행…', keys: 'mod+shift+n' },
  { id: 'closeTab', group: '탭', label: '탭 닫기', keys: 'mod+shift+w' },
  { id: 'nextTab', group: '탭', label: '다음 탭', keys: 'alt+]' },
  { id: 'prevTab', group: '탭', label: '이전 탭', keys: 'alt+[' },
  { id: 'moveTabUp', group: '탭', label: '탭을 위로 이동', keys: 'alt+shift+[' },
  { id: 'moveTabDown', group: '탭', label: '탭을 아래로 이동', keys: 'alt+shift+]' },
  { id: 'nextTab2', group: '탭', label: '다음 탭 (대체)', keys: 'mod+shift+]' },
  { id: 'prevTab2', group: '탭', label: '이전 탭 (대체)', keys: 'mod+shift+[' },
  { id: 'closePane', group: '분할 · Pane', label: '포커스된 pane 닫기', keys: 'alt+w' },
  { id: 'zoom', group: '분할 · Pane', label: 'Pane 최대화 전환', keys: 'mod+shift+enter' },
  { id: 'focusNext', group: '분할 · Pane', label: '다음 pane으로 이동', keys: 'alt+shift+arrowright' },
  { id: 'focusPrev', group: '분할 · Pane', label: '이전 pane으로 이동', keys: 'alt+shift+arrowleft' },
  { id: 'focusNext2', group: '분할 · Pane', label: '다음 pane으로 이동 (대체)', keys: 'alt+shift+arrowdown' },
  { id: 'focusPrev2', group: '분할 · Pane', label: '이전 pane으로 이동 (대체)', keys: 'alt+shift+arrowup' },
  { id: 'focusModright', group: '분할 · Pane', label: '다음 pane으로 이동 (대체)', keys: 'mod+shift+arrowright' },
  { id: 'focusModleft', group: '분할 · Pane', label: '이전 pane으로 이동 (대체)', keys: 'mod+shift+arrowleft' },
  { id: 'focusModdown', group: '분할 · Pane', label: '다음 pane으로 이동 (대체)', keys: 'mod+shift+arrowdown' },
  { id: 'focusModup', group: '분할 · Pane', label: '이전 pane으로 이동 (대체)', keys: 'mod+shift+arrowup' },
  { id: 'review', group: '화면 · 도구', label: '변경사항(Diff) 패널 전환', keys: 'mod+shift+g' },
  { id: 'palette', group: '화면 · 도구', label: '명령 팔레트', keys: 'mod+shift+p' },
  { id: 'palette2', group: '화면 · 도구', label: '명령 팔레트(F1)', keys: 'f1' },
  { id: 'addProject', group: '프로젝트', label: '프로젝트 열기…', keys: 'mod+alt+o' },
  { id: 'toggleProjects', group: '화면 · 도구', label: '프로젝트 사이드바 접기/펼치기', keys: 'mod+alt+b' },
  { id: 'settings', group: '화면 · 도구', label: '설정 열기', keys: 'mod+,' },
  { id: 'closeProject', group: '프로젝트', label: '프로젝트 닫기', keys: 'mod+alt+w' },
  { id: 'nextProject', group: '프로젝트', label: '다음 프로젝트', keys: 'mod+alt+]' },
  { id: 'prevProject', group: '프로젝트', label: '이전 프로젝트', keys: 'mod+alt+[' },
  { id: 'splitRight', group: '분할 · Pane', label: '좌우 분할', keys: 'ctrl+d' },
  { id: 'splitDown', group: '분할 · Pane', label: '상하 분할', keys: 'ctrl+shift+d' },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `tab${i + 1}`, group: '탭', label: `${i + 1}번 탭으로 이동`, keys: `alt+${i + 1}` })),
  ...Array.from({ length: 9 }, (_, i) => ({ id: `project${i + 1}`, group: '프로젝트', label: `${i + 1}번 프로젝트로 이동`, keys: `mod+alt+${i + 1}` })),
];
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
