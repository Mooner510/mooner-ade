# 원격 연결 요청·폰 승인·푸시 알림 마무리

- 일시: 2026-11-26 19:34 (KST) · 브랜치/커밋: `master` `d78a47b`(ade#181 머지)
- 이 GUIDE는 이번 세션에서 확인하지 못한 항목만 담습니다. 모두 확인되면 이 폴더를 삭제합니다.

## 목적
QR이나 링크 없이 "다른 PC에 접속"에서 연결을 요청하면, 그 PC나 제어 권한으로 페어링된 폰이 같은 확인 코드를 보고 승인해 연결된다. 앱이 꺼져 있어도 폰에 PC의 알림(연결 요청, 에이전트 완료·응답 필요, 보안)이 FCM으로 오고, 폰 로그인은 코드 입력 없이 끝난다.
코드는 네 저장소 모두 master에 머지됐다: mooner-ade-hub#21, mooner-ade-plugins#27, mooner-webapps#47, mooner-ade#181. Hub는 2026-11-27 02:27(KST)에 배포됐다(이미지 `c434e0d`, 시작 로그에 `push notifications enabled`와 `project=roufin`, `POST /v1/push`가 401). 플러그인은 v0.8.0이 나왔고, 폰 앱과 ADE 릴리스는 아직 하지 않았다.

## 미확인 항목
| 항목 | 못 한 이유·필요한 것(환경·사람) | 확인 절차 | 기대 |
|---|---|---|---|
| 1. 폰 앱·ADE 릴리스 | 사람이 정할 버전, 서명 키 | 폰 앱 → ADE 순서(플러그인은 v0.8.0이 나왔다). 아래 "릴리스" | 앞 단계가 배포된 뒤 다음 단계를 낸다 |
| 2. 실기기 확인 | 실제 폰, 실제 Hub(배포됨), 생체 인증 | mooner-webapps `apps/ade/docs/DEVICE_TEST_CHECKLIST.md`의 "푸시 알림과 연결 요청" | 모든 항목 통과 |

### 릴리스
- **플러그인:** 원격 접속 플러그인 새 버전. 에이전트 푸시 감시는 ADE가 `workspace.quiet`를 알릴 때만 켜진다(옛 ADE에서는 그것만 꺼진다).
- **폰 앱:** `apps/ade/android/app/google-services.json`이 있어야 푸시가 켜진 APK가 나온다. 다른 기기라면 Firebase 콘솔(`roufin` → 프로젝트 설정 → Android 앱)에서 두 앱(`com.roufin.ade`, `com.roufin.ade.dev`)이 든 파일을 다시 받아 그 자리에 둔다. 커밋하지 않는다(gitignore, gitleaks가 API 키로 잡는다). `versionCode`/`versionName`을 올려 서명 빌드한다.
- **ADE:** CLAUDE.md의 릴리스 규칙대로. 연결 요청·원격 창 파일 업로드(올린 파일 `upload-*`가 오래되면 지워지는 것 포함)·푸시는 Hub 계정 기능이라 `changelog.json`과 릴리스 노트에 어떤 형태로도 넣지 않는다.

## 참고
- Hub 배포 확인(2026-11-27): 컨테이너 `mooner-ade-hub.api` 이미지 `c434e0dd…`(Hub master와 같음), 시작 로그에 `push notifications enabled`와 `project=roufin`, `POST /v1/push`가 토큰 없이 401(배포 전에는 404). 아직 로그에서 직접 보지 못한 것은 migration `00007_pkce_push.sql`의 적용이다(서비스가 정상 기동해 `healthy`라 적용됐을 가능성이 높다).
- 이미 확인한 것: Hub `go test ./...`, 플러그인 `pnpm test` 143개, 폰 Kotlin 단위 테스트와 웹 typecheck·lint·test·build, ADE `tests/remote-link.test.mjs`와 `node scripts/verify/t-remote-pc.mjs`(격리 Electron, 대화상자 연결 요청과 터미널 파일 끌어 놓기 포함 16/16). 네 PR의 CI와 머지 뒤 master CI 모두 통과.
- 구조와 프로토콜: `docs/REMOTE_UI.md`("PC에서 PC로"), mooner-ade-plugins `docs/REMOTE_ACCESS.md`("연결 요청", "푸시 알림"), mooner-webapps `apps/ade/docs/PUSH.md`.
