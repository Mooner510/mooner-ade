# 화면 그리기 비용 기준선 (Frame cost baseline)

최적화 전후를 같은 잣대로 비교하기 위한 기준 측정이다. 측정 도구: `scripts/perf/frame-cost.mjs`.

## 측정 환경 (2026-11-14)

| 항목 | 값 |
|---|---|
| 기기 | Apple M1 Pro (10코어), 32GB, macOS 26.6.1 |
| 화면 | 내장 디스플레이 1728x1001 pt @2x(3456x2002 px), ProMotion 120Hz |
| 코드 | master `b8c8fa8` (0.5.4), `apps/web/dist` 프로덕션 빌드 |
| Electron | 44.7.0 (저장소에 설치된 버전) |

## 측정 방법

- 같은 Electron 실행 파일로 작업 영역 전체 크기의 창을 하나 띄운다. 빈 페이지(`blank-*`)와 ADE 화면(`ade-*`)은 같은 하네스, 같은 화면, 같은 창 크기로 잰다.
- ADE는 격리된 임시 서버(`scripts/verify/lib.mjs`의 `boot()`, 가짜 `claude`)에 붙는다. 튜토리얼을 끝낸 상태에 임시 저장소 하나가 열려 있다.
- 창이 뜨고 준비되면 5초를 기다린 뒤 15초 동안 프로세스 종류별 CPU 시간 증가분을 `ps`로 잰다. 값은 **코어 1개 대비 %** 이다(100% = 코어 하나를 꽉 씀). Activity Monitor의 %와 같은 기준이다.
- 비교에 쓰는 값은 **renderer + GPU 프로세스** 합이다. browser(메인)와 utility는 모든 시나리오에서 0.1~0.6%라 표에서 뺐다.
- **창 포커스:** ADE는 사용 중이 아닌 창(`data-blurred`)에서 반복 애니메이션을 멈춘다. 하네스 창은 OS 포커스를 받지 않으므로, 페이지에 "사용 중인 창"이라고 알려 **앞에 있는 창** 상황을 잰다. 실제 OS 포커스는 결과의 `focused` 열에 남는다.
- **보이지 않는 창 (2026-11-14부터):** 측정 창은 포커스를 가져가지 않고, Dock 아이콘 없이, 완전히 투명하고 클릭이 통과하는 상태로 뜬다. 측정하는 동안에도 Mac을 그대로 쓸 수 있다.
  - 가려진 창도 매 프레임 그리도록 Chromium 스위치(`disable-backgrounding-occluded-windows` 등)를 켠다. 끄면 가려진 창은 그리기를 멈춰 0%로 잘못 잰다.
  - 보이는 창보다 숫자가 조금 낮게 나온다. OS가 창 자체를 합성하지 않기 때문이다. 그래서 **결과는 같은 모드끼리만 비교한다.** 아래 "4. 개선" 표가 이 모드의 기준값이다.
  - 창을 보면서 재려면 `SHOW=1`을 준다.
- 턴 실행 중(`ade-chat-turn`)은 가짜 `claude`가 `slow` 메시지로 턴을 2분 동안 붙잡아 둔 상태다. 텍스트 스트리밍은 없다. 화면에는 "생각하는 중..." 스피너, 정지 버튼 숨쉬기, 사이드바 탭의 작업 링이 돈다.

### 다시 재는 법

```sh
pnpm --filter @mooner/ade-web build
VERIFY_OUT=$(mktemp -d -t ade-verify-out) node scripts/perf/frame-cost.mjs                 # 전체 시나리오(약 9분)
VERIFY_OUT=$(mktemp -d -t ade-verify-out) node scripts/perf/frame-cost.mjs ade-chat-turn   # 일부만
PROBE=1 VERIFY_OUT=... node scripts/perf/frame-cost.mjs ade-chat-turn   # 진단 (아래 목록)
CSS='.chat-statusbar { display: none !important; }' VERIFY_OUT=... node scripts/perf/frame-cost.mjs ade-chat-spinner   # 임의의 CSS를 넣고 재기 (원인 좁히기)
FLAGS='switch=value' ...   # Chromium 스위치를 넣고 재기
SHOTS=12 ...               # 스크린샷 12장을 250ms 간격으로 더 남김 (<시나리오>-1.png ...), 움직임 확인용
```

