# 테스트 가이드 (작성·실행 규칙)

이 문서가 테스트 방법의 기준(SoT)입니다. 기능별 절차를 쌓아 두는 문서가 아니라, **어떻게 테스트하고 어떻게 기록하는가**만 적습니다. 하네스 사용법은 [E2E_HANDOFF](E2E_HANDOFF.md) 4절, 기능별 절차와 기록은 [tests/](tests/)에 있습니다(옛 `TESTING_GUIDE.md`의 절차는 거기로 이관했고 원문은 git `bb5fa1d`에 있습니다).

## 1. 원칙

1. **개발한 세션이 직접 테스트한다.** 별도 세션에 위임하지 않고, 확인 못 한 것만 사람에게 남긴다(5절). 위임은 릴리스 직전 독립 검증이나 사람이 해야 하는 단계처럼 이득이 분명할 때만 쓴다.
2. **항상 격리 세션.** 사용자의 설치 앱과 실제 `~/.claude`·`~/.codex`·`~/.cursor`는 읽지도 쓰지도 않는다. 서버는 임시 `ADE_DATA_DIR`·임시 git repo, 브라우저는 임시 프로필의 보이는 Chrome(CDP)이다. `--incognito`는 쓰지 않는다(재시작 때 상태가 사라진다).
3. **기초 검사(`pnpm typecheck`, `node --test`)는 처음과 끝에서만.** 처음에는 실패 목록을 기준선으로 기록하고, 끝에서는 기준선과 비교해 **새로 생긴 실패만** 판정한다(master에서도 실패하는 `pnpm e2e` 등이 있다). 중간에는 돌리지 않는다. 수정을 모두 마친 뒤 마지막 결과로 고친다.
4. **끝나면 만든 것을 모두 치운다.** 서버·Chrome·임시 폴더·임시 프로필·테스트 세션 기록(6절). 증거는 GUIDE를 쓸 때만 그 폴더로 옮기고, 아니면 버린다(`--discard-evidence`).
5. **계획한 것만 확인했다고 쓴다.** 증거(스크린샷·이벤트·로그) 없는 PASS는 쓰지 않는다. 실행하지 않은 것은 "미확인"이다.

## 2. 환경 모드

