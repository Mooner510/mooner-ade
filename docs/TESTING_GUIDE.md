# 테스트 가이드 (작성·실행 규칙)

이 문서가 테스트 방법의 기준(SoT)입니다. 기능별 절차를 쌓아 두는 문서가 아니라, **어떻게 테스트하고 어떻게 기록하는가**만 적습니다. 하네스 사용법은 [E2E_HANDOFF](E2E_HANDOFF.md) 4절, 기능별 절차와 기록은 [tests/](tests/)에 있습니다(옛 `TESTING_GUIDE.md`의 절차는 거기로 이관했고 원문은 git `bb5fa1d`에 있습니다).

## 1. 원칙

1. **개발한 세션이 직접 테스트한다.** 별도 세션에 위임하지 않고, 확인 못 한 것만 사람에게 남긴다(5절). 위임은 릴리스 직전 독립 검증이나 사람이 해야 하는 단계처럼 이득이 분명할 때만 쓴다.
2. **항상 격리 세션, 기본은 공용 세션 하나.** 사용자의 설치 앱과 실제 `~/.claude`·`~/.codex`·`~/.cursor`는 읽지도 쓰지도 않는다. 서버는 세션 폴더의 `ADE_DATA_DIR`·git repo, 브라우저는 그 폴더 프로필의 보이는 Chrome(CDP)이다. 세션은 모두 메인 checkout의 `tmp/`(gitignore)에 있고, 모든 에이전트·worktree가 **`tmp/main` 하나**를 함께 쓴다(3절). `--incognito`는 쓰지 않는다(재시작 때 상태가 사라진다).
3. **전체 기초 검사(`pnpm typecheck`, `node --test`)는 처음과 끝에서만.** 처음에는 실패 목록을 기준선으로 기록하고, 끝에서는 기준선과 비교해 **새로 생긴 실패만** 판정한다. CI가 master에서 같은 검사를 돌리므로, 기준선은 로컬(macOS)에서만 나는 실패를 거르는 용도다. 중간에는 고친 모듈의 테스트 파일 하나(`node --test tests/x.test.mjs`)만 돌려도 된다.
4. **끝나면 내가 만든 것을 치운다.** 격리 세션(`tmp/ade-*`)과 테스트 세션 기록(6절). 증거는 GUIDE를 쓸 때만 그 폴더로 옮기고, 아니면 버린다(`--discard-evidence`). `tmp/main`은 공용이라 끄지 않는다(사용자가 끄라고 할 때만).
5. **계획한 것만 확인했다고 쓴다.** 증거(스크린샷·이벤트·로그) 없는 PASS는 쓰지 않는다. 실행하지 않은 것은 "미확인"이다.

## 2. 환경 모드

| 모드 | 기동 | 용도 | 비고 |
|---|---|---|---|
| **A 더미** | `session.mjs up` → 공용 `tmp/main` | 화면·상태·렌더링·플러그인·서버 로직 | 가짜 `claude`·가짜 Hub와 Claude Code·Codex·Cursor 예시 사용량, 비용 없음 |
| **B API 키** | `session.mjs new <목적> --real --reason "…"` → `tmp/ade-*` | 실제 CLI 프로토콜·출력·권한 흐름, `$` 비용 확인 | 세션 HOME이라 설정 › AI 툴에 저장한 API 키로만 로그인 |
| **C′ 격리 CLI + 구독** | `session.mjs new <목적> --agent-dirs --reason "…"` (`--fresh-agents`는 매번 새 로그인) | 실제 AI 검증의 기본값, 구독 사용량 | HOME은 실제, CLI 설정 폴더만 `~/.ade-test/agents/{claude,codex,cursor}`로 격리 |

선택 규칙: 주장을 반증할 수 있는 **가장 낮은 모드**를 쓴다. 화면·로직은 A, 실제 CLI 동작은 C′(또는 B), 로그인에 묶인 것(플랜 사용량 %p, Cursor)만 C′다.

