# 보안 검토 (mooner-ade)

- 최초 검토: 2026-10-09 / 현재 구현 반영: 2026-10-19
- 범위: 로컬 서버(`apps/local-server`), 런타임 어댑터(`packages/runtime-local`), 웹 UI(`apps/web`)
- 범위: 아래 수정 이력과 현재 코드의 보안 경계. 완전한 침투 테스트나 Git 전체 이력 비밀정보 검사는 아니다.
- 위협 모델: 127.0.0.1에 바인딩된 단일 사용자 로컬 도구. 원격 웹 페이지, DNS 리바인딩, 교차 사이트 요청을 주된 외부 위협으로 본다. 인증된 사용자는 PTY 터미널로 이미 셸을 가지므로 파일 API의 root jail은 인증 경계가 아니다.

## 1. 수정한 항목

| 심각도 | 항목 | 위치 | 검증 |
|---|---|---|---|
| Medium | `git/discard`에 `files: ["."]`를 보내면 `ls-files`가 실패하는 경우 프로젝트 루트 전체를 `fs.rm`한다. 추적 파일이 있으면 루트 전체를 `git restore`로 되돌린다. `files/delete`에는 루트 가드가 있었지만 discard에는 없었다. | `apps/local-server/src/index.js` (`git/discard`) | 회귀 테스트 `git: show, stage, discard, branches` 마지막 단언. 가드를 제거하면 실패하고, 복구하면 통과함을 확인했다. |
| Medium | 저장소의 `.git/config`에 있는 `core.fsmonitor`는 `git status`가 실행할 때 임의 명령으로 실행된다. ADE는 프로젝트를 열 때 `git/status`를 자동 호출하므로, 신뢰하지 않은 저장소를 여는 것만으로 명령이 실행될 수 있다. **재현됨**(임시 저장소, git 2.50.1). | `packages/runtime-local/src/index.js` (`GIT_TRUSTED_REPO_CONFIG`) | 회귀 테스트 `git: a repository-configured core.fsmonitor command never runs during status`. 수정을 끄면 실패하고 켜면 통과함을 확인했다. |
| Medium (사용자 동작 필요) | 저장소의 `.git/hooks`(예: `post-checkout`)가 ADE의 브랜치 전환(`git switch`)에서 실행되었다. **재현됨**: 훅 환경변수 없이 `git switch`하면 훅이 실행되고, 적용하면 실행되지 않음을 확인했다(git 2.50.1). | `packages/runtime-local/src/index.js` (`GIT_TRUSTED_REPO_CONFIG`에 `core.hooksPath=/dev/null`) | 회귀 테스트 `git: a repository hook never runs during ADE checkout`. **현재 동작:** 로컬 런타임의 Git에서는 훅을 비활성화한다. 앱의 커밋 API는 제거했다. 독립 프레임워크의 commit 기능과 달리 터미널·에이전트 CLI에서 실행한 Git은 사용자의 훅 설정을 따른다. |

## 2. 수정하지 않은 항목 (권고)

설계 판단이나 추가 재현이 필요한 항목이다.

| 심각도 | 항목 | 위치 | 권고 |
|---|---|---|---|
| Low | 영구 bootstrap 토큰을 서버 기동 때마다 stdout에 출력한다. 터미널 로그가 캡처되면 장기 자격증명이 노출된다. | `apps/local-server/src/index.js` (토큰 로드, 기동 로그) | 토큰 파일 경로만 출력하거나 값을 마스킹한다. |
| Low | 정규식 검색이 동기 실행되며 패턴 길이 500자까지 허용된다(ReDoS). 인증이 필요하며 자기 자신에 대한 서비스 거부 수준이다. | `apps/local-server/src/files.js` (검색) | 검색에 시간 제한을 두거나 비정규식 검색을 기본으로 한다. |
| Low | 루트 밖을 가리키는 untracked 심볼릭 링크가 하나 있으면 `git/status` 전체가 실패한다(가용성). | `apps/local-server/src/index.js` (git status), `packages/runtime-local` `resolve` | 해당 항목만 건너뛰도록 처리한다. |
| Low | 세션 쿠키에 `Secure`가 없다. 세션은 만료나 정리 없이 `sessions` Set에 계속 쌓인다. | `apps/local-server/src/index.js` (인증 쿠키, `sessions`) | 만료 시각을 두고 주기적으로 정리한다. `Secure`는 localhost 전제에서 영향이 작다. |
| Low | 파일 시스템 오류 메시지에 절대 경로가 그대로 포함된다. | `apps/local-server/src/index.js` (오류 응답) | 응답에서 경로를 제거한다. |
| Info | 토큰 비교가 `!==`로 상수 시간이 아니다. 루프백과 256비트 토큰이라 실익은 낮다. | `apps/local-server/src/index.js` (인증) | `crypto.timingSafeEqual`로 바꾼다. |
| Info | LSP 클라이언트 JSON-RPC를 필터 없이 TypeScript 서버에 전달한다. `file://` URI로 루트 밖 파일을 읽을 수 있다. 인증이 필요하고 PTY가 이미 셸을 주므로 추가 권한은 없다. | `apps/local-server/src/index.js`, `lsp.js` | 요청 URI를 프로젝트 루트로 제한한다. |
| Info | `/api/ui` 본문을 인증 전에 파싱하며 최대 64MB까지 허용한다. | `apps/local-server/src/index.js` (본문 파싱) | 인증 이후로 옮기고 상한을 줄인다. |
| 미검증 | Claude `query()`가 로드하는 `.claude/settings.json`의 allow 규칙이 `canUseTool` 승인을 우회하는지 확인하지 못했다. | `apps/local-server/src/agents.js` (Claude 설정 소스) | SDK 설정 로딩 소스를 확인하고, 실제 모델 호출 없이 재현 가능한 범위에서 검증한다. |

