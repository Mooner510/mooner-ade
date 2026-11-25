# 폰에서 쓰는 ADE 화면 (Remote UI)

MoonerADE 안드로이드 앱(`mooner-webapps/apps/ade`)은 PC가 이 화면을 제공하면 **데스크톱과 같은 UI**(`apps/web`)를 그대로 띄운다. Chat, 터미널, Git 그래프, 파일 편집, 피드백, 사용량, 설정을 모두 PC에서와 같은 화면과 동작으로 쓴다. 기능을 따로 옮겨 오지 않으므로, ADE에 새 기능이 생기면 다음 접속부터 폰에도 나타난다.

## 흐름

1. **폰 앱**: 로그인하고, PC 목록에서 PC를 고르고, 페어링·생체 인증을 거쳐 Noise 링크를 연다(기존 그대로).
2. **앱이 PC의 `hello.api`에 `ui/manifest`가 있는지 확인한다.** 있으면 `ui/manifest`를 부르고 `RemoteUiActivity`를 연다. 없거나 실패하면(옛 ADE나 옛 플러그인) 앱 자체 화면을 쓴다.
3. **`RemoteUiActivity`가 `https://ade.remote/`를 WebView로 서빙한다.**
   - 요청이 오면 manifest의 경로와 해시를 확인한다.
   - 캐시(앱 내부 저장소, 해시 기준)에 있으면 바로 쓴다.
   - 없으면 `ui/file`로 받아 SHA-256을 검증한 뒤 저장한다. 해시가 다르면 버린다.
   - 피드백 스크린샷(`/feedback-file/...`)은 캐시 없이 매번 받는다.
4. **페이지는 `#remote=<hello base64url>`로 시작한다.**
   - `transport.ts`가 이것과 `AdeRemoteNative`를 보고 원격 모드로 동작한다.
   - 모든 `api()`는 `{k:'call'}`로, `/ws`는 `{k:'connect'|'send'}`로 링크를 탄다.

## 보안

- **페이지가 네트워크에 직접 닿지 않는다.**
  - CSP는 `connect-src 'none'`이다(`REMOTE_PAGE_CSP`, `apps/local-server/src/remote-ui.js`).
  - 모든 요청은 앱을 거쳐 플러그인 허용 목록(`mooner-ade-plugins/remote/lib/dispatch.js`)을 통과해야 한다.
- **`AdeRemoteNative`는 메인 frame에만 주입한다.**
  - 주입 방식은 `addWebMessageListener`이고, 허용 origin은 `https://ade.remote`, 메인 frame만이다.
  - 채팅의 인터랙티브 UI iframe은 sandbox 처리된 opaque origin이고 모델이 쓴 HTML을 실행한다. 이 iframe은 PC 제어에 닿지 못한다.
  - `addJavascriptInterface`는 모든 frame에 주입되므로 쓰지 않는다.
- **페이지에는 계정 토큰, 기기 키, 페어링 정보가 넘어가지 않는다.**
- **보기 전용(view) 폰**
  - 허용 목록이 읽기 action만 허용한다.
  - `chat/open`은 PC에 이미 열린 채팅에만 허용한다(검사 이름 `existing-chat`).
  - UI는 `html[data-remote="view"]`일 때 쓰기 컨트롤을 숨긴다(`mobile.css`). 프로젝트는 `project/open` 대신 `snapshot`으로 읽는다.
- **PC 창 자체를 바꾸는 action은 폰에 열지 않는다.**
  - 대상: `project/close`, `app/state` 쓰기, `ui`(PC 창의 서랍·포커스까지 담은 전체 저장), `dialog/folder`, 플러그인 관리(Electron IPC).
  - 폰에서 프로젝트를 닫으면 폰 목록에서만 빠진다. 열린 프로젝트 목록과 설정은 기기마다 따로 바뀐다.
- **탭 배치는 모든 기기가 하나를 공유한다.**
  - 탭, 분할 pane, 터미널·채팅·편집기 leaf, 탭 이름, 분할 크기가 대상이다.
  - 폰은 탭만 `ui/layout`(control 전용)으로 저장한다. 서버가 `project.state.ui.paneTabs`에 쓰고 구독 중인 모든 기기에 `ui/changed`를 보낸다. 보낸 기기는 `from`(clientId)으로 자기 에코를 건너뛴다.
  - 받은 기기는 `Workspace.tsx`의 `applyLayout`으로 같은 탭을 보여 준다. 이미 같은 탭은 그대로 두고, 자기가 보던 탭과 포커스는 사라지지 않는 한 유지한다. 받은 배치는 서버로 되돌려 보내지 않는다(`fromRemote`).
  - 종료가 확인된 터미널은 늦게 도착한 배치에도 되살리지 않는다(`gone`). 연결이 끊겼다 돌아오면 구독 직후의 `snapshot`에 든 배치로 따라잡는다.
  - 보기 전용 폰은 저장하지 않고 따라가기만 한다. 옛 PC 플러그인(`ui/layout` 없음)에 붙은 폰도 같다.
  - 동시에 두 기기가 0.4초 안에 탭을 바꾸면 나중에 저장한 쪽이 이긴다.