**C′ 로그인.** 폴더가 격리돼 있어 별도 로그인이 필요하다(사용자의 기존 로그인 파일은 복사하지 않는다. 토큰 갱신이 꼬일 수 있다).
```
node scripts/verify/agents.mjs status                  # 로그인 상태 확인(모델 호출 없음), 사전점검에 사용
node scripts/verify/agents.mjs login claude|codex      # 사용자가 자기 터미널에서 한 번(브라우저 OAuth). AI는 대신할 수 없다
```
- 기본은 한 번 로그인해 두고 계속 쓴다. 매번 새로 로그인하려면 `AGENT_FRESH=1`(폴더가 세션 안에 생기고 정리 때 Claude Keychain 항목까지 삭제).
- Cursor는 설정·세션만 격리되고 **로그인은 Keychain을 공유**한다(CLI가 그렇게 동작함을 확인).
- 로그인이 없으면 시작 전에 BLOCKED로 보고하고 멈춘다.
- 구독은 평소 작업과 **한도를 공유**한다. 시작과 끝의 사용량 칸(`%p`)을 기록한다.
- 격리 폴더가 비어 있어 전역 `CLAUDE.md`·훅·MCP·메모리가 로드되지 않는다. 첫 턴의 `cacheCreate`를 접두부 기준선으로 기록한다.

## 3. 세션 수명주기

```
0 사전점검(session.mjs status, 모드 C′면 agents.mjs status)  1 기준선  2 세션 확보  3 케이스 실행(수정·재확인 포함)  4 최종 검사  5 보고(GUIDE는 이번 세션에서 못 끝낸 것만)  6 정리
```

세션은 `node scripts/verify/session.mjs` 하나로 다룬다. 폴더는 메인 checkout의 `tmp/`이며 어느 worktree에서 실행해도 같은 곳을 본다.

| 폴더 | 언제 | 띄우기 | Chrome |
|---|---|---|---|
| `tmp/main` | **기본. 모든 경우**(화면·플러그인·서버 로직·가짜 `claude`) | `session.mjs up` (떠 있으면 아무것도 안 하고 주소만 출력) | 공용 창 하나, 에이전트마다 자기 탭 |
| `tmp/ade-<목적>-<id>` | 실제 계정·API 키·사용량을 분리해야 할 때만(모드 B·C′) | `session.mjs new <목적> --real\|--agent-dirs\|--fresh-agents --reason "…"` | 자기 창(쿠키가 포트를 구분하지 않아 한 Chrome에 서버 둘을 열 수 없다) |
| `tmp/ade-<목적>-<id>` (폴더만) | 프로세스 없이 빈 `VERIFY_OUT`이 필요한 스크립트(`t-update*.mjs` 등) | `session.mjs new <목적> --folder-only --reason "…"` | 없음 |
| `tmp/run-*` | `t-chat.mjs`·`t-feedback.mjs`·`node --test`가 스스로 띄우는 서버 | 자동, 끝나면 스스로 삭제 | 없음 |

