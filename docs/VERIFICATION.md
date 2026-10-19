# 검증 상태

기준일: 2026-10-19. 현재 작업 트리 기준이며 미커밋 작업을 포함합니다. 결과를 기록할 때 실행 환경과 범위를 함께 적습니다.

## 현재 실행 결과

환경: macOS Apple Silicon / Node 24.12.0 / pnpm 11.27.1. 프로젝트 요구 Node >=24.21.0보다 낮아 engine 경고가 있었으며, 요구 버전의 실행을 대신하지 않습니다. 파일 감시·프로세스 조회·브라우저가 제한되는 샌드박스와 구분해 전체 Node 검사와 E2E는 일반 로컬 권한으로 실행했습니다.

| 검사 | 범위 | 결과 |
|---|---|---|
| frozen install | lockfile 설치 재현성 | 로컬 의존성 재설치 후 `pnpm install --frozen-lockfile` 통과 |
| `pnpm typecheck` | 패키지 계약·웹 타입 검사 | 통과 |
| `pnpm check` | import·계약 타입·Node 테스트 | 107개 중 106개 통과, 브라우저 전용 1개 건너뜀, 실패 0개 |
| `pnpm web:build` | 웹 타입 검사·Vite 번들 | 통과. Monaco 등의 큰 청크 경고는 남음 |
| `pnpm smoke` | 프레임워크 파일 조회·프로세스 실행 | 통과 |
| `pnpm e2e` | 실제 서버·Chrome·PTY·Diff·탭 복원·사이드바 드래그 | 통과. 별도 사이드바 브라우저 테스트 29개도 통과 |
| `pnpm audit` | lockfile 보안 경고 | 모든 심각도 취약점 0건 |

## 검증 범위

Node 테스트에는 기본 거절 정책, 경로·symlink 제한, argv 실행과 취소·출력 상한, JSONL 파싱, 가짜 transport의 승인·resume·full-access, 이벤트 식별자·버전, JSONL 기록·손상 꼬리 복구, 서버 인증·Origin, 파일 충돌, Git 보안 회귀, 실제 PTY와 언어 서버가 포함됩니다. 감시 실패와 앱 커밋 API 제거도 회귀 테스트합니다.

브라우저 E2E는 모델을 호출하지 않습니다. 실제 PTY 입력으로 파일을 쓰고 읽기 전용 Diff와 탭 복원을 확인합니다. 서버의 파일 저장 API 테스트와 일반 파일 편집 UI 검증을 혼동하지 마세요. 현재 UI에는 일반 파일 편집 진입점이 없습니다.

## 아직 보증하지 않는 범위

- 프로젝트 요구 버전 Node >=24.21.0에서의 실행과 원격 GitHub CI 결과
- Windows/Linux 네이티브 앱·PTY 및 Safari/Firefox
- 실제 모델 호출과 두 제공자의 실제 승인·resume·full-access
- 실제 CLI의 follow-up과 SSH/tmux 전송, 전체 2 × 3 수용 검사
- 장시간·대용량 이력, 모든 파일 감시 자원 제한 환경, 멀티 사용자 보안
- Git 전체 이력 비밀정보 검사와 설치형 배포 패키지

이전 P1/P2 문서의 테스트 수와 오래된 화면의 수동 통과 기록은 현재 릴리스 증거가 아닙니다. 절차는 [TESTING_GUIDE](TESTING_GUIDE.md)를 따릅니다.
