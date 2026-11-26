# ADE 성능 전수 측정 보고서 (2026-11-26)

설치 앱·`tmp/main`·실제 Hub/AI 계정은 사용하지 않았습니다. 격리 세션 `tmp/ade-perf-*`, 가짜 `claude`, `apps/web/dist` 프로덕션 빌드, Electron 44 계열(저장소 lockfile 기준)입니다.

## 요약

| 영역 | 결과 | 비고 |
|---|---|---|
| **쉬는 때 (Electron)** | `ade-idle` 0.2%, `ade-chat` 0.4% renderer+GPU | 바닥(스피너 단독) 8.8~9.4% |
| **턴 중 CPU (Electron)** | `ade-chat-turn` **11.9%** renderer+GPU (하네스 API 전송 수정 후 재측정) | 이전 기준 [`FRAME_COST.md`](FRAME_COST.md): **27.2%** (다른 날·모드; ±환경 편차) |
| **긴 채팅 UI (Chrome/CDP)** | 이번 런 **미완료** (격리 세션에서 탭/프로젝트 시드 후 CDP 불안정) | 코드 기준선 [`CHAT_SPLIT_SWITCH.md`](CHAT_SPLIT_SWITCH.md) 유지 |
| **메모리 soak** | 서버·Chrome·힙 **초반 대비 감소**, 누수 의심 없음 | 6라운드×5채팅 open/close |
| **가짜 스트리밍** | 25줄 e2e-stream, jank 0, CPU 4×에서도 worst ~9–13ms | 짧은 구간·윈도잉 적용 상태 |

## 측정 환경

| 항목 | 값 |
|---|---|
| 기기 | MacBook Pro (Apple M1 Pro), 32GB, macOS 26.6.1 |
| 화면 | 내장 1728×1005 pt @2x, 120Hz |
| ADE 버전 | 0.6.3 (`package.json`) |
| 커밋 | master 작업 트리, `git rev-parse HEAD` 시점 |
| 웹 | `pnpm --filter @mooner/ade-web build` → `dist` |
| 세션 | `node scripts/perf/session.mjs up` → `tmp/ade-perf-7fbf04` |
| 증거 | `tmp/ade-perf-7fbf04/evidence/*.json` (gitignore, 로컬만) |

## 1. 프레임 비용 (Electron)

도구: `VERIFY_OUT=<세션> node scripts/perf/frame-cost.mjs`  
값: 5초 워밍업 후 15초 동안 renderer+gpu % (코어 1개=100%).

### 이번 측정 (성공한 시나리오)

| 시나리오 | renderer + GPU | [`FRAME_COST.md`](FRAME_COST.md) 참고 |
|---|---|---|
| `blank-idle` | **0%** | 0% |
| `blank-spinner` | **9.4%** | ~14% (바닥 비용) |
| `blank-webgl` | **8.8%** | ~14–18% |
| `ade-idle` | **0.2%** | 0.5–0.6% |
| `ade-spinner` | **10.1%** | 15–18% |
| `ade-chat` | **0.4%** | 0.3–0.6% |
| `ade-chat-spinner` | **8.3%** | master 35.7% → 개선 후 **16.3%** |

- 쉬는 화면·빈 채팅은 여전히 **1% 미만** 수준입니다.
- 빈 채팅+스피너는 문서의 개선 후(16.3%)보다 낮게 나왔습니다(±환경·편차). **회귀로 보기 어렵습니다.**
- `ade-chat-turn`: 초기 런은 `insertText` 전송 실패·선행 API와의 경합으로 전부 실패. **수정 후**(페이지 `fetch`에 `credentials`+`Origin`, 턴은 UI 오픈 후 `chat/send`, frame-cost에서 선행 `send` 제거) **11.9%** (renderer 6.2 + GPU 5.7).
- ablation 9종은 이번 후속 런에서 미재실행(동일 하네스로 개별 시나리오만 돌리면 됨).

```sh
VERIFY_OUT=tmp/perf-evidence node scripts/perf/frame-cost.mjs ade-chat-turn
```

## 2. 채팅·UI (chat-heavy)

도구: [`scripts/perf/chat-heavy.mjs`](../scripts/perf/chat-heavy.mjs) (500턴 시드, Ctrl+D·탭·프로젝트 전환)

**이번 격리 세션에서는 시드·`show`·이중 `reload-tab`까지 성공했으나 `run` 단계에서 CDP DOM/`window.__perf` 타이밍 오류로 중단**했습니다. 재현은 공용 `tmp/main` + `VERIFY_TAB`에서 더 안정적입니다(문서 [`CHAT_SPLIT_SWITCH.md`](CHAT_SPLIT_SWITCH.md)와 동일).

코드 기준선(이미 master에 반영된 개선 후, dev 빌드·같은 도구):

