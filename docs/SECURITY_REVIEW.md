# 보안 검토 (mooner-ade)

- 최초 검토: 2026-10-09 / 현재 구현 반영: 2026-10-23 (데스크톱 전용 전환과 미사용 API 제거)
- 범위: 로컬 서버(`apps/local-server`), 런타임 어댑터(`apps/local-server/src/runtime.js`), 웹 UI(`apps/web`)
- 범위: 아래 수정 이력과 현재 코드의 보안 경계. 완전한 침투 테스트나 Git 전체 이력 비밀정보 검사는 아니다.
- 위협 모델: 127.0.0.1에 바인딩된 단일 사용자 로컬 도구. 원격 웹 페이지, DNS 리바인딩, 교차 사이트 요청을 주된 외부 위협으로 본다. 인증된 사용자는 PTY 터미널로 이미 셸을 가지므로 파일 API의 root jail은 인증 경계가 아니다.

## 1. 수정한 항목

| 심각도 | 항목 | 위치 | 검증 |
|---|---|---|---|
| Medium (API 제거됨) | `git/discard`에 `files: ["."]`를 보내면 `ls-files`가 실패하는 경우 프로젝트 루트 전체를 `fs.rm`한다. 추적 파일이 있으면 루트 전체를 `git restore`로 되돌린다. `files/delete`에는 루트 가드가 있었지만 discard에는 없었다. | `apps/local-server/src/index.js` (`git/discard`) | 이후 UI가 쓰지 않는 `git/discard`·`files/*` API 자체를 제거했다. 회귀 테스트 `endpoints of removed features stay gone`이 404를 확인한다. |
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
- **클라이언트 XSS**: `dangerouslySetInnerHTML`, `innerHTML`, 마크다운 렌더러가 없다. 터미널 출력은 xterm이 그린다. 일반 실행의 CSP는 `script-src 'self'`다. Vite 개발 모드에는 HMR용 inline script와 localhost WebSocket 예외가 있다.
- **토큰 취급**: 서버 프로세스마다 `randomBytes(32)`로 생성하며 디스크에 쓰지 않는다. 이전 버전이 남긴 `token` 파일은 기동 시 삭제한다. URL 해시는 클라이언트가 읽은 뒤 `history.replaceState`로 지우고 `Referrer-Policy: no-referrer`를 적용한다. 쿠키는 HttpOnly, SameSite=Strict다.

## 4. 실행하지 않은 검증

- 원격 노출 시나리오 (설계상 127.0.0.1 전용이라 대상이 아님)

## 5. 현재 회귀 검증과 의존성

실행 환경·결과는 [VERIFICATION](VERIFICATION.md)에 모은다. 과거 테스트 수나 ADE/IDE 화면의 통과 기록을 현재 상태로 사용하지 않는다.

- 파일 감시 생성 실패와 실행 중 오류를 처리한다. 오류 후 감시기·타이머·수집 경로를 정리하며 서버는 계속 동작한다. 현재 프로젝트의 Git 폴링은 유지한다. 개발 모드 감시 오류도 프로세스를 종료하지 않고 수동 재시작을 안내한다.
- 앱의 `git/commit`·`git/stage`·`git/discard`·`files/*` API는 404를 반환한다. 터미널에서 직접 커밋하는 기능은 사용자 셸에 속한다.
- `atom-material-icons@3.0.0`은 공개된 JSON/SVG만 사용한다. 사용하지 않는 YAML 빌드 도구 `js-yaml`은 pnpm override로 설치에서 제외해 `argparse`·`sprintf-js` 의존 경로를 제거했다. 경고를 숨기거나 취약 버전을 허용한 것은 아니다. 아이콘 패키지의 CLI/생성 도구를 사용하게 되면 이 override를 다시 검토해야 한다.

터미널에 붙여넣은 이미지가 임시 폴더(`mooner-ade-paste`)에, 에이전트 세션 정보가 앱 데이터 폴더에 남는다. 로컬 데이터와 로그를 공개 저장소나 이슈에 첨부하기 전에 확인한다. 이 앱은 단일 사용자 로컬 전용이며 멀티 사용자 호스팅을 지원하지 않는다.
