# 보안 검토 (mooner-ade)

- 최초 검토: 2026-10-09 / 현재 구현 반영: 2026-10-23 (데스크톱 전용 전환과 미사용 API 제거). 4-1 이후 절은 2026-11-12 `feat/ui-frame` 브랜치 코드를 읽고 쓴 것이며, 각 표의 "검증" 열이 확인 범위다.
- 범위: 로컬 서버(`apps/local-server`), 런타임 어댑터(`apps/local-server/src/runtime.js`), 웹 UI(`apps/web`)
- 범위: 아래 수정 이력과 현재 코드의 보안 경계. 완전한 침투 테스트나 Git 전체 이력 비밀정보 검사는 아니다.
- 위협 모델: 127.0.0.1에 바인딩된 단일 사용자 로컬 도구. 원격 웹 페이지, DNS 리바인딩, 교차 사이트 요청을 주된 외부 위협으로 본다. 인증된 사용자는 PTY 터미널로 이미 셸을 가지므로 파일 API의 root jail은 인증 경계가 아니다.

## 1. 수정한 항목

| 심각도 | 항목 | 위치 | 검증 |
|---|---|---|---|
| Medium (API 제거됨) | `git/discard`에 `files: ["."]`를 보내면 `ls-files`가 실패하는 경우 프로젝트 루트 전체를 `fs.rm`한다. 추적 파일이 있으면 루트 전체를 `git restore`로 되돌린다. `files/delete`에는 루트 가드가 있었지만 discard에는 없었다. | `apps/local-server/src/index.js` (`git/discard`) | 이후 UI가 쓰지 않는 `git/discard`·`files/*` API 자체를 제거했다(이후 채팅 `@` 언급용 `files/list`가 새로 추가됐다, 4-2). 회귀 테스트 `endpoints of removed features stay gone`이 404를 확인한다. |
| Medium | 저장소의 `.git/config`에 있는 `core.fsmonitor`는 `git status`가 실행할 때 임의 명령으로 실행된다. ADE는 프로젝트를 열 때 `git/status`를 자동 호출하므로, 신뢰하지 않은 저장소를 여는 것만으로 명령이 실행될 수 있다. **재현됨**(임시 저장소, git 2.50.1). | `apps/local-server/src/runtime.js` (`GIT_TRUSTED_REPO_CONFIG`) | 회귀 테스트 `git: a repository-configured core.fsmonitor command never runs during status`. 수정을 끄면 실패하고 켜면 통과함을 확인했다. |
| Medium (사용자 동작 필요) | 저장소의 `.git/hooks`(예: `post-checkout`)가 ADE의 브랜치 전환(`git switch`)에서 실행되었다. **재현됨**: 훅 환경변수 없이 `git switch`하면 훅이 실행되고, 적용하면 실행되지 않음을 확인했다(git 2.50.1). | `apps/local-server/src/runtime.js` (`GIT_TRUSTED_REPO_CONFIG`에 `core.hooksPath=/dev/null`) | 회귀 테스트 `git: a repository hook never runs during ADE checkout`. **현재 동작:** 로컬 런타임의 Git에서는 훅을 비활성화한다. 앱에는 커밋 API가 없다. 터미널·에이전트 CLI에서 실행한 Git은 사용자의 훅 설정을 따른다. |
| Medium | 저장소의 `.git/config`에 있는 `filter.<이름>.clean/smudge/process`가 `.gitattributes`와 함께 지정되면, ADE가 자동으로 호출하는 `git diff --numstat HEAD`(`git/status`)와 브랜치 전환·워크트리 추가에서 임의 명령으로 실행되었다. `diff.<이름>.textconv/command`도 diff에서 실행될 수 있다. **재현됨**(git 2.45.1). | `apps/local-server/src/runtime.js` (`repositoryFilters`가 system·global이 아닌 범위의 필터 명령을 명령 범위에서 빈 값으로 덮어씀), `apps/local-server/src/index.js` (diff 호출에 `--no-ext-diff --no-textconv`) | 회귀 테스트 `git: repository-configured filter and diff commands never run during status, show or checkout`. 수정을 끄면 실패하고 켜면 통과함을 확인했다. 사용자 전역 설정의 필터(git-lfs 등)는 그대로 동작한다. |

