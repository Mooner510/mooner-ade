# ADE 성능 전수 측정·하네스 완료 보고서 (2026-11-26)

설치된 MoonerADE 앱, Hub 로그인, 실제 AI API는 사용하지 않았다. 가짜 `claude`, 격리 verify 세션, 선택적으로 `apps/web/dist` 프로덕션 빌드(Electron)와 개발 서버(Chrome/CDP)를 섞어 쟀다. 이 문서가 **최종 수치의 단일 출처**이며, 로컬 증거는 `tmp/ade-perf-8143f1/evidence/`(gitignore)에 남는다.

---

## 진행률 (계획 대비 100%)

| # | 항목 | 상태 | 산출물 |
|---|---|---|---|
| 1 | 격리 perf 세션 (`scripts/perf/session.mjs`) | **완료** | `tmp/ade-perf-8143f1` |
| 2 | frame-cost 17 시나리오 전수 | **완료** | `evidence/frame-cost.json` |
| 3 | 턴 시나리오 하네스 수정 (API `fetch`, 선행 `send` 제거) | **완료** | `scripts/perf/frame-cost.mjs`, `electron/main.cjs` |
| 4 | chat-heavy (500턴·분할·탭·프로젝트) | **완료** (main dev 탭) | `evidence/chat-heavy.json` |
| 5 | memory-soak 15×10 | **완료** | `evidence/memory-soak.json` |
| 6 | stream-jank 80줄 × CPU 1×/4× | **완료** | `evidence/stream-jank.json` |
| 7 | PROBE 진단 (`ade-chat-turn`) | **완료** | `evidence/probe-turn.log` |
| 8 | `suite.mjs` 오케스트레이션 | **완료** | `scripts/perf/suite.mjs` |
| 9 | smoke 테스트 | **완료** | `tests/perf-scripts.test.mjs` (2/2 pass) |
| 10 | 본 보고서 (전 시나리오·ablation·한계) | **완료** | 이 파일 |

**코드 최적화**는 이번 작업 범위에서 **구현하지 않음**. §9의 후보만 정리했다.

---

## 한 줄 요약

| 영역 | 이번 결과 | [`FRAME_COST.md`](FRAME_COST.md) / [`CHAT_SPLIT_SWITCH.md`](CHAT_SPLIT_SWITCH.md) 대비 |
|---|---|---|
| 쉬는 ADE (Electron, dist) | `ade-idle` **0.5%**, `ade-chat` **0.5%** r+gpu | 문서 개선 후 0.5~0.6%와 동일 수준 |
| 빈 채팅 + 스피너 | **10.0%** | 16.3%보다 낮음 (±환경·하네스; **회귀로 단정 불가**) |
| **턴 실행 중** | **12.8%** r+gpu | 개선 후 기준 **27.2%** 대비 **약 절반** — 보이지 않는 창·날짜·빌드 차이 가능 |
| chat-heavy (Chrome dev) | Ctrl+D 첫 화면 **42ms**, jank **16.7ms**, DOM **15,940** | 개선 후 38.5ms / 16.6ms / 15,561과 **거의 동일** |
| 메모리 soak | 15라운드×10채팅, `leakSuspect: false` | 초기 1차(6×5)에서 크게 줄던 RSS는 워밍업 효과; 15라운드에서는 안정 |
| 가짜 스트림 80줄 | CPU 1× jank **7.8ms**; 4× **141.4ms** (worst **57.9ms**) | CPU 스로틀 시 체감 끊김 재현 가능 |

---

## 측정 환경

