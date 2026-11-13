# Full E2E 인수인계 (feat/ui-frame → master 머지 전)

기준일: 2026-11-12(Full E2E 1차 완료 후 갱신). 이 문서만 읽고 Full E2E를 이어서 진행할 수 있도록 현재 상태, 환경 구성, 확인할 항목, 알려진 문제, 규칙을 모았습니다.
항목별 결과표는 [E2E_CHECKLIST](E2E_CHECKLIST.md)입니다.
결과 기록은 [VERIFICATION](VERIFICATION.md), 테스트 규칙은 [TESTING_GUIDE](TESTING_GUIDE.md), 실제 AI 에이전트가 필요한 항목은 [AI_AGENT_TEST_CHECKLIST](tests/261113_1021_실제AI체크리스트/GUIDE.md), 보류 중인 절차는 [docs/tests/](tests/)에 있습니다.

## 1. 현재 상태

- 브랜치 `feat/ui-frame`, HEAD `f1863ba`(master 대비 10개 커밋·68개 파일). **이후 커밋은 없고 모두 작업 트리에 있습니다.**
- 작업 트리 변경(미커밋):
  - 이전부터 있던 것: Provider 전환(`archiveAs`·연타 잠금) — `apps/local-server/src/chat.js`, `index.js`, `apps/web/src/ChatPane.tsx`, `Workspace.tsx`.
  - 문서: `CHAT_MODE_FEATURES.md`, `ENVIRONMENT_VARIABLES.md`, `README.md`, `docs/*`(백그라운드 에이전트가 낡은 내용 정리).
  - 2026-11-12 검증에서 찾아 고친 결함(아래 3절): `chat-model.ts`, `main.tsx`, `Workspace.tsx`, `feedback-store.ts`, `FeedbackCapture.tsx`, `errors.ts`, `ChatPane.tsx`, `QuickInput.tsx`, `style.css`, `tests/errors.test.mjs`, 루트 `a.txt` 삭제.
  - 새 파일: `docs/tests/261113_1021_실제AI체크리스트/GUIDE.md`, 이 문서, `scripts/verify/`(검증 하네스).
- 1차 Full E2E(2026-11-12)에서 아래 3절 수정을 실행으로 확인했고, 새로 찾은 결함 2건(후속 큐 이미지 썸네일 `ChatPane.tsx`·`style.css`, `ade-ui` 스크롤바 `UiFrame.tsx`)을 고쳤습니다. 타입 검사 통과. 가짜 `claude`에는 `adeui` 응답이 추가됐습니다(`scripts/verify/bin/claude`). 커밋은 아직 없습니다.
- **웹 번들 없음:** 검증 세션(`start-ui.mjs`)과 `pnpm e2e`의 서버는 `ADE_DEV=1`로 떠서 `apps/web/src`를 Vite 개발 서버로 직접 서빙합니다. 빌드도, `apps/web/dist`도 필요 없습니다. 웹 소스를 고치면 열린 페이지에 HMR로 약 0.1초 안에 반영되므로 새로고침도 필요 없습니다(서버 코드 `apps/local-server`를 고쳤을 때만 세션을 다시 띄웁니다). `pnpm --filter @mooner/ade-web build`는 패키징·`pnpm start`용 프로덕션 번들일 뿐 검증에는 쓰지 않습니다. 개발 서버의 HMR 소켓(`/?token=…`, 프로토콜 `vite-hmr`)은 서버의 `upgrade` 핸들러가 같은 출처·로그인 확인 뒤 Vite에 넘깁니다.

## 2. 이미 확인한 것 (격리 환경, 실제 AI 없음)

| 영역 | 결과 |
|---|---|
| `pnpm test`(수정 전) | 458개 중 453 통과·2 실패·3 건너뜀. 실패 2건 중 1건(`mcpSummary`)은 3절에서 고침, 1건(`update-busy`)은 환경 의존 |
| 서버 수준 피드백(`t-feedback.mjs`) | 21/21 통과 |
| 서버 수준 채팅·보안(`t-chat.mjs`) | 13/13 통과 |
| UI 피드백 | 환영 화면 진입, 빈 초안 자동 삭제, 모델/Effort 선택과 설정 연동, AI 정리 → `--model`/`--effort` 전달, 제출 확인창, 대기 취소, 목록 칩, 에이전트 초안 "검토 필요"와 상태바 배지, 주석 저장/복원, 설정 섹션, 단축키 `⌘⌥F`·`⌘⌥⇧F` |
| UI 채팅 | 서브에이전트 카드·트래커·드로어, 계획 카드(목차·크게 보기·승인), `ui` 블록(통계·폼 전송·깨진 JSON), 도구 카드(MCP 라벨·자동 모드 차단·Artifact 카드), `/`+Tab, `@` 메뉴, 모델 변경 캐시 경고와 "압축하고 전환", Provider 전환 연타 잠금, 헤더 툴팁, 연결 끊김 표시 |
| `pnpm e2e` | **실패**(master에서도 동일): 첫 단언 `an empty project must not open a terminal on its own`(1 !== 0) |

