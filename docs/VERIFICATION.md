# 검증 상태

기준일: 2026-10-23. 데스크톱 전용 전환과 미사용 기능 제거를 반영한 작업 트리 기준이며 미커밋 작업을 포함합니다. 결과를 기록할 때 실행 환경과 범위를 함께 적습니다.

## 현재 실행 결과

환경: macOS Apple Silicon / Node 24.21.0 / pnpm 11.27.1. 파일 감시·프로세스 조회·Chrome 실행이 제한되는 샌드박스와 구분해 E2E는 일반 로컬 권한으로 실행했습니다.

| 검사 | 범위 | 결과 |
|---|---|---|
| frozen install | lockfile 설치 재현성 | `pnpm install --frozen-lockfile` 통과 |
| `pnpm check` | 웹 타입 검사·Node 테스트 | 81개 중 80개 통과, CDP 전용 1개 건너뜀, 실패 0개 |
| `pnpm e2e` | 웹 빌드·실제 서버·Chrome·PTY·에이전트 상태·Diff·탭 복원·사이드바 드래그 | 2026-10-23 기준 통과. 사이드바 드래그 테스트 29개도 통과. Monaco 등의 큰 청크 경고는 남음. **2026-11-12 현재는 master에서도 첫 단언에서 실패합니다**(맨 아래 2026-11-12 섹션) |
| `pnpm audit` | lockfile 보안 경고 | 개발 전용 `vite@6.4.3`(및 하위 `launch-editor`)에서 high 1·moderate 3·low 1건. 앱 런타임 의존성(`node-pty`, `ws`)에는 없음 |

## 검증 범위

Node 테스트에는 경로·symlink 제한, argv 실행과 시간·출력 상한, 서버 인증·Origin, 프로세스별 접속 토큰, Git 보안 회귀(fsmonitor·hooks), 제거한 API의 404, 레이아웃 저장 검증, 실제 PTY·터미널 세션 복구·follow-up, 가짜 Codex app server의 계정 확인이 포함됩니다. 감시 실패와 사용량·WakaTime 연동도 회귀 테스트합니다.

E2E는 모델을 호출하지 않으며 Electron 셸 대신 headless Chrome으로 같은 웹 UI를 엽니다. 실제 PTY 입력으로 파일을 쓰고 읽기 전용 Diff와 탭 복원을 확인합니다.

## 아직 보증하지 않는 범위

- 원격 GitHub CI 결과
- Electron 셸 자체(창·메뉴·폴더 선택·종료 정리)의 자동 검사, Windows 앱·PTY
- 실제 CLI의 질문·승인, follow-up과 SSH/tmux 전송, 전체 2 × 3 수용 검사
- 채팅 탭: 2026-11-10에 claude 2.1.322의 stream-json 출력(init, 승인 control 요청, result, 중단)과 대조했습니다. 이미지 첨부, Edit/Write diff, Electron 앱 안 실행, Windows `claude.cmd`는 확인하지 않았고, 컨텍스트 창 크기는 첫 응답 전에는 추정(200k/1M)입니다.
- 장시간 사용, 모든 파일 감시 자원 제한 환경
- Git 전체 이력 비밀정보 검사, `pnpm package` 결과물의 서명·배포

규칙은 [TESTING_GUIDE](TESTING_GUIDE.md), 보류 중인 절차는 [docs/tests/](tests/)를 따릅니다.


## 2026-11-10 Codex·Cursor 채팅 확장

- 별도 데이터 폴더에서 codex-cli 0.167.0과 Cursor 2026.10.19-6bbf2c4의 실제 모델 조회·응답·도구 승인·파일 작성·세션 재개를 확인했습니다. Codex Branch/Rewind는 첫 턴 이후의 맥락이 제외됨을 실제 응답으로 확인했습니다.
- 브라우저에서 세 채팅 런처와 Codex·Cursor의 전송·응답·상태 표시를 확인했습니다. Cursor의 승인 대기·중단과 지원하지 않는 분기·복원 버튼도 확인했습니다.
- 타입 검사와 채팅 관련 35개 검사 통과. 전체 Node 검사: 253개 중 248개 통과, 2개 건너뜀, 3개 실패. 실패는 변경 전에도 동일했던 dropdown 마크업·zsh 시작 환경·업데이터 프로세스 이름 검사입니다. 전체 검사 통과나 릴리스 준비 완료로 보지 않습니다.
- 실제 이미지 해석·모든 모델/권한 조합·Electron/Windows·실시간 스티어링·터미널 전환 화면은 미검증입니다. 남은 확인 항목은 [실제 AI 회귀 가이드](tests/261113_1415_회귀_실제AI_격리CLI/GUIDE.md)에 있습니다.

## 2026-11-12 feat/ui-frame 머지 전 검증

범위: master 대비 10개 커밋·68개 파일과 미커밋 Provider 전환 변경. **실제 AI 에이전트가 필요한 항목은 제외**했고, 그 목록은 [AI_AGENT_TEST_CHECKLIST](tests/261113_1021_실제AI체크리스트/GUIDE.md)에 남겼습니다(전부 미실행).