```
node scripts/verify/session.mjs status             # 먼저 항상: 무엇이 떠 있고, 누가 어느 checkout·브랜치로 띄웠고, 내가 할 일은 무엇인지(판정)
node scripts/verify/session.mjs up --as <이름>      # main이 없으면 띄우고, 있으면 그대로 쓴다. 닫힌 Chrome만 다시 연다. 두 에이전트가 동시에 불러도 하나만 뜬다
node scripts/verify/session.mjs tab --as <이름>     # main Chrome에 내 탭(백그라운드, 포커스 안 가져감). 이후 드라이버에 VERIFY_TAB=<이름>
VERIFY_TAB=<이름> node scripts/verify/t-open-chat.mjs   # main의 드라이버는 VERIFY_OUT 없이 실행한다
node scripts/verify/session.mjs use [<checkout>]   # main의 서버를 다른 worktree 소스로(기본: 지금 checkout). Chrome·데이터는 유지
node scripts/verify/session.mjs build              # 폰이 받는 PC 화면(apps/web/dist)을 다시 만든다. 세션이 뜰 때 없으면 한 번 만든다
node scripts/verify/session.mjs reset              # main의 데이터를 비우고 다시(첫 실행 화면이 필요할 때)
```
- **폰에 보이는 화면은 `apps/web/dist`다.** 폰은 PC의 서버가 내려 주는 빌드된 화면을 보므로(`ui/manifest`, docs/REMOTE_UI.md), HMR만 도는 세션에는 그 화면이 없어 `UI_UNAVAILABLE`이 되고 폰이 옛 기본 화면으로 떨어진다. 세션은 시작할 때 `apps/web/dist`가 없으면 한 번 만들고, 웹을 고친 뒤 폰 쪽에서 보려면 `session.mjs build`로 다시 만든다(Chrome의 페이지는 HMR로 이미 따라간다).
- **소스는 알아서 따라간다.** 웹 소스는 Vite HMR로 바로 반영된다. 서버 소스(`apps/local-server/src`, `apps/desktop/src`, 플러그인 하네스)를 고치면 서버만 자동 재시작되고, 포트·토큰이 고정이라 주소와 로그인이 유지되며 열린 탭은 스스로 새로고침된다. 문법 오류로 서버가 못 뜨면 `status`에 오류가 보이고, 고치면 다시 뜬다. 수동 재시작은 `session.mjs restart`.
- **main은 함께 쓴다.** `use`·`reset`은 main을 보는 모든 에이전트의 화면을 바꾸므로 `status`의 시작자·소스를 보고 쓴다. 설정을 바꾼 테스트는 끝나면 되돌린다. main의 소스가 내 worktree가 아니면 `status`가 알려 준다.
- 새 세션을 띄우기 전에 반드시 `status`. `tmp/` 밖에 `start-ui.mjs`를 직접 띄우지 않는다. 남의 격리 세션은 건드리지 않는다.
- 세션 폴더의 `env.json`이 그 세션의 프로세스 기록(manifest)이다. 정리는 이 기록만 따른다.
- **Chrome 조작.** 사용자는 테스트 중에도 다른 작업을 한다.
  - main의 Chrome은 창 하나다. 에이전트는 `tab --as`로 그 창에 자기 탭을 열어 쓰고(남의 탭을 조작하지 않는다), 새 Chrome을 띄우지 않는다.
  - 창을 앞으로 가져오거나 옮기지 않는다: `Page.bringToFront`·`Target.activateTarget`·`Browser.setWindowBounds`, `osascript`·`open -a`로 활성화 금지. `cdp.mjs`가 막는다. 예외는 피드백 화면 캡쳐뿐이며 `connect(match, { focus: true })`로 연다. Chrome은 가려지거나 백그라운드 탭이어도 렌더링·스크린샷이 된다(`start-ui.mjs` 플래그).
  - 조작은 `scripts/verify/cdp.mjs`로 그 창에서 사람이 하듯 클릭·입력한다([E2E_HANDOFF](E2E_HANDOFF.md) 4.4~4.5). 서버 API를 직접 불러 결과만 받는 방식으로 화면 검증을 대신하지 않는다(사용자가 볼 수 없다). 서버 수준 확인은 `t-chat.mjs`·`t-feedback.mjs` 같은 기존 스위트로 한다.
  - 반복해서 쓸 조작은 `cdp.mjs`·`lib.mjs`에 더한다. 한 번만 쓰는 탐색 스크립트는 세션 폴더(`tmp/main/probe-<이름>/` 등) 안에 두고 끝나면 지운다(GUIDE 폴더에 커밋하지 않는다).
- 케이스를 **실행 전에** 미리 적어 둔다(프롬프트·기대·모드·컨텍스트 태그). 턴 사이에 머뭇거리면 캐시가 식는다.

## 4. 모델·비용 규칙

- **가장 싼 모델·낮은 Effort**: Claude는 Haiku 5.5·low, Codex는 GPT-6-Luna·low, Cursor는 목록에서 가장 싼 모델. 시작 때 `ps` 인자나 저장된 이벤트의 `model`로 실제 모델을 확인한다(드롭다운 기본값은 CLI 기본 모델이다).
- **한 채팅 안에서 모델·Effort·인터랙티브 UI·Artifact 설정을 바꾸지 않는다**(캐시가 깨진다). 조합이 바뀌면 새 채팅을 연다. 앞 대화가 필요한 케이스(재개·Branch/Rewind·캐시 경고 등)는 한 채팅에서 이어서 끝낸다.
- 도구 사용이 목적이 아니면 "한 줄로 답하고 도구는 쓰지 마"를 붙인다. AI가 필요 없는 케이스(모드 A)는 AI 케이스 앞뒤로 몰아서 한다.
- 시작과 끝의 사용량(구독 `%p`, API 키 `$`)을 기록하고, 세션 비용 상한을 정해 넘으면 멈춘다.