## 3. 수정 후 확인 결과 (1차 Full E2E, 2026-11-12)

| # | 수정 | 어디서 | 확인 방법 | 결과 |
|---|---|---|---|---|
| 1 | `mcpSummary` 탐색 깊이 3→6 | `apps/web/src/chat-model.ts` | `node --test tests/chat-model.test.mjs` | ✅ 51/51 |
| 2 | 프로젝트 없는 화면에서도 `feedback/changed` 푸시 처리 | `main.tsx`(처리), `Workspace.tsx`(중복 제거) | 프로젝트를 열지 않은 화면에서 제출·큐 → 새로고침 없이 상태·시각 갱신 | ✅ |
| 3 | 브라우저 캡쳐: 공유를 **먼저** 시작하고 안정된 화면에서 영역 선택 | `feedback-store.ts`(`openBrowserShare`), `FeedbackCapture.tsx` | 요소·범위·창 캡쳐 결과가 선택 영역과 일치, 검은 띠 없음 | ✅ 창 전체·범위·요소·Esc. 공유 중지·가려진 창 안내는 ⬜ |
| 4 | 빈 `a.txt` 삭제 | 루트 | `git status` | ✅ |
| 5 | 네트워크 오류 문구 한국어화 | `apps/web/src/errors.ts`, `tests/errors.test.mjs` | `node --test tests/errors.test.mjs`, 서버를 끈 채 토스트 확인 | ✅ 단위 테스트. 서버 끈 토스트는 ⬜ |
| 6 | 모델 변경 경고 문구 공백 | `ChatPane.tsx` | 대화 중 모델 변경 | ✅ |
| 7 | 긴 선택형 대화상자 제목이 잘리던 문제(줄바꿈 본문으로 표시) | `apps/web/src/QuickInput.tsx`, `style.css` | 모델 변경 경고창, 외부 링크 확인창, "그래도 보내기" 창 | ✅ 경고창·외부 링크·`/model`. "그래도 보내기"는 ⬜ |

항목별 기대 결과와 결과는 [VERIFICATION](VERIFICATION.md)의 "발견한 결함·확인 필요 사항"과 [E2E_CHECKLIST](E2E_CHECKLIST.md)에 있습니다(옛 표는 git `bb5fa1d`의 `docs/TESTING_GUIDE.md`).

## 4. 환경 구성

사용자의 설치 앱(`/Applications/MoonerADE.app`)과 다른 세션의 서버·Chrome을 건드리지 않도록 **전부 격리**합니다. 실제 모델 호출, 실제 Hub 전송, Electron 실행은 없습니다.

### 4.1 테스트 세션 (서버 + 가짜 Hub + 보이는 Chrome)

```
VERIFY_OUT=/tmp/ade-verify-out node scripts/verify/start-ui.mjs      # 계속 실행되는 프로세스. 다른 터미널에서 이어서 작업
```

- 임시 HOME·`ADE_DATA_DIR`·`ADE_PORT=0`·`ADE_PTY_ENDPOINT=`의 서버, 가짜 Hub(`ADE_HUB_URL`), 별도 프로필의 보이는 Chrome(`--remote-debugging-port=0`)을 띄우고 `VERIFY_OUT/env.json`에 `origin`·`token`·`cookie`·`projectId`·`repo`·`data`·`temp`·`hub`·`cdp`·`pid`·`serverPids`(두 서버의 PID)·`chromePid`를 적습니다.
- Chrome 경로는 macOS 기본값이며 `CHROME=<경로>`로 바꿉니다. 검증은 Chrome 157로 했습니다.
- Chrome은 **이 탭만 공유**하도록(`--auto-accept-this-tab-capture`) 뜹니다. `--auto-select-desktop-capture-source=Entire screen`을 붙이면 캡쳐가 화면 크기로 나와 결과가 어긋나 보이니 쓰지 마세요.
- 첫 화면은 프로젝트 선택 화면입니다(최근 프로젝트에 `repo`). `repo`를 눌러 워크스페이스를 엽니다. 온보딩이 뜨면 "다음: 기능 둘러보기" → "건너뛰기".
- 두 번째 서버(`origin2`)는 저장소 파일 없이 하나 더 뜨지만 이번 검증에서는 쓰지 않았습니다.
- Chrome은 `start-ui`와 **분리**(`detached`)되어 뜹니다. Windows에서는 자식 프로세스가 부모와 같은 Job에 묶여 부모가 끝나면 같이 죽기 때문에, 분리하지 않으면 서버를 재시작할 때 Chrome도 닫힙니다.