환경: 사용자 앱과 분리된 격리 서버(임시 HOME·`ADE_DATA_DIR`·`ADE_PORT=0`·`ADE_PTY_ENDPOINT=`), 가짜 `claude`(stream-json·one-shot), 가짜 Hub(`ADE_HUB_URL`), 보이는 Chrome(CDP). 실제 모델 호출·실제 Hub 전송·Electron 실행은 없습니다. 하네스는 [`scripts/verify/`](../scripts/verify/)에 있습니다(사용법과 이어서 진행할 항목은 [E2E_HANDOFF](E2E_HANDOFF.md)). 하네스를 이 폴더로 옮긴 뒤에는 문법 검사만 했고 다시 실행하지는 않았습니다.

### 결과

| 영역 | 결과 |
|---|---|
| 타입 검사 | 통과 |
| `pnpm test` | 458개 중 453 통과·2 실패·3 건너뜀(아래 참고) |
| 서버 수준(피드백 F1~F6) | 21/21 통과: 저장소·이미지 12MB 한도·AI 정리 실패 롤백·영속 큐(5분 간격·재시작 복구)·Hub 200/429/503·MCP 초안·미검토 제출 차단 |
| 서버 수준(채팅·보안) | 13/13 통과: 서브에이전트·계획 승인(`setMode`)·Artifact 켜기·UI 지침 파일·`ade-ui` CSP·`files/list`·압축·도구 카드 입력·Provider 전환(`archiveAs` 잘못된 값은 400) |
| UI(Chrome) 피드백 | 통과: 환영 화면 진입·빈 초안 자동 삭제·모델/Effort 선택(Haiku/Sonnet/Opus, 낮음/보통만)과 설정 연동·AI 정리가 `--model`/`--effort`로 전달·제출 확인창·대기 취소·목록 칩·에이전트 초안 "검토 필요"·상태바 개수 배지·주석 저장/복원·설정 섹션·단축키 `⌘⌥F`·`⌘⌥⇧F` |
| UI(Chrome) 채팅 | 통과: 서브에이전트 카드·트래커·드로어(이전/다음·Esc)·계획 카드(목차·크게 보기·승인)·`ui` 블록(통계·폼 전송·깨진 JSON은 코드 블록)·도구 카드(MCP 라벨·자동 모드 차단 카드·JSON 정리·Artifact 카드)·`/`+Tab·`@` 파일 메뉴·모델 변경 캐시 경고와 "압축하고 전환"·Provider 전환 연타 잠금·헤더 툴팁·연결 끊김 표시 |
| `pnpm e2e` | **실패**: `an empty project must not open a terminal on its own`(1 !== 0). master·브랜치 HEAD(미커밋 제외)·작업 트리 모두 동일하게 실패 → 이 브랜치가 만든 회귀가 아니며 첫 단언에서 중단돼 이후 단계(PTY·Diff·탭 복원)는 이 머신에서 확인하지 못했습니다 |

### `pnpm test` 실패 분류
- **결정적 실패 1건(결함)**: `tests/chat-model.test.mjs:564` "MCP tools: readable label and summary instead of raw JSON". `mcpSummary`의 탐색이 `depth > 3`에서 멈춰 깊이 5의 `payload.ops[0].with.from.content`를 못 찾고 `'a'`로 떨어집니다(커밋 78b25d7). 탐색 깊이를 6으로 올려 수정(미검증).
- **환경 의존 1건**: `tests/update-busy.test.mjs:75` — `ps`가 프로세스 이름을 `(mkdir)`로 돌려줄 때 `/^node/` 단언이 깨집니다. 2026-11-10 기록의 "업데이터 프로세스 이름 검사"와 같은 항목이며 통과할 때도 있습니다.
- **병렬 실행에서만 실패한 3건**(단독 재실행은 통과): `tests/feedback.test.mjs:175`, `:377`, `tests/local-server.test.mjs:408`.

### 발견한 결함·확인 필요 사항

