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
| `ADE_USER_DATA_DIR` | `~/Library/Application Support/@mooner/ade-desktop` (Windows `%APPDATA%\@mooner\ade-desktop`) | Electron 프로필(단일 실행 잠금·PTY 호스트·플러그인·Chromium 데이터). 패키징 앱 사본을 셸에서 격리 실행할 때 씀. macOS는 업데이트 재시작에도 유지되고, Windows는 재시작하면 기본 프로필로 돌아감 |
| `ADE_UPDATE_URL` | `https://api.github.com` | 업데이트가 릴리스를 조회하는 API 주소. 테스트용 가짜 릴리스(`scripts/verify/t-update.mjs`). 파일 해시·서명 검사는 그대로 |
| `ADE_UPDATE_ANSWER` | 없음 | 업데이트 질문 창에 자동으로 누를 버튼 이름(`\|`로 구분, 예 `지금 업데이트\|확인`). 격리 테스트 전용 |
| `ADE_PLUGINS_DIR` | `<userData>/plugins` | 플러그인 폴더. 개발·테스트용 [플러그인](docs/PLUGINS.md) |
| `ADE_BUILTIN_PLUGINS_DIR` | `apps/desktop/builtin-plugins` | 앱에 들어 있는 [내장 플러그인](docs/PLUGINS.md#내장-플러그인) 폴더. 테스트용 |
| `ADE_PTY_ENDPOINT` / `ADE_PTY_TOKEN` | 없음 | 앱이 서버·PTY 호스트에 넘기는 호스트 연결·인증. 직접 설정하지 않음. 비워서 서버를 실행하면 터미널이 서버 프로세스 안에서 열림(테스트) |
| `ADE_PTY_LINGER_MS` / `ADE_PTY_FIRST_OWNER_MS` | `120000` / `60000` | PTY 호스트가 서버 없이 터미널을 유지하는 시간, 첫 연결을 기다리는 시간. 테스트용 |
| `ADE_PLUGIN_NODE` | 없음 | 플러그인 MCP 서버가 쓸 Node 경로. ADE가 넘김. 직접 설정하지 않음 |
| `ADE_CHAT_ID` / `ADE_PROJECT_ID` / `ADE_CHAT_AGENT` | 없음 | 채팅 전용 내장 플러그인([에이전트 버스](docs/AGENT_BUS.md))이 자기 채팅을 식별하도록 ADE가 넣는 값. 터미널에는 주지 않음. 직접 설정하지 않음 |
| `ADE_HUB_URL` | `https://ade-hub.mooner510.kr` | 로그인 없이 보내는 피드백([피드백 요청](docs/ARCHITECTURE.md#피드백-요청))이 가는 MoonerADE Hub 주소. 서버가 읽습니다 |
| `ADE_FEEDBACK_ANONYMOUS` | 켜짐 | `0`이면 로그인 없는 피드백 제출을 끕니다. 제출 가능한 플러그인 계정이 없으면 피드백 제출을 할 수 없게 됩니다 |
| `ADE_NVIDIA_CHECK` | 켜짐 | Windows에서 시작 후 GPU 프로세스에 NVIDIA RTX HDR 모듈(`nvppex.dll`)이 붙었는지 확인하고, 붙었으면 드라이버 설정으로 끄자고 묻습니다. `0`이면 확인하지 않습니다 |

macOS의 기본 데이터 경로는 `~/Library/Application Support/mooner-ade`, Windows는 `%LOCALAPPDATA%/mooner-ade`(변수 미설정 시 사용자 홈 아래)입니다. 실제 프로젝트 파일과 CLI 자체 인증 설정은 별도로 관리됩니다.

| 변수 | 기본값 | 용도 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 계정 폴더(설정·세션 기록·인증). 채팅 계정(configDir)이 따로 있으면 그것이 우선. 세션 통계·캐시 타이머·사용 한도 조회가 이 폴더를 읽는다 |
| `CODEX_HOME` | `~/.codex` | Codex 계정 폴더(`auth.json`, 세션 기록). 사용 한도 조회와 Codex 채팅이 읽는다 |
| `CLAUDE_CODE_EFFORT_LEVEL` | 없음 | Claude Code의 Effort. 설정 파일의 값보다 우선. 채팅을 시작하기 전 상태 줄 표시에만 쓰이고, 실제 적용은 CLI가 한다 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 없음 | Auto Compact 창 크기. 직접 지정하면 ADE가 게이지에서 정한 auto 창 대신 이 값을 따른다 |
| `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` | `3000` (Chat만) | Claude Chat이 첫 메시지 전에 MCP 서버 연결을 기다리는 최대 시간(ms). 느리거나 응답 없는 MCP 서버(예: 외부 커넥터)가 있어도 첫 응답이 최대 30초 지연되지 않도록 ADE가 3초로 제한한다. 직접 지정하면 그 값을 따른다 |
| `LC_CTYPE` | `C.UTF-8` (Windows, 로케일 변수가 하나도 없을 때만, Chat 에이전트 전체) | 에이전트의 Bash 도구가 쓰는 Git Bash는 로그인 셸이 아니라 로케일이 비어 있어, `ls`가 한글 이름을 `'존'$'\236'…` 같은 바이트로 출력합니다. 인코딩만 UTF-8로 맞추고 메시지 언어(`LANG`, `LC_MESSAGES`)는 바꾸지 않습니다. 사용자가 `LANG`·`LC_ALL`·`LC_CTYPE` 중 하나라도 두면 그대로 둡니다(`withUtf8Ctype`). |
| `CLAUDE_CODE_ARTIFACT` | 없음 | ADE가 Claude 채팅의 Artifact 도구를 켤 때 `1`로 넣는 값입니다. 메시지에 `artifact`·`아티팩트`가 있거나 설정 "Artifact 항상 켜기"가 켜졌을 때 설정되며, 한 번 켠 채팅은 다시 시작해도 유지됩니다. 사용자가 직접 설정하는 변수가 아닙니다. [채팅 기능 정리](CHAT_MODE_FEATURES.md) §7 |
| `DISABLE_AUTO_COMPACT` | 없음 | `1`/`true`이면 자동 압축이 꺼진 것으로 본다. 컨텍스트 게이지의 Auto Compact 창과 캐시 타이머의 "자동 compact" 예정 시각이 사라진다. 실제 동작은 CLI가 정한다 |
| `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` | `200000` (하한 `100000`) | 유휴 자동 압축이 일어나는 최소 컨텍스트 크기. 캐시 타이머가 압축 예정 시각을 계산할 때만 읽는다 |
| `ANTHROPIC_MODEL` | 없음 | 채팅에서 모델을 고르지 않았을 때 모델 목록이 "기본 모델"로 푸는 값. `settings.json`의 `model`보다 우선 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_MODEL` / `_HAIKU_MODEL` | 없음 | `opus`·`sonnet`·`haiku` 별칭이 가리키는 모델 ID. 없으면 CLI 카탈로그를 따른다 |
| `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` | 없음 | `1`/`true`이면 별칭을 해당 공급자의 모델 ID로 푼다 |
| `ANTHROPIC_API_KEY` / `ADE_CODEX_OPENAI_API_KEY` / `CURSOR_API_KEY` | 없음 | 설정 › AI 툴 › 채팅 인증에서 API 키를 고른 에이전트의 **채팅 프로세스에만** ADE가 넣는 값. 직접 설정할 필요는 없다. `ADE_CODEX_OPENAI_API_KEY`는 ADE가 `-c`로 정의한 `ade-openai-key` provider가 읽는다. [채팅 기능 정리](CHAT_MODE_FEATURES.md) §3 |
| `CURSOR_APP_SUPPORT` | OS별 Cursor 앱 데이터 경로 | IDE 로그인 DB(`state.vscdb`) 위치 |
| `CURSOR_ACCESS_TOKEN` / `CURSOR_REFRESH_TOKEN` | 없음 | Cursor 사용량 API용 JWT. 설정 시 Keychain 읽기 생략 |
| `CURSOR_IDE_AUTH` | 꺼짐 | `1`이면 macOS에서 Cursor **앱** 로그인(`state.vscdb` + Safe Storage)을 쓴다. Keychain 확인 창이 뜰 수 있음. 기본은 `cursor-agent login`의 CLI Keychain만 사용 |
| `CURSOR_STORE_CONTEXT` | 켜짐 | `0`이면 Cursor 채팅의 컨텍스트 사용률을 Cursor 세션 저장소(`~/.cursor`)에서 읽지 않는다. [채팅 기능 정리](CHAT_MODE_FEATURES.md) §11 |
