# 로컬 웹 IDE 실행 안내

## 설치와 실행

Node 24.21.0 이상, pnpm 11.27.1 및 Git을 준비한다. 사용자가 의존성 설치를 완료했고 lockfile이 갱신되었다. 새 환경의 패키지 설치도 **사용자가 저장소 루트에서 직접 실행한다.**

```sh
pnpm install --frozen-lockfile
```

`pnpm-workspace.yaml`은 `node-pty`, `esbuild`의 설치 스크립트를 허용한다. node-pty 네이티브 빌드에 필요한 OS 도구가 없으면 해당 패키지의 설치 안내에 따라 준비한 후 설치를 완료한다. 기존 minimumReleaseAge / trustPolicy 정책은 유지한다. 설치로 생성된 lockfile을 함께 검토·커밋해야 CI의 frozen 설치가 가능하다.

설치 완료 후 정적 검사·빌드·실행:

```sh
pnpm typecheck
pnpm web:build
pnpm start
```

서버는 `ADE_PORT`(기본: 임의 포트)에서 열리고 데이터 폴더는 `ADE_DATA_DIR`로 바꿀 수 있다. 서버가 출력한 `http://127.0.0.1:<port>/#token=...` 링크를 직접 연다. 토큰은 최초 한 번 HttpOnly / SameSite=Strict 세션 쿠키로 교환되며 주소에서 제거된다. 쿠키를 삭제했거나 서버를 재시작했다면 새 서버의 링크를 사용한다. Vite 개발 서버를 별도로 공개하지 않고 빌드 산출물을 로컬 서버가 같은 출처에서 제공한다.

로그인은 앱 외부 터미널에서 직접 진행한다:

```sh
codex login
claude auth login
```

준비 상태에서 버전, 로그인, PTY 모듈 로딩 상태를 확인한다. Codex initialize/account API 또는 Claude auth status가 지원되지 않으면 실행을 막고 오류를 표시한다. 모델 호출 없이 하는 준비 상태 확인도 로컬 CLI 프로세스를 시작한다. 앱은 자격 증명을 자체 저장소로 복사하지 않는다.

## 사용 흐름

1. 프로젝트 절대 경로를 입력하거나 최근 프로젝트를 선택한다.
   선택한 폴더가 Git 저장소이면 기존 싱글 프로젝트로 연다. 저장소가 아니면 바로 아래 폴더에서 Git 저장소를 찾아 멀티 프로젝트로 연다. 이때 편집기, 터미널, AI 대화는 상위 폴더를 계속 기준으로 사용한다.