## 화면 배치 (`mobile.ts`, `mobile.css`)

폭이 760px 이하이면 데스크톱 창이라도 같은 배치가 된다.

- **프로젝트 사이드바**: 서랍이 된다. 상단 바의 첫 버튼으로 열고, 탭이나 pane을 고르면 닫힌다.
- **분할 pane**: 탭 하나에 pane 하나씩, 포커스된 pane만 보인다. 기존 zoom을 재사용하고, 서랍에서 pane을 바꾼다.
- **터미널 보조 키 줄**: Esc, Tab, sticky Ctrl, 방향키, ^C 등을 둔다. 길게 누르면 기존 context menu가 열린다(Android의 contextmenu).
- **Git, 파일 트리, 오른쪽 패널**: 작업 영역을 덮는다. 설정, 프로젝트 선택, 폴더 선택은 전체 화면으로 뜬다.
- **폴더 선택**: 폰은 PC의 시스템 대화상자를 볼 수 없다. 그래서 `fs/folders`로 PC 폴더를 페이지 안에서 탐색한다(`remote-folder.tsx`).
- **뒤로 가기 제스처**: 열린 대화상자, 서랍 순으로 닫는다. 닫을 것이 없으면 PC 목록으로 돌아간다.

## 검증

- **단위 테스트**
  - ADE: `tests/remote-ui.test.mjs`
  - 플러그인: `tests/remote-dispatch.test.mjs`, `tests/remote-plugin.test.mjs`
  - 앱: `RemoteUiFilesTest.kt`
- **폰 없이 브라우저로 확인**: 공유 테스트 세션에서 `VERIFY_TAB=<이름> node scripts/verify/t-remote-ui.mjs [control|view] --plugins <mooner-ade-plugins>`를 실행한다.
  - 앱과 플러그인 역할을 대신하며, 실제 허용 목록을 거쳐 이 세션의 서버에 닿는다.
  - 모바일 크기 에뮬레이션은 CDP로 따로 건다.

## PC에서 PC로 (다른 PC에 접속)

같은 계정의 다른 PC에 있는 ADE를 이 PC의 창으로 띄운다. 폰 앱이 하던 클라이언트 역할을 데스크톱 앱(main 프로세스)이 한다. 호스트 쪽(플러그인)은 폰과 같고, Hub만 새 기기 종류 `desktop`을 받는다.

### 쓰는 법

1. 사이드바 아래쪽(또는 프로젝트가 없는 첫 화면)의 **다른 PC에 접속**을 누르고 **로그인**한다. 브라우저에서 코드가 같은지 확인하고 승인한다(Hub 기기 종류 `desktop`, 이 PC만의 새 키).
2. 접속할 PC의 설정 → 플러그인 → 원격 접속에서 **기기 추가**(보기만 또는 제어)를 눌러 나온 `moonerade://pair?…` 링크를 복사해, 이 대화상자에 붙여넣고 **확인** → 두 PC에 보이는 지문이 같은지 비교하고 **연결 요청**을 누른다. 그 PC의 확인 창에서 승인하면 끝난다.
3. 목록에서 **접속**을 누르면 그 PC의 ADE가 새 창에 뜬다. 창 제목은 `<PC 이름> — Remote`이고, **앱 전체에 초록 테두리**가 있어 이 PC의 ADE와 구분된다(모달 뒤 배경에도 같은 테두리가 그려진다). 창은 PC마다 하나이고, 닫아도 이 ADE는 계속 켜져 있다.

### 구조 (`apps/desktop/src`)

