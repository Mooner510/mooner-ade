# 로컬 ADE 사용 안내

무너에이드는 터미널과 에이전트 CLI 중심의 macOS·Windows 데스크톱 앱입니다. 설치·실행 명령은 [README](../README.md), 실제 검증 상태는 [VERIFICATION](VERIFICATION.md)이 기준입니다.

## 실행 환경

Node 24.21.0 이상, pnpm 11.27.1, Git이 필요합니다. `pnpm install --frozen-lockfile` 후 `pnpm start`로 실행합니다. 앱은 실행할 때마다 로컬 서버의 새 접속 토큰을 받아 HttpOnly/SameSite=Strict 쿠키로 교환하며, 토큰은 디스크에 저장하지 않습니다.

`pnpm dev`는 웹 HMR, 서버 자동 재시작과 preload 갱신을 지원합니다. 이때만 별도 PTY 호스트를 사용해 서버 교체 중 터미널을 유지합니다. Electron 메인 코드·PTY 호스트를 바꿨다면 앱을 직접 재시작하세요. 개발 파일 감시 오류가 나면 로그를 확인하고 수동 재시작하세요.

macOS 첫 실행은 `apps/desktop/dist/electron-<version>/MoonerADE.app`을 생성하고 로컬 서명합니다. Windows는 `apps/desktop/dist/electron-<version>-win32-<arch>/MoonerADE.exe`로 런타임을 복사합니다. 원본 Electron은 유지하며 별도 디스크 공간이 필요합니다. 배포용 앱은 `pnpm package`로 만듭니다(설치 프로그램은 생성하지 않습니다).

## 화면과 작업

- 왼쪽 프로젝트 사이드바에서 프로젝트·탭을 선택합니다. Shift+드래그로 분할 pane을 별도 탭으로 떼어낼 수 있습니다. 폴더 아래 ＋ 또는 상단 새 탭 버튼으로 터미널을 추가합니다.
- 빈 상태에서는 사용자 홈 폴더를 엽니다. **프로젝트 열기**에서 경로를 입력하거나, 데스크톱 폴더 선택·GitHub 클론을 사용할 수 있습니다.
- 터미널·Claude Code·Codex 실행을 선택합니다. Claude/Codex CLI는 별도 설치와 로그인이 필요합니다. CLI의 파일 수정·명령 실행 권한은 CLI 자체 설정과 승인 화면을 따릅니다.
- 오른쪽 **변경사항 Diff 패널**에서 HEAD 대비 파일과 읽기 전용 inline diff를 확인합니다. 기본적으로 첫 파일만 펼치며 전체 펼치기·접기·큰 화면 diff를 제공합니다.
- 파일 편집·탐색·검색·스테이징·커밋 화면은 없습니다. 커밋은 터미널이나 에이전트에서 하세요.
- 프로젝트가 Git 저장소가 아니면 바로 아래의 저장소를 탐색합니다. 여러 저장소를 찾으면 Diff 패널에서 Git 대상 저장소를 선택하며 터미널의 루트는 열린 상위 폴더입니다.
- 작업 중·응답 필요·완료 상태는 Claude Code/Codex가 직접 보내는 OSC 7501 상태 보고로 표시합니다. 서버가 지원 질의에 응답하고 마지막 상태를 보관해 창 새로고침·재연결에도 복원합니다. 일반 출력·제목·출력 없는 시간을 작업 상태로 추측하지 않습니다. 상태 보고가 없는 세션의 질문/승인 표시는 화면 문구를 보조적으로 확인합니다. 제공자 권한 검사를 대체하지 않습니다.
- Claude Code는 v2.1.295 이상이 필요합니다. 지원 응답을 받기 전에 시작된 Claude 세션은 CLI를 다시 실행해야 상태 보고가 켜집니다. tmux 안에서는 tmux 자체가 OSC 7501을 지원해야 합니다. 상태 보고를 보내지 않는 구버전·환경에서는 작업 중 표시를 추측해서 켜지 않습니다.

## 단축키

`mod`는 macOS에서 ⌘, 그 외에는 Ctrl입니다. 명령 팔레트(`mod+Shift+P` 또는 F1)에서 명령을 검색할 수 있습니다.

| 키 | 동작 |
|---|---|
| `mod+Alt+O` / `mod+Alt+W` | 프로젝트 열기 / 닫기 |
| `mod+Alt+1…9` | 프로젝트 선택 (9는 마지막) |
| `mod+Alt+]` / `mod+Alt+[` | 다음 / 이전 프로젝트 |
| `mod+Alt+B` | 사이드바 접기/펼치기 |
| `mod+Shift+T` / `Alt+T` | 새 터미널 탭 |
| `mod+Shift+N` | 새 탭에서 CLI 실행 선택 |
| `mod+Shift+W` / `Alt+W` | 탭 / 포커스 pane 닫기 |
| `Alt+]` / `Alt+[` / `Alt+1…9` | 다음 / 이전 / N번째 탭 |
| `mod+Shift+Enter` | pane 최대화 전환 |
| `Alt+방향키` | pane 포커스 이동 |
| `mod+Shift+G` / `mod+,` | Diff 패널 / 설정 |