| 항목 | 개선 후 |
|---|---|
| Ctrl+D 첫 화면 (500턴) | 38.5ms |
| Ctrl+D jank | 16.6ms |
| 탭 전환 → 긴 대화 | 34.7ms |
| 페이지 DOM 요소 | 15,561 (터 UI 윈도잉) |

## 3. 메모리 soak

도구: `VERIFY_OUT=... VERIFY_TAB=perf node scripts/perf/memory-soak.mjs`

| 샘플 | server RSS (MB) | Chrome RSS (MB) | JS heap (MB) |
|---|---|---|---|
| start | 124 | 541 | 46 |
| round 6 | 75 | 451 | 42 |

- **driftPct**: server −39.5%, Chrome −16.6%, heap −8.7% → `leakSuspect: false`
- 초반 서버 RSS는 채팅 시드·첫 로딩에서 커졌다가 GC/탭 정리 후 줄었습니다. **단기 반복 open/close에서는 누수 징후 없음.**

## 4. 스트리밍 + CPU 스로틀

도구: `stream-jank.mjs`, 가짜 `e2e-stream 25`, API `chat/send`

| 조건 | jank (ms) | worst frame (ms) | >50ms 프레임 | heap (MB) |
|---|---|---|---|---|
| 정상 CPU | 0 | 12.9 | 0 | 43 |
| CPU 4× | 0 | 9.4 | 0 | 43 |

- 짧은 25줄 스트림에서는 윈도잉·최근 렌더링 최적화 덕에 **체감 끊김이 거의 없었습니다.**
- 80줄·500턴·도구 카드가 있는 실제형 부하는 `chat-heavy`/프로파일로 별도 재측정 필요입니다.

## 5. 회귀·최적화 우선순위 (코드 변경 없음, 권장만)

| 우선순위 | 항목 | 근거 |
|---|---|---|
| P1 | ~~`frame-cost` 턴 시나리오 API 전송~~ | 2026-11-26 후속: `ade-chat-turn` 측정 가능 |
| P2 | `chat-heavy` 격리 세션: 시드 후 프로젝트 2개·탭 바 가시성 자동 대기 | `seed` → reload → `show` ×2 필요, CDP 깨짐 완화 |
| P3 | 장기 스트리밍·터미널+xterm | [`FRAME_COST.md`](FRAME_COST.md) "아직 재지 않은 것" |
| P4 | Windows / 60Hz 외장 | 미측정 |
| 유지 | 턴 중 애니메이션은 `transform`/`opacity`만, filter·mask 안에 넣지 않기 | 문서화된 2026-11 개선 |

## 6. 재현

```sh
# 한 번에 (frame-cost ~10분)
node scripts/perf/suite.mjs

# 단계별
node scripts/perf/session.mjs up --reason "…"
pnpm --filter @mooner/ade-web build
VERIFY_OUT=tmp/ade-perf-xxx node scripts/perf/frame-cost.mjs
VERIFY_OUT=tmp/ade-perf-xxx VERIFY_TAB=perf node scripts/perf/chat-heavy.mjs seed
VERIFY_OUT=... VERIFY_TAB=perf node scripts/perf/reload-tab.mjs
VERIFY_OUT=... VERIFY_TAB=perf node scripts/perf/chat-heavy.mjs show
# (위 reload+show 한 번 더)
VERIFY_OUT=... VERIFY_TAB=perf node scripts/perf/memory-soak.mjs
VERIFY_OUT=... VERIFY_TAB=perf node scripts/perf/stream-jank.mjs
node scripts/perf/session.mjs down --discard-evidence
```

## 7. 추가된 도구

| 파일 | 역할 |
|---|---|
| [`scripts/perf/session.mjs`](../scripts/perf/session.mjs) | 더미 격리 verify 세션 |
| [`scripts/perf/suite.mjs`](../scripts/perf/suite.mjs) | 오케스트레이터 |
| [`scripts/perf/memory-soak.mjs`](../scripts/perf/memory-soak.mjs) | RSS/heap soak |
| [`scripts/perf/stream-jank.mjs`](../scripts/perf/stream-jank.mjs) | e2e-stream + CPU 4× |
| [`scripts/perf/reload-tab.mjs`](../scripts/perf/reload-tab.mjs) | chat-heavy 시드용 탭 새로고침 |
| [`scripts/perf/ps-tree.mjs`](../scripts/perf/ps-tree.mjs) | 프로세스 트리 RSS/CPU |
| [`tests/perf-scripts.test.mjs`](../../tests/perf-scripts.test.mjs) | smoke |

## 한계

- Electron `frame-cost`와 Chrome verify 세션(개발 서버·CDP) 숫자는 **직접 비교하지 않습니다.**
- soak·stream은 **가짜 데이터·분 단위**이며, 장시간 실사용 누수를 대체하지 않습니다.
- 설치 앱(Electron 패키지)·실제 AI 스트리밍은 이번 세션에서 다루지 않았습니다.