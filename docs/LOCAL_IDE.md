# 로컬 ADE 실행 안내

무너에이드는 Warp 스타일의 **터미널·에이전트 중심** 작업 환경이다. 탭과 분할 pane에서 셸·Claude Code·Codex를 실행하고, 코드는 에이전트가 고치고 커밋한다. 사람은 오른쪽 **변경사항(Diff)** 패널과 하단 상태 표시줄로 최소한만 확인한다. 파일 탐색기·검색·편집기·스테이징·커밋 UI는 없다.

## 설치와 실행

Node 24.21.0 이상, pnpm 11.27.1 및 Git을 준비한다. 패키지 설치는 **사용자가 저장소 루트에서 직접 실행한다.**

```sh
pnpm install --frozen-lockfile
```

`pnpm-workspace.yaml`은 `electron`, `node-pty`, `esbuild`의 설치 스크립트를 허용한다. node-pty 네이티브 빌드에 필요한 OS 도구가 없으면 해당 패키지의 설치 안내에 따라 준비한 후 설치를 완료한다. 기존 minimumReleaseAge / trustPolicy 정책은 유지한다. 설치로 생성된 lockfile을 함께 검토·커밋해야 CI의 frozen 설치가 가능하다.

설치 완료 후 정적 검사·빌드·실행:

```sh
pnpm typecheck
pnpm desktop      # 웹 UI 빌드 후 데스크톱 앱(Electron)으로 실행
pnpm start        # 또는 서버만 실행하고 브라우저에서 링크를 연다 (먼저 pnpm web:build)
```

**데스크톱 앱**(`apps/desktop`)은 시스템 Node로 로컬 서버를 자식 프로세스로 띄우고, 서버가 출력한 접속 링크를 창에 연다. 상단 바가 창 제목 표시줄을 겸하며(Windows/Linux는 창 버튼이 오른쪽에 겹쳐 표시된다), 창을 닫으면 IPC로 서버에 종료를 요청해 상태 저장과 프로젝트 잠금 해제를 마친 뒤 종료한다. Node 실행 파일 경로는 `ADE_NODE`로 바꿀 수 있다.

서버는 `ADE_PORT`(기본: 임의 포트)에서 열리고 데이터 폴더는 `ADE_DATA_DIR`로 바꿀 수 있다. 브라우저로 쓸 때는 서버가 출력한 `http://127.0.0.1:<port>/#token=...` 링크를 직접 연다. 토큰은 최초 한 번 HttpOnly / SameSite=Strict 세션 쿠키로 교환되며 주소에서 제거된다. 쿠키를 삭제했거나 서버를 재시작했다면 새 서버의 링크를 사용한다. Vite 개발 서버를 별도로 공개하지 않고 빌드 산출물을 로컬 서버가 같은 출처에서 제공한다.

로그인은 앱 외부 터미널(또는 앱의 터미널 탭)에서 직접 진행한다:

```sh
codex login
claude auth login
```

준비 상태(상태 표시줄 오른쪽)에서 버전, 로그인, PTY 모듈 로딩 상태를 확인한다. Codex initialize/account API 또는 Claude auth status가 지원되지 않으면 실행을 막고 오류를 표시한다. 모델 호출 없이 하는 준비 상태 확인도 로컬 CLI 프로세스를 시작한다. 앱은 자격 증명을 자체 저장소로 복사하지 않는다.

## 화면 구성