| 모드 | 기동 | 용도 | 비고 |
|---|---|---|---|
| **A 더미** | `node scripts/verify/start-ui.mjs` | 화면·상태·렌더링·서버 로직 | 가짜 `claude`·가짜 Hub, 비용 없음. 가짜는 Claude뿐이다 |
| **B API 키** | `REAL_AGENTS=1` 추가 | 실제 CLI 프로토콜·출력·권한 흐름, `$` 비용 확인 | 임시 HOME이라 설정 › AI 툴에 저장한 API 키로만 로그인 |
| **C′ 격리 CLI + 구독** | `AGENT_DIRS=1` 추가 | 실제 AI 검증의 기본값, 구독 사용량 | HOME은 실제, CLI 설정 폴더만 `~/.ade-test/agents/{claude,codex,cursor}`로 격리 |

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
0 사전점검(모드 C′면 agents.mjs status)  1 기준선  2 세션 기동  3 케이스 실행(수정·재확인 포함)  4 최종 검사  5 보고(GUIDE는 이번 세션에서 못 끝낸 것만)  6 정리
```
```
export VERIFY_OUT=$(mktemp -d)                 # 임시 폴더 안에 둔다(정리 스크립트가 임시 폴더 밖은 지우지 않는다)
node scripts/verify/start-ui.mjs &             # 모드 A. 모드 C′는 AGENT_DIRS=1 앞에 붙인다
VERIFY_OUT=$VERIFY_OUT node scripts/verify/restart-ui.mjs   # 서버 코드를 고쳤을 때(웹 소스는 HMR로 자동)
```
- 이미 떠 있는 세션이 있으면 재활용한다. 남의 세션(`ps`로 `verify/start-ui.mjs` 확인)은 건드리지 않는다.
- `env.json`(`VERIFY_OUT`)이 이 세션이 만든 프로세스·폴더의 기록(manifest)이다. 정리는 이 기록만 따른다.
- **Chrome 조작(예전 방식 그대로).** 사용자는 테스트 중에도 다른 작업을 한다.
  - 세션의 Chrome은 `start-ui.mjs`가 띄운 창 하나다. 실행마다 새 세션·새 Chrome을 띄우지 않는다(새 창이 뜰 때마다 포커스를 가져간다). 서버를 고쳤으면 `restart-ui.mjs`로 같은 창의 탭만 옮긴다.
  - 창을 앞으로 가져오거나 옮기지 않는다: `Page.bringToFront`·`Target.activateTarget`·`Browser.setWindowBounds`, `osascript`·`open -a`로 활성화 금지. `cdp.mjs`가 막는다. 예외는 피드백 화면 캡쳐뿐이며 `connect(match, { focus: true })`로 연다. Chrome은 가려져도 렌더링을 멈추지 않게 떠 있다(`start-ui.mjs` 플래그).
  - 조작은 `scripts/verify/cdp.mjs`로 그 창에서 사람이 하듯 클릭·입력한다([E2E_HANDOFF](E2E_HANDOFF.md) 4.4~4.5). 서버 API를 직접 불러 결과만 받는 방식으로 화면 검증을 대신하지 않는다(사용자가 볼 수 없다). 서버 수준 확인은 `t-chat.mjs`·`t-feedback.mjs` 같은 기존 스위트로 한다.
  - `/tmp`에 별도 드라이버를 새로 만들지 않는다. 필요한 도우미는 `cdp.mjs`·`lib.mjs`에 더한다.
- 케이스를 **실행 전에** 미리 적어 둔다(프롬프트·기대·모드·컨텍스트 태그). 턴 사이에 머뭇거리면 캐시가 식는다.

## 4. 모델·캐시 규칙

- **가장 싼 모델·낮은 Effort**: Claude는 Haiku 5.5·low, Codex는 GPT-6-Luna·low, Cursor는 목록에서 가장 싼 모델을 처음에 정해 기록에 남긴다. 시작 때 `ps` 인자와 저장된 이벤트의 `model`로 실제 모델을 확인한다(드롭다운 기본값은 CLI 기본 모델이다).
- **한 채팅 안에서 모델·Effort·인터랙티브 UI·Artifact 설정을 바꾸지 않는다.** 접두부가 달라져 캐시가 깨진다. 설정 조합이 같은 케이스끼리 묶고, 조합이 바뀔 때 새 채팅을 연다.
- 케이스에 **컨텍스트 태그**를 단다. `독립`(새 채팅이나 `/clear`로 시작해도 됨), `연쇄`(앞 대화가 필요: 재개·Branch/Rewind·모델 변경 경고·캐시 경고 등, `/clear` 금지, 식기 전에 묶어서 끝냄).
- **캐시가 식으면(Claude)** 헤더 캐시 타이머가 ❄️이거나 곧 끝나고 컨텍스트가 크며 케이스가 `독립`이면 `/clear` 후 다시 시작한다. 컨텍스트가 작으면(처음 기준 약 2만 토큰 미만) 재작성 비용이 작아 `/clear`하지 않는다. 이 값은 휴리스틱이므로 첫 기록으로 보정한다. 구독 TTL은 1시간(문서 기록), API 키는 5분일 가능성이 있다(미확인: 첫 턴 뒤 타이머로 확인).
- Codex·Cursor에는 캐시 타이머가 없다. 케이스마다 새 채팅, 짧은 프롬프트로 한다.
- 도구 사용이 목적이 아니면 "한 줄로 답하고 도구는 쓰지 마"를 붙인다. 임시 repo는 파일 2개짜리 그대로 쓴다.
- 기록에 케이스별 `cacheRead`·`cacheCreate`·입출력(API 키는 `$`)을 남긴다. 세션당 최대 턴 수·비용 상한을 정해 넘으면 멈춘다.
- AI가 필요 없는 케이스(모드 A)는 AI 케이스 앞뒤로 몰아서 한다.

## 5. 기록

**이번 세션 안에서 끝낼 수 있으면 GUIDE 없이 끝낸다.** 케이스별 결과·증거·토큰·고친 것·남은 문제는 그 세션의 최종 답변에 보고하고 파일은 만들지 않는다(사용자가 GUIDE를 요청한 경우만 예외). GUIDE는 이번 세션 안에서 확인하지 못한 항목이 있을 때만 쓴다.

폴더: `docs/tests/YYMMDD_HHMM_제목/GUIDE.md` (KST, 제목은 공백 없이). GUIDE를 쓸 때는 **테스트를 마친 뒤에** 파일 1개로 쓴다([_template/GUIDE.md](tests/_template/GUIDE.md)).

- 담는 것: 목적과 의도한 결과, 모드·모델, 실제로 한 절차, 케이스별 결과·증거·토큰, 고친 것, 남은 문제와 그 수정 방향.
- 증거는 필요한 스크린샷만 같은 폴더의 `evidence/`에 남긴다(`cleanup-ui.mjs --evidence`가 전부 복사하니 필요 없는 것은 지운다).
- **미리 쓰는 가이드는 만들지 않는다.** 환경이나 사람이 없어 이번 세션에서 확인하지 못한 항목만, 그 항목만 담은 짧은 GUIDE로 남긴다(Electron·Windows·실제 계정 등). 이번 세션에서 할 수 있는 것을 가이드로 미루지 않는다. 그래야 보류 가이드가 쌓이지 않는다.
- 판정은 `PASS / FAIL / BLOCKED / SKIP`. 절차에 없던 이상은 `NOTE`로 따로 쓴다.
- 기능 설명용 원본 문서(`ARCHITECTURE`, `E2E_HANDOFF`, `VERIFICATION` 등)는 `docs/` 바로 아래에 두고 이 규칙의 대상이 아니다.

## 6. 정리

```
node scripts/verify/cleanup-ui.mjs --evidence docs/tests/<폴더>   # 증거 보관 후 정리 (버리려면 --discard-evidence)
node scripts/verify/cleanup-ui.mjs --list                        # 임시 폴더에 방치된 ade-verify-* 목록(삭제 안 함)
```
- `env.json`에 기록된 PID(명령줄이 기록과 맞을 때만), 임시 폴더, Chrome 프로필, `VERIFY_OUT`, (`AGENT_FRESH`면) Claude Keychain 항목을 지운다. `~/.ade-test/agents`를 유지할 때는 이 세션의 transcript(임시 폴더의 고유한 이름으로 식별)만 지우고, 모르는 흔적은 지우지 않고 알린다.
- 하지 않는 것: `node`·`chrome` 이름으로 일괄 종료, 확인하지 않은 경로 `rm -rf`, 임시 폴더 밖 삭제, 남의 세션 종료.
- 중단·실패로 끝났을 때도 같은 명령으로 정리한다. 사용자가 확인하러 열어 둔 세션은 사용자가 닫으라고 할 때까지 둔다.
