# 테스트 실행 안내

현재 결과는 [VERIFICATION](VERIFICATION.md)에서 확인하세요. 모든 명령은 저장소 루트에서 실행합니다.

## 설치와 자동 검사

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm check
pnpm web:build
pnpm smoke
pnpm audit
```

`check`는 import 검사·패키지 타입 계약·Node 테스트입니다. 웹 타입 검사는 `typecheck` 또는 `web:build`로 별도 실행합니다. `pnpm build`는 웹을 빌드하지 않습니다. 테스트는 임시 저장소·데이터 폴더·가짜 제공자 transport를 사용하며 실제 모델을 호출하지 않습니다. 로컬 서버 테스트에는 실제 Git·PTY·TypeScript 언어 서버 호출이 포함됩니다.

파일 감시 오류를 집중 확인하려면 `node --test tests/project-watch.test.mjs`를 실행합니다. 생성 실패, 비동기 EMFILE, 경로 배치 상한, 정상 종료 후 지연 이벤트 차단을 검증합니다. 커밋 제거 회귀 테스트는 `tests/local-server.test.mjs`에서 삭제한 API가 404를 반환하고 HEAD·index를 유지하는지 확인합니다.

## 브라우저 E2E

```sh
pnpm web:build
pnpm e2e
# Chrome을 찾지 못하면:
CHROME_PATH=/path/to/chrome pnpm e2e
```

E2E는 임시 홈·프로젝트·앱 데이터·Chrome 프로필을 만들고 종료 시 정리합니다. 모델 호출 없이 접속 인증, 토큰 URL 제거, 프로젝트 열기, 실제 PTY의 입력과 파일 쓰기, Git Diff 렌더링, 탭 추가·새로고침 복원을 확인합니다. 같은 격리 Chrome에서 사이드바 네이티브 드래그 테스트도 실행합니다. 브라우저 예외·console.error가 있으면 실패합니다.

`pnpm check`에서 사이드바 브라우저 테스트가 건너뛰어지는 것은 `ADE_TEST_CDP`가 없기 때문입니다. `pnpm e2e`가 Chrome을 시작하고 해당 테스트에 주소를 전달합니다. E2E가 없어진 ADE/IDE 전환이나 SDK 대화 UI를 검증한다고 해석하지 마세요.

## 실제 모델 호출 — 사용량 발생

공식 Codex/Claude CLI를 설치하고 `codex login`, `claude auth login`을 완료한 머신에서만 실행합니다.

```sh
ADE_LIVE_TEST=1 pnpm test:live
```

서버용 에이전트 transport의 실제 실행·승인·thread resume·full-access를 점검합니다. 이 검증은 UI의 터미널 CLI 흐름과 별개입니다. opt-in 없이 스크립트는 모델을 호출하지 않습니다. full-access는 CLI 보호를 생략하므로 격리된 임시 작업에서만 확인하세요.

## 수동 수용 검사

- macOS/Windows/Linux에서 첫 설치, PTY, 경로, 창 종료와 단축키 확인
- 실제 Claude/Codex CLI의 질문·승인·완료, SSH/tmux, follow-up 대기·취소·재연결 확인
- 2 × 3 pane 각각의 입력·크기 변경, 여러 프로젝트에서 실행 유지 확인
- worktree 병렬 작업, dirty 제거 거절, fast-forward 통합 확인
- 서버 종료 후 interrupted 기록·만료 승인, 재사용 토큰과 레이아웃 복구 확인
- 큰 저장소·오랜 이벤트 이력·감시 자원 고갈 시 응답성과 폴링 확인

이 항목들은 단위 테스트 통과만으로 완료 처리하지 않습니다.
