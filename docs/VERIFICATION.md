# 검증 상태

기준일: 2026-10-23. 데스크톱 전용 전환과 미사용 기능 제거를 반영한 작업 트리 기준이며 미커밋 작업을 포함합니다. 결과를 기록할 때 실행 환경과 범위를 함께 적습니다.

## 현재 실행 결과

환경: macOS Apple Silicon / Node 24.21.0 / pnpm 11.27.1. 파일 감시·프로세스 조회·Chrome 실행이 제한되는 샌드박스와 구분해 E2E는 일반 로컬 권한으로 실행했습니다.

| 검사 | 범위 | 결과 |
|---|---|---|
| frozen install | lockfile 설치 재현성 | `pnpm install --frozen-lockfile` 통과 |
| `pnpm check` | 웹 타입 검사·Node 테스트 | 81개 중 80개 통과, CDP 전용 1개 건너뜀, 실패 0개 |
| `pnpm e2e` | 웹 빌드·실제 서버·Chrome·PTY·에이전트 상태·Diff·탭 복원·사이드바 드래그 | 통과. 사이드바 드래그 테스트 29개도 통과. Monaco 등의 큰 청크 경고는 남음 |
| `pnpm audit` | lockfile 보안 경고 | 개발 전용 `vite@6.4.3`(및 하위 `launch-editor`)에서 high 1·moderate 3·low 1건. 앱 런타임 의존성(`node-pty`, `ws`)에는 없음 |

## 검증 범위

Node 테스트에는 경로·symlink 제한, argv 실행과 시간·출력 상한, 서버 인증·Origin, 프로세스별 접속 토큰, Git 보안 회귀(fsmonitor·hooks), 제거한 API의 404, 레이아웃 저장 검증, 실제 PTY·터미널 세션 복구·follow-up, 가짜 Codex app server의 계정 확인이 포함됩니다. 감시 실패와 사용량·WakaTime 연동도 회귀 테스트합니다.

E2E는 모델을 호출하지 않으며 Electron 셸 대신 headless Chrome으로 같은 웹 UI를 엽니다. 실제 PTY 입력으로 파일을 쓰고 읽기 전용 Diff와 탭 복원을 확인합니다.

## 아직 보증하지 않는 범위

- 원격 GitHub CI 결과
- Electron 셸 자체(창·메뉴·폴더 선택·종료 정리)의 자동 검사, Windows 앱·PTY
- 실제 CLI의 질문·승인, follow-up과 SSH/tmux 전송, 전체 2 × 3 수용 검사
- 장시간 사용, 모든 파일 감시 자원 제한 환경
- Git 전체 이력 비밀정보 검사, `pnpm package` 결과물의 서명·배포

절차는 [TESTING_GUIDE](TESTING_GUIDE.md)를 따릅니다.