## 5. 기록

**이번 세션 안에서 끝낼 수 있으면 GUIDE 없이 끝낸다.** 케이스별 결과·증거·토큰·고친 것·남은 문제는 그 세션의 최종 답변에 보고하고 파일은 만들지 않는다(사용자가 GUIDE를 요청한 경우만 예외). GUIDE는 이번 세션 안에서 확인하지 못한 항목이 있을 때만 쓴다.

폴더: `docs/tests/YYMMDD_HHMM_제목/GUIDE.md` (KST, 제목은 공백 없이). GUIDE를 쓸 때는 **테스트를 마친 뒤에** 파일 1개로 쓴다([_template/GUIDE.md](tests/_template/GUIDE.md)).

- 담는 것: 목적, 미확인 항목과 각각에 필요한 것(환경·사람), 확인 절차. 이번 세션에서 확인한 결과는 최종 답변에 쓰고 GUIDE에는 옮기지 않는다.
- 증거는 필요한 스크린샷만 같은 폴더의 `evidence/`에 남긴다(`session.mjs down … --evidence`가 전부 복사하니 필요 없는 것은 지운다. main의 증거는 `tmp/main/shots`에서 필요한 것만 직접 옮긴다).
- **GUIDE의 끝:** 남긴 미확인 항목이 모두 확인되면 그 폴더를 삭제한다(기록은 git history에 남는다). 일부만 확인됐으면 확인된 항목을 GUIDE에서 지운다.
- **미리 쓰는 가이드는 만들지 않는다.** 환경이나 사람이 없어 이번 세션에서 확인하지 못한 항목만, 그 항목만 담은 짧은 GUIDE로 남긴다(Electron·Windows·실제 계정 등). 이번 세션에서 할 수 있는 것을 가이드로 미루지 않는다. 그래야 보류 가이드가 쌓이지 않는다.
- 판정은 `PASS / FAIL / BLOCKED / SKIP`. 절차에 없던 이상은 `NOTE`로 따로 쓴다.
- 기능 설명용 원본 문서(`ARCHITECTURE`, `E2E_HANDOFF`, `VERIFICATION` 등)는 `docs/` 바로 아래에 두고 이 규칙의 대상이 아니다.

## 6. 정리

```
node scripts/verify/session.mjs down <tmp/ade-* 이름> --evidence docs/tests/<폴더>   # 격리 세션: 증거 보관 후 정리 (버리려면 --discard-evidence)
node scripts/verify/session.mjs prune                  # 주인이 끝난 tmp/run-* 삭제
node scripts/verify/session.mjs prune --legacy --dry-run   # OS 임시 폴더에 남은 옛 ade-verify-* (지울 것만 보기, --dry-run을 빼면 삭제)
```
- `down`은 `env.json`에 기록된 PID를 명령줄이 기록과 맞을 때만 끄고(Windows는 CIM으로 확인), 세션 폴더 하나(표시 파일이 있는 `tmp/` 바로 아래 폴더)만 지운다. `~/.ade-test/agents`를 유지할 때는 이 세션의 transcript(세션 폴더 이름으로 식별)만 지우고, 모르는 흔적은 지우지 않고 알린다. `AGENT_FRESH`면 Claude Keychain 항목도 지운다.
- **`tmp/main`은 끄지 않는다.** 모두가 함께 쓰는 세션이라 사용자가 끄라고 할 때만 `down main --main`. 내가 남긴 것(내 탭, `probe-*` 스크립트, 바꾼 설정)만 치운다.
- `prune --legacy`는 살아 있는 프로세스가 기록하거나 이름으로 쓰는 폴더, 2시간 안에 바뀐 폴더를 남긴다.
- 하지 않는 것: `node`·`chrome` 이름으로 일괄 종료, 확인하지 않은 경로 `rm -rf`, `tmp/` 밖 세션 폴더 삭제, 남의 세션 종료.
- 중단·실패로 끝났을 때도 같은 명령으로 정리한다. 사용자가 확인하러 열어 둔 세션은 사용자가 닫으라고 할 때까지 둔다.

## 7. 브라우저에서 플러그인 검증

