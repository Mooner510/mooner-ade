// The shortcut guide (mod+/, KeyGuide.tsx): every key the app answers to, grouped and searchable. The keys a user can change come from
// shortcuts.ts `appKeyDefs` and chat-model.ts `chatKeyDefs` (with the user's own choices); the fixed ones live here.
// fixedKeys: one entry per line, so other teams can add theirs and a merge only interleaves lines. `keys` is a combo ("mod+s", shown as
// Ctrl+S or ⌘S) or plain text ("↑ / ↓"); " / " separates alternatives.
import { appKey, appKeyDefs } from './shortcuts';
import { chatKey, chatKeyDefs, showCombo } from './chat-model';

export type FixedKey = { group: string; keys: string; label: string };
export const fixedKeys: FixedKey[] = [
  { group: '명령 팔레트', keys: '>', label: '명령만 검색' },
  { group: '명령 팔레트', keys: '#', label: '탭, 채팅, 프로젝트로 이동 (모든 프로젝트)' },
  { group: '명령 팔레트', keys: '@', label: '프로젝트 파일 열기' },
  { group: '명령 팔레트', keys: ',', label: '설정 항목 열기' },
  { group: '명령 팔레트', keys: '?', label: '접두사 도움말' },
  { group: '사이드바 (탭 목록에 포커스)', keys: 'arrowup / arrowdown', label: '위아래 줄로 이동' },
  { group: '사이드바 (탭 목록에 포커스)', keys: 'arrowleft / arrowright', label: '접기·펼치기, 상위 줄로' },
  { group: '사이드바 (탭 목록에 포커스)', keys: 'home / end', label: '처음 / 마지막 줄' },
  { group: '사이드바 (탭 목록에 포커스)', keys: 'enter / space', label: '선택한 탭·pane 열기' },
  { group: '사이드바 (탭 목록에 포커스)', keys: 'f2', label: '탭 이름 바꾸기' },
  { group: '사이드바 (탭 목록에 포커스)', keys: 'delete', label: '닫기 (항상 확인)' },
  { group: '사이드바 (탭 목록에 포커스)', keys: 'alt+arrowup / alt+arrowdown', label: '탭 순서 옮기기' },
  { group: '사이드바 (탭 목록에 포커스)', keys: 'shift+f10', label: '메뉴 열기' },
  { group: '편집기', keys: 'mod+s', label: '저장' },
  { group: '편집기', keys: 'arrowleft / arrowright', label: '파일 탭 줄에서 옆 파일로' },
  { group: '편집기', keys: 'delete', label: '파일 탭 줄에서 그 파일 닫기' },
  { group: '편집기', keys: 'ctrl+d', label: '다음 일치 항목 선택 (편집기 안의 Ctrl+글자는 편집기 몫)' },
  { group: '터미널', keys: 'ctrl+c', label: '선택한 글자가 있으면 복사, 없으면 중단' },
  { group: '터미널', keys: 'ctrl+shift+c', label: '복사' },
  { group: '터미널', keys: 'ctrl+v', label: '붙여넣기 (이미지는 파일 경로로)' },
  { group: '터미널', keys: 'shift+enter', label: 'CLI에서 줄바꿈' },
  { group: '터미널', keys: 'tab', label: 'Claude 작업 중: 입력을 후속 대기열에 넣기' },
  { group: '채팅 입력창', keys: 'enter', label: '보내기 (설정에서 Ctrl+Enter로 바꿀 수 있음)' },
  { group: '채팅 입력창', keys: 'shift+enter', label: '줄바꿈' },
  { group: '채팅 입력창', keys: 'tab', label: '응답 중: 끝난 뒤 보내기 대기열에 넣기' },
  { group: '채팅 입력창', keys: 'shift+tab', label: '권한 모드 바꾸기' },
  { group: '채팅 입력창', keys: 'escape', label: '메뉴 닫기, 응답 중단, 입력창 나가기' },
  { group: '채팅 입력창', keys: 'arrowup / arrowdown', label: '보낸 메시지 다시 불러오기' },
  { group: '채팅 입력창', keys: '/ / @', label: '슬래시 명령 / 파일 언급' },
  { group: 'Git 커밋 그래프', keys: 'shift+escape', label: '닫기' },
  { group: '크기 조절 막대 (포커스)', keys: '화살표', label: '크기 조절' },
  { group: '크기 조절 막대 (포커스)', keys: 'enter / home', label: '더블클릭과 같은 동작 / 기본 크기' },
  { group: '대화상자', keys: 'escape', label: '닫기' },
];

export type GuideRow = { keys: string[]; label: string };
export type GuideGroup = { title: string; rows: GuideRow[]; changeable: boolean };
const mac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
// "mod+s" → "Ctrl+S" / "⌘S"; text that is not a combo ("화살표", "/") stays as written.
export function showGuideKey(keys: string, onMac = mac()): string {
  if (!/^[a-z0-9.,/;'[\]\\=`-]+(\+[a-z0-9.,/;'[\]\\=`-]+)*$/.test(keys)) return keys;
  return showCombo(keys.replace(/\bmod\b/, onMac ? 'meta' : 'ctrl'));
}
const splitKeys = (keys: string, onMac?: boolean) => keys.split(' / ').map(part => showGuideKey(part.trim(), onMac));

// Changeable keys first (app keys by their settings group, then the chat box), then the fixed ones; rows with no key are left out.
// A query keeps the rows whose label, key or group matches.
export function keyGuideGroups(settings: { appKeys?: Record<string, string>; chatKeys?: Record<string, string> }, query = '', onMac?: boolean): GuideGroup[] {
  const groups = new Map<string, GuideGroup>();
  const add = (title: string, changeable: boolean, row: GuideRow) => { const group = groups.get(title) ?? { title, rows: [], changeable }; group.rows.push(row); groups.set(title, group); };
  for (const def of appKeyDefs) {
    const combo = appKey(settings.appKeys, def.id);
    if (combo) add(def.group, true, { keys: [showGuideKey(combo, onMac)], label: def.label });
  }
  for (const def of chatKeyDefs) add('채팅 입력창 (바꿀 수 있음)', true, { keys: [showGuideKey(chatKey(settings.chatKeys, def.id), onMac)], label: def.label });
  for (const item of fixedKeys) add(item.group, false, { keys: splitKeys(item.keys, onMac), label: item.label });
  const needle = query.trim().toLowerCase();
  return [...groups.values()].map(group => !needle || group.title.toLowerCase().includes(needle) ? group
    : { ...group, rows: group.rows.filter(row => row.label.toLowerCase().includes(needle) || row.keys.some(key => key.toLowerCase().includes(needle))) })
    .filter(group => group.rows.length);
}