#### 테스트 세션 운영 규칙

| 상황 | 하는 일 | 하지 않는 일 |
| --- | --- | --- |
| 웹 소스(`apps/web/src`)를 고침 | 아무것도 안 합니다. 열린 페이지에 HMR로 약 0.1초 만에 반영됩니다. 안 바뀌면 그 탭만 새로고침(F5, CDP `Page.reload`) | 웹 빌드, 서버 재시작, Chrome 재시작 |
| 서버 코드(`apps/local-server`)를 고침 | `VERIFY_OUT=<경로> node scripts/verify/restart-ui.mjs` — 서버와 가짜 Hub만 다시 뜨고, **같은 Chrome의 첫 탭이 새 주소(포트·토큰이 바뀜)로 이동**합니다. 저장된 데이터(채팅·키·저장소)는 그대로입니다 | Chrome을 끄고 다시 켜기 |
| 서버만 다시 띄우고 싶음(수동) | `VERIFY_OUT=<경로> VERIFY_TEMP=<env.json의 temp> VERIFY_CHROME=<env.json의 cdp> node scripts/verify/start-ui.mjs`. 이 프로세스를 끌 때 Chrome은 남습니다 | |
| 실제 CLI(API 키)로 확인 | `REAL_AGENTS=1`을 붙여 `start-ui.mjs`/`restart-ui.mjs`를 실행하면 가짜 `claude` 대신 PATH의 실제 CLI를 씁니다. HOME이 임시라 설정 › AI 툴 › 채팅 인증에 저장한 API 키로만 로그인됩니다 | 내 로그인으로 실제 모델 호출 |
| 실제 CLI(구독 로그인)로 확인 | `AGENT_DIRS=1`을 붙입니다(`REAL_AGENTS` 포함). HOME은 실제 값이고 CLI 설정 폴더만 `~/.ade-test/agents`로 격리됩니다. 먼저 `node scripts/verify/agents.mjs status`/`login`. 상세: [TESTING_GUIDE](TESTING_GUIDE.md) 2절 | 내 `~/.claude`·`~/.codex`를 그대로 쓰기 |
| 사용자가 Chrome을 직접 닫았거나 `cdp`가 응답하지 않음 | 그때만 `start-ui.mjs`를 `VERIFY_CHROME` 없이 새로 띄웁니다(`VERIFY_TEMP`를 주면 데이터는 유지) | |
| 이미 떠 있는 세션이 있음(내 것이든 다른 세션 것이든) | 그걸 재활용합니다. 확인은 `node.exe` 명령줄의 `verify/start-ui.mjs`와, 서버 포트의 소유 프로세스에서 부모를 따라가는 것으로 합니다 | 확인 없이 새로 띄우기 |
| 병렬로 따로 검증해야 함 | `VERIFY_OUT`을 달리해 각자 `start-ui.mjs`를 띄웁니다 | 같은 `VERIFY_OUT` 공유·덮어쓰기 |
| 세션 종료 | `VERIFY_OUT=<경로> node scripts/verify/cleanup-ui.mjs --evidence <기록 폴더>`. `env.json`에 기록된 PID(명령줄 확인 후)·임시 폴더·Chrome 프로필·`VERIFY_OUT`만 지웁니다. 규칙: [TESTING_GUIDE](TESTING_GUIDE.md) 6절 | 이름(`node`, `chrome`)으로 일괄 종료 — 다른 에이전트의 세션까지 꺼집니다 |