2. 탐색기(활동 표시줄 첫 번째)에서 파일을 연다. 한 번 클릭은 미리보기 탭(이탤릭), 더블클릭·편집은 고정 탭이다. 우클릭 메뉴와 `F2`/`Delete`로 새 파일·새 폴더·이름 바꾸기(폴더 포함)·삭제(폴더 포함)·경로 복사·터미널에서 열기를 쓴다. 편집기는 Monaco(VS Code와 같은 코어)이며 찾기/바꾸기, 미니맵, 멀티 커서, 접기, diff 편집기를 쓴다. UTF-8 일반 파일만 편집하고 2 MiB를 넘거나 바이너리이면 이유를 표시한다.
3. 저장 충돌 시 현재 디스크(왼쪽)와 내 편집(오른쪽)을 diff 편집기로 비교하고 **내 편집으로 덮어쓰기** 또는 **디스크 내용으로 되돌리기**를 고른다. 자동 덮어쓰기나 자동 병합은 하지 않는다. 열린 파일이 수정되지 않은 상태에서 디스크가 바뀌면 조용히 다시 읽는다.
4. 오른쪽에서 제공자를 선택하고 새 대화를 만든다. 싱글 프로젝트에서는 공유/worktree 모드도 선택할 수 있다. 같은 대화는 한 번에 한 실행만 허용하고, 다른 대화는 병렬로 실행할 수 있다. 네이티브 제공자가 승인을 요청하면 작업 경로와 요청 내용을 확인하고 승인/거절한다.
5. **ADE 모드**는 터미널과 편집기 pane을 한 분할 트리에 섞어 배치한다. 새 터미널·2×3 프리셋·새 편집기 pane을 열고, 포커스된 터미널에서 Ctrl+D는 좌우, Ctrl+Shift+D는 상하 분할이다. `⌘/Ctrl+P`로 연 파일은 마지막으로 쓴 편집기 pane(없으면 새 pane)에 열린다. pane은 `⌘/Ctrl+Shift+Enter`로 최대화한다. **IDE 모드**는 편집기 그룹(`⌘/Ctrl+\`로 분할)과 하단 패널(터미널/문제)을 쓴다. ADE와 IDE의 레이아웃은 각각 저장되고 터미널 프로세스만 공유한다. 레이아웃에 터미널이 없으면 이미 실행 중인 터미널을 연결하고, 없을 때만 새로 연다.
6. 소스 제어 뷰는 스테이지된 변경/변경 그룹, 행별 stage·unstage·변경 취소, 클릭 시 diff 편집기, `Ctrl+Enter` 커밋을 제공한다. 상태 표시줄의 브랜치를 눌러 전환한다. 저장소별 worktree를 켜면 ADE 데이터 경로에 worktree를 만들고 Git 작업을 그 경로에 적용한다. 변경이 남아 있으면 worktree 설정을 끌 수 없으며, 원본 저장소 통합은 fast-forward만 허용한다. 제거해도 branch는 보존한다.
7. 싱글 프로젝트에서 별도 작업은 사이드바의 **작업 경로**에서 해당 worktree를 선택한다. AI 대화의 작업 경로는 대화 생성 시 고정된다. 변경 검토·stage·커밋은 선택한 경로에 적용된다. AI 뷰의 작업 경로를 펼쳐 통합/제거한다. 실행/PTY가 남아 있거나 dirty이면 거절하며, 통합은 기본 프로젝트로 fast-forward만 허용한다. 분기/충돌은 터미널에서 직접 해결한다. 브랜치는 자동 삭제하지 않는다.

## 단축키

`mod`는 macOS의 ⌘, 그 밖의 OS의 Ctrl이다. 모든 명령은 명령 팔레트(`mod+Shift+P`, `F1`)에서도 실행한다. 터미널에 포커스가 있으면 셸 입력(readline/tmux)을 지키기 위해 ⌘, Ctrl+Shift, Alt 조합만 IDE가 가로챈다. 따라서 Windows/Linux의 터미널 안에서 파일 열기는 `Ctrl+Shift+P`로 팔레트를 열어 `>`를 지우고 이름을 입력한다.

| 키 | 동작 | 키 | 동작 |
|---|---|---|---|
| `mod+P` | 파일로 이동 | `mod+Shift+P` / `F1` | 명령 팔레트 |
| `mod+S` / `mod+Shift+S` | 저장 / 다른 이름으로 저장 | `Alt+W` / `mod+W` | 편집기 닫기(`mod+W`는 브라우저가 가로채면 `Alt+W`) |
| `Alt+]` / `Alt+[` | 다음/이전 탭 | `mod+\` | 편집기 분할 |
| `mod+B` | 사이드바 | `mod+J` | 패널 |
| `mod+Shift+E/F/G/H` | 탐색기 / 검색 / 소스 제어 / 바꾸기 | `mod+,` | 설정 |
| `Ctrl+\`` | 터미널 전환 | `mod+Shift+Enter` | pane 최대화 |
| `Alt+방향키` | pane 포커스 이동 | `Alt+Z` | 자동 줄바꿈 |

## 언어 지능 (TS/JS)

서버가 프로젝트 루트에서 `typescript-language-server`를 처음 필요할 때 실행하고 `/ws`의 `lsp` 메시지로 중계한다. 진단은 편집기 표시·문제 패널·상태 표시줄에, hover·자동완성·정의로 이동(다른 파일 포함)·기호 이동(`Ctrl/⌘+Shift+O`)은 편집기에 연결된다. worktree 작업 경로에서는 파일 경로가 달라지므로 LSP를 끈다. 다른 언어는 `apps/local-server/src/lsp.js`에 서버 명령을 추가하는 방식으로 확장한다.

## 저장과 복구

- macOS: `~/Library/Application Support/mooner-ade`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/mooner-ade`
- Windows: `%LOCALAPPDATA%/mooner-ade` (없으면 사용자 홈)

최근 프로젝트, 화면 상태, 편집 초안, 대화/실행 기록은 위 디렉터리에 저장한다. 프로젝트 소스 아래에 앱 상태를 생성하지 않는다. 프롬프트와 도구 결과도 기록에 포함된다.

프로젝트/대화/실행/제공자 thread ID는 별개다. 실행의 소비자는 서버이므로 브라우저 연결 종료가 실행 중지를 의미하지 않는다. 재연결은 마지막 연속 sequence 이후를 재생하며 화면은 sessionId+sequence로 중복을 제거한다. sequence가 앞뒤로 섞여 도착해도 누락을 건너뛰지 않는다.

서버 재시작 후 프로젝트를 열면 저장된 running 실행은 interrupted가 된다. 이전 승인은 새 브로커에 등록되지 않으므로 만료 상태이며 다시 결정할 수 없다. PTY 레이아웃은 복구하되 이전 OS 프로세스가 살아 있다고 표시하지 않는다. 서버가 같은 경우 PTY에 재접속하며 최근 출력 256 KiB를 재생한다.

## 계약과 제한

- `/api/*`: 같은 출처 JSON POST, 인증 쿠키, Host/Origin 검증. 공통 실패 응답은 `{error:{code,message,retryable,details?}}`.
- `/ws`: 인증된 동일 출처 연결. `subscribe`는 projectId와 실행별 cursor를 받는다. `event`, `snapshot`, `approvals`, `terminal`, `terminal/replay`, `terminal/exit`, `fs`(파일 변경 경로), `lsp`, `error`를 전송한다. 터미널 입력·크기 변경도 이 채널을 사용한다.
- 승인 이벤트는 `kind: approval`, `phase: requested|approved|denied`, `approvalId`, `tool`, `summary`를 기록한다. 과거 requested 이벤트가 있어도 현재 pending 목록에 없으면 승인 버튼을 만들지 않는다. denied에는 거절·만료·취소가 포함된다.
- 텍스트 `mode: append`는 누적, `replace`는 같은 itemId의 전체 교체다. mode가 없는 과거 delta 이벤트는 누적, Codex item.completed는 교체로 읽는다.
- 승인 여부는 제공자 권한 정책에 따른다. Codex는 untrusted + workspaceWrite, Claude는 default + canUseTool을 사용한다. 모든 읽기/허용된 도구가 반드시 승인 콜백을 거치는 것은 아니다. 지원하지 않는 Codex 서버 요청은 오류로 거절한다.
- 검색은 파일 10,000개/결과 200개로 제한하고 정규식·대소문자·단어 단위·포함/제외 glob·파일 단위 바꾸기를 지원한다(바꾸기는 revision을 확인하며 저장하지 않은 파일은 건너뛴다). node_modules/.git/dist/.idea와 심볼릭 링크는 검색하지 않는다. 외부 편집은 `fs.watch`(재귀) 알림과 10초 주기 비교로 감지한다. 확실한 소유 정보가 없는 변경은 외부 변경으로 표시한다.
- 저장은 프로젝트 내 요청을 직렬화하고 revision을 두 번 확인한 뒤 atomic rename한다. 협력하지 않는 외부 프로세스가 마지막 확인과 rename 사이에 쓰는 OS 수준 race를 제거하는 CAS는 아니다. 로컬 경로 검증도 악성 프로세스에 대한 OS 격리를 대체하지 않는다.
- PTY 최근 출력은 256 KiB다. 대용량 장시간 세션 저장은 기존 JSON snapshot 방식을 사용하므로 이벤트 수에 따라 비용이 증가한다.
- 호스팅, 다중 사용자, 컨테이너 격리, 디버거는 범위 밖이다.

## 검증 상태 (이번 변경)

Node 24.12.0 / pnpm 11.27.1 / macOS(Apple Silicon)에서 실제로 실행해 확인했다.

- `pnpm check`: 타입 계약·웹 타입체크·테스트 62개 통과. `tests/local-server.test.mjs`는 서버를 child process로 띄워 인증/Origin 거부, 파일 검색·바꾸기·폴더 rename/delete, Git show/stage/discard/브랜치, **실제 PTY 에코**, 터미널 크기 검증, **실제 typescript-language-server 초기화 응답**, LSP 프레임 파서를 검증한다.
- `pnpm web:build` 통과. Monaco는 동적 청크(`editor.main` 약 3.3 MB, gzip 857 kB)로 분리되어 첫 화면 청크는 약 597 kB다.
- 헤드리스 Chrome(CDP)으로 ADE/IDE 화면을 구동해 확인: 터미널 자동 열기, Quick Open → 편집기 pane 생성, LSP 진단이 상태 표시줄에 도달, IDE 하단 터미널 패널, 소스 제어 → diff 편집기, 검색 결과, 편집기 분할, 라이트 테마. 페이지 예외 없음. 이 스크립트는 저장소에 포함하지 않았다.
- 수정한 실제 결함: macOS에서 pnpm이 node-pty `spawn-helper`의 실행 권한을 빼서 모든 터미널이 `posix_spawnp failed`로 실패했다(서버 시작 시 권한 보정). 포트 6000 고정(브라우저 unsafe port), 폴더 rename/delete 불가, 터미널 크기 미검증, CSP에 막히는 CDN 폰트, Git 브랜치가 `## main` 문자열로 표시되고 worktree 통합 확인에 쓰이던 문제.

아직 하지 않은 확인: 두 제공자(Codex/Claude)의 실제 승인/재개, 서버 재시작 복구, Windows·Linux, Node >=24.21.0, 파일 감시가 재귀 `fs.watch`를 지원하지 않는 플랫폼의 폴링 대체 경로, 브라우저 간(Safari/Firefox) 확인. 실행 환경이 Node 24.12.0이라 요구 버전 경고가 남아 있다.

구현 참조: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude SDK 승인 콜백](https://code.claude.com/docs/en/agent-sdk/user-input), [Claude 권한 평가 순서](https://code.claude.com/docs/en/agent-sdk/permissions).
