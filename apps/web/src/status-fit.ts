// 하단 상태바 접기의 순수한 부분(StatusFit.tsx가 DOM을 재서 이 함수로 고른다). 노드 테스트가 바로 읽을 수 있게 JSX 없이 둔다.
// 접는 순서: 순위가 낮은 쪽부터(CPU·메모리 → 시계·WakaTime → Codex·Cursor 사용량), 같은 순위끼리는 사용자가 정한 오른쪽 순서의 뒤쪽부터.
// 순위가 없는 항목(경로·브랜치·연결 상태·Claude 사용량·준비 상태)은 끝까지 남긴다.
export const foldRank: Record<string, number> = { cpu: 1, memory: 1, clock: 2, wakatime: 2, codexusage: 3, cursorusage: 3 };
export const foldOrder = (right: string[]) => right.filter(id => id in foldRank).map((id, at) => ({ id, at })).sort((a, b) => foldRank[a.id] - foldRank[b.id] || b.at - a.at).map(item => item.id);

export const STATUS_MENU_BUTTON = 30;

// `available`: 오른쪽 묶음이 쓸 수 있는 폭, `fixed`: 접을 수 없는 것(배지 등)의 폭, `widths`: 항목별 자연 폭, `order`: foldOrder 결과.
export function chooseFolded({ available, fixed, widths, order }: { available: number; fixed: number; widths: Record<string, number>; order: string[] }) {
  let total = fixed + Object.values(widths).reduce((sum, width) => sum + width, 0);
  const folded: string[] = [];
  for (const id of order) {
    if (total <= available) break;
    if (!(widths[id] > 0)) continue; // 지금 아무것도 그리지 않는 항목(아직 데이터 없음)은 접어도 자리가 나지 않는다
    total -= widths[id]; folded.push(id);
    if (folded.length === 1) total += STATUS_MENU_BUTTON; // 처음 접을 때 "…" 버튼이 자리를 차지한다
  }
  return folded;
}