| 영역 | 내용 |
|---|---|
| 탭 (사이드바) | 탭은 상단이 아니라 왼쪽 사이드바에서 프로젝트 폴더 아래에 모인다. 탭마다 독립된 pane 분할 트리를 가진다. 폴더의 `＋` 또는 상단 `＋` 새 탭, `⌄` 새 탭에서 실행(터미널 · Claude Code · Codex). 탭 제목은 포커스된 터미널의 제목(OSC 0/2) → 작업 폴더 순으로 자동 표시되며 더블클릭으로 이름을 바꾸고 가운데 클릭으로 닫는다. 다른 탭에 새 출력이 오면 점(●)으로 표시한다. |
| 가운데 | 터미널과 편집기 pane. pane 헤더 없이 마우스를 올리면 오른쪽 위에 분할·최대화·닫기 도구가 나타난다. 비활성 pane은 흐리게 표시한다(설정에서 끌 수 있다). |
| 오른쪽 패널 | **변경사항(Diff)**: HEAD와 비교한 변경 파일 목록과 inline diff(읽기 전용). 파일별 +/− 줄 수와 큰 화면 diff 탭만 제공하며 stage/커밋/되돌리기는 없다. 설정의 새로고침 주기(기본 3초)마다 Git 상태를 다시 읽는다. **에이전트**: SDK 기반 Claude/Codex 세션, 승인 요청, worktree 작업. |
| 프로젝트 사이드바 크기 | 오른쪽 경계를 끌어 160–480px로 조절한다(더블클릭: 기본 252px, 방향키: 16px). 너비는 설정(`sidebarWidth`)으로 저장된다. |
| 프로젝트 사이드바 | 열린 프로젝트가 폴더로 나열되고 각 폴더 안에 그 프로젝트의 탭이 모인다(폴더는 접고 펼 수 있다). 폴더에는 에이전트 실행 수·승인 대기 배지, 백그라운드 터미널 출력(●), 저장 안 된 파일 표시가 붙는다. `«`로 접으면 프로젝트 이니셜만 보이는 좁은 막대가 된다(`Ctrl/⌘+Alt+B`). |
| 상태 표시줄 | 연결 상태, 프로젝트 경로(작업 경로 전환), 브랜치, 변경 요약, 에이전트·승인 대기, 터미널 수, 포커스 터미널 크기(열×행), CPU·메모리(`system/info`, 5초 주기), 시계, 준비 상태. 설정 > 상태바에서 항목별로 켜고 끈다. |

### 여러 프로젝트 동시에 쓰기

한 창에서 프로젝트를 여러 개 열어 두고 오가며 작업한다. 프로젝트마다 탭·pane·편집기·터미널·에이전트 세션이 독립적이며, 다른 프로젝트로 전환해도 터미널과 에이전트 실행은 서버에서 계속된다. 전환 시 저장 확인은 없고, 프로젝트를 **닫을 때** 저장하지 않은 파일과 실행 중인 에이전트·터미널을 확인한다.

| 동작 | 단축키 |
| --- | --- |
| 프로젝트 열기 | `Ctrl/⌘+Alt+O` |
| N번째 프로젝트로 전환 (9는 마지막) | `Ctrl/⌘+Alt+1…9` |
| 다음 / 이전 프로젝트 | `Ctrl/⌘+Alt+]` / `[` |
| 프로젝트 닫기 | `Ctrl/⌘+Alt+W` |

- 열린 프로젝트 목록, 활성 프로젝트, 공용 설정(테마·글꼴 등)은 `app-state.json`에 저장되어 재시작 후 복원된다. 화면 배치와 편집 초안은 프로젝트별로 저장한다.
- 보고 있지 않은 프로젝트에서 승인 요청이 오거나 에이전트 작업이 끝나면 사이드바 폴더 배지, 창 제목, 시스템 알림(허용 시)으로 알린다.
- 같은 저장소를 다른 경로(worktree, 심볼릭 링크)로 열어도 하나의 프로젝트로 합쳐진다.
- 언어 서버는 프로젝트가 처음 화면에 보일 때 시작한다. 폴링(Git 상태, 외부 변경 확인)은 보고 있는 프로젝트만 수행한다.
- 열린 프로젝트 전체의 터미널은 최대 128개(프로젝트당 32개)다.

## 사용 흐름

1. 프로젝트 절대 경로를 입력하거나 최근 프로젝트를 선택한다. 이미 프로젝트가 열려 있으면 사이드바의 ＋ 또는 `Ctrl/⌘+Alt+O`로 추가한다.
   선택한 폴더가 Git 저장소이면 싱글 프로젝트로 연다. 저장소가 아니면 바로 아래 폴더에서 Git 저장소를 찾아 멀티 프로젝트로 연다. 이때 편집기, 터미널, AI 대화는 상위 폴더를 계속 기준으로 사용한다.
