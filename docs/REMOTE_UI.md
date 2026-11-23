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
