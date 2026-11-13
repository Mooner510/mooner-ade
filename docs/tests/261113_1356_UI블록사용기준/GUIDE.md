# Chat UI 블록 사용 기준 확인 (지침 변경 전후)

목적: `apps/local-server/src/chat-ui-prompt.js`의 지침을 판단 문턱("plain text보다 나을 때만")에서 알아챌 수 있는 순간(선택 질문으로 끝낼 때·수치 보고·단계)으로 바꿨다. 이 변경 뒤 두 가지를 확인한다.

- 필요한 곳에서는 UI 블록이 쓰인다
- 예/아니오 확인·설명·제안에서는 쓰이지 않는다

Claude와 Codex를 각각 **격리된 테스트 세션**에서 확인한다. Cursor는 지침이 전달되지 않으므로(`chat-rpc.js`의 `session/new`) 제외한다.

## 기준선 (변경 전, 2026-11-13 집계)

`node docs/tests/261113_1356_UI블록사용기준/audit.mjs` 결과. Claude 채팅 17개에서 포크 중복을 빼고 130턴을 집계했다. 끝맺음 분류는 휴리스틱이라 수작업 분류와 ±3건 정도 다르다.

| 지표 | 값 |
|---|---|
| UI 블록이 있는 턴 | 2 (그중 chart 1건은 프레임 수와 ms를 한 축에 섞은 오용) |
| 선택 질문으로 끝난 턴 / 그중 form | 15 / 0 |
| 예/아니오로 끝난 턴 / 그중 form | 18 / 1 |
| "필요하면 말씀해 주세요"류 / 그중 form | 20 / 0 |
| 마크다운 표가 있는 턴 | 24 |

## 1. 테스트 세션 열기 (공통)

규칙은 [TESTING_GUIDE](../../TESTING_GUIDE.md)를 따른다. 모드는 **C′ 격리 CLI + 구독**(`AGENT_DIRS=1`)이다. 사용자의 설치 앱과 실제 `~/.claude`·`~/.codex`는 읽지도 쓰지도 않는다. CLI 설정 폴더는 `~/.ade-test/agents/{claude,codex}`다.

1. 사전점검: `node scripts/verify/agents.mjs status`에서 claude·codex가 `로그인됨`이어야 한다. 아니면 BLOCKED로 멈추고 사용자에게 `agents.mjs login <claude|codex>`를 부탁한다.
2. 이미 떠 있는 테스트 세션(`ps`의 `verify/start-ui.mjs`)이 내 것이면 재활용하고, 남의 것은 건드리지 않는다. 없으면 띄운다.
   ```
   export VERIFY_OUT=$(mktemp -d -t ade-ui-usage)
   AGENT_DIRS=1 node scripts/verify/start-ui.mjs &
   ```
   - 지침은 서버 코드에 들어 있다. 띄운 뒤 서버 코드를 고쳤다면 `AGENT_DIRS=1 VERIFY_OUT=$VERIFY_OUT node scripts/verify/restart-ui.mjs`로 서버만 재시작한다
3. Chrome에서 프로젝트 선택 화면의 `repo`(임시 git 저장소, `a.txt`·`src/b.ts`만 있음)를 연다. 온보딩이 뜨면 "다음: 기능 둘러보기" → "건너뛰기".
4. 설정 › AI 툴 › Claude 탭의 '프롬프트 캐시·입력' 묶음에서 **인터랙티브 UI**가 켜져 있는지 본다(기본값 켜짐). 이 토글은 Codex 채팅에도 적용된다. 테스트 중에는 바꾸지 않는다(캐시 접두부가 바뀐다).
5. 시작할 때 상태바의 Claude·Codex 사용량(`%p`)을 기록한다. 구독 한도는 평소 작업과 공유된다. 끝날 때 한 번 더 기록한다.

## 2. Claude: Haiku 5.5 · Low · 구독(C′)

### 준비

1. 설정 › AI 툴 › Claude의 **채팅 인증 방식**은 `CLI 로그인`(기본값)이다. API 키는 저장하지 않는다.
2. 새 Claude 채팅을 열고 하단 줄에서 모델 `Haiku 5.5`, Effort `낮음`을 고른다. 고르지 않으면 CLI 기본 모델이 돈다.
3. 첫 메시지를 보낸 뒤 아래를 확인한다. 하나라도 다르면 그 회차는 무효다.
   - 채팅 상태 줄이 **API Usage가 아니라** Plan Usage(또는 `%p` 기여도)다
   - `ps -Ao pid,args | grep -- '--append-system-prompt-file'`의 인자에 `--model claude-haiku-5-5`, `--effort low`, `--append-system-prompt-file …/ade-ui-prompt.md`가 있고, 환경의 `CLAUDE_CONFIG_DIR`가 `~/.ade-test/agents/claude`다
   - 그 `ade-ui-prompt.md`에 `single yes/no`가 있다(새 지침)
   - `<env.json의 data>/*/chat/<채팅 id>/events.jsonl`의 어시스턴트 `model`이 `claude-haiku-5-5`다
   - 첫 회차의 `cacheCreate`를 접두부 기준선으로 기록한다(지침 1,853자 → 2,374자의 영향, 체크리스트 G4)

