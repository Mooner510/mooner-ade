# 환경 변수

기본 실행에는 추가 환경 변수가 필요하지 않습니다. 서버·터미널·에이전트는 실행 사용자의 환경을 상속하며 공식 CLI의 인증을 사용합니다. 자격증명과 `.env` 파일을 커밋하지 마세요.

| 변수 | 기본값 | 용도 |
|---|---|---|
| `ADE_PORT` | 사용 가능한 임의 포트 | 서버는 항상 `127.0.0.1`에 바인딩. |
| `ADE_DATA_DIR` | OS별 앱 데이터 경로 | 열린 프로젝트·레이아웃·설정, 터미널 세션 기록, 저장소 worktree 저장 |
| `ADE_NODE` | `node` | Electron이 로컬 서버·PTY 호스트를 실행할 시스템 Node |
| `ADE_DEV` | 꺼짐 | `1`이면 로컬 서버가 Vite를 같은 출처에서 제공. `pnpm dev`가 설정 |
| `ADE_DEV_TOKEN` | 없음 | `ADE_DEV=1`일 때만 유효한 64자리 16진수. 접속 토큰과 세션 쿠키를 고정해, 서버가 재시작돼도 주소와 로그인이 유지된다. 설정하지 않으면 매번 새 토큰이 발급된다. 서버가 환경에서 지워 터미널에 전달되지 않는다. |
| `CHROME_PATH` | OS의 일반 설치 경로 탐색 | E2E용 Chrome/Chromium 실행 파일 |
| `ADE_TEST_CDP` | 없음 | 이미 실행 중인 격리 Chrome의 CDP HTTP 주소. 사이드바 드래그 테스트 전용 |
| `ADE_PLUGINS_DIR` | `<userData>/plugins` | 플러그인 폴더. 개발·테스트용 [플러그인](docs/PLUGINS.md) |
| `ADE_PTY_ENDPOINT` / `ADE_PTY_TOKEN` | 없음 | 앱이 서버·PTY 호스트에 넘기는 호스트 연결·인증. 직접 설정하지 않음. 비워서 서버를 실행하면 터미널이 서버 프로세스 안에서 열림(테스트) |
| `ADE_PTY_LINGER_MS` / `ADE_PTY_FIRST_OWNER_MS` | `120000` / `60000` | PTY 호스트가 서버 없이 터미널을 유지하는 시간, 첫 연결을 기다리는 시간. 테스트용 |

macOS의 기본 데이터 경로는 `~/Library/Application Support/mooner-ade`, Windows는 `%LOCALAPPDATA%/mooner-ade`(변수 미설정 시 사용자 홈 아래)입니다. 실제 프로젝트 파일과 CLI 자체 인증 설정은 별도로 관리됩니다.

| 변수 | 기본값 | 용도 |
|---|---|---|
| `CURSOR_APP_SUPPORT` | OS별 Cursor 앱 데이터 경로 | IDE 로그인 DB(`state.vscdb`) 위치 |
| `CURSOR_ACCESS_TOKEN` / `CURSOR_REFRESH_TOKEN` | 없음 | Cursor 사용량 API용 JWT. 설정 시 Keychain 읽기 생략 |
| `CURSOR_IDE_AUTH` | 꺼짐 | `1`이면 macOS에서 Cursor **앱** 로그인(`state.vscdb` + Safe Storage)을 쓴다. Keychain 확인 창이 뜰 수 있음. 기본은 `cursor-agent login`의 CLI Keychain만 사용 |