> 1·2·3·4·6번과 위 `mcpSummary`는 같은 날 수정했습니다(파일 목록은 [E2E_HANDOFF](E2E_HANDOFF.md) 3절). 수정은 같은 날 Full E2E에서 실행으로 확인했습니다(아래 "2026-11-12 Full E2E"·[E2E_CHECKLIST](E2E_CHECKLIST.md)). 확인 절차는 [TESTING_GUIDE](TESTING_GUIDE.md)의 "머지 전 검증에서 찾아 고친 결함"에 있습니다.
1. **환영 화면(프로젝트 없음)의 피드백 패널이 서버 푸시를 받지 못함.** `feedback/changed`는 `Workspace.tsx`의 `refs.onMessage`에서만 처리되고 `main.tsx`의 WS 라우팅은 프로젝트 구독자에게만 전달합니다. 큐 전송이 끝나도 "전송 대기 · 곧 전송"이 남고(새로고침 후 `제출됨`), 큐 항목의 예상 시각도 "약 4분 뒤" 대신 "곧 전송"으로 보입니다. 프로젝트를 연 워크스페이스에서는 정상 갱신됩니다.
2. **브라우저 캡쳐(`getDisplayMedia`) 어긋남.** 공유가 시작되면 Chrome이 뷰포트를 줄이고(`innerHeight` 863→807) DPR이 바뀌며 프레임 크기가 변합니다(1988→1860). 공유 전에 잰 좌표로 자르므로 가운데 정렬 콘텐츠는 약 28px, 아래 고정 영역은 약 56px 어긋나고, 저장 이미지 아래쪽에 검은 띠가 생길 수 있습니다. `feedback-store.ts`의 ponytail 주석이 알려 둔 한계이며 Electron(`ade:capture`)에는 해당하지 않습니다. 페이지가 `hidden`이면 `getDisplayMedia`가 `InvalidStateError`를 내며, 이때 사용자에게 보이는 오류는 확인하지 못했습니다.
3. 모델 변경 경고 문구에서 문장 사이 공백이 빠지고, 문구가 한 줄 입력창의 placeholder로 표시돼 뒷부분이 잘림("…컨텍스트 전체를 ㅋ…"). 공용 `QuickInput`이 긴 제목(40자 초과·줄바꿈 포함)을 줄바꿈되는 본문으로 보여 주도록 수정.
4. 서버 연결이 끊기면 오류 토스트가 영어 원문 "Failed to fetch"로 표시됨.
5. 코드 읽기로 판단(수정하지 않음). 결함이 아닌 설계로 본 것: 사용량 `envrcVariable` 제거(커밋 361e78a, "차단된 `.envrc`는 direnv 실패 → 활성 아님"으로 의도 변경)·설치 경로에 `'`가 있으면 피드백 MCP 서버가 빠지는 점(Codex TOML 리터럴 제한, `terminal-sessions.js`에 명시된 제한)·항목을 열면 `reviewed`가 자동으로 true가 되는 점·`ade.send`의 사용자 활성화 검사(샌드박스 안에서는 실제 클릭 여부까지만 확인 가능). 실제 CLI가 필요해 보류한 것: 응답 중(steer) 전송에서 `enableArtifact`가 호출되지 않는 점(응답 중 `apply_flag_settings`를 CLI가 받는지 확인 필요, 체크리스트 F5). 판단이 필요한 것: busy 중 `/x`+Tab이 후속 큐로 먼저 가는 동작·`feedbackAiEffort` 타입은 `high`를 허용하지만 UI·에이전트는 low/medium만 쓰는 점(서버가 low로 낮춰 받음).
6. 루트의 빈 `a.txt`가 커밋 361e78a에 포함되어 있음.

### 아직 확인하지 못한 것
- 실제 AI 에이전트가 필요한 항목 전체: [AI_AGENT_TEST_CHECKLIST](tests/261113_1021_실제AI체크리스트/GUIDE.md)의 A~J.
- Electron 전용: `ade:capture` IPC(배율 80%·150%, 메인 창 외 프레임 거부), `feedback/submit` 메인 중계, 실제 Hub·GitHub 이슈 생성, 실제 zsh 셸 히스토리(커밋 9d6f979), Windows PSReadLine.
- `ade-ui` iframe: 가짜 CLI에 `adeui` 응답을 추가해 Full E2E에서 렌더·`ade.send`·`ade.prefill`·CSP 차단을 확인했습니다(아래 섹션). iframe 안 CSP 위반 콘솔 로그는 못 봤습니다.
- `pnpm e2e`는 위 이유로 완주하지 못했습니다.
- Full E2E 1차 이후에도 남은 것: 헤더 버튼 노출 규칙·사용량 칸 값 없음 처리·온보딩 화면·Provider 전환 이후 화면·가려진 창의 캡쳐 안내·"그래도 보내기" 대화상자. 목록: [E2E_HANDOFF](E2E_HANDOFF.md) 5절.

## 2026-11-12 Full E2E (병렬 실행)

격리 서버 3개(가짜 claude·가짜 Hub, 실제 AI 없음)로 영역을 나눠 진행했습니다. 항목별 결과·근거·미확인 목록은 [E2E_CHECKLIST](E2E_CHECKLIST.md)에 있습니다. 확인한 수정(환영 화면 피드백 푸시·브라우저 캡쳐·모델 변경 경고창 등)은 통과했고, 새로 찾아 고친 결함은 2건입니다: 후속 큐의 이미지 썸네일 미표시(`ChatPane.tsx`), `ade-ui` 프레임의 상시 스크롤바(`UiFrame.tsx`). 둘 다 타입 검사와 화면으로 확인했습니다. `pnpm test` 전체·`pnpm e2e`·헤더 버튼·사용량 칩·온보딩 화면은 이번에 실행하지 않았습니다.

환경: 격리 서버·가짜 claude·가짜 Hub·Chrome 157. 새로 고친 두 결함은 위 "발견한 결함" 목록의 연장입니다: 후속 큐 이미지 썸네일(`ChatPane.tsx`·`style.css`), `ade-ui` 스크롤바(`UiFrame.tsx`). 병렬 진행·창 규칙·번들 재빌드 주의는 [E2E_HANDOFF](E2E_HANDOFF.md) 1·7절에 있습니다.
