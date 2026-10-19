# ADE 아키텍처와 계약

## 애플리케이션

- `apps/desktop`: 격리된 Electron 렌더러와 폴더 선택 preload. 시스템 Node로 서버를 실행하며 종료 시 IPC로 정리를 요청합니다. 개발 모드에서만 별도 PTY 호스트가 서버 재시작 사이의 터미널을 유지합니다.
- `apps/web`: 터미널 탭·분할과 읽기 전용 Diff 중심 React UI. 하나의 WebSocket으로 여러 프로젝트를 구독하며 메시지의 `projectId`로 분배합니다. 현재 일반 편집기·검색·커밋 UI는 없습니다.
- `apps/local-server`: 루프백 인증, 프로젝트 잠금, 파일·Git·PTY·LSP API, 서버 소유 에이전트 실행과 영속화. 앱에서 커밋하는 API는 없습니다.

## 재사용 패키지

| 패키지 | 책임 |
|---|---|
| `ade-core` | 정책 검사, 에이전트 등록·수명주기·취소, 승인 브로커 |
| `ade-protocol` | wire envelope와 버전이 있는 에이전트 이벤트 검증 |
| `ade-runtime-local` | 호스트 파일·argv 프로세스·Git·주입 가능한 PTY 포트 |
| `ade-agent-core` | 크기 제한이 있는 UTF-8 JSONL 파싱·CLI 프로세스 처리 |
| `ade-agent-codex` / `ade-agent-claude` | 비대화형 CLI 이벤트 정규화 |
| `ade-session-store` | 단일 writer용 메타 JSON + append-only JSONL 이벤트 |
| `ade-session-runner` | 이벤트를 저장한 후 소비자에게 전달하고 terminal 상태 반영 |

core는 로컬 파일 시스템·브라우저·컨테이너를 직접 import하지 않습니다. `AllowAllPolicy`는 신뢰하는 로컬 사용자를 위한 선택이며 기본 거절 정책과 구분합니다. 공개 패키지 API는 `0.1.0` 단계입니다.

## 에이전트와 복구

터미널의 CLI 실행과 서버의 SDK 실행은 별개입니다. 터미널에서는 CLI 자체 승인 화면을 사용합니다. 서버의 `CodexAppAgent`와 `ClaudeSdkAgent`는 네이티브 요청을 승인 브로커에 연결하지만 현재 UI에는 SDK 대화 패널이 없습니다. 재사용 JSONL CLI adapters는 브라우저의 대화형 승인을 지원하지 않습니다.

ADE 실행 ID와 제공자 thread ID는 별개입니다. 서버가 이벤트를 소비하므로 브라우저 연결 해제는 실행 종료가 아닙니다. 서버 재시작 후 running 기록은 interrupted로 바뀌며, 저장된 thread ID를 이용한 새 실행은 예전 OS 프로세스 재접속을 뜻하지 않습니다.

## 로컬 경계

`LocalWorkspace`의 기본 범위는 unrestricted입니다. 앱의 root 범위 경로 검사는 traversal·symlink를 방어하지만 악성 프로세스에 대한 OS sandbox가 아닙니다. PTY는 사용자 셸과 동일한 권한입니다. 로컬 서버는 Git fsmonitor와 hooks를 비활성화하며 터미널에서 실행한 Git에는 적용하지 않습니다.

파일 감시는 최적화입니다. 생성 실패·실행 중 오류가 나면 감시기를 닫고 Git/열린 파일 폴링을 유지합니다. 종료 시 지연 알림과 수집한 경로도 정리합니다. 폴링은 현재 표시 중인 프로젝트에 적용되며 전환 시 즉시 확인합니다.

검증은 [VERIFICATION](VERIFICATION.md), 호스팅 경계는 [PORTING](PORTING.md)을 참고하세요.