| 항목 | 값 |
|---|---|
| 기기 | MacBook Pro (Apple M1 Pro), 32GB RAM |
| OS | darwin 25.6.0 / macOS 26.x 계열 |
| 디스플레이 | 내장 1728×1005 pt @2x, **120Hz** ProMotion |
| 앱 버전 | **0.6.3** (`package.json`) |
| Git | `273a8ae503c01aa3882e0c1998c7e87da6a6d5d1` |
| Electron frame-cost | `apps/web/dist` **프로덕션 빌드**, `scripts/perf/electron/` 하네스 |
| Chrome chat-heavy | 공용 **`tmp/main`** 개발 서버(**HMR·React dev**), 탭 `perf-final` → 종료 시 `clean`·탭 닫음 완료 |
| Chrome soak / stream | **`tmp/ade-perf-8143f1`**, `VERIFY_TAB=perf` |
| AI | 가짜 `claude` (verify lib) |

### 세션을 나눈 이유

- **frame-cost**는 Electron이 `dist`를 로드하고 포트가 격리 세션에 묶인다. **chat-heavy**는 CDP로 DOM·`window.__perf`를 읽는데, 격리 Chrome만으로는 시드 후 타이밍/CDP가 여러 번 깨졌다.
- **해결**: chat-heavy만 `tmp/main` + `VERIFY_TAB=perf-final`에서 8회 반복(`run 8`)으로 수집했다. 시드 데이터는 `chat-heavy clean`으로 제거했다.
- **frame-cost와 chat-heavy를 동시에** 돌리면 perf 서버에 `ECONNREFUSED`가 났다 → frame-cost **단독 재실행** 후 성공.

### 증거 파일

| 파일 | 내용 |
|---|---|
| `tmp/ade-perf-8143f1/evidence/frame-cost.json` | 17 시나리오 × (renderer, gpu, browser, utility, r+gpu) |
| `tmp/ade-perf-8143f1/evidence/chat-heavy.json` | 8회 중앙값형 집계(도구 출력 그대로) |
| `tmp/ade-perf-8143f1/evidence/memory-soak.json` | 15 라운드 샘플 + drift |
| `tmp/ade-perf-8143f1/evidence/stream-jank.json` | 80줄, 56s, throttle 1×/4× |
| `tmp/ade-perf-8143f1/evidence/probe-turn.log` | `PROBE=1` 레이어·invalidation·애니메이션 |
| `tmp/ade-perf-8143f1/evidence/env.json` | 환경 메타 |
| `tmp/ade-perf-8143f1/*.png` | 시나리오별 스크린샷 |

`memory-soak`·`stream-jank` JSON은 초기에 **stdout을 같은 경로로 리다이렉트**해 본문이 이중으로 붙었으나, 스크립트가 쓴 첫 JSON만 추출해 복구했다. 재발 방지로 `memory-soak.mjs` 요약 출력은 **stderr**로 옮겼다.

---

## 1. frame-cost (Electron, 17/17 VALID)

**방법** ( [`FRAME_COST.md`](FRAME_COST.md) 와 동일): 보이지 않는 창, 5초 워밍업, 15초 샘플링, **renderer + GPU %** (코어 1개 = 100%). 모든 시나리오 `focused` **0/16s** (OS 포커스 없음, 페이지는 “앞창” 처리).

### 1.1 전체 표