세션(`start-ui.mjs`)은 기본으로 테스트 전용 플러그인 호스트를 켭니다. Electron 없이도 같은 플러그인 코어와 실제 Node 호스트를 사용하므로 설정·승인·상단 헤더 버튼·액션·워크스페이스 연결을 검증할 수 있습니다. 일반 서버와 설치 앱에는 이 HTTP 연결을 열지 않습니다(`ADE_DEV=1`, 하네스 플래그, 표시 파일이 있는 세션 폴더 안의 `VERIFY_OUT`·`ADE_DATA_DIR`가 모두 필요하며 Electron IPC 실행에서는 차단).

- 플러그인은 설정 → 플러그인의 zip 선택으로 설치합니다. 로컬 소스를 시험하려면 `VERIFY_PLUGIN_DIR=<plugin.json이 있는 폴더> node scripts/verify/session.mjs restart`(떠 있지 않으면 `up`)로 지정합니다. 해당 폴더를 세션의 플러그인 폴더에 한 번 복사하며, 이미 설치한 복사본은 재시작 때 덮어쓰지 않습니다. 비공개 소스와 zip은 공개 저장소에 복사하거나 커밋하지 않습니다.
- 실행·설치·플러그인의 확인 요청은 브라우저 DOM 대화상자로 표시하며 기본 선택은 취소입니다. `cdp.mjs`의 JavaScript dialog 자동 수락으로는 승인되지 않습니다. 원래 플러그인 코어의 콘텐츠 해시 승인과 변경 시 중단을 그대로 사용합니다.
- 키와 승인은 `<ADE_DATA_DIR>/verify-plugins`에 AES-GCM으로 저장하고 암호화 키 파일은 권한 0600으로 같은 임시 폴더에 둡니다. **OS Keychain 보호와 동등하지 않습니다.** 짧게 쓰는 테스트 키를 사용하고 끝나면 설정 화면에서 지웁니다(격리 세션이면 `session.mjs down`이 키 파일과 함께 삭제합니다). 화면에도 이 차이를 표시합니다.
- 서버 재시작(자동 또는 `session.mjs restart`)은 Chrome을 유지하고 서버의 플러그인을 종료한 뒤 다시 연결합니다. 설치·승인·저장 설정은 같은 세션 폴더에서 유지됩니다. 세션 시작 시 자동 업데이트나 모델 호출은 하지 않습니다. 업데이트 확인은 화면에서 직접 실행합니다.
- 기본 모드 A의 Claude는 여전히 가짜입니다. 실제 API 작업은 `session.mjs new <목적> --real --reason "…"`의 격리 세션에서 합니다. A/B의 GitHub CLI도 임시 HOME을 사용하므로 별도 로그인이 필요합니다. 기존 GitHub Keychain 로그인이 필요한 검증은 사전점검 후 `--agent-dirs`(C′) 격리 세션을 사용합니다. HOME은 실제 값으로 두고 AI 설정 폴더만 격리하며, GitHub 활성 계정은 바꾸지 않습니다. `GH_CONFIG_DIR`만 지정해서는 Keychain 인증이 되지 않을 수 있습니다.
- OS 알림과 Finder/Explorer 폴더 열기는 검증 대상이 아닙니다. 폴더 열기 버튼은 임시 플러그인 폴더 경로를 표시하고, zip은 브라우저 파일 선택기를 사용합니다. 해당 네이티브 동작과 Keychain 자체는 데스크톱 검증이 별도로 필요합니다.

## 8. 폰 종단 테스트

실제 폰의 debug 앱과 일회용 테스트 ADE(실제 원격 접속 플러그인, 로컬 Hub, 가짜 claude)를 지문·실제 Hub 로그인·AI 사용 없이 이어 로그인, 페어링, PC 화면, 채팅, 재연결까지 돌린다: `node scripts/verify/t-phone-e2e.mjs all`. 쓰는 법, 구성, 안전장치, 한계는 [REMOTE_UI](REMOTE_UI.md#폰-종단-테스트-실제-폰-지문실제-hub-로그인ai-사용-없이)에 있다. 공용 세션 `tmp/main`과 사용자의 설치 앱은 건드리지 않고 자기 세션 폴더 `tmp/ade-phone-e2e`만 쓴다. 끝나면 `down`으로 정리한다(앱 로그아웃, 이 rig가 더한 `adb reverse`/`forward` 제거, 기록한 PID만 종료).