- 서버를 재시작한다는 이유로 Chrome을 끌 필요는 없습니다. 주소가 바뀌었을 뿐이므로 주소만 다시 입력하면 되고, `restart-ui.mjs`가 그 일을 CDP `Page.navigate`로 대신합니다.
- `restart-ui.mjs`는 그 `VERIFY_OUT`의 `env.json`에 적힌 PID만 `SIGKILL`로 끕니다(종료 핸들러가 Chrome을 같이 닫지 않도록). Chrome이 이미 없으면 새 세션을 띄우라는 오류로 멈춥니다.
- 정리 전까지 `VERIFY_OUT`(`env.json`·`shots`)을 지우거나 덮어쓰지 않습니다. 새 세션이 같은 경로를 덮으면 기존 세션을 가리키던 `env.json`이 사라집니다. 정리는 증거를 옮긴 뒤 `cleanup-ui.mjs`가 합니다.
- Windows에서 `detached`로 띄운 프로세스 아래서 콘솔 앱(서버 `node`)을 띄우면 서버마다 새 콘솔 창이 뜹니다. 그래서 `start-ui`의 Chrome, `restart-ui`가 띄우는 `start-ui`, `boot()`의 서버는 모두 `windowsHide: true`로 띄웁니다. 새로 spawn을 추가할 때도 같게 합니다.
- Windows에서 `node -e` 문자열 안의 `/tmp`는 `C:\tmp`로 풀립니다. 스크립트에서는 절대 경로나 `VERIFY_OUT` 환경변수를 씁니다.

### 4.2 서버 수준 스위트 (UI 없음)

```
VERIFY_OUT=/tmp/ade-verify-out node scripts/verify/t-feedback.mjs     # 피드백 F1~F6
VERIFY_OUT=/tmp/ade-verify-out node scripts/verify/t-chat.mjs         # 채팅·CSP·files/list·Artifact·UI 지침·계획·서브에이전트·압축·도구·Provider 전환
ONLY=F4 node scripts/verify/t-feedback.mjs                            # id가 F4로 시작하는 것만
```

각각 `PASS/FAIL` 줄을 찍고 `VERIFY_OUT/results-*.json`에 저장합니다.

### 4.3 가짜 `claude` (`scripts/verify/bin/claude`)

서버를 띄울 때 PATH 맨 앞에 놓입니다. stream-json 모드에서 **메시지에 포함된 단어**로 동작이 바뀝니다.

| 보내는 말 | 동작 |
|---|---|
| (그 외) | `ok` 응답, `ai-title`("AI가 붙인 제목") |
| `adeui` | ` ```ade-ui ` 블록(보내기·입력창에 채우기·외부 요청·키우기 버튼) |
| `/compact` | 압축 시퀀스(231k → 14.6k 토큰) |
| `slow` | 4초 뒤 응답 |
| `ask`(단어 단위) | AskUserQuestion 카드 |
| `plan` | ExitPlanMode(목차 3개 섹션) |
| `tasks` | 서브에이전트 2개(일반·백그라운드), task_started/progress/notification |
| `uiblock` | ` ```ui ` 블록 3개(통계, 폼, 깨진 JSON) |
| `tools` | MCP 도구(Claude Docs update + Artifact URL), 자동 모드 차단 Bash, Read |

`apply_flag_settings`·`set_permission_mode`·`set_model` 제어 요청에도 응답하며 모든 시작·사용자 메시지·제어 요청을 `<temp>/fake-claude.jsonl`에 남깁니다(`env.json`의 `temp`). 피드백 AI 정리(one-shot)는 `<temp>/ctl.json`의 `{"fb":"ok|fail|badjson|empty|iserror|slow"}`로 결과를 바꾸고, `{"flag":"error"}`는 `apply_flag_settings`를 거부합니다. **`codex`, `cursor-agent`는 가짜가 없습니다.**

### 4.4 Chrome 구동 도우미 (`scripts/verify/cdp.mjs`)

```js
import { connect, env } from './scripts/verify/cdp.mjs';
const c = await connect(p => p.url.includes('127.0.0.1'));  // 창을 앞으로 가져오지 않는다. 피드백 캡쳐만 connect(…, { focus: true }) 후 Page.bringToFront
await c.clickSel('button', '새 피드백');               // 보이는 요소의 텍스트/aria-label 일치 → 가운데 클릭
await c.click(...await c.centre('textarea')); await c.type('본문');
await c.key('Enter', 'Enter');                         // key(키, 코드, modifiers) — Alt=1 Ctrl=2 Meta=4 Shift=8
await c.shot('이름');                                  // VERIFY_OUT/shots/이름.png
console.log(await c.ev(`return document.body.innerText`));
```