### Claude에서 따로 볼 것

- P1·P2에서 form 대신 `AskUserQuestion` 질문 카드가 나올 수 있다. 결과 표에 `질문 카드`로 따로 적고, form과 합쳐 "구조화된 질문"으로 판정한다. 평문 질문만 나오면 실패다.
- 카드를 건너뛰면 평문 질문으로 돌아가는 경로(`ASK_SKIPPED`)가 있다. 카드를 건너뛴 회차는 결과에 메모만 남긴다.

## 3. Codex: GPT-6-Luna · Low

### 준비

1. 설정 › AI 툴 › Codex의 **채팅 인증 방식**이 `CLI 로그인`(기본값)인지 본다. 로그인은 격리 폴더 `~/.ade-test/agents/codex`의 것이다.
2. 새 Codex 채팅을 열고 하단 줄에서 다음을 고른다.
   - 모델: `GPT-6-Luna`(계열 색이 Luna인 항목). 목록에 없으면 `더 많은 모델…`에서 찾는다
   - Effort: `low`. 목록에 `low`가 없으면 진행하지 말고 알린다
3. 첫 메시지를 보낸 뒤 아래를 확인한다. 하나라도 다르면 그 회차는 무효다.
   - 채팅 상태 줄이 **API Usage가 아니라** Plan Usage(또는 `%p` 기여도)다
   - `<env.json의 data>/*/chat/<채팅 id>/meta.json`의 `configDir`가 `~/.ade-test/agents/codex`이고 `model`에 `luna`가 있으며, Effort 표시가 `low`다
   - 지침: `grep -rl "single yes/no" ~/.ade-test/agents/codex/sessions/$(date +%Y/%m/%d)`. 이 버전의 Codex가 developer 지침을 rollout에 남기지 않아 비어 있으면 건너뛰고 결과에 적는다

### Codex에서 따로 볼 것

- Codex의 질문 카드(`requestUserInput`)는 보통 계획 모드에서만 나온다. 기본 모드에서는 form이 유일한 구조화된 질문 수단이므로 P1·P2의 form 비율을 그대로 판정한다.
- 코드 펜스 언어 표기를 다르게 쓰는지(`json`, 언어 없음 등) 본다. `ui`가 아니면 그냥 코드 블록으로 보인다. 이런 경우는 `깨짐`이 아니라 실패로 적고 원문을 남긴다.

## 4. 시나리오 (두 에이전트 공통)

각 시나리오를 에이전트마다 **새 채팅에서 3회** 실행한다. 모델 출력은 매번 달라서 1회로는 판정할 수 없다. 질문 문구는 아래 그대로 붙여 넣는다. 임시 저장소와 상관없이 답할 수 있게 만든 질문이다(N1만 `src/b.ts`를 쓴다).

### 써야 하는 경우

| # | 질문 | 기대 |
|---|---|---|
| P1 | `채팅 앱에서 서버 '연결 상태' 표시를 개선할 방법을 두세 가지 제안하고 내가 고르게 해줘. 파일은 만들거나 고치지 마.` | 답변 **맨 끝**에 form이 하나 온다. radio를 쓰고, 권장안이 첫 항목이며, 가능하면 '기타' text 칸이 있다. form 뒤에는 작업을 이어 가지 않는다 |
| P2 | `채팅 목록에 정렬 옵션을 새로 넣으려고 해. 기본값, 정렬 기준, 설정 저장 범위를 정해야 하니 필요한 걸 나한테 물어봐. 파일은 만들거나 고치지 마.` | 칸이 여러 개인 form 하나로 묻는다. 질문 세 개를 평문으로 나열하지 않는다 |
| P3 | `파일 다섯 개의 줄 수야: ChatPane.tsx 1420, Settings.tsx 610, Workspace.tsx 980, Markdown.tsx 240, style.css 2100. 한눈에 비교되게 보여줘.` | 단위가 하나(줄 수)인 `chart` bar. stats도 통과로 본다 |
| P4 | `성능 수정 결과야. 그려진 프레임 257→761, 34ms 넘는 긴 프레임 48→5, Paint+PrePaint 2721ms→675ms. 수정 전후를 정리해줘.` | 단위가 섞인 데이터다. 세 값을 **한 축의 chart로 그리면 실패**다. stats(지표별 전→후), 표, 단위별로 나눈 차트는 통과다. 실제로 나왔던 오용을 재현하는 문항이다 |
| P5 | `채팅 목록 정렬 기능을 구현하는 계획을 단계로 세워줘. 파일은 만들거나 고치지 마.` | steps 또는 번호 목록. 둘 다 통과다 |