터미널에 포커스가 있을 때 일반 Ctrl 조합은 셸·CLI로 전달합니다. 분할은 pane의 도구 버튼 또는 명령 팔레트를 사용하세요. 과거 안내의 Ctrl+D 좌우 분할은 현재 터미널 입력 정책과 일치하지 않습니다.

## 데이터와 복구

기본 경로는 [환경 변수](../ENVIRONMENT_VARIABLES.md)에 있습니다. 최근 프로젝트·화면 배치·설정과 터미널별 에이전트 세션 기록이 저장됩니다. 경로나 세션 정보가 들어 있으므로 데이터 폴더를 공유하지 마세요.

열린 프로젝트·공용 설정은 `app-state.json`, 최근 목록은 `recent.json`, 프로젝트별 레이아웃과 저장소 worktree 설정은 `<projectId>/state.json`입니다. 이전 버전이 만든 `<projectId>/runs/`(서버 SDK 실행 기록)는 더 이상 읽지 않으며 필요 없으면 지워도 됩니다.

창 새로고침은 기존 서버의 PTY에 다시 붙고 최근 터미널 출력 256 KiB를 재생합니다. 앱 재시작은 저장된 레이아웃에 새 셸을 열며 예전 셸 프로세스나 명령 실행을 복원하지 않습니다.

ADE의 Claude Code/Codex 실행 메뉴와 터미널에 직접 입력한 `claude`·`codex` 모두 각각의 대화 ID로 복구합니다. bash/zsh/sh/dash/fish/PowerShell에서 사용자 시작 설정을 먼저 읽고 ADE 셸에만 실행 함수를 연결합니다. 프로젝트 데이터의 `terminal-sessions/<terminalId>/`에 Claude의 `SessionStart` 훅 기록 또는 Codex의 터미널별 실행 로그를 보관합니다. Claude의 `/clear`·`/resume`, Codex의 새 대화·복구로 ID가 바뀌면 다음 복구에 반영합니다. ID가 없는 기존 기록은 `claude --resume` / `codex resume` 선택 화면을 엽니다. 최근 대화를 임의로 선택하지 않습니다.

Codex는 다른 터미널과 기록이 섞이지 않도록 이 실행에만 `--no-daemon`과 `log_dir`를 지정합니다. 세션 추적은 Codex 0.163.0의 root session 시작 로그 형식과 Claude 2.1.304의 `SessionStart` 훅을 기준으로 합니다. Codex는 `--no-daemon`을 지원해야 하며, 로그 형식이 바뀌거나 Claude 훅이 비활성화되어 ID를 확인하지 못하면 자동 복구 대신 선택 화면이 필요합니다. 전역 CLI 설정 파일은 변경하지 않습니다.

절대 경로·`command claude`·`env codex` 등으로 함수를 우회하거나, SSH/중첩 셸·tmux에서 실행하면 ID 추적이 보장되지 않습니다. 지원하지 않는 셸도 직접 실행 추적 대상이 아닙니다. 업데이트 전에 이미 열린 셸에는 함수가 없으므로 새 터미널에서 실행하세요.

프로젝트당 터미널 32개, 전체 128개 제한이 있습니다. 파일 감시 실패 시 서버는 계속 동작하며 현재 프로젝트의 Git 상태를 설정한 Diff 새로고침 주기(기본 3초)로 비교합니다. 백그라운드 프로젝트는 다시 선택할 때 갱신합니다.

## Worktree와 안전 범위

공유 경로가 기본입니다. 멀티 저장소 프로젝트에서 저장소별로 worktree를 명시적으로 켤 때만 생성합니다. 원본 통합은 fast-forward만 지원하고, dirty 상태의 제거와 대상 경로의 변경을 거절합니다. 통합 전에 터미널에서 변경을 커밋하세요. 브랜치는 자동 삭제하지 않습니다.

로컬 서버가 실행한 Git은 저장소의 fsmonitor와 hooks를 끕니다. 터미널에서 직접 실행하는 Git과 에이전트 CLI의 Git은 사용자의 환경을 따릅니다. 프로젝트 루트 경로 검사는 터미널과 에이전트를 격리하지 않습니다. [보안 제한](SECURITY_REVIEW.md)을 참고하세요.

Claude follow-up의 버전 조건·중단·재연결 시 동작은 [README](../README.md#claude-code-terminal-follow-up)에 모았습니다.