`PROBE=1` 출력 (진단용. 프로브가 붙어 있는 동안은 숫자가 틀어진다):
- `ANIMATIONS`: 돌고 있는 애니메이션
- `EFFECTS`: iframe·canvas, filter·mask·will-change·opacity가 걸린 보이는 요소
- `LAYERS`: 합성 레이어의 크기(기기 px)와 합성 이유
- `RAF`: requestAnimationFrame 호출자
- `METRICS`: 3초 동안의 메인 스레드 작업 (스타일·레이아웃 횟수와 시간)
- `TRACE`, `TIME`: 2초 트레이스의 이벤트 횟수와 이벤트별 총 시간 (렌더러와 GPU 프로세스 모두)
- `SURFACES`: 컴포지터가 매 프레임 따로 그리는 render surface와 그 이유 (filter, mask, 스케일 변환 등)
- `NOT_COMPOSITED`: 컴포지터가 맡지 못한 애니메이션과 그 속성
- `INVALIDATIONS`: 스타일 재계산을 일으킨 원인
- `ARGS='이벤트 이름,...'`: 그 트레이스 이벤트들의 인자 (예: `SkiaOutputDevice->ScheduleOverlays()`의 overlay 수)

- 시나리오마다 스크린샷(`$VERIFY_OUT/<시나리오>.png`)이 남는다. 무엇을 쟀는지 그걸로 확인한다.
- 측정 중 Mac을 써도 되지만, 무거운 작업(빌드, 영상 등)은 숫자에 섞인다.
- 같은 시나리오를 반복하면 ±1~4%p 정도 흔들렸다. 아래 표에서 여러 번 잰 값은 범위로 적었다.

## 결과

1~3은 보이는 창 하네스로 master `b8c8fa8`(0.5.4)을 잰 처음 기록이다. 해석의 일부는 4에서 바로잡았다.

### 1. 바닥 비용: Electron/Chromium 자체

| 시나리오 | 화면 | renderer + GPU |
|---|---|---|
| `blank-idle` | 빈 창, 텍스트 80줄, 움직임 없음 | **0%** |
| `blank-spinner` | 위 + 16px CSS 스피너 1개(`transform` 회전, GPU만 쓰는 애니메이션) | **12~17%** |
| `blank-webgl` | 위 + 정지된 WebGL 캔버스 3개(xterm 터미널 흉내) | 14~18% |

- **무엇이든 하나라도 120Hz로 움직이면, 빈 창이라도 코어의 약 17%가 든다.** 이 화면(3456x2002 px, 120Hz)에서 Chromium이 매 프레임 창을 다시 합성하는 고정비다. 앱 코드로는 줄일 수 없다.
- 정지된 WebGL 캔버스는 비용을 늘리지 않았다.

### 2. ADE가 쉬고 있을 때

| 시나리오 | 화면 | renderer + GPU |
|---|---|---|
| `ade-idle` | 새 탭 선택 화면(터미널/Claude/Codex/Cursor 카드) | **0.5%** |
| `ade-chat` | Claude Chat 빈 화면, 입력 대기 | **0.3~0.6%** |
| `ade-spinner` | `ade-idle` + 위와 같은 CSS 스피너 1개 | **15~18%** |

- 쉬고 있을 때는 빈 Electron 창과 같은 수준이다.
- ADE 화면에 같은 스피너를 넣어도 빈 창과 같은 비용이다. **ADE의 화면 구성 자체는 프레임을 비싸게 만들지 않는다.**

### 3. Chat 턴 실행 중: 무엇이 비용을 만드는가

턴 중에 도는 것은 세 가지다:
- `spin`: "생각하는 중..." 스피너, CSS, 120Hz
- `chat-breathe`: 정지 버튼 뒤 원, CSS, 120Hz
- 작업 링: 사이드바 탭 테두리의 `svg.agent-trail`. JS 타이머가 초당 24번 `--f`를 써서 `stroke-dashoffset`를 움직인다(`apps/web/src/main.tsx:25-44`).

시나리오 이름 뒤에 붙은 키로 하나씩 끄며 쟀다. 키의 정의는 `scripts/perf/electron/main.cjs`에 있다.

