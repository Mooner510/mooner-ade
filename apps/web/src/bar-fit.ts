// 상단 바가 좁을 때 오른쪽 버튼 묶음(.bar-tools)이 Windows 창 버튼 밑으로 넘치지 않게 하는 단계 선택(순수한 부분).
// 바 오른쪽 padding이 창 버튼 폭을 비워 두므로, 묶음의 오른쪽 끝이 그 안쪽 한계를 넘지 않으면 들어간 것이다.
// 단계는 정보가 적은 것부터 줄인다: 1 검색 창을 아이콘만, 2 "새 탭" 글자 숨김, 3 커밋 그래프의 +/− 숫자 숨김(style.css의 `.tabbar[data-fit]`).
// 3단계로도 안 들어가면 3을 돌려준다(그 이상은 줄일 것이 없다). 노드 테스트가 바로 읽을 수 있게 JSX·DOM 없이 둔다.
export const BAR_FIT_LEVELS = 3;

// 반 픽셀 안쪽 오차는 소수점 레이아웃 때문이라 넘친 것으로 보지 않는다.
export const barFits = (toolsRight: number, limit: number) => toolsRight <= limit + 0.5;

// `fits(level)`: 그 단계를 적용했을 때 들어가는가. 가장 덜 줄인 단계를 고른다.
export function chooseBarFit(fits: (level: number) => boolean, levels = BAR_FIT_LEVELS): number {
  for (let level = 0; level < levels; level++) if (fits(level)) return level;
  return levels;
}