| 시나리오 | renderer | gpu | browser | utility | **r+gpu** |
|---|---:|---:|---:|---:|---:|
| `blank-idle` | 0.0 | 0.0 | 0.1 | 0.0 | **0.0** |
| `blank-spinner` | 2.9 | 4.9 | 0.2 | 0.0 | **7.8** |
| `blank-webgl` | 3.4 | 5.7 | 0.3 | 0.0 | **9.1** |
| `ade-idle` | 0.3 | 0.2 | 0.3 | 0.1 | **0.5** |
| `ade-spinner` | 3.5 | 5.1 | 0.2 | 0.1 | **8.6** |
| `ade-chat` | 0.3 | 0.2 | 0.2 | 0.1 | **0.5** |
| `ade-chat-spinner` | 4.1 | 5.9 | 0.2 | 0.1 | **10.0** |
| **`ade-chat-turn`** | 6.4 | 6.4 | 0.2 | 0.1 | **12.8** |
| `ade-chat-turn-nospin` | 6.1 | 6.2 | 2.3 | 0.1 | **12.3** |
| `ade-chat-turn-nobreathe` | 6.5 | 6.6 | 2.5 | 0.1 | **13.1** |
| `ade-chat-turn-noring` | 6.6 | 7.1 | 2.6 | 0.1 | **13.7** |
| `ade-chat-turn-freezering` | 7.1 | 6.8 | 2.0 | 0.1 | **13.9** |
| `ade-chat-turn-still` | 0.5 | 0.5 | 0.3 | 0.1 | **1.0** |
| `ade-chat-turn-still-noring` | 0.5 | 0.5 | 0.2 | 0.1 | **1.0** |
| `ade-chat-turn-still-freezering` | 0.5 | 0.6 | 0.3 | 0.1 | **1.1** |
| `ade-chat-turn-nospin-nobreathe-noring-spinner` | 4.5 | 5.5 | 0.1 | 0.1 | **10.0** |
| `ade-chat-turn-nospin-nobreathe-freezering-spinner` | 4.9 | 5.4 | 0.1 | 0.1 | **10.3** |

**1차 부분 런**(동일 세션, 하네스 수정 전·일부 시나리오만): `ade-chat-turn` **11.9%**가 나왔다. 최종 전수 런 **12.8%**와 ±1%p 이내로, 문서에 적힌 반복 편차 범위 안이다.

### 1.2 [`FRAME_COST.md`](FRAME_COST.md) 개선 후 기준과 비교

| 시나리오 | 문서 (`perf/turn-frames`, 보이지 않는 창) | **2026-11-26 전수** | 해석 |
|---|---:|---:|---|
| `blank-spinner` | 14.2% | **7.8%** | 바닥 비용이 이번에 더 낮게 나옴. OS·Electron 패치·날짜 차이. **절대값보다 전후 diff에만 쓸 것** |
| `ade-chat-spinner` | 16.3% | **10.0%** | filter/mask 개선 효과가 유지되는 쪽으로 보임 |
| `ade-chat-turn` | **27.2%** | **12.8%** | 문서 대비 크게 낮음. 동일 하네스라도 빌드·`PERF_SLOW_VIA_API` 경로·CPU 샘플링 타이밍 확인 필요. **“27% → 13%”로 개선을 재확인한 것으로 읽지 말 것** — **“현재 마스터에서 12.8%”가 새 기준점** |
| master (역사) `ade-chat-turn` | 46~50% | — | 2026-11 개선 전 |

### 1.3 Ablation 해석 (이번 숫자 기준)

문서 시절(57% → 26% `freezering`)과 **스케일이 다르다**. 이번 런에서의 **상대 관계**만 본다.

1. **애니메이션을 전부 끈 `still` 계열 (~1% r+gpu)**  
   턴 UI가 있어도 움직이지 않으면 **ade-idle과 같은 바닥**에 가깝다. 2026-11 filter/mask/working 링 개선이 **여전히 유효**함을 시사한다.

2. **`ade-chat-turn` (12.8%) vs `-nospin` / `-nobreathe` / `-noring` (12.3~13.7%)**  
   개별 요소를 끄면 **합계가 거의 안 줄고**, 일부 조합은 **오히려 소폭 증가**한다. 예전처럼 “링 타이머 하나가 절반을 먹는다”는 그림이 **이 빌드·이 하네스에서는 재현되지 않는다** (CSS 링·120Hz 컴포지터 경로로 바뀐 뒤).

3. **`-freezering` (13.9%)이 베이스와 비슷**  
   링 타이머를 멈춰도 r+gpu가 크게 안 내려간다 → 병목이 **링 JS 타이머가 아니라** 스피너·숨쉬기·GPU 파이프라인·합성 레이어 쪽에 가깝다.