2. 첫 탭에 터미널이 열린다. `mod+Shift+N`(또는 `⌄`)으로 새 탭에서 Claude Code/Codex를 바로 실행한다. 셸이 첫 출력을 낸 뒤 `claude` / `codex` 명령을 입력해 준다. 포커스된 터미널에서 Ctrl+D는 좌우, Ctrl+Shift+D는 상하 분할이다. pane은 `mod+Shift+Enter`로 최대화한다. 탭의 마지막 pane을 닫으면 탭도 닫힌다(마지막 탭은 빈 탭으로 남는다).
3. 에이전트가 파일을 바꾸면 오른쪽 **변경사항**에 HEAD 대비 diff가 나타난다. 변경 파일이 5개 이하면 모두 펼치고, 그보다 많으면 접힌 채로 보여 준다. 카드의 외부 링크 아이콘은 큰 화면 diff 탭을 연다.
4. 사이드바 아래 톱니 아이콘 또는 `mod+,`로 설정 창을 연다. 터미널 글꼴·줄 높이·커서·스크롤백, 상태바 항목, 알림, Diff 새로고침 주기를 바꾼다.
5. 저장 충돌 시 현재 디스크(왼쪽)와 내 편집(오른쪽)을 diff로 비교하고 **내 편집으로 덮어쓰기** 또는 **디스크 내용으로 되돌리기**를 고른다. 자동 덮어쓰기나 자동 병합은 하지 않는다. 열린 파일이 수정되지 않은 상태에서 디스크가 바뀌면 조용히 다시 읽는다.
6. **에이전트** 패널에서 제공자·모델·Effort를 고르고 새 세션을 만든다(`Ctrl+Enter`로 보내기). 싱글 프로젝트에서는 공유/worktree 모드도 선택할 수 있다. 같은 대화는 한 번에 한 실행만 허용하고, 다른 대화는 병렬로 실행할 수 있다. 승인 요청이 오면 탭 바와 상태 표시줄에 표시되며 작업 경로와 요청 내용을 확인하고 승인/거절한다.
7. 저장소별 worktree(멀티 프로젝트)를 켜면 ADE 데이터 경로에 worktree를 만들고 Git 작업을 그 경로에 적용한다. 변경이 남아 있으면 worktree 설정을 끌 수 없으며, 원본 저장소 통합은 fast-forward만 허용한다. 제거해도 branch는 보존한다.
8. 싱글 프로젝트에서 별도 작업은 상태 표시줄의 **작업 경로**에서 해당 worktree를 선택한다. AI 대화의 작업 경로는 대화 생성 시 고정된다. 변경 검토·stage·커밋은 선택한 경로에 적용된다. 에이전트 패널의 작업 경로를 펼쳐 통합/제거한다. 실행/PTY가 남아 있거나 dirty이면 거절하며, 통합은 기본 프로젝트로 fast-forward만 허용한다. 분기/충돌은 터미널에서 직접 해결한다. 브랜치는 자동 삭제하지 않는다.

## 단축키

`mod`는 macOS의 ⌘, 그 밖의 OS의 Ctrl이다. 모든 명령은 명령 팔레트(`mod+Shift+P`, `F1`)에서도 실행한다. 터미널에 포커스가 있으면 셸·에이전트 CLI 입력(readline/tmux)을 지키기 위해 ⌘, Ctrl+Shift, Alt 조합만 앱이 가로챈다. 브라우저에서 쓸 때 `Ctrl+Shift+T/W` 같은 일부 조합은 브라우저가 먼저 가져가므로 `Alt+T` 또는 팔레트를 쓴다(데스크톱 앱에서는 그대로 동작한다).

| 키 | 동작 | 키 | 동작 |
|---|---|---|---|
| `mod+Shift+T` / `Alt+T` | 새 탭 | `mod+Shift+N` | 새 탭에서 실행(Claude Code · Codex) |
| `mod+Shift+W` | 탭 닫기 | `Alt+W` | 포커스된 pane 닫기 |
| `Alt+]` / `Alt+[` | 다음/이전 탭 | `Alt+1`…`Alt+9` | N번째 탭(9는 마지막) |
| `Ctrl+D` / `Ctrl+Shift+D` | 터미널 좌우/상하 분할 | `mod+Shift+Enter` | pane 최대화 |
| `Alt+방향키` | pane 포커스 이동 | `mod+Shift+G` | 변경사항(Diff) 패널 |
| `mod+Shift+A` | 에이전트 패널 | `mod+,` | 설정 |

## 언어 지능 (TS/JS)