| 시나리오 | 켜져 있는 것 | renderer + GPU |
|---|---|---|
| `ade-chat-turn` | 스피너 + 숨쉬기 + 작업 링 (실제 상태) | **53~57%** |
| `-nospin` | 숨쉬기 + 링 | 48~49% |
| `-nobreathe` | 스피너 + 링 | 53~55% |
| `-noring` | 스피너 + 숨쉬기, 링 숨김(타이머는 계속 돎) | 58% |
| **`-freezering`** | 스피너 + 숨쉬기, 링은 보이지만 타이머가 아무것도 쓰지 않음 | **26%** |
| `-still` | 링만(CSS 애니메이션·전환 전부 끔) | 24~26% |
| `-still-noring` | 링 숨김, 타이머만 돎 | 8% |
| `-still-freezering` | 아무것도 안 움직임 | 5% |
| `-nospin-nobreathe-noring-spinner` | 링 숨김(타이머 돎) + 중립 스피너 1개 | 41% |
| `-nospin-nobreathe-freezering-spinner` | 링 타이머 멈춤 + 중립 스피너 1개 | 34% |
| `-flat` / `-unfocus` | 입력창의 포커스 효과(살짝 떠오름·그림자) 제거 / 포커스 해제 | 57% / 56% (영향 없음) |

### 4. 개선 (브랜치 `perf/turn-frames`, 보이지 않는 창 모드)

턴 중 비용을 쪼개 보니 원인은 애니메이션 자체가 아니었다. **움직이는 것이 filter·mask·뒤집기(스케일) 안에 있거나, 화면 어딘가에 끝난 filter 애니메이션이 남아 있으면 macOS에서 창 전체를 매 프레임 다시 합성한다.** GPU 프로세스 시간이 `SwapBuffers`와 `ScheduleOverlays`에서 크게 늘었다(`PROBE=1`의 `TIME`). 이런 요소가 없으면 움직이는 레이어만 OS에 넘겨 바닥 비용 수준으로 끝난다.

찾은 원인 (모두 `CSS=`와 ablation으로 하나씩 확인):

| 원인 | 혼자 있을 때 비용 | 원인을 뺐을 때 |
|---|---|---|
| 채팅 상태줄의 `.chat-stat-swap` 애니메이션이 `both`로 끝난 뒤에도 `filter: blur(0)`을 붙잡고 있음 (61x14 px 요소 하나) | 빈 채팅 + 스피너 35% | 15% |
| 채팅 스크롤 영역의 아래쪽 페이드 `mask-image` 안에서 "생각하는 중" 스피너가 돎 | 스피너만 42.5% | 17.7% |
| 작업 링의 `drop-shadow` filter 안에서 혜성이 움직임 | 링만 44.6% | 18.1% |
| 작업 링 아래쪽 변을 `rotate(180deg)`로 돌림 (뒤집기는 스케일로 취급되어 별도 surface) | 링만 40.7% | 22.8% |

고친 것:
- `.chat-stat-swap`: `animation-fill-mode`를 `both` → `backwards`
- 채팅 아래쪽 페이드: `mask-image` 대신 배경색(`--surface`) 그라데이션을 sticky `::after`로 덮음
- 작업 링: SVG + 24fps JS 타이머(`stroke-dashoffset`) → `transform`만 움직이는 CSS 애니메이션. 네 변마다 혜성 띠가 미끄러진다. 같은 속도·같은 이징·탭마다 다른 주기와 위상은 그대로다. 빛번짐(`drop-shadow`)은 뺐다. 블러 없이 흉내 낸 띠는 모서리가 각지게 보였다.

결과 (같은 날, 같은 모드, master는 같은 하네스에서 master 소스로 빌드한 `apps/web/dist`):

| 시나리오 | master `b8c8fa8` | `perf/turn-frames` |
|---|---|---|
| `blank-spinner` (바닥 비용) | 14.2% | 14.2% |
| `ade-idle` / `ade-chat` | - | 0.6% / 0.5% |
| `ade-chat-spinner` (빈 채팅 + 스피너 1개) | 35.7% | **16.3%** |
| `ade-chat-turn` (턴 실행 중) | 46~50% | **27.2%** |
| `ade-chat-turn-nospin-nobreathe` (링만) | 26% | 23% |
| `ade-chat-turn-noring` (스피너 + 숨쉬기) | - | 23.4% |

