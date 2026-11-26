# 남은 절차 (2026-11-26)

관리자 셸(admin-shell), 원격 연결 요청·푸시, Hub 플러그인 API 버전 작업 뒤에 사람이 할 일이다. 위에서부터 순서대로 진행한다. 끝난 항목은 지우고, 모두 끝나면 이 파일을 삭제한다.

## 현재 상태

| 저장소 | 상태 |
| --- | --- |
| mooner-ade | #181(원격 연결 요청), #182(플러그인 API v1 외), #183(콘솔 탭, API v2) 머지. 릴리스 안 함(최신 태그 v0.6.3) |
| mooner-ade-plugins | #27, #28, #29 머지. **v0.8.0 릴리스 완료**: server-shell 0.4.0(v1), remote 0.6.0(v1), admin-shell 0.1.0(v2), 데몬 |
| mooner-ade-hub | #21(PKCE, 푸시, 연결 요청) 머지, 배포 안 함. 브랜치 `feat/plugin-api-tracks-web` 푸시만 함(PR 없음) |
| mooner-webapps | #47 머지, 폰 앱 릴리스 안 함 |

## 1. Hub 브랜치 정리 (`feat/plugin-api-tracks-web`)

다른 세션이 Hub 체크아웃에 커밋하지 않고 남긴 변경을 커밋 두 개로 나눠 이 브랜치에 올렸다.

- `feat: 플러그인 카탈로그를 API 버전별로 나누어 내준다`: `GET /v1/plugins?apiVersions=1,2`. 기본값은 v1이라 ADE 0.6.3에는 v2 플러그인(admin-shell)이 보이지 않는다.
- `feat: 기기 연결 화면 문구를 다듬고 기기 코드 입력에 자동 하이픈을 더한다`: `hub.js`를 추가하고 CSP에 `script-src 'self'`를 연다.
  - #21과 충돌한 `confirm.html`은 #21의 `{{if not .Enrollment.Challenge}}` 조건을 살리고 새 입력 칸을 그 안에 넣었다.
  - rebase 뒤 `go test ./...`는 통과했다.

할 일:
1. 내용을 검토한다. `confirm.html`의 `·`는 문구 규칙에 맞는지 확인한다.
2. PR을 만들어 CI를 확인한 뒤 `--merge --delete-branch`로 머지한다.
3. ADE는 마켓 목록과 업데이트 확인에 이미 `?apiVersions=1,2`를 보낸다(`hub-client.js`). 그래서 이 브랜치가 배포되기 전까지는 Hub가 v1 목록만 주고, admin-shell은 zip으로만 설치된다.
4. Hub 로컬 체크아웃은 이 브랜치에 있다. 끝나면 `git switch master && git pull`로 돌아간다.

## 2. Hub 배포 (FCM 키 + migration 00007)

절차는 `docs/tests/261126_1934_원격승인_푸시_마무리/GUIDE.md`의 "1. Hub"를 따른다. 요약은 아래와 같다.

1. 서비스 계정 키를 만든다(`roufin` 프로젝트, 역할은 FCM API Admin 하나).
2. `project secret set mooner-ade-hub/api FCM_SERVICE_ACCOUNT_JSON`
3. `sudo project deploy mooner-ade-hub/api`
4. 확인: 시작 로그에 `push notifications enabled`가 있고, `POST /v1/push`가 401을 돌려준다.

1번 브랜치를 먼저 머지했다면 이 배포에 함께 실린다.

## 3. 폰 앱 릴리스 (mooner-webapps)

1. `google-services.json`을 둔다. 커밋하지 않는다.
2. `versionCode`와 `versionName`을 올린다.
3. 서명 빌드를 한다.

자세한 내용은 위 GUIDE의 "2. 릴리스"를 본다. 플러그인은 이미 v0.8.0에 나와 있으므로 따로 낼 필요가 없다.

## 4. ADE 릴리스

1. 버전을 정한다. 현재는 0.6.3이고 콘솔 탭이라는 새 기능이 있으므로 **0.7.0(minor)을 권장한다**.
2. 노트를 쓴다. `apps/web/src/changelog.json`에 항목을 넣는다. minor이므로 `intro`(새 hue와 tagline)가 필요하다. 그 뒤 master에 머지한다.
   - 넣을 수 있는 것은 플러그인 콘솔 탭(API v2, 플러그인이 여는 명령 실행 탭)과 그 사이의 다른 변경이다. `git log v0.6.3..master`로 확인한다.
   - 넣으면 안 되는 것: 원격 연결 요청, 폰 승인, 푸시, Hub 마켓처럼 Hub 계정이 있어야 쓰는 기능. 관리자 셸 플러그인 자체(비공개 플러그인)도 넣지 않는다.
3. master에 `chore: release x.y.z` 커밋을 올리고 `pnpm release`를 실행한다.

admin-shell(API v2)은 이 릴리스가 나와야 설치된다. 0.6.3은 API v2 플러그인을 거절한다.

## 5. 서버에 관리자 셸 데몬 설치

admin-shell 플러그인이 접속할 `mooner` 계정 데몬이다. 자세한 내용은 mooner-ade-plugins `docs/ADMIN_SHELL.md`에 있다.

1. plugins 릴리스 v0.8.0에서 파일을 받는다.
   - `mooner-admin-shelld-linux-amd64`(서버 아키텍처에 맞게)
   - `mooner-admin-shelld.system.service`
   - `install-admin.sh`
   - `SHA256SUMS`

   받은 뒤 `sha256sum -c --ignore-missing SHA256SUMS`로 확인한다.
2. 서버에서 `sudo bash install-admin.sh`를 실행한다. 데몬은 `127.0.0.1:7423`에서 `mooner` 계정으로 실행된다. 설정은 `/etc/mooner-admin-shell`, 상태는 `/var/lib/mooner-admin-shell`에 둔다.
3. Cloudflare Tunnel에 ai 계정 셸과 **다른 호스트 이름**을 만들어 `http://127.0.0.1:7423`으로 보낸다.
4. ADE에서 관리자 셸 플러그인(`mooner-ade-admin-shell-plugin-api-v2.zip`)을 설치하고 승인한다.
5. 설정에 서버 주소(3번 호스트)와 서버 키를 저장한다. 서버 키는 설치 스크립트가 끝에 출력하는 "서버 공개 키"다. 다시 보려면 `sudo mooner-admin-shelld pubkey --config /etc/mooner-admin-shell`을 실행한다.
6. 설정 화면의 PC 키로 `sudo mooner-admin-shelld keys add <PC 키> <이름>`을 실행한다. 그다음 연결 확인을 누른다.
7. 확인할 것:
   - 새 탭 메뉴에 콘솔 항목이 나온다.
   - 처음 열 때와 15분 쉰 뒤 잠금 확인 창이 뜬다.
   - `whoami`가 `mooner`를 돌려준다.
   - `sudo true`를 실행하면 비밀번호 바가 나오고, 입력하면 종료 코드 0이 나온다.
   - 중지(Ctrl+C)가 동작한다.

## 6. 실기기 확인

2번과 3번이 끝나면 mooner-webapps `apps/ade/docs/DEVICE_TEST_CHECKLIST.md`의 "푸시 알림과 연결 요청" 항목을 확인한다. 확인할 것은 FCM 수신, PKCE 로그인 복귀, 생체 인증 승인이다. 모두 통과하면 `docs/tests/261126_1934_원격승인_푸시_마무리/`를 지운다.
