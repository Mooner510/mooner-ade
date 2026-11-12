# 실제 AI 에이전트가 필요한 테스트 체크리스트

`feat/ui-frame` → master 머지 전 검증 중, **실제 claude/codex 프로세스나 모델 출력이 있어야만** 확인되는 항목입니다.
나머지(단위·HTTP·fake CLI·브라우저)는 별도로 끝냈거나 진행 중이며 `docs/VERIFICATION.md`에 결과를 남깁니다. 이 문서의 항목은 **아직 하나도 실행하지 않았습니다.**

## 공통 사전조건
- 격리 서버·가짜 Hub·보이는 Chrome은 `node scripts/verify/start-ui.mjs`로 띄울 수 있다(사용법: [E2E_HANDOFF](E2E_HANDOFF.md) 4절). 실제 `claude`를 쓰려면 PATH 앞에 있는 `scripts/verify/bin/claude`(가짜)가 가리지 않게 `PATH`를 바꿔 직접 서버를 띄운다.
- Chrome은 "Entire screen" 자동 선택 플래그 없이(이 탭만 공유) 띄우고 `Page.bringToFront`로 앞에 둔다. 가려진 창에서는 캡쳐가 실패한다.
- 사용자의 실제 MoonerADE 앱을 건드리지 않는다: `apps/local-server/src/index.js`를 `ADE_DATA_DIR=<임시>`, `ADE_DEV=1`, `ADE_PORT=0`, `ADE_PTY_ENDPOINT=`, throwaway git 저장소로 띄운다. Electron 개발 앱은 띄우지 않는다.
- 보이는 Chrome(`--remote-debugging-port`, 별도 `--user-data-dir`)으로 구동한다.
- **모델은 `claude-haiku-5-5`, Effort는 low**로 명시한다(채팅 모델 드롭다운 기본값은 CLI 기본 모델이라 sonnet이 돌 수 있음). `claude` 래퍼로 `--effort low`를 붙이고, `ps` 인자와 저장된 이벤트의 `model`로 확인한다.
- 피드백 제출이 실제 Hub로 나가지 않게 `ADE_FEEDBACK_ANONYMOUS=0` 또는 로컬 fake Hub(`ADE_HUB_URL`)를 쓴다.
- 끝나면 서버·Chrome 종료, 남은 `~/.claude/projects/*scratchpad*` 세션 폴더를 사용자에게 알린다.

기호: `[ ]` 미실행 · 각 항목에 결과(통과/실패/메모)를 적는다.

## A. 피드백 — AI 정리 (F3)
- [ ] A1. 본문+스크린샷 1장으로 "AI 정리" 실행 → 제목 ≤60자, 본문 약 400자 한국어, 문제/기대 동작/개선 제안 구조인가. 기대: `status=review`, `reviewed=false`.
- [ ] A2. 스크린샷 내용을 정말 읽는가(이미지에만 있는 글자를 결과가 반영하는지).
- [ ] A3. 모델 Haiku/Sonnet/Opus 5.5 선택이 실제 `--model claude-*-5-5`로 받아들여지는가(CLI가 거부하지 않는지). Effort low/medium 모두 수용되는가.
- [ ] A4. 응답 시간이 문서의 "약 5~6초" 주장과 대략 맞는가(45초 이후 문구 전환은 임의 지연이 아니면 안 뜸).
- [ ] A5. `--strict-mcp-config --setting-sources user` 조합에서도 사용자의 로그인(OAuth/Bedrock/프록시)이 유지되는가.
- [ ] A6. 컨텍스트 포함 on/off에 따라 프롬프트에 앱 버전·프로젝트명·열린 pane·최근 오류가 들어가고 빠지는가.

## B. 피드백 — 에이전트 MCP 도구 (F6)
- [ ] B1. 새 Claude 채팅/터미널에서 `ade_feedback` MCP 서버가 로드되는가(도구 목록에 `ade_feedback_draft`).
- [ ] B2. "MoonerADE 피드백 초안을 남겨줘" 요청에 모델이 이 도구를 호출하는가. 프로젝트 자체 버그 요청에는 호출하지 않는가.
- [ ] B3. 호출 결과가 inbox에 `source=agent`, `status=review`, 미검토로 나타나고, 사람이 열기 전에는 제출이 막히는가.
- [ ] B4. Codex에서도 같은 서버가 TOML 전달로 로드되는가. 권한 프롬프트 동작은 어떤가.
- [ ] B5. 설정 `feedbackAgentTool` 끔 → **새로** 연 채팅에서 도구가 없는가(이미 실행 중인 세션은 영향 없음).

## C. 서브에이전트 (C1)
- [ ] C1. 한 메시지에서 Agent 도구를 두 번 병렬 호출하게 시킨다 → 카드 2개, 상단 트래커 "실행 N · 완료 M", 드로어(Esc, 이전/다음, 스크롤 추종).
- [ ] C2. 실제 `system/task_started|task_progress|task_notification` 이벤트의 필드·순서가 `taskEvent` 정규화와 맞는가(주석 기준 CLI 2.1.322).
- [ ] C3. 백그라운드 서브에이전트는 자식 프로세스가 살아있는 동안 running, 포그라운드는 결과 도착 시 완료로 보이는가. 프로세스 교체/종료 후 liveTasks가 비워지는가.