- `remote-link.js`: Hub 세션(device code 로그인, 토큰 갱신), 페어링 링크 해석(`PairLink.kt`와 같은 규칙), Noise 링크(`start → hello`, `api`/`ws`, ping 30초, 끊기면 1→30초 백오프로 다시 연결, PC가 의도한 끊김은 최종). `vendor/noise.js`는 플러그인의 `shared/noise.js` 복사본이며 같은 cacophony 벡터를 `tests/noise.test.mjs`가 돌린다.
- `remote-ui-proxy.js`: 폰 앱의 `RemoteUiActivity`와 같다. `ui/manifest`로 목록을 받고 `ui/file`을 해시별로 받아 SHA-256을 확인한 뒤 `userData/remote-ui/<해시>`에 둔다(동시 3개). 해시가 다르면 버린다.
- `remote.js`: 봉인 저장소(`remote.bin`, safeStorage — 대화상자를 처음 쓸 때 한 번 읽는다), `ade-remote://<호스트 해시>/` 프로토콜, PC마다 별도 세션(partition)의 창, 메인 창의 대화상자용 IPC(`ade:remote:*`). 창의 페이지는 인터넷으로 나갈 수 없고(요청은 모두 링크를 거친다) 권한 요청은 모두 거부된다.
- `remote-preload.cjs`: 창에는 `AdeRemoteNative`(`client: 'desktop'`)만 준다. `adeDesktop`을 주지 않는 이유: 폴더 선택·업데이트·플러그인 설정이 이 PC에 작용하기 때문이다. 메인 프레임만 브리지를 쓴다(채팅의 샌드박스 iframe은 못 쓴다).
- `remote-bridge.js`: 페이지 ↔ 앱 메시지(`transport.ts`의 계약).

### 웹 UI

- `transport.ts`가 `AdeRemoteNative.client`로 `html[data-remote-client="phone"|"desktop"]`를 설정한다. 폰 전용(한글 웹폰트 생략)은 `phone`일 때만 적용하고, 데스크톱 창은 PC와 같은 폰트를 쓴다.
- 초록 테두리는 `style.css`(`:root[data-remote-client="desktop"]`)의 고정색 `--remote-green`이다. 테마나 강조색이 바꾸지 못한다. 폰에는 그리지 않는다.
- 호스트 쪽 `remoteApi` 허용 목록이 창 단위 작업(`project/close`, `app/state` 쓰기, `ui`, `dialog/folder`)을 막는 것은 폰과 같다. 폴더 선택은 `remote-folder.tsx`.

### 검증

- 단위: `tests/remote-link.test.mjs`(가짜 Hub와 가짜 상대 PC), `tests/remote-ui-proxy.test.mjs`(실제 `remote-ui.js`가 호스트), `tests/remote-bridge.test.mjs`, `tests/noise.test.mjs`.
- 실제 앱: `node scripts/verify/t-remote-pc.mjs --plugins <mooner-ade-plugins>`. 격리된 Electron(별도 `ADE_USER_DATA_DIR`·`ADE_DATA_DIR`·`HOME`, Chromium mock keychain, 브라우저 없음)이 이 PC, 일회용 ADE 서버와 가짜 Hub가 다른 PC 역할이다. 로그인, 페어링, 창, 초록 테두리(모달 포함), 네트워크 차단, 프로젝트·터미널 열기, 닫기, 연결 해제를 확인한다. `apps/web/dist`가 필요하다(`pnpm --filter @mooner/ade-web build`).

## 폰 종단 테스트 (실제 폰, 지문·실제 Hub 로그인·AI 사용 없이)

USB로 연결한 실제 폰의 debug 앱(`com.roufin.ade.dev`)이 일회용 테스트 ADE에 로그인·페어링하고, `RemoteUiActivity`에 그 ADE의 화면을 띄워 가짜 `claude`와 채팅하는 전체 사슬을 사람 없이 반복해서 돌린다. 사용자의 설치 앱(`com.roufin.ade`), 실제 Hub(`ade-hub.mooner510.kr`), 공용 세션 `tmp/main`, 진짜 AI는 쓰지 않는다.

```text
node scripts/verify/t-phone-e2e.mjs all [--hub <mooner-ade-hub>] [--plugins <mooner-ade-plugins>] [--webapps <mooner-webapps>]
```

`all`은 아래를 차례로 한다. 단계마다 따로도 실행한다(`up`, `link`, `apk`, `login`, `pair`, `open`, `scenarios [이름…]`, `shot <이름>`, `describe [--remote|--any] [--eval <js>]`, `status`, `down`). 오래 걸리는 `all`과 `apk`(첫 빌드)는 백그라운드로 로그 파일에 받아 확인한다.

### 준비물