### 쓰면 안 되는 경우

| # | 질문 | 기대 |
|---|---|---|
| N1 | `src/b.ts에 고칠 점이 있는지 봐 줘. 고치진 마.` | 끝에 "고칠까요?" 같은 예/아니오가 오더라도 **평문**이다. form이 나오면 실패다 |
| N2 | `JavaScript에서 Promise.all과 Promise.allSettled의 차이를 설명해줘.` | UI 블록이 없다. 표는 허용한다 |
| N3 | `Node.js에서 현재 작업 디렉터리를 얻는 함수 이름이 뭐야?` | UI 블록이 없다 |
| N4 | `자주 쓰는 HTTP 상태 코드 10개를 의미와 함께 정리해줘.` | 마크다운 표 또는 목록이 온다. `ui` 블록이면 실패다(행이 많고 글자가 섞인 비교) |

### form 왕복 (P1의 3회 중 1회)

P1에서 나온 form의 첫 항목이 아닌 다른 안을 골라 제출한다.

- 제출 내용이 다음 사용자 메시지로 가야 한다
- 에이전트는 고른 안을 기준으로 이어 가야 한다
- 같은 답변 안에서 form을 띄운 뒤 스스로 안을 골라 진행했다면 실패다("stop there" 위반)

## 5. 결과 기록

에이전트마다 아래 표를 채운다. 칸에는 회차별 결과를 적는다(예: `form / form / 평문`).

| # | Claude (Haiku 5.5 · low) | Codex (GPT-6-Luna · low) |
|---|---|---|
| P1 | | |
| P2 | | |
| P3 | | |
| P4 | | |
| P5 | | |
| N1 | | |
| N2 | | |
| N3 | | |
| N4 | | |
| form 왕복 | | |

집계 스크립트로 같은 데이터를 다시 본다. 표는 `claude 전체`·`codex 전체` 행으로 나온다.

```
ADE_DATA_DIR=<env.json의 data> node docs/tests/261113_1356_UI블록사용기준/audit.mjs --list
```

## 6. 판정

| 결과 | 결론 |
|---|---|
| P1·P2가 3회 중 2회 이상 구조화된 질문(form, Claude는 질문 카드 포함), P4에 단위를 섞은 chart 없음, N1~N4는 모든 회차에서 블록 없음 | 그 에이전트는 통과 |
| P1·P2에서 구조화된 질문이 0~1회 | 트리거가 약하다. 답변 원문을 알려 달라(하네스의 "질문은 막혔을 때만" 지시와 충돌하는지 본다) |
| N1에서 form이 나옴 | 남용이다. "single yes/no stays a sentence"가 무시됐다. 회차와 원문을 알려 달라 |
| P4에서 한 축에 단위를 섞음 | "never mix units on one axis"가 무시됐다 |
| form 뒤에 작업이 이어짐 | "stop there"를 더 강하게 써야 한다 |
| 블록이 코드로 보임 | JSON 오류(`깨짐`)이거나 펜스 언어 표기가 틀린 것이다. 원문을 남긴다 |
| 한 에이전트만 실패 | 공통 지침은 그대로 두고, 그 에이전트에만 한 줄을 덧붙이는 것을 검토한다(주입 위치: `chat.js`의 `protocol.initialize`, `index.js`의 `chatLaunchFiles`) |

## 7. 정리

```
VERIFY_OUT=$VERIFY_OUT node scripts/verify/cleanup-ui.mjs --evidence docs/tests/<기록 폴더>
```
- `env.json`에 기록된 PID·임시 폴더·Chrome 프로필만 지운다. `node`·`chrome` 이름으로 일괄 종료하지 않는다.
- `~/.ade-test/agents`(로그인)는 유지되고, 이 세션의 transcript·Codex rollout만 지워진다. 모르는 흔적은 지우지 않고 알린다.

## 실사용 비교 (며칠 뒤, 사용자 앱 데이터)

```
node docs/tests/261113_1356_UI블록사용기준/audit.mjs --since <새 지침이 반영된 서버의 재시작 시각, 예: 2026-11-13T15:00>
node docs/tests/261113_1356_UI블록사용기준/audit.mjs --since <같은 값> --list   # 질문 끝맺음의 분류와 chart 원문을 사람이 검토
```

표는 `에이전트 기간` 단위의 행으로 나온다(예: `claude 이후`, `codex 이후`). 목표는 다음과 같다.

- `선택+form / 선택 질문`이 대부분이다
- `예/아니오+form`과 `제안+form`은 0에 가깝다
- `깨짐`은 0이다
- `[chart]` 줄에 단위를 섞은 차트가 없다

분류는 끝 120자로 판정하는 휴리스틱이므로 `--list`로 오분류를 걸러서 본다.
