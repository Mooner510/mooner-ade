# 남은 절차 (2026-11-26)

관리자 셸(admin-shell), 원격 연결 요청·푸시, Hub 플러그인 API 버전 작업 뒤에 사람이 할 일이다. 위에서부터 순서대로 진행한다. 끝난 항목은 지우고, 모두 끝나면 이 파일을 삭제한다.

## 현재 상태 (2026-11-27)

| 저장소 | 상태 |
| --- | --- |
| mooner-ade | #181(원격 연결 요청), #182(플러그인 API v1 외), #183(콘솔 탭, API v2), #184~#187(툴팁, Esc와 백그라운드 서브에이전트, 문서, 업데이트 테스트) 머지. 릴리스 안 함(최신 태그 v0.6.3) |
| mooner-ade-plugins | #27, #28, #29 머지. **v0.8.0 릴리스 완료**: server-shell 0.4.0(v1), remote 0.6.0(v1), admin-shell 0.1.0(v2), 데몬 |
| mooner-ade-hub | #21(PKCE, 푸시, 연결 요청)과 #22(플러그인 카탈로그 API 버전별 제공, 기기 연결 화면)가 master에 머지됨. **배포됨**(2026-11-27 02:27 KST, 이미지 `c434e0d`, 시작 로그에 `push notifications enabled`와 `project=roufin`, `POST /v1/push`가 401) |
| mooner-webapps | #47 머지, 폰 앱 릴리스 안 함(최신 `ade-v0.2.1`, versionCode 3) |

## 1. 폰 앱 릴리스 (mooner-webapps)

1. `google-services.json`을 둔다. 커밋하지 않는다.
2. `versionCode`와 `versionName`을 올린다.
3. 서명 빌드를 한다.

자세한 내용은 위 GUIDE의 "릴리스"를 본다. 플러그인은 이미 v0.8.0에 나와 있으므로 따로 낼 필요가 없다.

## 2. ADE 릴리스

1. 버전을 정한다(사용자가 정한다). 현재는 0.6.3이고, 노트에 쓸 수 있는 새 기능은 업데이트 백그라운드 받기와 트리 파일 끌어 놓기 정도다. minor이면 `intro`(새 hue와 tagline)가 필요하다.
2. 노트를 쓴다. `apps/web/src/changelog.json`에 항목을 넣고 master에 머지한다. `git log v0.6.3..master`로 변경을 확인한다.
   - **넣으면 안 되는 것**: Hub 계정이 있어야 쓰는 기능(원격 연결 요청, 폰 승인, 푸시, Hub 마켓)과 내부·비공개 플러그인에만 쓰이는 기능. 플러그인 콘솔 탭과 플러그인 API v2(콘솔 탭만 더한다)는 관리자 셸 플러그인(비공개)만 쓰므로 넣지 않는다. 이름을 일반 기능처럼 바꿔 써도 같다. 애매하면 뺀다.
3. master에 `chore: release x.y.z` 커밋을 올리고 `pnpm release`를 실행한다.

admin-shell(API v2)은 이 릴리스가 나와야 설치된다. 0.6.3은 API v2 플러그인을 거절한다. 어떤 버전으로 내든 master의 API v2 지원은 함께 나간다.

## 3. 서버에 관리자 셸 데몬 설치

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

## 4. 실기기 확인

폰 앱 릴리스(1번)가 끝나면 mooner-webapps `apps/ade/docs/DEVICE_TEST_CHECKLIST.md`의 "푸시 알림과 연결 요청" 항목을 확인한다. 확인할 것은 FCM 수신, PKCE 로그인 복귀, 생체 인증 승인이다. 모두 통과하면 `docs/tests/261126_1934_원격승인_푸시_마무리/`를 지운다.
