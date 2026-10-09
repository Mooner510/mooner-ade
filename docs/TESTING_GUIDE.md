# 테스트 가이드 (mooner-ade)

이 문서는 이번 실사용화 작업(append-only 세션 저장소, 에이전트 transport 수정, 로컬 편의 기능, E2E 스크립트)을 사람이 직접 검증하는 방법이다.

## 1. 이번 작업의 변경 요약

| 영역 | 내용 | 주요 파일 |
|---|---|---|
| 세션 저장소 | 이벤트마다 파일 전체를 다시 쓰던 방식을 `<id>.json`(메타) + `<id>.events.jsonl`(append + fsync)로 변경. 마지막 줄이 깨졌으면 무시 후 다음 append에서 잘라낸다. 기존 단일 json 기록도 읽는다. | `packages/session-store/src/index.js` |
| Codex 버그 수정 | `thread/start`의 `sandbox`가 `workspaceWrite`로 전달되어 실제 Codex가 거부할 수 있었다 → `workspace-write`. 모델 목록은 `result.models`를 읽어 항상 비었다 → `result.data` + 페이지네이션 + `hidden` 제외. | `apps/local-server/src/agents.js` |
| Claude readiness | PATH의 `claude`가 아니라 SDK가 실제로 쓰는 실행 파일과 계정(`accountInfo()`)으로 확인한다. 모델 호출은 없다. | `agents.js` (`claudeAccount`), `index.js` (`readiness`) |
| Full access | 실행 단위 체크박스. Claude는 `bypassPermissions`, Codex는 `approvalPolicy:'never'`, `sandbox:'danger-full-access'`. 기본값은 꺼짐. | `agents.js`, `index.js`, `apps/web/src/main.tsx` |
| 접속 토큰 | 1회용이던 토큰을 `<데이터 디렉터리>/token`(0600)에 영속 저장. 두 번째 브라우저나 쿠키 삭제 후에도 같은 URL로 재접속된다. | `apps/local-server/src/index.js` |
| 엔진 메모리 | 종료된 세션은 최근 100개만 메모리에 유지. | `packages/core/src/index.js` |
| 중단된 실행 이어하기 | 서버 재시작으로 `interrupted`가 된 대화에 "이어하기" 배너와 버튼. 저장된 `threadId`로 resume한다. | `apps/web/src/main.tsx` |
| 테스트·스크립트 | `tests/agents.test.mjs`, `tests/fixtures/`, `scripts/e2e.mjs`, 재작성한 `scripts/live-agent-check.mjs` | |
| 공유 이벤트 계약 | `tests/fixtures/agent-events.v1.jsonl`은 webai의 `internal/executorapi/testdata/`와 내용이 같아야 한다. 한쪽을 바꾸면 다른 쪽도 바꾼다. | |

## 2. 검증 상태

개발 중에 실행해서 통과를 확인한 것:

- `pnpm check` 73/73 (타입 계약 포함)
- `pnpm e2e` (헤드리스 Chrome: 인증, 프로젝트 열기, 탐색기, ADE/IDE 전환, AI 입력창)
- 실제 Codex(0.161)에 모델 호출 없이 `initialize`, `account/read`, `model/list`만 보내서 프로토콜 일치 확인
- 실제 Claude SDK로 모델 호출 없이 `accountInfo()`와 모델 목록 확인

실행하지 않은 것 (아래 절차로 직접 확인):

- 실제 모델 호출을 포함한 `pnpm test:live` (사용량이 발생해서 실행하지 않았다)
- 서버 재시작 후 이어하기 흐름, Full access 동작, 영속 토큰의 브라우저 동작
- P2 완료 조건 5개 (6분할 그리드, 단축키, 레이아웃 영속, 병렬 worktree, macOS/Windows)

## 3. 자동 테스트

```sh
pnpm install
pnpm check            # verify + 타입 계약 + 전체 테스트 (73개)
pnpm typecheck        # 서버 계약 + 웹 앱
node --test tests/agents.test.mjs tests/p1-session-store.test.mjs tests/local-server.test.mjs
```

`pnpm check`에서 기대하는 새 테스트:

- `agents.test.mjs`: 가짜 `codex app-server`와 가짜 Claude `query`로 승인(허용·거절), resume, `fullAccess`, 로그인 없음 오류, 모델 목록 페이지네이션을 확인한다.
- `p1-session-store.test.mjs`: 깨진 꼬리 줄 복구, 기존 단일 json 호환.
- `local-server.test.mjs`: 재시작 후에도 같은 토큰으로 인증되고 토큰 파일 권한이 0600인지 확인한다.
- `framework.test.mjs`: 종료된 세션 메모리 상한.
- `p1-event-contract.test.mjs`: 공유 fixture가 모든 이벤트 종류를 포함하고 파싱되는지 확인한다.

## 4. E2E (헤드리스 Chrome)

```sh
pnpm web:build
pnpm e2e              # Chrome 경로를 못 찾으면 CHROME_PATH=/path/to/chrome pnpm e2e
```

기대 결과: `e2e: auth, project open, explorer, ADE/IDE switch and AI composer passed`. 임시 데이터 디렉터리와 저장소를 쓰므로 실제 데이터는 건드리지 않는다. 브라우저 콘솔 오류가 하나라도 있으면 실패한다.

빌드 후 `git status`에 `apps/web/dist` 외의 산출물이 남았는지 확인한다.