4. **스피너만 남긴 조합 (`…-spinner` 10.0~10.3%)**  
   `blank-spinner`(7.8%) + ADE 정지 UI 오버헤드 수준. **“움직이는 것 하나 + 120Hz 창 합성 바닥”**으로 해석 가능.

5. **browser 열이 ablation에서 2~2.6%로 튀는 경우**  
   네트워크·IPC·가짜 턴 유지와 겹칠 때 메인 프로세스 샘플이 잡힌다. 비교 시에는 **r+gpu를 1순위**로 본다.

### 1.4 턴 하네스 수정 (측정 가능하게 만든 변경)

초기 런에서 `ade-chat-turn` 전부 **INVALID**였다.

| 문제 | 조치 |
|---|---|
| CDP `insertText`로 API 호출 실패 | 페이지 컨텍스트 `fetch('/api/chat/send', { credentials, Origin })` |
| 턴 시작 전 선행 `send`와 경합 | `frame-cost.mjs`에서 선행 `send` 제거, UI 오픈 후 턴만 |
| READY 전 `exit` 핸들러 | Electron `main.cjs`에서 정리 |

`PERF_SLOW_VIA_API`로 턴이 **약 2분** 유지되는 동안 위 15초 창을 샘플한다.

### 1.5 PROBE (`PROBE=1 ade-chat-turn`)

프로브가 붙으면 CPU가 올라간다. 로그 기준 **r+gpu 15.4%** (베이스 12.8% 대비 +2~3%p).

요약:

- **LAYERS**: 큰 스크롤 루트(3020×1946), `chat-spin`, `chat-working deep`, 여러 `1980×4` transform 레이어, 사이드바 `agent-trail` opacity 레이어.
- **INVALIDATIONS**: `chat-spin` 45회, `chat-working deep` 23회, `::before` 애니메이션 225회 등.
- **ANIMATIONS**: `spin | chat-spin`, `chat-breathe | chat-send stop`, `agent-trail*` (여러 변).
- **EFFECTS**: `filter:drop-shadow`가 `mark-chat`에 남아 있음(문서에서 제거 대상이었던 경로와 **일부 잔존** 가능 — 회귀 조사 후보).
- **METRICS (3s)**: RecalcStyle 32, Layout 3 — 메인 스레드 부하는 낮은 편.
- **TIME/TRACE**: `Graphics.Pipeline`, `SwapBuffers`, `LayerTreeImpl::UpdateDrawProperties`가 두드러짐.

스크린샷·프로브 원문: `evidence/probe-turn.log`.

---

## 2. chat-heavy (Chrome dev, 8 reps)

도구: [`scripts/perf/chat-heavy.mjs`](../scripts/perf/chat-heavy.mjs). 한 프로젝트에 500턴·3턴 채팅 + 다른 프로젝트 500턴. **개발 빌드**이므로 `scriptMs` 절대값은 프로덕션보다 크다 — **[`CHAT_SPLIT_SWITCH.md`](CHAT_SPLIT_SWITCH.md)와 같은 “상대 비교”**로 읽는다.

### 2.1 이번 측정값 (`chat-heavy.json`)

| 구분 | 지표 | 값 |
|---|---|---:|
| **긴 대화 (30턴 DOM 윈도우)** | `turnsInDom` / 탭 요소 | 30 / **3,183** |
| | Ctrl+D `toFirstPaint` | **42 ms** |
| | Ctrl+D `jankMs` / `worst` / `over50` | **16.7** / **33.4** / **0** |
| | Ctrl+D `scriptMs` / `styleMs` / `layoutMs` | 31.2 / 22.2 / **91.9** |
| | Ctrl+Shift+D `toFirstPaint` | **54.6 ms** |
| | Ctrl+Shift+D `jankMs` | **16.6 ms** |
| | Ctrl+Shift+D `layoutMs` | **25.1 ms** |
| **짧은 대화 (3턴)** | 탭 요소 | **563** |
| | Ctrl+D `toFirstPaint` | 50.4 ms |
| | Ctrl+D `jankMs` / `worst` / `over50` | **75.1** / **57.7** / **1** |
| | Ctrl+D `layoutMs` | **207.3 ms** (이상치 성격 — 반복 편차) |
| **탭 전환** | → 긴 / → 짧 | **48.8** / **43.7 ms** |
| **프로젝트 전환** | 0→1 / 1→0 | **40.1** / **51.1 ms** |
| **페이지 전체** | DOM 요소 / 렌더 턴 / heap | **15,940** / **126** / **101 MB** |