`ev`는 `async` 본문을 실행하고 값을 돌려줍니다. `waitFor`·`drag`·`dialogs`(자동 수락된 `confirm`/`prompt` 문구)·`problems`(콘솔 오류·예외)도 있습니다.

### 4.5 화면을 다룰 때 걸렸던 점

- 드롭다운은 `<details><summary aria-label="모델">` + `[role=listbox][aria-label="모델"] [role=option]`입니다. `button`으로는 찾을 수 없습니다. 모델·Effort·권한 모드 목록이 DOM에 숨은 채 여러 개 있으니 **보이는 것만** 고르세요.
- `[role=dialog]`는 여러 곳에 있습니다(권한 모드 목록 포함). 설정 화면은 "설정 검색"을 가진 컨테이너로 찾고, 좌측 메뉴는 `button`에서 `x < 300`인 것을 고르세요.
- 피드백 패널은 환영 화면에서 `aside[aria-label="피드백 요청"].feedback-side`, 워크스페이스에서는 오른쪽 `.feedback-side`입니다. 창이 가려진 상태·포커스 없음에서는 키 입력과 캡쳐가 실패합니다.
- 텍스트 입력은 `Input.insertText`(`c.type`)가 안정적이고, 값을 지울 때는 네이티브 setter + `input` 이벤트를 씁니다.
- 첫 익명 제출은 5분 간격 없이 **즉시** 전송되고, 그다음부터 큐에 들어갑니다(큐 표시를 보려면 5분 안에 한 번 더 제출).

## 5. Full E2E에서 볼 것

"실행해 보고 화면·문구가 이상하면 고친다"가 목적입니다. 아래는 **지금까지 끝내지 못했거나 수정 후 다시 봐야 하는 것**을 앞에 두었습니다.

### 5.1 아직 못 본 UI 항목
1차에서 **끝낸 것**: 이미지 첨부(C3, 대기열 썸네일 수정 포함), QuestionCard(W5), 계획 카드 4동작과 이전 모드 복귀, `ade-ui` iframe(C5/C7, 스크롤바 수정 포함).
- **헤더 버튼 노출 규칙(W1):** Review·오류·Chat 전환 버튼이 언제 보이고 숨는지. (툴팁 문구는 확인함)
- **사용량(U1):** 상태바 칩이 값이 없을 때 "—"로 보이는 게 의도인지, `N%p`/`<1%p`가 값이 있을 때만 나오는지.
- **Setup/온보딩(W3):** 글꼴 "시스템 기본" 외 정리된 화면 전체.
- **계획 카드:** 대기 중인 계획을 두고 탭을 닫았다 다시 열어 승인(응답 대기 중 닫기는 중단 확인창이 떠서 이 경로를 못 만들었음. 이전 대화 불러오기로 시도).
- **busy 중 `/x`+Tab:** 후속 큐로 가는 동작이 커밋 메시지("Tab 포커스 이동 방지")와 맞는지 판단.
- **Provider 전환:** Codex·Cursor 채팅이 열린 뒤의 화면(가짜가 없어 오류 상태가 정상인지).
- **대화상자:** "그래도 보내기"·브랜치 전환·명령 팔레트(CLI 모드 터미널 에이전트·실제 터미널 필요).
- **서버 재시작 후 이미지 썸네일 유지:** 1차는 `chat/close`+새로고침으로 대신 확인. 이제 `scripts/verify/restart-ui.mjs`로 Chrome을 그대로 두고 서버만 재시작할 수 있으니(4.1절) 같은 `ADE_DATA_DIR`로 다시 확인하면 됩니다.

### 5.2 수정 후 남은 확인
- 브라우저 캡쳐: 창이 **가려졌을 때**의 "화면 공유를 시작하지 못했습니다…" 안내, "공유 중지" 시 공유 종료(창을 가려야 하므로 사용자 창 배치를 건드리지 않는 방법이 필요).
- 요소 캡쳐는 가장 가까운 `data-feedback-region`(없으면 창 전체)을 고릅니다. 환영 화면에서 창 전체가 잡히는 건 확인했고 의도인지 판단이 필요합니다. Alt로 요소 그대로 잡는 동작도 확인하지 않았습니다.
- 사소한 점(수정 안 함): 메시지형 선택창의 빈 입력줄·캐럿(`QuickInput.tsx`), QuestionCard의 숫자키 없음·Enter만으로 제출 안 됨(`QuestionCard.tsx:14`), 질문 대기 중 Shift+Tab이 권한 모드를 순환.

