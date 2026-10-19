# 환경 변수

기본 실행에는 추가 환경 변수가 필요하지 않습니다. 서버·터미널·에이전트는 실행 사용자의 환경을 상속하며 공식 CLI의 인증을 사용합니다. 자격증명과 `.env` 파일을 커밋하지 마세요.

| 변수 | 기본값 | 용도 |
|---|---|---|
| `ADE_PORT` | 사용 가능한 임의 포트 | 서버는 항상 `127.0.0.1`에 바인딩 |
| `ADE_DATA_DIR` | OS별 앱 데이터 경로 | 프로젝트 상태, 프롬프트·이벤트, worktree, 재사용 접속 토큰 저장 |
| `ADE_NODE` | `node` | Electron이 로컬 서버·PTY 호스트를 실행할 시스템 Node |
| `ADE_DEV` | 꺼짐 | `1`이면 로컬 서버가 Vite를 같은 출처에서 제공. `desktop:dev`가 설정 |
| `ADE_LIVE_TEST` | 꺼짐 | `1`일 때만 `test:live`의 실제 모델 호출 허용 |
| `CHROME_PATH` | OS의 일반 설치 경로 탐색 | E2E용 Chrome/Chromium 실행 파일 |
| `ADE_TEST_CDP` | 없음 | 이미 실행 중인 격리 Chrome의 CDP HTTP 주소. 사이드바 드래그 테스트 전용 |
| `ADE_PTY_ENDPOINT` / `ADE_PTY_TOKEN` | 없음 | 데스크톱 개발 모드의 내부 PTY 호스트 연결·인증. 직접 설정하지 않음 |

macOS의 기본 데이터 경로는 `~/Library/Application Support/mooner-ade`, Linux는 `${XDG_DATA_HOME:-~/.local/share}/mooner-ade`, Windows는 `%LOCALAPPDATA%/mooner-ade`(변수 미설정 시 사용자 홈 아래)입니다. 실제 프로젝트 파일과 CLI 자체 인증 설정은 별도로 관리됩니다.