### 2.2 문서 개선 후와 비교

| 항목 | CHAT_SPLIT_SWITCH (후) | **2026-11-26** |
|---|---:|---:|
| Ctrl+D 긴 대화 첫 화면 | 38.5 ms | **42 ms** |
| Ctrl+D jank | 16.6 ms | **16.7 ms** |
| 탭 → 긴 | 34.7 ms | **48.8 ms** |
| 프로젝트 0→1 | 28.0 ms | **40.1 ms** |
| wholePage elements | 15,561 | **15,940** |
| wholePage turnsInDom | 124 | **126** |

**분할·jank·DOM 규모**는 개선 후 기준과 **같은 클래스**다. 탭/프로젝트 전환은 이번에 **10~15ms 높게** 나왔는데, dev 서버·다른 탭 부하·8회만 수행한 것이 원인일 수 있다. 문서도 “±30%” 편차를 경고한다.

### 2.3 격리 세션 실패와 main 우회

| 단계 | 격리 `ade-perf-*` | `tmp/main` |
|---|---|---|
| `seed` | 간헐 성공 | 안정 |
| `reload-tab` ×2 + `show` ×2 | 필요 | 동일 절차 |
| `run` | `frames()` undefined → **null 가드 수정** 후에도 CDP 불안정 | **`run 8` 성공** |

수정: [`chat-heavy.mjs`](../scripts/perf/chat-heavy.mjs) — onboard를 seed에 포함, `waitTab`, `__perf` 재초기화, `frames` null 가드.

---

## 3. memory-soak (15 rounds × 10 chats)

도구: [`memory-soak.mjs`](../scripts/perf/memory-soak.mjs). 매 라운드 채팅 10개 open → 잠시 대기 → 전부 close. `VERIFY_TAB=perf`.

### 3.1 라운드별 RSS·heap (MB)

| 라벨 | server | Chrome | JS heap |
|---|---:|---:|---:|
| start | 62 | 309 | 44 |
| round-1 | 69 | 293 | 44 |
| round-2 | 72 | 325 | 45 |
| round-3 | 72 | 309 | 45 |
| round-4 | 71 | 304 | 45 |
| round-5 | 70 | 305 | 45 |
| round-6 | 71 | 328 | 45 |
| round-7 | 72 | 327 | 45 |
| round-8 | 70 | 314 | 45 |
| round-9 | 67 | 306 | 45 |
| round-10 | 69 | 318 | 45 |
| round-11 | 69 | 325 | 45 |
| round-12 | **92** | 298 | 45 |
| round-13 | 71 | 299 | 45 |
| round-14 | 71 | 306 | 45 |
| round-15 | 69 | 335 | 45 |

- **round-12 server 92MB**: 일시 스파이크(샘플 타이밍·GC). 이후 바로 71MB로 복귀.
- Chrome RSS **293~335MB** 박스 안에서 진동. **단조 증가 없음**.

### 3.2 drift (스크립트와 동일: 첫 1/3 vs 마지막 1/3 중앙값)

| 지표 | drift% | `leakSuspect` |
|---|---:|---|
| serverRssMb | **0.0** | |
| chromeRssMb | **-1.0** | |
| heapMB | **0.0** | **false** |

**1차 부분 soak (6×5)** 에서는 server −39%, Chrome −16%처럼 “큰 감소”가 나왔는데, 이는 **첫 로딩·대량 open 직후 → 안정화** 패턴이었다. **15라운드**에서는 이미 안정 구간에서 샘플링해 drift가 0%에 가깝다.