## 3. 확인하고 이상 없음으로 판단한 항목

- **Origin/Host/CSRF**: `trusted()`가 Host를 정확히 비교해 DNS 리바인딩을 막는다. POST는 Origin 정확 일치와 `application/json`을 요구한다. WebSocket upgrade도 Host, Origin, 쿠키를 검사한다.
- **경로 탈출/symlink**: `inside()`는 `path.relative` 기반이라 `/root2` 같은 prefix 문제가 없다. 조상 경로의 realpath를 검사한다. 정적 파일은 `webRoot + sep` 접두사를 검사한다. 세션 저장소 id는 정규식으로 검증한다.
- **명령 주입**: `shell: true`를 쓰지 않는다. git 호출은 argv 배열과 `--literal-pathspecs`, `--`를 쓴다. 브랜치 이름은 `-`로 시작하면 거부하고 정규식으로 검증한다.
- **서버 SDK Full access/승인**: 기본값은 꺼짐이다. 서버는 `=== true`로 엄격히 비교하고 `approvalMode`는 서버가 `interactive`로 고정한다. 승인 오류, 만료, 취소는 모두 deny로 처리된다.
- **클라이언트 XSS**: `dangerouslySetInnerHTML`, `innerHTML`, 마크다운 렌더러가 없다. 에이전트 출력은 React 텍스트 노드로 렌더링된다. 일반 실행의 CSP는 `script-src 'self'`다. Vite 개발 모드에는 HMR용 inline script와 localhost WebSocket 예외가 있다. 터미널 CLI의 도구 권한과 서버 SDK의 승인 흐름은 별개다.
- **토큰 취급**: `randomBytes(32)`로 생성하고 파일 권한은 0600이다. URL 해시는 클라이언트가 읽은 뒤 `history.replaceState`로 지우고 `Referrer-Policy: no-referrer`를 적용한다. 쿠키는 HttpOnly, SameSite=Strict다.

## 4. 실행하지 않은 검증

- 모델 호출을 포함한 `pnpm test:live` (사용량 발생)
- 원격 노출 시나리오 (설계상 127.0.0.1 전용이라 대상이 아님)
- Claude 권한 우회 여부의 실환경 검증 (모델 호출 필요)

## 5. 현재 회귀 검증과 의존성

실행 환경·결과는 [VERIFICATION](VERIFICATION.md)에 모은다. 과거 테스트 수나 ADE/IDE 화면의 통과 기록을 현재 상태로 사용하지 않는다.

- 파일 감시 생성 실패와 실행 중 오류를 처리한다. 오류 후 감시기·타이머·수집 경로를 정리하며 서버는 계속 동작한다. 현재 프로젝트의 Git·열린 파일 폴링은 유지한다. 개발 모드 감시 오류도 프로세스를 종료하지 않고 수동 재시작을 안내한다.
- 앱의 `git/commit` API는 404를 반환한다. 요청 전후 HEAD와 index가 바뀌지 않는 회귀 테스트가 있다. 터미널에서 직접 커밋하는 기능은 사용자 셸에 속한다.
- `atom-material-icons@3.0.0`은 공개된 JSON/SVG만 사용한다. 사용하지 않는 YAML 빌드 도구 `js-yaml`은 pnpm override로 설치에서 제외해 `argparse`·`sprintf-js` 의존 경로를 제거했다. 경고를 숨기거나 취약 버전을 허용한 것은 아니다. 아이콘 패키지의 CLI/생성 도구를 사용하게 되면 이 override를 다시 검토해야 한다.

프롬프트·도구 결과·붙여넣은 이미지가 로컬 디스크에 남을 수 있다. 로컬 데이터와 로그·접속 링크를 공개 저장소나 이슈에 첨부하기 전에 확인한다. 멀티 사용자 호스팅은 [PORTING](PORTING.md)의 별도 격리가 필요하다.