### 5.3 이미 통과했지만 회귀 확인용
2절의 UI 피드백·UI 채팅 항목 전체.

### 5.4 이 환경으로는 못 하는 것
[AI_AGENT_TEST_CHECKLIST](tests/261113_1021_실제AI체크리스트/GUIDE.md)의 A~J(실제 AI 에이전트), K(Electron·실제 Hub·실제 zsh). 이번 범위에 넣지 않았습니다.

## 6. 알려진 문제 (수정하지 않음)

| 문제 | 상태 |
|---|---|
| `pnpm e2e` 첫 단언 실패(`.xterm-helper-textarea`가 1개) | master·브랜치 HEAD·작업 트리 모두 동일 → 이 브랜치의 회귀가 아님. 원인 미조사(빈 프로젝트의 런처가 뜬 직후 `.xterm-helper-textarea`가 이미 1개 있음). 이 단언에서 멈춰 이후 단계(PTY·Diff·탭 복원·스크롤백)는 이 머신에서 확인하지 못함 |
| `tests/update-busy.test.mjs:75` | `ps`가 프로세스 이름을 `(mkdir)`로 돌려줄 때 실패하는 환경 의존. 2026-11-10 기록의 "업데이터 프로세스 이름 검사"와 같은 항목 |
| `feedback.test.mjs:175`·`:377`, `local-server.test.mjs:408` | 전체 병렬 실행에서만 간헐 실패, 단독 실행은 통과 |
| 응답 중(steer) 전송에서 `enableArtifact` 미호출 | 실제 CLI가 응답 중 `apply_flag_settings`를 받는지 확인이 필요해 보류(체크리스트 F5) |
| 설치 경로에 `'`가 있으면 피드백 MCP 서버가 빠짐 | Codex TOML 리터럴 제한으로 `terminal-sessions.js`에 명시된 제한(의도) |
| 사용량 `envrcVariable` 제거 | "차단된 `.envrc`는 direnv 실패 → 활성 아님"으로 의도한 변경 |
| 항목을 열면 `reviewed` 자동 true | 의도. 패널을 연 채 AI 정리가 끝나면 바로 검토됨 |

## 7. 규칙

- **격리:** 임시 HOME·`ADE_DATA_DIR`·`ADE_PORT=0`·`ADE_PTY_ENDPOINT=`, 가짜 Hub. 설치된 MoonerADE 앱, 다른 세션이 띄운 서버·Chrome(예: `ade-test.*`)은 건드리지 않습니다. 프로세스를 끄기 전 `ps`로 이름·인자를 확인합니다.
- **보이는 Chrome**으로 진행합니다. 헤드리스로 바꾸면 사용자가 볼 수 없습니다. **사용자가 배치한 창의 위치·크기를 바꾸지 않습니다**(`Browser.setWindowBounds` 금지). `Page.bringToFront`도 캡쳐처럼 꼭 필요할 때만 씁니다.
- **병렬 진행:** 영역별로 `VERIFY_OUT`을 따로 주고 `start-ui.mjs`를 각각 띄우면 서버·Chrome·가짜 Hub가 서로 독립입니다(1차는 3개). 소스 수정은 한 곳에서만 합니다. 이미 떠 있는 세션이 있으면 병렬 검증이 아닌 한 새로 띄우지 않고 재활용합니다(4.1절 운영 규칙).
- **5179 등 다른 세션이 띄운 서버**는 PATH의 `claude`가 실제일 수 있으니(`ps eww`로 확인) 채팅·AI 정리는 격리 서버에서만 합니다.
- **실제 모델이 필요한 테스트**(체크리스트)는 `claude-haiku-5-5`·Effort low를 명시하고 `ps` 인자와 저장된 이벤트의 `model`로 확인합니다.
- 고친 뒤에는 `pnpm typecheck`, 해당 문서(TESTING_GUIDE·VERIFICATION) 갱신. 커밋·푸시·머지·릴리스는 요청이 있을 때만 합니다(릴리스는 master에서만, 루트 `CLAUDE.md`).
- 사용자가 개발 후 직접 테스트를 돌리지 않는 것을 기본으로 해 왔습니다. 이번 Full E2E는 사용자가 명시적으로 요청한 작업입니다.