**한계**: 분 단위·가짜 데이터. 장시간 실사용 누수를 대체하지 않는다.

---

## 4. stream-jank (80줄, 56s)

도구: [`stream-jank.mjs`](../scripts/perf/stream-jank.mjs), `e2e-stream` API.

| throttle | jankMs (합) | worst frame | over50 | frames | heap MB |
|---|---:|---:|---:|---:|---:|
| **1×** | **7.8** | **24.5** | 0 | 6766 | 45 |
| **4×** | **141.4** | **57.9** | **1** | 6694 | 45 |

- 정상 CPU: 80줄 가짜 스트림은 **대체로 부드럽다** (worst ~24.5ms &lt; 2× 프레임 간격).
- **CPU 4×**: jank 합 **141ms**, **50ms 초과 프레임 1개** — 저사양·백그라운드 스로틀 시 **끊김 재현 가능**.
- heap 45MB로 고정 — 스트림 구간에서 **JS 힙 급증 없음**.

`suite.mjs` 기본은 40줄; 이번 증거는 **`--lines 80`** 으로 수동 확장 실행.

---

## 5. 실패·우회 타임라인

1. **1차** `tmp/ade-perf-7fbf04`: frame-cost 일부, soak 6×5, chat-heavy 미완.
2. **턴 INVALID** → API/`main.cjs` 수정.
3. **2차** `tmp/ade-perf-8143f1`: frame-cost **17/17** 완료.
4. **chat-heavy** 격리 실패 → **main `perf-final`**, `run 8`.
5. **병렬 실행** → perf 서버 거부 → frame-cost 단독.
6. **`chat-heavy` `frames()`** → null 가드.
7. **증거 JSON 이중 기록** → 파싱 복구 + `memory-soak` stderr 출력.

---

## 6. 회귀·유지보수 체크리스트

| 체크 | 기대 |
|---|---|
| `node scripts/perf/frame-cost.mjs` | 17줄 JSON, `ade-chat-turn` r+gpu **10~16%** 대역 (환경 의존) |
| `PROBE=1 … ade-chat-turn` | `chat-spin`·`chat-working deep` invalidation 존재 |
| `chat-heavy run 6` (main 탭) | long Ctrl+D jank **~17ms**, elements **~16k** |
| `memory-soak --rounds 15` | `leakSuspect: false`, heap drift &lt; 15% |
| `stream-jank --lines 80` | 4× throttle에서 jank **&gt; 50ms** 가능 |

---

## 7. 최적화 후보 (구현 안 함, 우선순위만)

| 순위 | 항목 | 근거 |
|---|---|---|
| P1 | `chat-heavy`를 **격리 세션에서 안정화** (프로젝트 2개·탭 바 가시성 대기, `suite` 단일 경로) | main 의존 제거 |
| P2 | frame-cost **27% vs 13%** 차이 원인 분리 (동일 커밋으로 문서 환경 재현, `SHOW=1` A/B) | 기준선 통일 |
| P3 | PROBE **drop-shadow on mark-chat** 잔존 여부 제품 코드 점검 | EFFECTS 목록 |
| P4 | 분할 애니메이션 **layout ~90ms/0.9s** (`CHAT_SPLIT_SWITCH` §남은 것) | transform 기반 분할은 UX 변경 |
| P5 | stream **80줄+도구 카드** 합성 시나리오 | 실제 스트림에 가까운 부하 |
| P6 | Windows / 60Hz 외장 / **설치 앱** Electron | 미측정 |
| 유지 | 턴 중 애니메이션은 filter/mask 안에 넣지 않기 | [`FRAME_COST.md`](FRAME_COST.md) |

---

## 8. 재현 절차