서버가 프로젝트 루트에서 `typescript-language-server`를 처음 필요할 때 실행하고 `/ws`의 `lsp` 메시지로 중계한다. 진단은 편집기 안에 표시되고, hover·자동완성·정의로 이동(다른 파일 포함)·기호 이동(`Ctrl/⌘+Shift+O`)은 편집기에 연결된다. worktree 작업 경로에서는 파일 경로가 달라지므로 LSP를 끈다. 다른 언어는 `apps/local-server/src/lsp.js`에 서버 명령을 추가하는 방식으로 확장한다.

## 저장과 복구

- macOS: `~/Library/Application Support/mooner-ade`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/mooner-ade`
- Windows: `%LOCALAPPDATA%/mooner-ade` (없으면 사용자 홈)

최근 프로젝트, 화면 상태, 편집 초안, 대화/실행 기록은 위 디렉터리에 저장한다. 프로젝트 소스 아래에 앱 상태를 생성하지 않는다. 프롬프트와 도구 결과도 기록에 포함된다.

프로젝트/대화/실행/제공자 thread ID는 별개다. 실행의 소비자는 서버이므로 브라우저 연결 종료가 실행 중지를 의미하지 않는다. 재연결은 마지막 연속 sequence 이후를 재생하며 화면은 sessionId+sequence로 중복을 제거한다. sequence가 앞뒤로 섞여 도착해도 누락을 건너뛰지 않는다.

서버 재시작 후 프로젝트를 열면 저장된 running 실행은 interrupted가 된다. 이전 승인은 새 브로커에 등록되지 않으므로 만료 상태이며 다시 결정할 수 없다. PTY 레이아웃은 복구하되 이전 OS 프로세스가 살아 있다고 표시하지 않는다. 서버가 같은 경우 PTY에 재접속하며 최근 출력 256 KiB를 재생한다.

## 계약과 제한

- `/api/*`: 같은 출처 JSON POST, 인증 쿠키, Host/Origin 검증. 공통 실패 응답은 `{error:{code,message,retryable,details?}}`.
- `/ws`: 인증된 동일 출처 연결. 한 연결이 여러 프로젝트를 구독할 수 있다. `subscribe`는 projectId와 실행별 cursor를 받아 구독을 추가하고 `unsubscribe`가 해제한다. 서버가 보내는 모든 메시지에는 `projectId`가 붙는다. `project/close`(`force`로 실행 중인 작업까지 종료)와 `app/state`(열린 프로젝트·공용 설정 조회/저장) 요청이 있다. `event`, `snapshot`, `approvals`, `terminal`, `terminal/replay`, `terminal/exit`, `fs`(파일 변경 경로), `lsp`, `error`를 전송한다. 터미널 입력·크기 변경도 이 채널을 사용한다.
- 승인 이벤트는 `kind: approval`, `phase: requested|approved|denied`, `approvalId`, `tool`, `summary`를 기록한다. 과거 requested 이벤트가 있어도 현재 pending 목록에 없으면 승인 버튼을 만들지 않는다. denied에는 거절·만료·취소가 포함된다.
- 텍스트 `mode: append`는 누적, `replace`는 같은 itemId의 전체 교체다. mode가 없는 과거 delta 이벤트는 누적, Codex item.completed는 교체로 읽는다.
- 승인 여부는 제공자 권한 정책에 따른다. Codex는 untrusted + workspaceWrite, Claude는 default + canUseTool을 사용한다. 모든 읽기/허용된 도구가 반드시 승인 콜백을 거치는 것은 아니다. 지원하지 않는 Codex 서버 요청은 오류로 거절한다.
- 검색은 파일 10,000개/결과 200개로 제한하고 정규식·대소문자·단어 단위·포함/제외 glob·파일 단위 바꾸기를 지원한다(바꾸기는 revision을 확인하며 저장하지 않은 파일은 건너뛴다). node_modules/.git/dist/.idea와 심볼릭 링크는 검색하지 않는다. 외부 편집은 `fs.watch`(재귀) 알림과 10초 주기 비교로 감지한다. 확실한 소유 정보가 없는 변경은 외부 변경으로 표시한다.
- 저장은 프로젝트 내 요청을 직렬화하고 revision을 두 번 확인한 뒤 atomic rename한다. 협력하지 않는 외부 프로세스가 마지막 확인과 rename 사이에 쓰는 OS 수준 race를 제거하는 CAS는 아니다. 로컬 경로 검증도 악성 프로세스에 대한 OS 격리를 대체하지 않는다.
- PTY 최근 출력은 256 KiB다. 대용량 장시간 세션 저장은 기존 JSON snapshot 방식을 사용하므로 이벤트 수에 따라 비용이 증가한다.
- 호스팅, 다중 사용자, 컨테이너 격리, 디버거는 범위 밖이다.

## 검증 상태

### 터미널 중심 UI 정리

탐색기·검색·편집기·LSP 연결·스테이징/커밋 UI를 걷어냈다. 서버 API(`files/*`, `git/*`)와 테스트는 그대로 두었고 화면 진입점만 없앴다. 코드 리뷰 패널은 읽기 전용 **변경사항(Diff)** 패널이 되었다. 아이콘은 `apps/web/src/Icon.tsx`의 단일 SVG 세트로 통일하고 모든 아이콘 버튼에 툴팁과 접근성 이름을 붙였다. 설정은 `mod+,`의 설정 창(외관·터미널·상태바·알림·변경사항·단축키)으로 옮겼고, 새 설정 값은 `ui-state.js`의 `validateSettings`가 검증한다. `system/info`는 프로젝트 없이 호출할 수 있는 CPU·메모리 조회 API다.

### Warp 스타일 UI 전환 (feature/warp-style-ui)

IDE 모드(편집기 그룹·하단 패널·문제 패널·활동 표시줄)를 걷어내고 탭 바 + 분할 pane + 오른쪽 코드 리뷰/에이전트 패널 구조로 바꿨다. 소스 제어 뷰는 코드 리뷰 패널로 합쳤고, Git 상태 응답에 파일별 `added`/`deleted`를 추가했다. 화면 상태는 `paneTabs`/`activeTab`/`rightVisible`/`rightTab`을 더 저장하며, 이전 `pane` 하나짜리 상태는 첫 탭으로 복원한다. 데스크톱 셸(`apps/desktop`)을 추가했다.

### 이전 변경

Node 24.12.0 / pnpm 11.27.1 / macOS(Apple Silicon)에서 실제로 실행해 확인했다.

- `pnpm check`: 타입 계약·웹 타입체크·테스트 62개 통과. `tests/local-server.test.mjs`는 서버를 child process로 띄워 인증/Origin 거부, 파일 검색·바꾸기·폴더 rename/delete, Git show/stage/discard/브랜치, **실제 PTY 에코**, 터미널 크기 검증, **실제 typescript-language-server 초기화 응답**, LSP 프레임 파서를 검증한다.
- `pnpm web:build` 통과. Monaco는 동적 청크(`editor.main` 약 3.3 MB, gzip 857 kB)로 분리되어 첫 화면 청크는 약 597 kB다.
- 헤드리스 Chrome(CDP)으로 ADE/IDE 화면을 구동해 확인: 터미널 자동 열기, Quick Open → 편집기 pane 생성, LSP 진단이 상태 표시줄에 도달, IDE 하단 터미널 패널, 소스 제어 → diff 편집기, 검색 결과, 편집기 분할, 라이트 테마. 페이지 예외 없음. 이 스크립트는 저장소에 포함하지 않았다.
- 수정한 실제 결함: macOS에서 pnpm이 node-pty `spawn-helper`의 실행 권한을 빼서 모든 터미널이 `posix_spawnp failed`로 실패했다(서버 시작 시 권한 보정). 포트 6000 고정(브라우저 unsafe port), 폴더 rename/delete 불가, 터미널 크기 미검증, CSP에 막히는 CDN 폰트, Git 브랜치가 `## main` 문자열로 표시되고 worktree 통합 확인에 쓰이던 문제.

아직 하지 않은 확인: 두 제공자(Codex/Claude)의 실제 승인/재개, 서버 재시작 복구, Windows·Linux, Node >=24.21.0, 파일 감시가 재귀 `fs.watch`를 지원하지 않는 플랫폼의 폴링 대체 경로, 브라우저 간(Safari/Firefox) 확인. 실행 환경이 Node 24.12.0이라 요구 버전 경고가 남아 있다.

구현 참조: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude SDK 승인 콜백](https://code.claude.com/docs/en/agent-sdk/user-input), [Claude 권한 평가 순서](https://code.claude.com/docs/en/agent-sdk/permissions).