- 폰 1대(`adb devices`에 하나. 여럿이면 `ANDROID_SERIAL`)와 화면이 켜져 있고 잠금이 풀린 상태. 폰 설정은 바꾸지 않는다.
- `apps/web/dist`: 폰은 PC의 이 빌드를 `ui/manifest`로 받는다(`pnpm --filter @mooner/ade-web build`, 웹을 고친 뒤에는 다시). 개발 서버(Vite)만 쓰면 `ui/manifest`가 `UI_UNAVAILABLE`이라 폰이 옛 화면으로 돌아간다.
- Windows에서는 `scripts/verify/bin/claude.exe`(`powershell.exe -File scripts/verify/bin/build-claude-exe.ps1`), Go, JDK 21(`JAVA_HOME`, 기본 `C:\Program Files\Java\jdk-21`), Android SDK(`ANDROID_HOME`, 기본 `%LOCALAPPDATA%\Android\Sdk`), Chrome.
- 같은 층의 체크아웃: `mooner-ade-hub`, `mooner-ade-plugins`, `mooner-webapps`(`wt/hub-e2e`, `wt/plugins-e2e`, `wt/webapps-e2e` 같은 worktree가 있으면 그쪽을 먼저 찾고, 아니면 `--hub`/`--plugins`/`--webapps`나 `PHONE_E2E_HUB`/`PHONE_E2E_PLUGINS`/`PHONE_E2E_WEBAPPS`). 시험하려는 브랜치를 체크아웃해 둔다.

### 구성

| 조각 | 무엇 | 파일 |
| --- | --- | --- |
| 로컬 Hub | `mooner-ade-hub`를 `go build`해 `DEV_LOGIN=1`(메모리 저장소, 이름만으로 로그인)로 loopback에 띄운다. 깨끗한 환경(OIDC·DB·GitHub 토큰 없음) | `phone-rig.mjs` |
| 중계 | Hub 앞의 TCP 프록시(고정 기본 포트 47213, 바쁘면 빈 포트). 폰(`adb reverse`)과 플러그인이 둘 다 이 주소로 온다. `cut(ms)`로 모든 연결을 끊고 잠시 받지 않는다 | `phone-rig.mjs` |
| 테스트 ADE | `lib.mjs boot`의 서버(`ADE_DEV=1`, `ADE_VERIFY_PLUGINS=1`)가 실제 플러그인 관리자와 플러그인 호스트 프로세스(게이트웨이, Noise 링크 포함)를 돌린다. 확인 창은 하네스 큐에 쌓이고 스크립트가 승인한다. 가짜 `claude` | `t-phone-e2e.mjs` |
| 플러그인 | `mooner-ade-plugins/remote`를 릴리스 zip과 같은 모양으로 꾸린 사본(`// @shared` 대체). `plugin.json`의 `source`만 뺀다(플러그인 업데이트 확인이 GitHub에 가지 않게) | `phone-rig.mjs` |
| 폰 | `adb`(설치, `reverse`, 스크린샷, 입력 키)와 debug 앱의 WebView DevTools(`adb forward`로 `webview_devtools_remote_<pid>`). DOM 읽기·터치 | `phone-adb.mjs`, `phone-steps.mjs` |
| 시나리오 | 아래 6개 | `phone-scenarios.mjs` |

세션 폴더는 `tmp/ade-phone-e2e`(`rig.json`에 포트·PID·폰에 더한 `adb reverse`/`forward`를 적는다). 소유 프로세스(`owner`)가 Hub·중계·ADE 서버를 들고 있고, 제어용 loopback HTTP(`/cut`, `/relay`, `/stop`)가 있다.

### 로그인·페어링을 자동으로 하는 방법

- 로그인: 앱의 설정 → "계정으로 로그인"을 누르면 폰에 8자리 코드가 뜬다. 스크립트가 그 코드를 DOM에서 읽고, Hub의 dev-login 폼(`GET /enroll?code=…`, `POST /enroll/dev-login`, `POST /enroll/decide`)을 일반 HTTP로 눌러 승인한다. 사용자가 브라우저에서 하는 일과 같다.
- PC 쪽: 같은 방식으로 플러그인의 "계정 연결"을 승인하고, 플러그인 켜기·승인·원격 접속 켜기의 확인 창은 하네스 큐에서 승인한다.
- 페어링: 플러그인의 "기기 추가 (제어)"가 만든 링크(`moonerade://pair?…`)를 `adb shell am start -a android.intent.action.VIEW -p com.roufin.ade.dev -d '…'`로 앱에 넘긴다(QR 스캔과 같은 경로, 릴리스 앱이 아닌 debug 앱만 지정). 앱의 "페어링 요청"을 누르고, PC의 승인 창을 승인한다. 앱이 보여 준 PC 키 지문이 플러그인의 것과 같은지 로그에 남긴다.
- PC 열기: 앱의 PC 목록 카드를 눌러 `RemoteUiActivity`가 뜨는 것을 확인한다.
- 지문 확인 생략: debug 빌드이면서 Hub 주소가 로컬 http(127.0.0.1, localhost, 10.0.2.2)일 때만 제어 PC를 열기 전의 화면 잠금 확인을 건너뛴다(`ScreenLockPolicy`, mooner-webapps). 릴리스 빌드와 https Hub를 쓰는 debug 빌드는 그대로 묻는다. debug 빌드의 `network_security_config`는 127.0.0.1 http를 허용한다.