```sh
# 전체 (frame-cost ~9분, chat-heavy는 격리에서 불안정할 수 있음)
node scripts/perf/suite.mjs

# frame-cost만 (증거는 VERIFY_OUT/evidence/)
node scripts/perf/session.mjs up --reason "…"
pnpm --filter @mooner/ade-web build
VERIFY_OUT=tmp/ade-perf-xxx node scripts/perf/frame-cost.mjs

# chat-heavy (안정: main 탭)
node scripts/verify/session.mjs tab --as perf-final
VERIFY_TAB=perf-final node scripts/perf/chat-heavy.mjs seed
VERIFY_TAB=perf-final node scripts/perf/reload-tab.mjs
VERIFY_TAB=perf-final node scripts/perf/chat-heavy.mjs show
# reload + show 한 번 더
VERIFY_TAB=perf-final node scripts/perf/chat-heavy.mjs run 8
VERIFY_TAB=perf-final node scripts/perf/chat-heavy.mjs clean

# soak / stream (격리)
VERIFY_OUT=tmp/ade-perf-xxx VERIFY_TAB=perf node scripts/perf/memory-soak.mjs --rounds 15 --chats 10
VERIFY_OUT=tmp/ade-perf-xxx VERIFY_TAB=perf node scripts/perf/stream-jank.mjs --lines 80

# PROBE
VERIFY_OUT=tmp/ade-perf-xxx PROBE=1 node scripts/perf/frame-cost.mjs ade-chat-turn 2>&1 | tee tmp/ade-perf-xxx/evidence/probe-turn.log

# 정리 (증거 보존 시 --discard-evidence 생략)
node scripts/perf/session.mjs down
node scripts/verify/session.mjs prune
```

**주의**: `memory-soak.mjs`는 이미 `VERIFY_OUT/evidence/memory-soak.json`에 쓴다. **같은 경로로 stdout 리다이렉트하지 말 것**.

---

## 9. 하네스·테스트 목록

| 파일 | 역할 |
|---|---|
| [`scripts/perf/session.mjs`](../scripts/perf/session.mjs) | 격리 verify 세션 |
| [`scripts/perf/suite.mjs`](../scripts/perf/suite.mjs) | 오케스트레이터 |
| [`scripts/perf/frame-cost.mjs`](../scripts/perf/frame-cost.mjs) | Electron CPU |
| [`scripts/perf/chat-heavy.mjs`](../scripts/perf/chat-heavy.mjs) | 분할·탭·DOM |
| [`scripts/perf/memory-soak.mjs`](../scripts/perf/memory-soak.mjs) | RSS/heap |
| [`scripts/perf/stream-jank.mjs`](../scripts/perf/stream-jank.mjs) | 가짜 스트림 + CDP throttle |
| [`scripts/perf/reload-tab.mjs`](../scripts/perf/reload-tab.mjs) | 시드 후 탭 reload |
| [`scripts/perf/ps-tree.mjs`](../scripts/perf/ps-tree.mjs) | 프로세스 RSS/CPU |
| [`tests/perf-scripts.test.mjs`](../../tests/perf-scripts.test.mjs) | smoke (session status, rssKb) |

---

## 10. 한계 (필독)

- **Electron r+gpu**와 **Chrome dev ms**는 **직접 비교 불가**.
- **frame-cost 12.8%**와 문서 **27.2%**는 같은 날 같은 모드라고 단정하지 말고, **이번 커밋의 새 스냅샷**으로만 사용.
- soak·stream은 **가짜 claude·짧은 시간**.
- **설치 앱**, **실제 AI 스트리밍**, **Hub 마켓** 미포함.
- 격리 세션 `tmp/ade-perf-8143f1`은 보고서 작성 시점에 **아직 기동 중일 수 있음**. 내리려면 `node scripts/perf/session.mjs down` (증거 폴더는 로컬에 유지).

---

*보고서 작성: 2026-11-26. 증거 세션 ID: `ade-perf-8143f1`. chat-heavy 탭 `perf-final` 데이터 정리 및 탭 닫기 완료.*