## 2. 수정하지 않은 항목 (권고)

설계 판단이나 추가 재현이 필요한 항목이다.

| 심각도 | 항목 | 위치 | 권고 |
|---|---|---|---|
| Low | 접속 토큰을 서버 기동 때마다 stdout에 출력해 앱에 전달한다. 토큰은 이제 프로세스마다 새로 만들고 디스크에 저장하지 않으므로 노출 범위는 해당 실행 동안으로 줄었다. | `apps/local-server/src/index.js` (기동 로그), `apps/desktop/src/main.js` | 출력 대신 IPC로 전달한다. |
| Low | 루트 밖을 가리키는 untracked 심볼릭 링크가 하나 있으면 `git/status` 전체가 실패한다(가용성). | `apps/local-server/src/index.js` (git status), `runtime.js` `resolve` | 해당 항목만 건너뛰도록 처리한다. |
| Low | 세션 쿠키에 `Secure`가 없다. 세션은 만료나 정리 없이 `sessions` Set에 계속 쌓인다. | `apps/local-server/src/index.js` (인증 쿠키, `sessions`) | 만료 시각을 두고 주기적으로 정리한다. `Secure`는 localhost 전제에서 영향이 작다. |
| Low | 파일 시스템 오류 메시지에 절대 경로가 그대로 포함된다. | `apps/local-server/src/index.js` (오류 응답) | 응답에서 경로를 제거한다. |
| Info | 토큰 비교가 `!==`로 상수 시간이 아니다. 루프백과 256비트 토큰이라 실익은 낮다. | `apps/local-server/src/index.js` (인증) | `crypto.timingSafeEqual`로 바꾼다. |
| Info | API 본문을 인증 확인 전에 파싱한다(상한 3MB). | `apps/local-server/src/index.js` (본문 파싱) | 인증 이후로 옮긴다. |

## 3. 확인하고 이상 없음으로 판단한 항목