### 시나리오 (`scenarios`)

| 이름 | 확인하는 것 |
| --- | --- |
| `s1-phone-roundtrip` | 폰에서(실제 키 입력 `adb input text`) 친 메시지가 테스트 ADE의 fake claude에 닿고 답이 폰에 나타난다 |
| `s2-live-stream` | fake claude의 답(`e2e-stream <n> [표식]`)이 폰에 한 줄씩 이어서 나타난다(중간 상태를 여럿 본다) |
| `s3-desktop-to-phone` | 우리 헤드리스 Chrome(데스크톱 폭, 자기 프로필, 인터넷 차단)에서 보낸 메시지와 답이 폰에 나타난다 |
| `s4-autoscroll` | 맨 아래에 있는 동안 새 줄이 올 때 폰의 채팅 스크롤이 따라간다(대화가 화면보다 길어져야 인정) |
| `s5-reconnect` | 중계를 9초 끊었다 되살려도 폰이 다시 붙고, 끊긴 동안 PC에서 나온 줄까지 빠짐·중복 없이 따라잡는다 |
| `s6-offline-safety` | rig의 모든 프로세스(소유 프로세스 아래 전부와 Chrome)가 loopback 밖으로 연결하지 않았다 |

스크린샷은 `C:\AI\claude-temp\phone-e2e`(저장소 밖)에, 결과는 세션 폴더의 `results.json`에 남는다.

### 안전장치

- Hub 주소는 모든 곳에 명시한다(`MOONER_REMOTE_HUB_URL`은 중계 주소, 앱은 `-PhubUrl`, `ADE_HUB_URL`은 닫힌 포트). 실제 Hub로는 가지 않는다.
- `scripts/verify/loopback-only.cjs`를 rig의 모든 Node 프로세스(소유 프로세스, ADE 서버, 플러그인 호스트)에 `NODE_OPTIONS --require`로 미리 올린다. 소켓은 loopback으로만 연결할 수 있고, 나머지(예: Claude Code 업데이트 알림이 부르는 npm 레지스트리)는 DNS·TCP 전에 거부하고 `blocked-connections.log`에 남긴다. Hub는 Go 바이너리이며 loopback에만 열고 바깥 설정이 없다. Chrome은 죽은 프록시와 `--host-resolver-rules`로 막는다. `s6`은 `Get-NetTCPConnection`으로 한 번 더 확인한다.
- 프로세스는 기록한 PID와 명령줄이 맞을 때만 끝낸다(이름으로 죽이지 않는다). `down`은 앱을 로그아웃(Hub에서 폰 삭제, 키·페어링 삭제)하고, 이 rig가 더한 `adb reverse`/`forward`만 지운 뒤 owner를 멈춘다. 앱의 SSH 서버·설정과 `com.roufin.ade`는 건드리지 않는다.
- 앱 `singleTask` 때문에 `RemoteUiActivity`가 떠 있을 때 `MainActivity`를 다시 시작하면 PC 화면이 닫힌다. 스크립트는 이미 PC 화면이면 그대로 쓴다.

### 못 하는 것

- 실제 AI 응답과 사용량, 실제 Authentik 로그인(권한 있는 계정 확인), 지문 프롬프트 자체, 사용자의 릴리스 앱 경로, 실제 네트워크 단절(모바일↔Wi-Fi 전환). 중계 끊기는 같은 PC의 TCP 연결을 끊는 것이라 라우팅이 바뀌는 경우는 시험하지 못한다.
- Hub를 재시작하는 시험은 하지 않는다. DEV_LOGIN Hub는 메모리 저장소라 재시작하면 토큰이 모두 사라져 로그아웃 상태가 된다.
- 폰이 USB로 연결되어 화면이 켜져 있는 동안의 동작이다(백그라운드, 절전, 알림은 확인하지 않는다).