## 5. 실제 모델 호출 (opt-in, 사용량 발생)

사전 조건: `codex login`과 `claude auth login`이 되어 있어야 한다.

```sh
ADE_LIVE_TEST=1 pnpm test:live
```

각 provider(Codex, Claude)에 대해 다음을 자동으로 확인한다.

1. 기본 모드에서 임시 저장소에 파일을 쓰는 명령이 승인을 요구하고, 승인 후 파일이 생성된다.
2. 같은 `threadId`로 resume하면 이전에 만든 파일 이름을 기억한다.
3. `fullAccess`에서는 승인 요청이 0건이고 파일이 생성된다.

기대 결과: `codex: live run, approval, resume and full-access passed`, `claude: ...` 두 줄. 실패하면 어느 단계인지 메시지에 나온다.

## 6. 수동 시나리오

### 6.1 영속 토큰

1. `pnpm start` 실행 후 출력된 `…/#token=…` URL로 접속한다.
2. 같은 URL을 시크릿 창이나 다른 브라우저에서 열어 접속되는지 확인한다.
3. 서버를 재시작해도 URL의 토큰이 같은지 확인한다 (`<데이터 디렉터리>/token`).
4. `ls -l "<데이터 디렉터리>/token"`이 `-rw-------`인지 확인한다.
5. 토큰을 바꾸고 싶으면 파일을 지우고 재시작한다.

### 6.2 Full access

1. 체크박스를 끈 상태로 Codex와 Claude에 파일 수정을 요청하면 승인 카드가 나타나야 한다.
2. 체크박스를 켠 상태로 같은 요청을 하면 승인 없이 실행되어야 한다.
3. 체크박스가 대화에 고정되지 않고 실행마다 적용되는지 확인한다 (켠 채 보내고, 끄고 다시 보내면 다시 승인을 묻는다).

### 6.3 Claude/Codex 준비 상태와 모델 목록

1. 설정 화면의 준비 상태에서 Claude가 `agent-sdk · <계정>`으로 표시되는지 확인한다.
2. `claude auth logout` 후 새로고침하면 "claude auth login 실행 후 다시 확인하세요"가 표시되어야 한다. 확인 후 다시 로그인한다.
3. Codex 모델 드롭다운에 모델과 Effort가 채워지는지 확인한다 (예전에는 비어 있었다).

### 6.4 서버 재시작 후 이어하기

1. 긴 작업(예: "프로젝트의 모든 파일을 읽고 요약해줘")을 시작한다.
2. 실행 중에 서버를 종료(Ctrl+C)하고 다시 시작한다.
3. 같은 대화를 열면 "이전 실행이 중단되었습니다" 배너와 "이어하기" 버튼이 보여야 한다. 대화 입력창은 사용 가능해야 한다.
4. 이어하기를 누르면 같은 `threadId`로 resume되어 이전 맥락을 유지해야 한다.
5. 이어하기 실행이 끝나면 배너가 사라진다.

### 6.5 세션 저장소 파일 확인

`<데이터 디렉터리>/<projectId>/runs/`에서 다음을 확인한다.

- `<id>.json`은 메타(작은 파일)이고 `<id>.events.jsonl`에 이벤트가 한 줄씩 쌓인다.
- 실행 중 `tail -f <id>.events.jsonl`로 이벤트가 실시간으로 추가되는지 본다.
- 실행 중 서버를 `kill -9`한 뒤 재시작했을 때 해당 세션이 `interrupted`로 바뀌고 이전 이벤트가 그대로 재생되는지 확인한다.
- 긴 대화(수천 개 이벤트)에서도 응답 지연이 늘어나지 않는지 확인한다 (예전에는 이벤트마다 전체를 다시 썼다).

### 6.6 P2 완료 조건 (`docs/P2_UX_SPEC.md`)

각 항목을 직접 확인하고 `docs/P2_UX_SPEC.md`의 완료 조건에 결과를 기록한다.

1. 6분할(2×3) 프리셋에서 터미널 6개가 동시에 입출력되고, 창 크기를 줄여도 깨지지 않는다.
2. Ctrl+D, Ctrl+Shift+D 분할과 이동·닫기 단축키가 동작한다.
3. 레이아웃이 새로고침과 서버 재시작 후에도 유지된다.
4. 별도 worktree 모드로 두 대화를 병렬 실행하고, 각각의 변경이 섞이지 않으며 정리(integrate/remove)가 된다.
5. macOS에서 확인하고, 가능하면 Windows/Linux에서도 PTY와 경로 처리를 확인한다.

## 7. 알려진 제한

- 로컬 전용(127.0.0.1)이고 단일 사용자 전제다. 토큰 파일을 가진 사람은 누구나 접속할 수 있다.
- Claude는 `query()`가 모든 설정 소스를 로드한다 (사용자·프로젝트 `.claude/settings.json`, CLAUDE.md). 로컬 단일 사용자에 맞는 동작이다. webai는 `settingSources: []`로 격리한다.
- 서버를 재시작하면 대기 중이던 승인 요청은 만료되고 실행 중이던 대화는 `interrupted`가 된다. 이어하기는 같은 provider thread를 resume하는 것이지 실행 중인 프로세스를 되살리는 것이 아니다.
- `ClaudeSdkAgent`/`CodexAppAgent`에 대한 실제 모델 호출 자동 테스트는 opt-in이다 (5절).
