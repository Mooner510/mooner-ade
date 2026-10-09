# 보안 검토 (mooner-ade)

- 검토일: 2026-10-09
- 범위: 로컬 서버(`apps/local-server`), 런타임 어댑터(`packages/runtime-local`), 웹 UI(`apps/web`)
- 방법: 읽기 전용 코드 추적(위협 범주별 체크리스트), 의심 항목은 임시 디렉터리에서 직접 재현한 뒤 수정 및 회귀 테스트 추가
- 위협 모델: 127.0.0.1에 바인딩된 단일 사용자 로컬 도구. 원격 웹 페이지, DNS 리바인딩, 교차 사이트 요청을 주된 외부 위협으로 본다. 인증된 사용자는 PTY 터미널로 이미 셸을 가지므로 파일 API의 root jail은 인증 경계가 아니다.

## 1. 수정한 항목

| 심각도 | 항목 | 위치 | 검증 |
|---|---|---|---|
| Medium | `git/discard`에 `files: ["."]`를 보내면 `ls-files`가 실패하는 경우 프로젝트 루트 전체를 `fs.rm`한다. 추적 파일이 있으면 루트 전체를 `git restore`로 되돌린다. `files/delete`에는 루트 가드가 있었지만 discard에는 없었다. | `apps/local-server/src/index.js` (`git/discard`) | 회귀 테스트 `git: show, stage, discard, branches` 마지막 단언. 가드를 제거하면 실패하고, 복구하면 통과함을 확인했다. |
| Medium | 저장소의 `.git/config`에 있는 `core.fsmonitor`는 `git status`가 실행할 때 임의 명령으로 실행된다. ADE는 프로젝트를 열 때 `git/status`를 자동 호출하므로, 신뢰하지 않은 저장소를 여는 것만으로 명령이 실행될 수 있다. **재현됨**(임시 저장소, git 2.50.1). | `packages/runtime-local/src/index.js` (`GIT_TRUSTED_REPO_CONFIG`) | 회귀 테스트 `git: a repository-configured core.fsmonitor command never runs during status`. 수정을 끄면 실패하고 켜면 통과함을 확인했다. |
| Medium (사용자 동작 필요) | 저장소의 `.git/hooks`(예: `post-checkout`)가 ADE의 브랜치 전환(`git switch`)에서 실행되었다. **재현됨**: 훅 환경변수 없이 `git switch`하면 훅이 실행되고, 적용하면 실행되지 않음을 확인했다(git 2.50.1). | `packages/runtime-local/src/index.js` (`GIT_TRUSTED_REPO_CONFIG`에 `core.hooksPath=/dev/null`) | 회귀 테스트 `git: a repository hook never runs during ADE checkout`. **부작용:** ADE가 실행하는 git(커밋 포함)에서는 사용자의 pre-commit 등 훅도 실행되지 않는다. 사용자의 터미널 git은 그대로다. |

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
- **Full access/승인**: 기본값은 꺼짐이다. 서버는 `=== true`로 엄격히 비교하고 `approvalMode`는 서버가 `interactive`로 고정한다. 승인 오류, 만료, 취소는 모두 deny로 처리된다.
- **클라이언트 XSS**: `dangerouslySetInnerHTML`, `innerHTML`, 마크다운 렌더러가 없다. 에이전트 출력은 React 텍스트 노드로 렌더링된다. CSP는 `script-src 'self'`다.
- **토큰 취급**: `randomBytes(32)`로 생성하고 파일 권한은 0600이다. URL 해시는 클라이언트가 읽은 뒤 `history.replaceState`로 지우고 `Referrer-Policy: no-referrer`를 적용한다. 쿠키는 HttpOnly, SameSite=Strict다.

## 4. 실행하지 않은 검증

- 모델 호출을 포함한 `pnpm test:live` (사용량 발생)
- 원격 노출 시나리오 (설계상 127.0.0.1 전용이라 대상이 아님)
- Claude 권한 우회 여부의 실환경 검증 (모델 호출 필요)

## 5. 실행한 검증 (2026-10-09)

- `pnpm check`: 76/76 통과. 수정 전 74개이며, 새 회귀 테스트 2개(fsmonitor, hooks)를 추가했다. discard 단언은 기존 테스트에 덧붙였다.
- `pnpm e2e`: 통과 (헤드리스 Chrome). 수정 후 한 번 더 실행해 통과를 확인했다.
- `pnpm web:build`: 통과.