## D. 계획 검토 (C2)
- [ ] D1. plan 모드에서 실제 `ExitPlanMode` 입력으로 계획 카드가 뜨고 목차 칩·섹션 접기·크게 보기가 동작하는가.
- [ ] D2. "자동 모드로 진행" / "편집 허용으로 진행" 승인 → CLI가 `setMode`(`updatedPermissions`)를 수용하고 실제로 그 모드로 바뀌는가.
- [ ] D3. "수정 요청…" 메시지 → 모델이 plan 모드에 머물며 재계획하는가(`planRevision` 문구).
- [ ] D4. "계획대로 진행"/반려 후 계획 이전 권한 모드(`prePlanMode`)로 돌아가는가. 창을 닫았다 다시 열어 승인해도 같은가.

## E. 이미지 첨부 (C3)
- [ ] E1. 이미지 첨부 후 전송 → 모델이 이미지를 실제로 읽는가(이미지에만 있는 정보를 묻기).
- [ ] E2. 썸네일이 사용자 말풍선·대기열에 보이고 앱 재시작 후에도 유지되는가(저장은 previews만, 원본은 저장되지 않음).

## F. Artifact (C4)
- [ ] F1. "artifact/아티팩트" 문구가 없는 대화에서는 Artifact 도구가 로드되지 않는가(입력 토큰 기준).
- [ ] F2. 대화 중간에 "아티팩트로 만들어줘" → `apply_flag_settings`가 `success`로 응답하고 Artifact 도구 3개가 로드되는가. 입력 토큰이 약 +12.9k 늘어나는가.
- [ ] F3. 세션 재시작/resume 후에도 env(`CLAUDE_CODE_ARTIFACT=1`)로 유지되는가.
- [ ] F4. 실제 도구 결과에서 `https://claude.ai/artifact/...` URL이 위치하는 곳과 "Artifact 생성됨" 카드가 맞는가. guide 결과의 링크는 무시되는가.
- [ ] F5. 응답 중(steer) 보낸 메시지에 "artifact"가 있어도 즉시 켜지지 않고 다음 턴에 켜지는 현재 동작이 의도에 맞는가(코드상 steer 경로는 `enableArtifact` 미호출).
- [ ] F6. 설정 `artifactAlways`가 켜져 있으면 첫 메시지부터 켜지는가.

## G. 인터랙티브 UI (C5, C7)
- [ ] G1. 지침(`--append-system-prompt-file` / Codex `developerInstructions`)이 CLI/Codex 버전에서 수용되는가.
- [ ] G2. "표/단계/폼으로 보여줘" 요청에 모델이 ```ui 또는 ```ade-ui를 생성하고, 일반 답변에는 쓰지 않는가("필요할 때만").
- [ ] G3. 폼 제출이 사용자 메시지로 나가고, 응답 중이면 후속 큐에 들어가는가.
- [ ] G4. 지침 길이로 인한 캐시/토큰 영향이 허용 범위인가.
- [ ] G5. 한 대화에서 설정을 바꿔도(처음 값으로 고정) 의도대로 유지되는가.

## H. 도구 카드 (C10)
- [ ] H1. 자동 모드에서 분류기가 막은 호출이 `blocked` 카드로 보이는가(정규식 `/denied by the Claude Code auto mode classifier/i`가 실제 문구와 맞는가 — CLI 문구가 바뀌면 깨짐).
- [ ] H2. 실제 `mcp__*` 도구 호출의 라벨/요약("서버 · 도구")과 JSON 결과 pretty-print.

## I. 모델 변경 (C11)
- [ ] I1. 대화가 있는 채팅에서 모델 변경 → 캐시 만료 경고와 "압축하고 전환"이 뜨고, 압축 완료 후에만 전환되는가. 압축이 안 되면 전환하지 않고 안내하는가.
- [ ] I2. 모델/Effort가 `meta`에 고정되어 재열기 후에도 유지되는가(저장된 이벤트의 `model`).

## J. 사용량·기타
- [ ] J1. 실제 Claude/Codex 로그인 상태에서 `≈N%p`/`<1%p` 값이 나오고, 5시간/주간 접미가 붙는가. 값이 없으면 칸이 숨겨지는가. k 학습(10포인트)이 현실적인가.
- [ ] J2. MCP 시작 대기 3초(`CLAUDE_CODE_MCP_STARTUP_WAIT_MS`)로 init이 실제로 빨라지는가(주석상 29.7s → 1.1s, CLI 2.1.322). 느린 MCP가 있는 환경에서 확인.
- [ ] J3. `usage.js`에서 `envrcVariable` 제거(커밋 361e78a)로 `.envrc`/direnv 환경에서 계정 해석이 달라지지 않는가 — 의도된 변경인지 작성자 확인 필요.

## K. Electron·외부 서비스 (AI 에이전트는 아니지만 격리 테스트로 못 하는 것)
- [ ] K1. `ade:capture` IPC: 요소/창/범위 캡쳐를 80%·150% 배율에서, 메인 창이 아닌 프레임은 거부되는가. (Electron 필요 — 설치된 앱과 userData/단일 인스턴스 락을 공유하므로 별도 절차 필요)
- [ ] K2. `feedback/submit` main 중계: 플러그인 없을 때 `FEEDBACK_UNAVAILABLE`, 로그인한 원격 플러그인으로 제출 후 이슈 번호 반환.
- [ ] K3. 실제 Hub `/v1/feedback/anonymous` 계약(5분 한도, `X-ADE-Device`, 429/`Retry-After`)과 GitHub 이슈 생성·`anonymous` 라벨·이미지 표시.
- [ ] K4. 실제 zsh에서 세션 터미널 위쪽 화살표 히스토리가 나오는가(커밋 9d6f979). Windows PowerShell PSReadLine 예측은 Windows에서만.
