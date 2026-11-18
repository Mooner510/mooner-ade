# ADE 아키텍처

무너에이드는 macOS·Windows용 Electron 데스크톱 앱입니다. 별도 웹 배포판은 없으며, 웹 UI는 앱 창 안에서만 동작합니다.

## 구성

- `apps/desktop`: Electron 메인 프로세스와 격리된 렌더러, preload(폴더 선택·앱 정보·플러그인 호출과 피드백용 화면 캡쳐 `ade:capture` 등을 `window.adeDesktop`으로 노출). `ade:capture`는 main이 앱 창(또는 그 안의 사각형)만 `capturePage`로 찍어 PNG로 돌려주며, 요청한 프레임이 메인 창의 앱 출처가 아니면 거절합니다. 시스템 Node(패키지 앱은 번들한 Node)로 로컬 서버를 실행하고, 종료 시 IPC로 정리를 요청합니다. 터미널과 Chat의 에이전트 CLI는 앱과 분리된 PTY 호스트(`apps/local-server/src/pty-host.js`)가 가지며, 서버 재시작·업데이트 재시작·백그라운드 종료 사이에도 유지됩니다. 패키지 앱은 호스트를 설치 폴더 밖 `<userData>/pty-host/`의 복사본에서 실행합니다(`pty-host-files.js`). 자세한 수명은 [로컬 IDE](LOCAL_IDE.md)를 참고하세요.
- `apps/web`: 앱 창에 표시하는 React UI. 터미널 탭·분할과 읽기 전용 Git Diff가 중심입니다. 하나의 WebSocket으로 여러 프로젝트를 구독하며 메시지의 `projectId`로 분배합니다. 파일 편집·검색·커밋 UI는 없습니다. 터미널은 창이 원하는 크기를 `terminal/resize`로 알리고, 서버가 보내는 실제 크기(`terminal/size`)로 그립니다. 같은 터미널을 플러그인 세션(다른 기기)도 볼 때 크기는 마지막으로 입력한 쪽을 따릅니다(`terminal-size.js`, [플러그인](PLUGINS.md#터미널-크기)).
- `apps/local-server`: 루프백 인증, 프로젝트 잠금, Git 상태·Diff·브랜치·저장소 worktree API, PTY와 터미널 세션 복구, 사용량·WakaTime 연동. `runtime.js`가 프로젝트 루트로 제한한 경로 검사, argv 기반 프로세스 실행, Git, PTY 포트를 제공합니다. 앱에서 커밋하는 API는 없습니다.

## 에이전트

Claude Code·Codex는 터미널에서 공식 CLI로 실행합니다. 권한·승인은 CLI 자체 화면을 따르며, 서버는 CLI가 보내는 OSC 7501 상태 보고와 프로세스 트리로 작업 상태·SSH 여부·세션 ID를 추적합니다. 로컬 Claude Code는 `<config>/sessions/<pid>.json`과 대화 transcript의 마지막 메인 요청(`api-request` 시작 시각, 요청한 캐시 TTL)으로 프롬프트 캐시 만료 시각을 계산해 해당 pane 헤더의 타이머에 보냅니다. 서버가 직접 모델을 호출하는 경로는 없습니다. 예외로 채팅 탭(`chat` 리프)은 서버(`apps/local-server/src/chat.js`, `chat-claude.js`)가 공식 `claude -p --input-format stream-json --output-format stream-json`를 pane마다 자식 프로세스 하나로 직접 spawn하고(`shell:false`, 프로젝트 cwd 고정), stdout JSONL을 이벤트로 정규화해 `chat/event` WebSocket 메시지로 보냅니다. 로그인 토큰은 읽거나 전달하지 않고 모델 호출은 CLI 안에서만 일어납니다. 대화 기록은 `<프로젝트 데이터>/chat/<id>/events.jsonl`에 저장되고, 재시작은 `--resume <session id>`입니다. 응답이 없으면 10분 뒤 프로세스를 닫습니다. 터미널의 로컬 Claude는 완전히 쉬는 상태(작업·승인 대기·백그라운드 task·예약 wakeup 없음, `claudeBusy`로 확인)일 때만 채팅으로 옮길 수 있습니다(`terminal/to-chat`). 서버가 그 프로세스를 종료하고 `<config>/projects/.../<session>.jsonl`을 채팅 이벤트로 바꿔 저장한 뒤 같은 세션을 `--resume`으로 이어받습니다. 확인할 수 없는 상태는 거절하며 SSH 터미널은 제외합니다. 반대로 쉬고 있는 채팅은 `chat/to-terminal`로 child를 종료한 뒤 같은 세션을 `claude --resume`으로 연 터미널로 옮길 수 있습니다(Rewind 직후는 제외). 준비 상태 확인만 `claude auth status`와 `codex app-server`의 계정 조회를 사용합니다.

## 채팅 화면의 확장

- **UI 블록과 샌드박스 프레임**: 채팅 답변의 ` ```ui ` 펜스는 위치 기반 JSON을 앱이 직접 그립니다(`ui-spec.ts`, `UiBlocks.tsx`, 모델이 쓴 코드는 실행하지 않음). ` ```ade-ui ` 펜스의 HTML/JS는 `UiFrame.tsx`가 `<iframe sandbox="allow-scripts" src="/ade-ui-frame.html">`(`allow-same-origin` 없음)에서만 실행합니다. 이 페이지(`ui-frame.js`)는 앱 쿠키 없이 응답하는 유일한 경로이며 전용 CSP(`default-src 'none'`, `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'`, `sandbox allow-scripts`)를 붙입니다. 프레임과 앱은 `postMessage`로만 이야기하고, 프레임에서 온 메시지(`ready`·`height`·`send`·`prefill`)는 `ui-frame-protocol.ts`가 형식·길이(4,000자)·높이 범위를 검증합니다. `ade.send`는 프레임 안의 스크립트가 사용자 활성화를 확인하지만 이는 모델이 쓴 코드와 같은 프레임 안의 검사이므로, 앱 쪽 보호는 1.5초에 한 번 제한입니다(코드 주석: 실제 클릭과 위조 메시지를 앱이 구분할 수 없음).
- **UI 지침**: 설정 "인터랙티브 UI"가 켜진 상태로 만든 채팅은 첫 메시지 때 정해진 값으로 `chat-ui-prompt.js`의 지침을 시스템 프롬프트로 받습니다. Claude는 `--append-system-prompt-file`(`index.js`가 채팅 폴더에 `ade-ui-prompt.md`를 씀), Codex는 `developerInstructions`로 전달합니다.
- **서브에이전트**: Claude의 `task_started`·`task_progress`·`task_notification` 시스템 이벤트를 `chat-claude.js`의 `taskEvent`가 `task` 이벤트로 바꿔 `Agent` 호출의 tool_use id로 묶어 보냅니다. 진행(`progress`) 이벤트는 저장하지 않고 실시간으로만 보내며, 화면은 `chat-model.ts`의 `agentsOf`로 카드·트래커·드로어 목록을 만듭니다(Claude 채팅만).
- **이미지 첨부 미리보기**: 이미지를 보낼 때 화면이 축소 JPEG(`previews`, 긴 변 640px, 15만 자 이하)를 함께 보내고, 서버는 형식·크기가 맞는 것만 `user`·`steer` 이벤트에 실어 `events.jsonl`에 저장합니다. 그래서 재시작 뒤에도 말풍선에 썸네일이 남습니다.
- **`@` 파일 언급**: 서버 `files/list`가 프로젝트 루트 검사를 거친 cwd에서 `git ls-files -co --exclude-standard`를 실행해 파일·폴더 이름만 돌려줍니다(최대 5만 개, git 저장소가 아니면 빈 목록). 파일 내용은 읽지 않습니다.
- **Artifact**: 채팅의 Claude는 기본으로 Artifact 도구를 쓰지 않고, 메시지에 `artifact`가 있거나 설정 "Artifact 항상 켜기"가 켜졌을 때만 `CLAUDE_CODE_ARTIFACT=1`을 줍니다(`chat.js`의 `enableArtifact`).

자세한 동작은 [채팅 기능 정리](../CHAT_MODE_FEATURES.md)에 있습니다.

## 인증과 연결

서버는 `127.0.0.1`의 임의 포트에 바인딩하고, 실행할 때마다 새 접속 토큰을 만들어 stdout으로 앱에 알립니다. 토큰은 디스크에 저장하지 않습니다. 앱 창은 URL 해시의 토큰을 HttpOnly·SameSite=Strict 세션 쿠키로 교환한 뒤 주소에서 지웁니다. API는 동일 출처 JSON POST만, WebSocket은 Host·Origin·쿠키가 맞는 요청만 받습니다.

## 플러그인 (선택)

받은 플러그인 폴더를 `<userData>/plugins`에 넣어 기능을 더합니다. 설치한 플러그인은 기본으로 꺼져 있고, 켜기와 플러그인별 승인은 main의 네이티브 확인 창을 거칩니다. 승인은 폴더의 SHA-256에 고정되어 파일이 바뀌면 실행되지 않습니다. 승인한 플러그인은 각자 Node 프로세스로 실행되고 main과 IPC로만 이야기합니다. main은 플러그인이 선언한 환경 변수 접두사, bin 폴더, MCP 스크립트만 골라 서버에 `plugins/terminal`로 보내고, 서버는 새 터미널과 그 안의 Claude Code·Codex에 이것을 더합니다. `workspace`를 선언한 플러그인의 작업공간 세션은 main이 서버에 `plugin/workspace`로 전달하고, 서버는 화면의 요청과 같은 처리기로 다룹니다(`apps/desktop/src/plugin-core.js`, [플러그인](PLUGINS.md)).

MoonerADE Hub에 로그인하면 Hub가 제공하는 플러그인을 설정 → 플러그인 → 마켓에서 골라 설치합니다. main의 Hub 클라이언트(`apps/desktop/src/hub-client.js`)는 앱 자신이 Hub의 기기(종류 `app`)로 기기 코드 로그인을 하고, 토큰은 `plugins.bin`에 봉인하며 Hub 주소(`ADE_HUB_URL`)에만 보냅니다. Hub에서 받은 zip은 `installZip`과 같은 길(확인 창, 해시 고정)로 설치하고, `plugin.json`의 `source.hub`가 있는 플러그인의 업데이트도 이 클라이언트가 확인합니다(GitHub 릴리스용 `createGithub`와 같은 `latest`/`download` 모양, `plugin-updates.js`). 서버(`apps/local-server`)는 마켓을 다루지 않습니다.

앱에는 [내장 플러그인](PLUGINS.md#내장-플러그인)이 하나 들어 있습니다(`apps/desktop/builtin-plugins/agent-bus`, 채팅 에이전트끼리 메시지를 주고받는 [에이전트 버스](AGENT_BUS.md)). 같은 플러그인 API를 쓰지만 승인 확인 창과 해시 고정이 없고 각자 켜고 끕니다.

## 피드백 요청

화면을 캡쳐하고 개선 요청을 써서 개발자에게 보내는 기능입니다. 피드백 하나는 이미지 n장(10장 이하)과 마크다운 본문 하나입니다.

- **저장**: 서버의 `feedback-store.js`가 `<dataRoot>/feedback/<id>/`에 `feedback.json`, `body.md`, `img-<n>.png|jpg`로 둡니다. 주석을 그린 이미지는 원본을 한 번 `img-<n>.orig.*`로 남깁니다. 화면은 `feedback/*` API와 `GET /feedback-file/<id>/<name>`(세션 쿠키 필요)을 쓰고, 바뀌면 WebSocket `feedback/changed`를 받습니다.
- **캡쳐**: Electron main의 `ade:capture`가 앱 창(또는 그 안의 사각형)을 `webContents.capturePage`로 찍습니다. 앱 창 밖은 찍지 않으므로 OS 화면 기록 권한이 필요 없습니다.
- **AI 작성·다듬기**: `AI로 작성`(한 칸 입력)이나 직접 작성 화면의 `AI로 다듬기`를 누르면 `feedback-agent.js`가 피드백 폴더에서 `claude -p --output-format json`을 Read 도구만 허용해 실행합니다. 적어 둔 요건과 스크린샷을 문제·기대 동작·개선 제안과 유형으로 정리하고(제목에는 `[ ]`를 쓰지 못하게 프롬프트로 막고, 결과에서도 지웁니다), 결과를 `review` 상태의 `ai` 초안으로 저장합니다. 제목은 선택이며, 비우고 제출하면 본문 첫 줄이 이슈 제목이 됩니다. 모델은 Haiku 5.5·Sonnet 5.5·Opus 5.5, Effort는 low·medium만 쓸 수 있고(기본 Haiku 5.5 + low) 서버도 그 밖의 값은 기본값으로 바꿉니다.
- **유형**: 항목의 `types`(bug·feature·pain·perf·design·question·praise, 여러 개)는 서버 `feedback-store.js`의 `FEEDBACK_TYPES`가 기준이고 웹 `feedback-model.ts`의 목록과 같아야 합니다(테스트가 비교). 제출할 때 서버가 이슈 제목 앞에 `[버그][성능]`처럼 태그를 붙이고(`issueTitle`; 저장된 제목은 그대로), meta의 `types`를 Hub가 `type:<id>` 라벨로 바꿉니다. Hub가 아직 업데이트되지 않았으면 라벨만 빠지고 제출은 됩니다. 사람이 제목에 `[ ]`를 직접 쓰면 중복될 수 있어 화면이 안내하고, AI·에이전트가 쓴 제목은 앞쪽 `[…]`를 지웁니다.
- **ADE 개요**: `ade-overview.js`의 손으로 쓴 요약(화면 구성·채팅/터미널 기능·설정 섹션·피드백 흐름, 약 1,000자)을 AI 작성·다듬기 프롬프트와 `ade_feedback_draft` 도구 설명에 넣어, AI가 앱이 이미 가진 기능을 없다고 쓰거나 다른 이름으로 부르지 않게 합니다. 기능을 더하거나 이름을 바꾸면 이 파일도 고칩니다. 도구 설명은 에이전트 세션마다 컨텍스트에 실립니다.
- **에이전트 MCP 도구**: 서버가 ADE에서 실행한 Claude Code·Codex(터미널과 채팅)에 `ade_feedback` MCP 서버(`feedback-mcp.js`)를 더합니다. 도구 `ade_feedback_draft`는 `feedback/incoming`에 초안 파일만 남기고, 서버가 이것을 `agent` 초안으로 가져옵니다. 설정에서 끌 수 있습니다.
- **검토 후 제출**: `ai`·`agent` 초안은 사람이 연 뒤(`reviewed`)에만 제출할 수 있습니다. 결과는 비공개 저장소 `Mooner510/mooner-ade-feedback`의 이슈가 됩니다. 피드백 id가 Hub의 중복 방지 키라서 결과를 못 받아 다시 보내도 이슈는 하나입니다.
- **전송 큐**: 제출은 피드백을 `queued` 상태로 큐에 넣을 뿐이고(`feedback.json`에 남아 재시작해도 이어짐), `feedback-queue.js`가 오래된 것부터 하나씩 보냅니다.
  - 로그인한 경우: 서버 → main(IPC `feedback/submit`) → `feedback`을 선언하고 로그인한 플러그인(원격 접속 플러그인) → Hub `POST /v1/feedback`.
  - 로그인하지 않은 경우(UI에는 "로그인 없이 제출"): 서버가 직접 Hub `POST /v1/feedback/anonymous`로 보냅니다(`feedback-hub.js`). 설치마다 임의 id(`feedback/device.json`)를 `X-ADE-Device`로 보내고, 이 기기에서 5분에 1건만 보냅니다(마지막 전송 시각은 `feedback/queue.json`). `ADE_FEEDBACK_ANONYMOUS=0`이면 끕니다. Hub 주소는 `ADE_HUB_URL`(기본 `https://ade-hub.mooner510.kr`).
  - 두 경로 모두 기기 UUID(`dataRoot/device.json`, 최초 1회 발급), `gh` 활성 GitHub 로그인 이름, 전역 Git `user.name`과 이메일의 `@` 앞부분을 전송합니다. 이름도 이메일 형태이면 도메인을 제외하며, 전체 이메일은 전송하지 않습니다. UUID는 피드백 삭제와 앱 업데이트로 바뀌지 않고 해당 파일을 삭제하면 재발급합니다. Hub는 수집 안 된 항목에 `수집 안됨`을 표시하고, `gh` → Git 이름 → 이메일 앞부분 순으로 `reporter:<이름>` 라벨 하나를 붙입니다. 모두 없으면 `anonymous`입니다.
  - Hub는 GitHub의 최신 정식 ADE 릴리스를 확인해 같은 정식 버전 또는 기본 버전이 더 높은 `beta`만 신규 등록을 허용합니다(정식 `0.5.10` 기준 `0.5.10`, `0.5.11-beta3` 허용; `0.5.9`, `0.5.10-beta2` 거부). 거부는 426 `update_required`로 자동 재시도를 멈추고, 최신 버전 조회 실패는 503 `version_check_failed`로 재시도합니다. 이미 생성한 이슈의 동일 키 재조회는 허용합니다.
  - 거절되면 기다렸다 다시 보냅니다: 한도 초과는 `Retry-After`만큼, 네트워크·Hub·GitHub 문제는 30초부터 30분까지 늘려 가며. 잘못된 요청·너무 큰 이미지처럼 기다려도 안 되는 것만 `failed`가 됩니다. 대기 중인 항목은 취소(`feedback/unqueue`)하거나 지울 수 있습니다.

## Git 커밋 그래프

상단 Git 버튼이 여는 하단 drawer(`GitLog.tsx`)는 IntelliJ Git 로그를 따릅니다. 예전 변경사항(Diff) 패널을 대신하며, 상단 버튼에는 `git/status`의 `+/−` 줄 수만 남았습니다.

- **서버** (`apps/local-server/src/git-log.js`): `git/log`는 브랜치·원격·태그·HEAD에서 닿는 커밋(기본 5,000개)과 ref, 진행 중 작업(머지·리베이스·체리픽·되돌리기)과 충돌 파일을 돌려줍니다. ref와 HEAD로 만든 서명이 같으면 `unchanged`만 보내 열린 동안의 주기 갱신이 가볍습니다. `git/commit-details`·`git/commit-file`·`git/compare`·`git/patch`·`git/paths`는 세부 정보와 diff 탭 내용을, `git/op`(프로젝트 `mutation` 직렬화)는 체크아웃·브랜치·태그·머지·리베이스·체리픽·되돌리기·리셋·히스토리 편집·push·업데이트·fetch·계속/건너뛰기/중단·충돌 해결을 실행합니다. 모든 호출은 argv 배열이고 이름은 `check-ref-format`, 해시는 16진수, ref는 `refs/(heads|remotes|tags)/` 전체 이름으로만 받습니다. 프롬프트와 편집기는 끄고(`GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`), 대화형 리베이스는 미리 만든 todo를 `GIT_SEQUENCE_EDITOR`로 덮어쓰고 메시지는 `exec git commit --amend -F`로 넣습니다. 저장소 훅·필터를 끄는 기존 규칙(runtime.js)이 그대로 적용됩니다.
- **그래프** (`apps/web/src/git-graph.ts`, 순수 함수·Node 테스트): head 우선순위(HeadCommitsComparator) 순서의 깊이 우선 탐색으로 layout index를 주고, 각 행에서 노드와 지나가는 선을 layout index로 정렬한 순서가 열입니다. 색은 head 브랜치 이름의 Java `hashCode`를 IntelliJ `DefaultColorGenerator`에 넣어 만들고(채도·밝기는 설정), 30행 이상 선은 양 끝 화살표로 줄입니다. 정렬은 커밋 날짜순(기본)·위상 정렬·머지 선형화, 필터는 숨긴 커밋 너머 가장 가까운 조상으로 점선을 잇습니다.
- **diff 탭**: `diff:<커밋>:<경로>[<TAB><옛 경로>]`(부모 대비), `diff:<a>..<b>:…`(두 커밋), `diff:<a>..:…`(작업 트리 대비). 예전 작업 트리 diff 탭(`diff:all:` 등)은 레이아웃을 불러올 때 버립니다.

## 로컬 경계

경로 검사는 traversal·symlink를 막지만 악성 프로세스에 대한 OS sandbox가 아닙니다. PTY는 사용자 셸과 같은 권한입니다. 로컬 서버가 실행하는 Git은 저장소의 fsmonitor와 hooks를 끄며, 터미널에서 실행한 Git에는 적용하지 않습니다.

파일 감시는 최적화입니다. 생성 실패나 실행 중 오류가 나면 감시기를 닫고 Git 폴링을 유지합니다. 폴링은 현재 표시 중인 프로젝트에만 적용되며 전환 시 즉시 확인합니다.

검증 상태는 [VERIFICATION](VERIFICATION.md), 보안 검토는 [SECURITY_REVIEW](SECURITY_REVIEW.md)를 참고하세요.


## Codex·Cursor 채팅 (2026-11-10)

채팅은 `chat.js`의 저장·재생·상태 관리와 `chat-rpc.js`의 CLI별 JSON-RPC 처리를 공유합니다. Codex는 `codex app-server`, Cursor는 `cursor-agent acp`를 `shell:false`로 실행합니다. 인증과 모델 호출은 공식 CLI가 담당하며 앱이 인증 토큰을 읽지 않습니다. 모델 목록은 CLI에서 조회하고 에이전트·프로젝트·설정 폴더별로 최대 1시간 캐시합니다. Cursor는 목록 조회 시 빈 ACP 세션을 하나 생성하지만 모델 호출은 하지 않습니다.

`chat/open`에 `agent`를 전달하며, 상태의 `agent`와 `capabilities`가 화면과 서버의 지원 범위를 결정합니다. `meta.json`에 에이전트·실제 cwd·CLI 세션 ID를 보관하고, 기존 agent 없는 기록은 Claude로 해석합니다. 메타데이터는 이벤트와 같은 쓰기 큐에서 임시 파일 후 rename으로 저장합니다. Codex의 message ID와 turn ID는 구분하며 Branch/Rewind는 선택한 완료 턴까지 `thread/fork(lastTurnId)`로 이어갑니다. 원본 CLI 기록과 작업 파일은 수정하지 않습니다.

채팅의 `이전 대화 불러오기`(`/resume`)는 전용 모달(`ResumeModal`)을 엽니다. 출처를 나누지 않고 하나의 목록에 최신순으로 보여 줍니다. 항목은 이 프로젝트의 저장된 채팅(`chat/sessions`)이고, Claude 채팅에서는 일반 `claude` CLI가 남긴 `<config>/projects/<cwd를 -로 바꾼 이름>/<session>.jsonl`(`chat/cli-sessions`, `cli-sessions.js`, 설정 폴더는 프로젝트 계정과 기본 `~/.claude`)이 함께 나옵니다. 제목은 `/rename` 이름, 없으면 Claude가 기록에 남긴 AI 제목, 없으면 슬래시 명령이 아닌 첫 입력입니다. 이미 채팅이 된 CLI 세션은 세션 ID로 걸러 한 번만 나옵니다. CLI 항목을 고르면 `chat/import-cli`가 `seedFromTranscript`로 transcript를 새 채팅에 옮긴 뒤 같은 세션을 `--resume`으로 이어받습니다. 실행 중인 `claude`(`<config>/sessions/<pid>.json`)가 쓰는 세션은 단일 writer를 지키기 위해 선택할 수 없습니다. 원본 CLI 기록은 수정하지 않으며 Codex·Cursor는 CLI 기록을 읽지 않고 저장된 채팅만 나옵니다. 채팅 시작 화면에는 브랜치·워크트리 선택이 없습니다.

Codex 권한은 기본(untrusted/workspace-write), 편집 허용(on-request/workspace-write), 계획(on-request/read-only), 모두 허용(never/danger-full-access)입니다. 추가 폴더는 writableRoots로 전달합니다. Cursor는 ACP의 Agent·Plan·Ask 모드를 사용하고, 승인은 CLI가 제시한 옵션 ID로 응답합니다. 질문·계획 승인도 응답까지 연결합니다. 제공되지 않은 비용·토큰·컨텍스트는 0으로 추정하지 않습니다.

Codex·Cursor 워크트리는 기존 Git 실행 보안 규칙을 재사용해 데이터 폴더 아래에 생성하고 cwd를 저장합니다. 탭을 닫아도 워크트리는 삭제하지 않습니다. 로컬 터미널→Chat에서 Claude는 유휴 상태를 검증하고, Codex·Cursor는 작업·미전송 입력의 중단 확인 뒤 해당 터미널의 에이전트 프로세스만 종료합니다. Codex는 `thread/read`와 페이지 단위 턴 조회로 기록을 가져와 같은 thread를 이어받습니다. Cursor는 사용자가 선택한 프로젝트 대화를 새 ACP 세션으로 복사하고 `session/load`의 기록 재생을 정규화합니다(`cli-conversations.js`). Chat→터미널도 child 종료를 확인하며, Cursor는 CLI의 별도 저장 위치에 새 세션을 복사합니다. SSH는 전환하지 않습니다.

Cursor Branch/Rewind는 완료된 응답마다 root 메타데이터를 저장하고 immutable blob을 채팅 폴더의 SQLite에 중복 없이 보관합니다(`cursor-sessions.js`). 새 세션에 선택한 root를 복원하고 agent ID를 바꾸며 강제 실행 상태는 해제합니다. 원본 대화·작업 파일은 변경하지 않습니다. 원본 저장 형식을 검증하지 못하면 거절합니다. 스티어링·추가 폴더는 ACP가 제공하지 않으며, 대기열에서 중단 후 전송은 지원합니다. Codex·Cursor `/stats`는 ADE가 보관한 이벤트를 집계하며 완료 응답 수를 모델 요청 수로 혼동하지 않습니다. Cursor의 ACP 사용량·비용 보고와 API 키를 통한 조건부 읽기 전용 청구 조회도 반영합니다. 미제공 토큰·비용·캐시 만료 시각은 추정하지 않습니다.

Cursor는 ACP의 `parameterizedModelPicker`를 선언하고 `configOptions`의 Fast·Context·Thinking·Effort·Auto 최적화 등 모델별 선택지를 표시합니다. `session/set_config_option` 응답과 알림으로 현재 값·지원 목록을 갱신하고, 선택값을 채팅 메타데이터에 저장해 재접속 시 복원합니다. 설정은 응답 대기 상태에서 적용하며 CLI가 제공하는 값만 허용합니다. 모델 선택은 First Party/Third Party 탭 안에서 Provider별로 묶고 표시 이름과 요청용 ID를 구분합니다.
