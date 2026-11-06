# 테스트 실행 안내

현재 결과는 [VERIFICATION](VERIFICATION.md)에서 확인하세요. 모든 명령은 저장소 루트에서 실행합니다.

## 설치와 자동 검사

```sh
pnpm install --frozen-lockfile
pnpm check   # 웹 타입 검사 + Node 테스트
pnpm audit
```

`check`는 `pnpm typecheck`(웹 UI 타입 검사)와 `tests/*.test.mjs`를 실행합니다. 테스트는 임시 저장소·데이터 폴더·가짜 Codex app server를 사용하며 모델을 호출하지 않습니다. 로컬 서버 테스트에는 실제 Git·PTY 호출이 포함됩니다. 제거한 API(`files/*`, `git/commit`, SDK 실행 등)가 404를 반환하는지도 확인합니다.

파일 감시 오류를 집중 확인하려면 `node --test tests/project-watch.test.mjs`를 실행합니다. 생성 실패, 비동기 EMFILE, 경로 배치 상한, 정상 종료 후 지연 이벤트 차단을 검증합니다.

## UI E2E

```sh
pnpm e2e
# Chrome을 찾지 못하면:
CHROME_PATH=/path/to/chrome pnpm e2e
```

`e2e`는 웹 UI를 빌드한 뒤 로컬 서버와 격리된 headless Chrome으로 앱 창과 같은 화면을 띄웁니다. 임시 홈·프로젝트·앱 데이터·Chrome 프로필을 만들고 종료 시 정리합니다. 모델 호출 없이 접속 인증, 토큰 URL 제거, 프로젝트 열기, 실제 PTY 입력과 파일 쓰기, 스크롤백 복원, 에이전트 상태 보고, Git Diff 렌더링, 탭 추가·새로고침 복원을 확인합니다. 같은 Chrome에서 사이드바 네이티브 드래그 테스트도 실행합니다. 페이지 예외·console.error가 있으면 실패합니다. Electron 셸(창·메뉴·폴더 선택)은 이 검사의 범위가 아닙니다.

`pnpm check`에서 사이드바 드래그 테스트가 건너뛰어지는 것은 `ADE_TEST_CDP`가 없기 때문입니다. `pnpm e2e`가 Chrome을 시작하고 해당 테스트에 주소를 전달합니다.

## 수동 수용 검사

- macOS·Windows에서 첫 설치, `pnpm package` 결과물 실행, PTY, 경로, 창 종료와 단축키 확인
- 실제 Claude/Codex CLI의 질문·승인·완료, SSH/tmux, follow-up 대기·취소·재연결 확인
- 2 × 3 pane 각각의 입력·크기 변경, 여러 프로젝트에서 실행 유지 확인
- 멀티 저장소 worktree 켜기·끄기, dirty 제거 거절, fast-forward 통합 확인
- 앱 재시작 후 레이아웃·에이전트 세션 복구 확인
- 큰 저장소·감시 자원 고갈 시 응답성과 폴링 확인
- 캐시 타이머(`node --test tests/claude-cache.test.mjs`로 transcript 해석부터 확인): 로컬 Claude Code에서 한 번 요청하면 3초 안에 그 Claude pane 헤더 왼쪽에 🔥 `59:5x`(TTL은 transcript의 `promptCacheRequested` 값, 현재 구독 계정은 1시간)가 뜨는지, 남은 시간이 20% 아래로 내려가면 아이콘 없이 노란 시간만, 만료되면 파란 `식음` 한 단어로 바뀌는지, Claude가 작업 중일 때는 시간 대신 🔥 `캐시 사용중`이 뜨고 작업이 끝나면 다시 시간으로 돌아오는지, 툴팁의 마지막 요청 시각이 실제 요청 시작과 맞는지 확인. Claude pane을 여러 개 띄우면 각 pane 헤더에 자기 대화 기준 타이머가 따로 뜨고, `/clear` 직후·Claude 종료·SSH 안의 Claude에서는 타이머가 사라져야 합니다. 사이드바에서는 지금 보고 있지 않은 탭(분할 탭은 각 pane 줄)의 오른쪽 끝에만 같은 타이머가 작게 뜨고, 그 탭을 선택하면 사이드바에서 사라지는지, 알림 점·닫기 버튼과 겹치지 않는지 확인.
이 항목들은 단위 테스트 통과만으로 완료 처리하지 않습니다.
