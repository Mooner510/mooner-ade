# mooner-ade (무너에이드)

로컬 PC에서 셸·Claude Code·Codex를 탭과 분할 터미널로 사용하는 개발 도구입니다. 오른쪽 읽기 전용 Diff 패널에서 파일 변경을 확인할 수 있습니다. Electron 데스크톱 앱 또는 로컬 브라우저로 실행합니다.

현재는 **단일 사용자용 알파**입니다. 호스팅 서비스나 다중 사용자 보안 경계를 제공하지 않습니다. 모델 이용에는 사용자의 공식 CLI 설치·로그인과 해당 제공자의 이용 권한이 필요합니다.

## 설치와 실행

Node **24.21.0 이상**, **pnpm 11.27.1**, Git을 준비합니다. 네이티브 모듈인 `node-pty` 설치에 OS 빌드 도구가 필요할 수 있습니다. 설치 스크립트 허용 목록은 `pnpm-workspace.yaml`에 있습니다.

```sh
pnpm install --frozen-lockfile
pnpm desktop
```

브라우저로 실행하려면:

```sh
pnpm web:build
pnpm start
```

서버가 출력한 `http://127.0.0.1:<port>/#token=...` 링크를 엽니다. 이 링크는 로컬 파일과 터미널에 접근할 수 있는 자격증명이므로 공유하지 마세요. Codex/Claude를 사용할 때는 공식 CLI를 별도로 설치하고 로그인합니다.

```sh
codex login
claude auth login
```

`pnpm desktop:dev`는 웹 HMR과 서버 재시작을 지원하며 개발 중 터미널을 별도 PTY 호스트에 유지합니다. Electron 메인 코드와 PTY 호스트 변경은 앱을 직접 재시작해야 반영됩니다. 일반 앱 종료 후에는 기존 셸 프로세스를 복원하지 않습니다.

## 제공하는 기능

- 여러 프로젝트, 탭, 터미널 분할과 2 × 3 프리셋, 화면 배치 저장·복원
- 공식 CLI를 터미널에서 실행하고 질문·승인·완료 상태를 사이드바에 표시
- HEAD 대비 변경 파일·추가/삭제 줄 수·읽기 전용 Monaco Diff
- 알림, 테마, 터미널 글꼴·커서·스크롤백, 상태바 설정
- 명시적으로 선택하는 Git worktree와 fast-forward 통합

현재 UI에는 탐색기·검색·일반 파일 편집·스테이징·커밋 화면과 ADE/IDE 모드 전환이 없습니다. **앱의 커밋 API도 제공하지 않습니다.** 커밋은 터미널이나 에이전트에서 수행합니다. 별도의 재사용 프레임워크에는 파일·Git·에이전트 API가 남아 있습니다.

## 검사

```sh
pnpm typecheck    # 패키지 계약 + 웹 타입 검사
pnpm check        # 패키지 import + 계약 타입 + Node 테스트
pnpm web:build    # 웹 타입 검사 + 실제 웹 번들 생성
pnpm smoke        # 프레임워크 파일 조회 + 자식 프로세스 실행
pnpm e2e          # 빌드된 앱 + 실제 Chrome/PTY, 모델 호출 없음
pnpm audit        # 현재 lockfile 의존성 보안 검사
```

`pnpm check`만으로 웹 빌드와 브라우저 검증이 완료되지는 않습니다. `pnpm build`는 프레임워크 import 검사이며 웹 번들은 `pnpm web:build`로 만듭니다. 실제 모델 검증은 사용량이 발생하는 명시적 opt-in입니다: `ADE_LIVE_TEST=1 pnpm test:live`.

현재 검증 결과와 미검증 범위는 [VERIFICATION](docs/VERIFICATION.md), 실행 절차는 [TESTING_GUIDE](docs/TESTING_GUIDE.md)에 모읍니다. 과거 단계별 테스트 수와 오래된 화면의 통과 기록을 현재 결과로 사용하지 않습니다.

## Claude Code terminal follow-up

새 ADE 터미널에서 **Claude Code 2.1.303 이상**을 실행하면, 작업 중 입력한 텍스트가 하단 추가 입력창에 표시된다. **Tab**은 현재 작업 완료 후 전송할 follow-up으로 예약하고, **Enter**는 바로 Claude에 전달한다. **Shift+Enter**는 줄바꿈이다. 예약은 터미널별로 순서대로 실행하며 목록에서 취소할 수 있다. Codex와 일반 셸의 Tab 동작은 기존대로 유지한다.

자동 전송은 Claude의 OSC 9;4 작업 완료 신호와 빈 입력란을 함께 확인하고, 서버에서 Claude 프로세스와 화면 출력 순번을 다시 검증한다. 질문·승인 화면이나 작성 중인 입력이 있으면 기다린다. 구버전, `terminalProgressBarEnabled`가 꺼진 세션, SSH 세션, 신호가 전달되지 않는 tmux 환경에서는 동작하지 않는다. 기존 터미널에는 새 환경 설정이 적용되지 않으므로 새 터미널을 열어야 한다.

중단(Esc/Ctrl+C)·재연결·제공자 전환·전송 거절 시 예약을 일시정지한다. **재개**해도 확인한 실제 완료 신호가 있어야 자동 전송한다. 예약과 작성 중 입력은 메모리에만 보관하므로 앱 새로고침·종료·pane 재생성 시 사라진다. 텍스트만 지원하며 이미지 첨부는 예약하지 않는다.

## 구조와 문서

`apps/desktop`은 Electron 셸, `apps/web`은 React UI, `apps/local-server`는 루프백 HTTP/WebSocket 서버입니다. `packages/*`에는 core·protocol·local runtime·CLI adapters·session store·recorded runner가 있습니다. core는 호스트 파일 시스템을 직접 import하지 않고 런타임 포트를 사용합니다.

- [로컬 실행·단축키·데이터 복구](docs/LOCAL_IDE.md)
- [아키텍처와 프레임워크 계약](docs/ARCHITECTURE.md)
- [이벤트 계약](docs/P1_EVENT_CONTRACT.md)
- [보안 경계와 알려진 제한](docs/SECURITY_REVIEW.md)
- [환경 변수](ENVIRONMENT_VARIABLES.md)
- [호스팅 환경으로 이식할 때의 경계](docs/PORTING.md)

기여는 `feature/*` → `master` PR과 `.github/workflows/ci.yml`의 재사용 CI를 따릅니다. 로컬 도구이므로 서버 배포 워크플로는 없습니다.

## 라이선스

Copyright (C) 2026 mooner-ade contributors.

이 프로젝트는 **GNU General Public License version 3 only (`GPL-3.0-only`)**로 배포합니다. GPL v3 조건에 따라 사용·수정·재배포할 수 있으며, 어떠한 보증도 제공하지 않습니다. 전문은 [LICENSE](LICENSE)를 참고하세요. 포함하거나 사용하는 외부 라이브러리·아이콘·폰트에는 각 저작권자와 라이선스의 고지가 적용됩니다.