- 턴 중 비용이 약 절반이 됐다. 바닥 비용(14%)보다 남은 약 13%p는 렌더러 쪽이다(렌더러 11.7% vs 빈 창 5.3%). 링 띠 4개와 스피너·숨쉬기를 컴포지터가 매 프레임 진행시키는 비용, 1초마다 바뀌는 경과 시간, 5초마다 붉어지는 "깊게 생각하는 중" 색 전환이 들어 있다.
- master의 링 단독(26%)이 고친 뒤(23%)와 큰 차이가 없는 것은, master에서는 링이 24fps로만 그려졌기 때문이다. 고친 링은 120Hz로 부드럽게 돌면서 비용은 조금 낮다.

## 해석

(1~3의 처음 해석이다. 4에서 보듯 진짜 원인은 filter·mask 안에서 움직이는 것과 남아 있던 filter 애니메이션이었고, 1번의 "링 타이머가 프레임을 비싸게 만든다"는 그 일부만 맞다.)

1. **턴 중 비용의 절반 이상은 작업 링의 JS 타이머다.** 타이머만 멈추면(`-freezering`) 57% → 26%가 된다. 링을 숨겨도 타이머가 돌면 그대로다(`-noring` 58%).
   - 원인: 초당 24번의 인라인 스타일 변경이 매번 메인 스레드의 스타일 재계산과 커밋을 일으킨다. 이것이 120Hz로 도는 스피너·숨쉬기 프레임과 겹치면서, 원래 GPU만으로 처리될 프레임까지 비싸진다.
   - 트레이스 근거(`PROBE=1`): 2초 동안 `svg.agent-trail`의 "Inline CSS style declaration was mutated"가 49회 기록됐다.
2. **스피너와 숨쉬기도 완전히 GPU만으로 돌지는 않는다.** 링 타이머를 멈춘 턴(26%)이 바닥 비용(약 17%)보다 약 9%p 높다.
   - 트레이스에서 `I.chat-spin`과 `::before`(정지 버튼)가 "Animation" 사유로 2초에 각 152회 스타일 재계산을 일으켰다.
   - 빈 창의 스피너는 이런 재계산이 없다.
3. **바닥 비용 약 17%는 플랫폼 몫이다.** 120Hz 화면에서 무엇이든 움직이는 동안 Chromium 앱이라면 피할 수 없다.
   - 네이티브 macOS 앱은 같은 일을 Core Animation(WindowServer)에 넘긴다. 그래서 앱 프로세스 CPU에는 잘 드러나지 않는다.
4. **쉬는 동안(0.3~0.6%)과 창이 뒤에 있을 때는 문제없다.**

### 이전 측정과의 차이

0.5.4 작업 때 잰 "턴 실행 중 약 40%, 작업 링 약 18%"는 하네스(터미널이 보이는 화면, 창 상태)가 달랐다. 앞으로는 이 문서의 `ade-chat-turn`(53~57%)을 기준값으로 쓴다.

## 지킬 것 (이번에 배운 것)

- 오래 도는 애니메이션은 `transform`·`opacity`만 움직인다.
- 움직이는 것을 `filter`(blur, drop-shadow), `mask-image`, `backdrop-filter`, 뒤집기·스케일 변환 안에 넣지 않는다. 그 요소만이 아니라 창 전체가 매 프레임 다시 합성된다.
- 한 번 도는 애니메이션에 `filter`를 쓰면 `both`·`forwards`로 끝 상태를 붙잡지 않는다. 끝난 뒤에도 화면에 남아 다른 모든 애니메이션의 프레임을 비싸게 만든다.
- 의심되면 `PROBE=1`의 `SURFACES`(별도 surface와 이유)와 `TIME`(GPU 쪽 `SwapBuffers`·`ScheduleOverlays` 시간)부터 본다.

## 다음 후보

| 후보 | 기대 효과 (턴 중) | 근거 |
|---|---|---|
| 턴 중 120Hz로 도는 것을 없애기. 예: 스피너·숨쉬기를 정지 표시로, 링을 몇 초마다 한 번 움직이는 표시로 | 27% → 거의 0 | `-still` 계열 |
| 터미널 화면(CLI 에이전트)에서도 같은 원인(filter·mask 안의 움직임)이 있는지 확인 | 미측정 | "아직 재지 않은 것" |

## 아직 재지 않은 것

- 터미널(xterm)에서 CLI 에이전트가 일하는 화면. 작업 링과 터미널 출력이 함께 있는 경우다. 가짜 에이전트로 재현하는 시나리오가 아직 없다.
- 실제 AI 응답이 스트리밍되는 동안. DOM이 계속 늘어나는 비용이다.
- Windows, 60Hz 외장 모니터.
