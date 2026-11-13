# Chat 모드 렌더링 성능 개선: 측정과 확인 방법

## 무엇을 고쳤나

| 원인 | 증상 | 수정 |
|---|---|---|
| `DeniedContext`에 `view.denied ?? {}` (렌더마다 새 객체), `awaitingTools`/`approvalAgents`가 빈 Set/Map을 매번 새로 만듦, `agentsOf` 결과가 토큰마다 새 배열 | 스트리밍 프레임마다, 입력창 키 입력마다 **과거 모든 턴의 ToolCard/ToolBundle이 리렌더** (Turn memo 무력화) | 공용 빈 값(`NO_DENIED`, `NO_IDS`, `NO_AGENTS`), `keepAgents`로 내용이 같으면 이전 배열 유지 |
| `DiffLayoutContext`가 `ctx`(Workspace 렌더마다 새 객체)에 의존 | Workspace가 다시 그려질 때마다 diff 소비자 리렌더 | `diffSplit`에만 의존, 호출은 `ctxRef` |
| 하단 줄 `fit()`이 매 렌더 `useLayoutEffect`에서 `clientWidth`를 읽음 | 스트리밍 토큰마다 강제 style/layout (프로파일 self time 1위) | 하단 줄 내용 변경(MutationObserver)·크기 변경(ResizeObserver) 때만 측정 |
| `style.css`의 `.chat-row…:has(> div > .chat-tool) + …:has(…) > div` | Chrome의 `:has()` 무효화 세트에 `div`가 들어가 **키 입력마다 페이지의 모든 div(41턴 기준 1,243개) style 재계산** | `Turn`이 붙이는 `data-tool` 속성으로 교체 |
| idle 때 접혀 보이지 않는 상태 행의 `.chat-spin`이 계속 회전 | 열린 채팅마다 idle에도 매 프레임 style recalc | 비활성 상태 행에서 `animation-play-state: paused` |
| 긴 히스토리 전체를 매 프레임 paint/prepaint | 스트리밍 중 Paint+PrePaint가 스크립트보다 큼 | `.chat-turn { content-visibility: auto }` (화면 밖 턴은 layout/paint 생략) |
| `syncPin`이 스크롤마다 맨 위부터 모든 요청의 rect를 읽음 | 화면 밖 턴까지 강제 layout | 최신 요청부터 역순으로 찾고 처음 맞는 곳에서 중단 |

## 측정 결과 (41~47턴, 각 턴 도구 4개 + 긴 마크다운, CPU 4배 스로틀)

fake `claude`(모델 호출 없음)로 만든 격리 환경(`ADE_DATA_DIR`·`HOME` 분리, `ADE_DEV=1`)에서 CDP `Performance.getMetrics`/CPU 프로파일/trace로 측정했다.

| 항목 | 수정 전 | 수정 후 |
|---|---|---|
| 스트리밍 1턴 (약 7.5초): 그려진 프레임 | 257 | 761 |
| 긴 프레임(>34ms) / 최악 프레임 | 48 / 958ms | 5 / 483ms |
| Script / Style / Layout | 2592 / 918 / 302ms | 1914 / 878 / 82ms (프레임 3배 처리하면서) |
| Paint / PrePaint (trace, 약 4.5초 구간) | 1458 / 1263ms | 432 / 243ms |
| 타이핑 40자: Script / Style | 570 / 760ms | 191 / 179ms |
| 타이핑 긴 프레임 | 15 | 1 |
| 키 입력당 style 재계산 대상 | 1,243개 (히스토리에 비례) | 47개 |

## 직접 확인할 것 (수동)

1. 긴 채팅(30턴 이상)을 열고 맨 위·중간·맨 아래로 스크롤: 내용이 빈칸 없이 그려지는지, 위로 스크롤할 때 화면이 튀지 않는지.
2. 스크롤 중 상단 고정 핀(직전 요청)이 맞는 요청을 가리키는지, 클릭하면 그 요청으로 이동하는지.
3. 응답 스트리밍 중 위로 스크롤하면 그 위치에 머무르고, 맨 아래로 돌아가면 다시 따라가는지.
4. 완료된 턴의 "과정"에서 도구 카드가 연속될 때 두 번째 카드부터 위쪽 여백이 붙어 보이는 기존 모양이 그대로인지.
5. 하단 줄: 창 폭을 줄이거나 Effort/모드/모델을 바꿀 때 라벨 접힘(data-fit 단계)이 전처럼 바뀌는지.
6. 턴 가장자리의 포커스 링·카드 그림자·새 행 등장 애니메이션이 잘리지 않는지 (`overflow-clip-margin: 16px`).
7. Cmd+F 검색으로 화면 밖 턴의 텍스트도 찾아지는지.
8. 서브에이전트(Agent) 실행 중 카드·트래커·드로어 상태가 실시간으로 바뀌는지, 승인 대기 표시가 나오는지.

## 확인한 것 / 안 한 것

- 단위 테스트: `tests/chat-model.test.mjs` 57개 통과(`keepAgents`·공용 빈 값 테스트 추가), typecheck 통과.
- 전체 `node --test tests/*.test.mjs`: 490개 중 6개 실패. 모두 이번 변경과 무관한 파일(usage-share의 `≈` 표기 변경, claude-auto-compact, update-busy의 셸 환경 의존)에서 남.
- 격리 환경에서 스크롤(idle/스트리밍 중) 위치 유지, 상단 핀, 렌더링 스크린샷 확인.
- Electron 앱 자체, Codex/Cursor 채팅, 실제 모델 응답, 서브에이전트 실행은 확인하지 않음.