- **Origin/Host/CSRF**: `trusted()`가 Host를 정확히 비교해 DNS 리바인딩을 막는다. POST는 Origin 정확 일치와 `application/json`을 요구한다. WebSocket upgrade도 Host, Origin, 쿠키를 검사한다.
- **경로 탈출/symlink**: `inside()`는 `path.relative` 기반이라 `/root2` 같은 prefix 문제가 없다. 조상 경로의 realpath를 검사한다. 정적 파일은 `webRoot + sep` 접두사를 검사한다.
- **명령 주입**: `shell: true`를 쓰지 않는다. git 호출은 argv 배열과 `--literal-pathspecs`, `--`를 쓴다. 브랜치 이름은 `-`로 시작하면 거부하고 정규식으로 검증한다.
- **서버의 모델 호출**: 서버 SDK 실행·승인 경로(`run/*`, `approval`, Claude Agent SDK 의존성)를 제거했다. 에이전트는 터미널의 공식 CLI로만 실행되며 권한은 CLI가 관리한다.
- **클라이언트 XSS**: 앱 코드에 `dangerouslySetInnerHTML`·`innerHTML` 사용이 없다(`apps/web/src`, `apps/local-server/src` grep). 채팅 답변은 직접 만든 Markdown 렌더러(`Markdown.tsx`)가 React 요소로만 그리고 http(s) 링크만 확인 창을 거쳐 연다. 모델이 쓴 ` ```ade-ui ` HTML/JS는 앱 문서가 아니라 4-4의 샌드박스 iframe에서만 실행한다. 터미널 출력은 xterm이 그린다. 일반 실행의 CSP는 `script-src 'self'`다. Vite 개발 모드에는 HMR용 inline script와 localhost WebSocket 예외가 있다.
- **토큰 취급**: 서버 프로세스마다 `randomBytes(32)`로 생성하며 디스크에 쓰지 않는다. 이전 버전이 남긴 `token` 파일은 기동 시 삭제한다. URL 해시는 클라이언트가 읽은 뒤 `history.replaceState`로 지우고 `Referrer-Policy: no-referrer`를 적용한다. 쿠키는 HttpOnly, SameSite=Strict다.

## 4. 붙여 넣은 이미지

| 위협 | 대응 | 검증 |
|---|---|---|
| 붙여 넣은 이미지가 임시 폴더에 쌓여 노출 | 데이터 폴더 `paste/`(0700), 파일 0600, 24시간과 256 MiB 상한을 둡니다. | 코드 검토 (`index.js` `prunePastes`) |

## 4-1. 플러그인 (2026-11, 선택 기능)

설계는 [PLUGINS](PLUGINS.md)에 있습니다. 아래 표는 설치하는 플러그인(승인 필요)에 대한 것입니다. MoonerADE에는 승인과 해시 고정이 없는 내장 플러그인 `agent-bus`(`apps/desktop/builtin-plugins`)가 앱의 일부로 들어 있고, 사용자가 켜고 끌 수 있습니다([내장 플러그인](PLUGINS.md#내장-플러그인)).

| 위협 | 대응 | 검증 |
|---|---|---|
| 렌더러 XSS·터미널 안 에이전트가 플러그인을 켜거나 심음 | 켜기와 승인은 main의 네이티브 확인 창에서만 됩니다. 승인은 폴더 SHA-256에 고정되고 실행 직전에 다시 확인합니다. 바뀐 플러그인은 멈추고 다시 승인해야 합니다. | `plugins.test.mjs` (승인 전 실행 안 함, 변경 시 멈춤) |
| 승인한 해시에 들어가지 않는 코드가 실행됨 | 링크, 파일도 폴더도 아닌 것(FIFO·소켓)이 든 폴더는 받지 않고, `plugin.json` 경로에 `:`(NTFS 대체 데이터 스트림)를 쓸 수 없습니다. | `plugins.test.mjs` |
| 플러그인이 터미널 환경을 넘어서 바꿈(`PATH`, `NODE_OPTIONS`, `BASH_ENV`, `HTTPS_PROXY`) | 선언한 접두사의 변수만, 예약 접두사(앱·Node·에이전트, 셸 시작·프록시·TLS 신뢰·언어 런타임)는 선언 불가. PATH에는 자기 bin 폴더만 앞에 붙습니다. | `plugins.test.mjs` |
| 플러그인 경로의 따옴표로 에이전트 명령줄을 벗어남 | 명령줄 인자는 작은따옴표로 감싸고, PowerShell이 작은따옴표로 읽는 `‘ ’ ‚ ‛`도 두 번 써서 글자로 남깁니다. | `plugins.test.mjs` (Windows는 PowerShell로 실제 실행) |
| 플러그인 확인 창이 MoonerADE 확인 창으로 위장 | 제목 `플러그인: <이름>`과 요청자 표기를 main이 붙입니다. 승인 확인 창에 나오는 이름·설명에는 제어 문자와 방향 바꿈 문자를 쓸 수 없습니다. | `plugins.test.mjs` |
| 플러그인이 허락받지 않고 프로젝트·터미널을 조작 | `workspace`를 선언하고 그 내용으로 승인받은 플러그인의 요청만 서버에 전달합니다. 플러그인당 세션 16개, 터미널 8개이고, 플러그인이 멈추면 세션을 모두 닫습니다. | `plugins.test.mjs`, `plugin-workspace.test.mjs` |
| 플러그인이 허락받지 않고 피드백(본문·스크린샷)을 받아 감 | `plugin.json`에 `feedback`을 선언하고 그 내용으로 승인받은 플러그인의 `feedback` 메시지만 받습니다. 승인 확인 창에 "피드백 요청에서 제출한 피드백(본문과 스크린샷)을 받아 개발자에게 전송합니다."가 표시됩니다. 제출 요청은 실행 중이고 `available: true`인 플러그인 하나에만 보내며 120초 안에 답이 없으면 실패로 봅니다. 이미지는 MoonerADE 데이터 폴더 안의 절대 경로로만 넘깁니다([PLUGINS](PLUGINS.md#피드백-feedback)). | 코드 검토 (`plugin-core.js`), `plugins.test.mjs` |
| 플러그인 알림·상태 표시가 MoonerADE 것으로 위장하거나 숨어서 동작 | 알림 제목은 MoonerADE가 `플러그인: <이름>`으로 붙이고 1분에 10개로 제한합니다. 상태바 표시는 플러그인 아이콘과 함께 그리고 마우스를 올리면 플러그인 이름이 보이며, 사용자가 숨길 수 없습니다. 상태바 표시와 QR은 텍스트로만 받아 MoonerADE가 그립니다. | `plugins.test.mjs` |

남은 위험: 승인한 플러그인과, 같은 사용자 권한으로 도는 악성 프로그램은 막지 못합니다. 승인한 플러그인이 터미널에 더한 도구는 그 터미널 안의 에이전트도 씁니다.

## 4-2. 채팅 탭 (2026-11)

서버가 공식 `claude` 바이너리를 직접 spawn합니다(모델 호출·로그인은 CLI 안에서만).

| 위협 | 대응 | 검증 |
|---|---|---|
| 채팅 입력이 명령줄·셸로 새어 나감 | `shell:false`, 인자는 배열, 사용자 텍스트는 stdin JSON으로만 전달합니다. cwd는 열린 프로젝트로 고정됩니다. | 코드 검토 |
| 이미지·세션 수 폭주 | 프로젝트당 채팅 16개, 메시지당 이미지 4장(PNG/JPEG/GIF/WebP, 각 base64 2.5M자 이하). | `local-server.test.mjs` 범위 밖, 수동 |
| 모델 출력이 UI에 마크업 삽입 | Markdown은 React 요소로만 그리고(HTML 문자열 없음) http(s) 링크만 연결하며 열기 전 확인 창을 거칩니다. | 코드 검토 |
| 승인 없이 도구 실행 | `--permission-prompts host`로 CLI가 묻는 승인을 GUI 카드에서 사용자가 직접 답합니다. `모두 허용` 모드는 사용자가 명시 선택해야 합니다. | `chat-claude.test.mjs`(변환), 실제 승인은 수동 |
| 접근 폴더·워크트리 설정 | `--add-dir` 경로는 OS 폴더 선택창에서만 고르며 서버가 절대경로·실존 디렉터리·최대 8개를 다시 검증합니다. `--worktree`는 대화 시작 전에만 켤 수 있습니다. 인사에 쓰는 OS 사용자 이름은 로컬 UI에만 반환합니다. | 실제 claude로 수동 확인 |
| 대화 분기·되돌리기·스티어링 | `chat/branch`·`chat/rewind`·`chat/cancel-steer`는 기존 인증된 `/api`를 거칩니다. 분기는 `seedChat`이 프로젝트 chat 폴더 아래에만 새 기록을 쓰고, 메시지 uuid는 형식을 검증한 뒤에만 `--resume-session-at`에 넘깁니다. 스티어링 취소는 CLI의 `cancel_async_message` 제어 요청만 보냅니다. 토큰·로그인 정보는 다루지 않습니다. | `chat-claude.test.mjs`(인자·uuid), 실제 동작은 수동 |
| 모델 목록 조회 | `chat/models`는 별칭마다 `claude -p /cost`(로컬 명령, 모델 호출 없음)를 인자 배열로 실행하고 cwd는 임시 폴더입니다. `chat/model-catalog`는 CLI 캐시 파일 `~/.claude/cache/model-catalog/*-cc.json`에서 모델 ID(정규식 검증)·이름·계열·컨텍스트 창만 읽어 최대 64개를 돌려주며 그 밖의 필드와 로그인 정보는 읽지 않습니다. | `chat-claude.test.mjs`(probe), 캐시 파싱은 수동 |
| 번들 글꼴 | Inter·Noto Sans KR·JetBrains Mono(SIL OFL 1.1)를 npm 패키지에서 빌드에 포함하며 외부 CDN을 쓰지 않습니다. 라이선스 전문은 빌드 결과 `licenses/`에 함께 배포합니다(pnpm `minimumReleaseAge` 7일 준수 버전). | 수동 |
| `@` 파일 목록(`files/list`)이 프로젝트 밖 경로를 드러냄 | 열린 프로젝트 루트 검사(`workspace.resolve`)를 거친 cwd에서 서버가 `git ls-files -co --exclude-standard`를 argv 배열로 실행하고 이름만 돌려줍니다(최대 5만 개, 시간 제한 10초, 출력 32 MiB, 파일 내용은 읽지 않음). git 저장소가 아니면 빈 목록입니다. 이 API는 앞서 제거한 `files/read`·`files/save`·`files/search`와 다른 새 경로입니다. | 코드 검토 (`index.js` `files/list`) |
| 첨부 이미지 축소본(`previews`)이 기록에 임의 데이터를 넣음 | 서버는 `data:image/jpeg;base64,` 형식에 150,000자 이하이고 이미지 수 안에 드는 것만 받아 `user`·`steer` 이벤트에 저장합니다. 화면은 이것을 `<img src>`로만 쓰며 앱 CSP는 `img-src 'self' data:`입니다. | 코드 검토 (`index.js` `chat/send`) |
| 설정 값 주입 | 채팅 상태줄의 색·아이콘·형식은 `ui-state.js`에서 형식 검증하고 외부 명령은 실행하지 않습니다. | `ui-state-chat.test.mjs` |

## 4-3. 피드백 요청 (2026-11)

화면 캡쳐와 글을 개발자에게 보내는 기능입니다. 구조는 [ARCHITECTURE](ARCHITECTURE.md#피드백-요청), 플러그인 쪽 계약은 [PLUGINS](PLUGINS.md#피드백-feedback)에 있습니다.

| 위협 | 대응 | 검증 |
|---|---|---|
| 렌더러(XSS)나 다른 창이 `ade:capture`로 화면을 찍어 감 | main의 `ade:capture` 처리기는 요청한 webContents가 **메인 창**이고 요청한 프레임 URL이 앱과 같은 출처일 때만 응답하며, 아니면 거절합니다. 캡쳐는 그 창의 `capturePage`뿐이라 앱 창 밖(OS 화면)은 찍지 않고, 사각형은 창 크기 안으로 잘라 크기를 검사합니다(`main.js`). | 코드 검토 (`apps/desktop/src/main.js`) |
| 스크린샷·본문에 비밀(터미널 출력, 경로, 토큰)이 섞여 Hub로 나감 | 직접 쓴 피드백은 사용자가 이미지를 보고 제출을 눌러야 합니다. `ai`·`agent` 초안은 `reviewed`가 아니면 서버가 제출을 거절하고(`FEEDBACK_UNREVIEWED`) 화면에서 항목을 열면 검토로 표시됩니다. 앱 창만 캡쳐하므로 다른 프로그램 화면은 들어가지 않지만, 앱 창 안의 터미널 출력은 들어갑니다. 제출 전에 이미지를 직접 확인해야 하는 위험은 남습니다. | 코드 검토 (`index.js` `feedbackSubmit`, `FeedbackPanel.tsx`), `feedback.test.mjs` |
| 로그인 없이 보내는 제출(익명 경로)이 사용자를 식별하거나 남용됨 | 서버가 Hub `POST /v1/feedback/anonymous`로 직접 보냅니다. 기기 식별자는 설치마다 임의로 만든 id(`feedback/device.json`, 0600)뿐이며(피드백 내용과 함께 앱 버전·플랫폼 이름이 같이 갑니다, `index.js`의 `metaOf`), 이 기기에서 5분에 1건만 보냅니다(마지막 전송 시각은 `queue.json`). `ADE_FEEDBACK_ANONYMOUS=0`이면 끄고, Hub 주소는 `ADE_HUB_URL`로 바꿀 수 있습니다. Hub 쪽 검증은 이 저장소 밖입니다. | `feedback.test.mjs` (전송 큐·익명 경로) |
| 전송 큐 재전송으로 같은 피드백이 여러 이슈로 올라감 | 피드백 id가 Hub의 중복 방지 키(`clientKey`)라 다시 보내도 이슈는 하나입니다. | `feedback.test.mjs` |
| 피드백 스크린샷 URL로 다른 파일을 읽음 | `GET /feedback-file/<id>/<name>`은 API와 같은 **세션 쿠키**가 없으면 401입니다. id는 `^[a-z0-9]{6,16}-[a-f0-9]{12}$`, 이름은 `img-<n>.png|jpg`(원본은 `.orig.`)만 받아 피드백 폴더 밖 경로로 풀리지 않습니다(`feedback-store.js`의 `folder`·`filePath`). | 코드 검토 (`index.js`, `feedback-store.js`) |
| 에이전트가 MCP 도구 `ade_feedback_draft`로 피드백을 몰래 제출하거나 임의 파일을 가져감 | 이 도구는 `incoming/`에 초안 파일만 쓰고 네트워크를 쓰지 않습니다. 서버가 이것을 `agent` 초안으로 가져오지만 사람이 열어 검토(`reviewed`)하기 전에는 제출할 수 없습니다. 첨부는 절대 경로의 PNG/JPEG만(시그니처 검사, 장당 크기·장수 상한) 복사해 초안 이미지로 보이므로 사람이 보고 지웁니다. 설정 `feedbackAgentTool`을 끄면 에이전트에 이 MCP 서버를 주지 않습니다(`index.js` `applyMcpServers`). 에이전트가 사용자 몰래 임의 이미지 파일을 초안에 붙일 수 있다는 점은 사람의 검토에 의존합니다. | 코드 검토 (`feedback-mcp.js`, `index.js`), `feedback.test.mjs` |
| "AI로 정리"가 사용자의 MCP·설정을 끌어다 실행함 | `feedback-agent.js`는 피드백 폴더에서 `claude -p`를 Read 도구만 허용해 실행합니다(쓰기·셸 불가). 켜 둔 설정 "AI 정리에 화면 정보 포함"이면 앱 버전, 열린 pane 종류, 프로젝트 이름, 최근 오류 메시지 5개가 이 요청에 함께 들어갑니다(Anthropic CLI를 거쳐 모델로 감). | 코드 검토 (`feedback-agent.js`, `Workspace.tsx` `feedbackContext`), `feedback.test.mjs` |

## 4-4. 채팅 인터랙티브 UI (2026-11)

모델이 쓴 HTML/JS(` ```ade-ui `)를 채팅 안에서 실행하는 기능입니다. 설정 "인터랙티브 UI"(기본 켜짐)를 끄면 일반 코드 블록으로 보입니다.

| 위협 | 대응 | 검증 |
|---|---|---|
| 모델 출력 스크립트가 앱의 쿠키·저장소·DOM·API에 접근 | `UiFrame.tsx`의 iframe은 `sandbox="allow-scripts"`(`allow-same-origin` 없음)라 origin이 없고, 앱 문서와 분리됩니다. 페이지(`/ade-ui-frame.html`)는 전용 CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src/font-src/media-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts`를 붙여 네트워크·중첩 프레임·폼 제출을 막습니다. 이 경로는 세션 쿠키 없이 응답하지만 비밀이 없는 고정 페이지입니다(`ui-frame.js`). 앱 문서 쪽 CSP는 `frame-src 'self'`입니다. | 코드 검토 (`ui-frame.js`, `UiFrame.tsx`, `index.js`), `ui-frame-protocol.test.mjs`(메시지 검증) |
| 프레임이 앱에 위조 메시지를 보냄 | 앱은 `event.source`가 그 블록의 iframe인 메시지만 보고, `parseFrameMessage`가 `ade:1`, 종류(`ready`·`height`·`send`·`prefill`), 텍스트(널 제거, 4,000자 상한), 높이(40–560px)를 검증합니다. | `ui-frame-protocol.test.mjs` |
| 모델이 쓴 UI가 사용자 몰래 채팅 메시지를 계속 보냄(`ade.send`) | `ade.send`는 프레임 안 스크립트가 사용자 활성화(`navigator.userActivation`)를 요구하지만, 이 검사는 모델이 쓴 코드와 같은 프레임 안에 있어 우회할 수 있습니다(코드 주석이 인정). 앱 쪽 보호는 블록마다 1.5초에 한 번 제한과 4,000자 상한뿐이며, 보낸 글은 사용자 메시지로 들어가거나(에이전트 작업 중이면 follow-up 대기열) 입력창에만 채워집니다(`prefill`). 남은 위험으로 둡니다. | 코드 검토 (`ui-frame.js`, `ui-frame-protocol.ts`의 `sendGate`, `ChatPane.tsx`) |
| 네이티브 `ui` 블록(JSON)이 코드 실행·마크업 삽입으로 번짐 | 위치 기반 JSON을 `ui-spec.ts`가 검증해 React 요소로만 그리고 모델 코드는 실행하지 않습니다. | `ui-spec.test.mjs` |
| 에이전트 지침이 사용자 설정과 어긋남 | 지침(`chat-ui-prompt.js`)은 채팅의 첫 메시지 때 설정값으로 한 번 정해 `meta`에 저장하며, 시스템 프롬프트 파일(`ade-ui-prompt.md`, 0600)이나 `developerInstructions`로만 전달합니다. | 코드 검토 (`chat.js`, `index.js`) |

## 5. 실행하지 않은 검증

- 원격 노출 시나리오(설계상 127.0.0.1 전용이라 대상이 아님)
- 4-3·4-4(피드백 요청, 인터랙티브 UI 프레임)와 `ade:capture`는 코드를 읽고 정리했을 뿐 앱에서 직접 실행해 확인하지 않았다. 샌드박스가 실제로 쿠키·네트워크를 막는지, 다른 출처의 프레임이 `ade:capture`를 거절하는지는 수동 확인이 필요하다([TESTING_GUIDE](TESTING_GUIDE.md)).

## 6. 현재 회귀 검증과 의존성

실행 환경·결과는 [VERIFICATION](VERIFICATION.md)에 모은다. 과거 테스트 수나 ADE/IDE 화면의 통과 기록을 현재 상태로 사용하지 않는다.

- 파일 감시 생성 실패와 실행 중 오류를 처리한다. 오류 후 감시기·타이머·수집 경로를 정리하며 서버는 계속 동작한다. 현재 프로젝트의 Git 폴링은 유지한다. 개발 모드 감시 오류도 프로세스를 종료하지 않고 수동 재시작을 안내한다.
- 앱의 `git/commit`·`git/stage`·`git/discard`·`files/read`·`files/save`·`files/search` API는 404를 반환한다(회귀 테스트가 확인하는 목록). 채팅 `@` 언급용 `files/list`(파일 이름만)는 새로 생겼으며 4-2에 있다. 터미널에서 직접 커밋하는 기능은 사용자 셸에 속한다.
- `atom-material-icons@3.0.0`은 공개된 JSON/SVG만 사용한다. 사용하지 않는 YAML 빌드 도구 `js-yaml`은 pnpm override로 설치에서 제외해 `argparse`·`sprintf-js` 의존 경로를 제거했다. 경고를 숨기거나 취약 버전을 허용한 것은 아니다. 아이콘 패키지의 CLI/생성 도구를 사용하게 되면 이 override를 다시 검토해야 한다.

터미널에 붙여넣은 이미지가 임시 폴더(`mooner-ade-paste`)에, 에이전트 세션 정보가 앱 데이터 폴더에 남는다. 로컬 데이터와 로그를 공개 저장소나 이슈에 첨부하기 전에 확인한다. 이 앱은 단일 사용자 로컬 전용이며 멀티 사용자 호스팅을 지원하지 않는다.
