# ADE 아키텍처

무너에이드는 macOS·Windows용 Electron 데스크톱 앱입니다. 별도 웹 배포판은 없으며, 웹 UI는 앱 창 안에서만 동작합니다.

## 구성

- `apps/desktop`: Electron 메인 프로세스와 격리된 렌더러, 폴더 선택 preload. 시스템 Node(패키지 앱은 번들한 Node)로 로컬 서버를 실행하고, 종료 시 IPC로 정리를 요청합니다. `pnpm dev`에서만 별도 PTY 호스트가 서버 재시작 사이의 터미널을 유지합니다.
- `apps/web`: 앱 창에 표시하는 React UI. 터미널 탭·분할과 읽기 전용 Git Diff가 중심입니다. 하나의 WebSocket으로 여러 프로젝트를 구독하며 메시지의 `projectId`로 분배합니다. 파일 편집·검색·커밋 UI는 없습니다.
- `apps/local-server`: 루프백 인증, 프로젝트 잠금, Git 상태·Diff·브랜치·저장소 worktree API, PTY와 터미널 세션 복구, 사용량·WakaTime 연동. `runtime.js`가 프로젝트 루트로 제한한 경로 검사, argv 기반 프로세스 실행, Git, PTY 포트를 제공합니다. 앱에서 커밋하는 API는 없습니다.

## 에이전트

Claude Code·Codex는 터미널에서 공식 CLI로 실행합니다. 권한·승인은 CLI 자체 화면을 따르며, 서버는 CLI가 보내는 OSC 7501 상태 보고와 프로세스 트리로 작업 상태·SSH 여부·세션 ID를 추적합니다. 서버가 직접 모델을 호출하는 경로는 없습니다. 준비 상태 확인만 `claude auth status`와 `codex app-server`의 계정 조회를 사용합니다.

## 인증과 연결

서버는 `127.0.0.1`의 임의 포트에 바인딩하고, 실행할 때마다 새 접속 토큰을 만들어 stdout으로 앱에 알립니다. 토큰은 디스크에 저장하지 않습니다. 앱 창은 URL 해시의 토큰을 HttpOnly·SameSite=Strict 세션 쿠키로 교환한 뒤 주소에서 지웁니다. API는 동일 출처 JSON POST만, WebSocket은 Host·Origin·쿠키가 맞는 요청만 받습니다.

## 로컬 경계

경로 검사는 traversal·symlink를 막지만 악성 프로세스에 대한 OS sandbox가 아닙니다. PTY는 사용자 셸과 같은 권한입니다. 로컬 서버가 실행하는 Git은 저장소의 fsmonitor와 hooks를 끄며, 터미널에서 실행한 Git에는 적용하지 않습니다.

파일 감시는 최적화입니다. 생성 실패나 실행 중 오류가 나면 감시기를 닫고 Git 폴링을 유지합니다. 폴링은 현재 표시 중인 프로젝트에만 적용되며 전환 시 즉시 확인합니다.

검증 상태는 [VERIFICATION](VERIFICATION.md), 보안 검토는 [SECURITY_REVIEW](SECURITY_REVIEW.md)를 참고하세요.
