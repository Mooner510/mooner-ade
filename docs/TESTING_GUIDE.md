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
- 캐시 타이머(`node --test tests/claude-cache.test.mjs`로 transcript 해석부터 확인): 로컬 Claude Code에서 한 번 요청하면 3초 안에 그 Claude pane 헤더 왼쪽에 🔥 `59:5x`(TTL은 transcript의 `promptCacheRequested` 값, 현재 구독 계정은 1시간)가 뜨는지, 남은 시간이 20% 아래로 내려가면 아이콘 없이 노란 시간만, 만료되면 글자 없이 파란 ❄️ 눈꽃 아이콘만 남는지(툴팁에는 식었다는 설명이 그대로), Claude가 작업 중일 때는 시간 대신 🔥 `캐시 사용중`이 뜨고 작업이 끝나면 다시 시간으로 돌아오는지, 툴팁의 마지막 요청 시각이 실제 요청 시작과 맞는지 확인. 자동 compact(idle compaction)가 켜진 환경(기본값, `autoCompactEnabled`·`idleCompaction`이 꺼져 있지 않고 `DISABLE_AUTO_COMPACT` 없음)에서 컨텍스트가 20만 토큰 이상인 1시간 캐시 대화는 카운트다운이 59분이 아니라 약 54분(`IDLE_LEAD` 0.9)에서 끝나고 툴팁이 "자동 compact" 문구로 바뀌는지, 실제로 Claude 터미널에 `Compacted while idle, before the prompt cache expired` 안내가 뜨는 시각과 맞는지(다르면 `claude-cache.js`의 `IDLE_LEAD` 조정), `/config`나 settings에서 끄면 다음 요청부터 다시 약 60분으로 돌아가는지 확인. 20만 토큰 미만이거나 5분 TTL이면 기존과 같아야 합니다. compact가 끝나면(수동 `/compact`, 컨텍스트가 차서 일어나는 자동 compact, idle compaction 모두) 3초 안에 타이머가 보라색 보관함 아이콘으로 바뀌고 툴팁에 compact 시각·수동/자동·토큰 변화(`223K → 19K`)가 뜨는지, 그 뒤 다음 메시지를 보내면 새 카운트다운으로 돌아오는지 확인. idle compaction이 실제로 일어났을 때 툴팁이 '자동'으로 나오는지도 확인(transcript의 `compactMetadata.trigger` 값이 `auto`가 아니면 알려주세요). Claude pane을 여러 개 띄우면 각 pane 헤더에 자기 대화 기준 타이머가 따로 뜨고, `/clear` 직후·Claude 종료·SSH 안의 Claude에서는 타이머가 사라져야 합니다. 사이드바에서는 지금 보고 있지 않은 탭(분할 탭은 각 pane 줄)의 오른쪽 끝에만 같은 타이머가 작게 뜨고, 그 탭을 선택하면 사이드바에서 사라지는지, 알림 점·닫기 버튼과 겹치지 않는지 확인.
- 설정 > **AI 툴** 분류(알림·사용량·캐시 타이머가 이곳으로 모임, 검증은 `node --test tests/ai-settings.test.mjs`). 상단 탭이 `공용`(알림 종류·소리·보고 있는 터미널·사용량 색상·갱신 주기) / `Claude Code` / `Codex` / `Cursor CLI`(런처 표시·실행 인자·알림, Claude는 사용량·5시간 한도·캐시 타이머·Follow-up, Codex는 사용량)로 나뉘는지, 숨긴 에이전트 탭에 `숨김` 표시가 뜨는지, 좁은 창에서 탭이 가로 스크롤되는지, 다크·라이트 테마에서 선택 탭이 구분되는지 먼저 확인합니다. ① 에이전트 표시를 끄면 새 탭 ▾ 메뉴·빈 탭/새 pane 런처·명령 팔레트(`새 탭에서 … 실행`)에서 그 에이전트만 사라지고 터미널은 남는지, 다시 켜면 돌아오는지 ② `추가 실행 인자`에 `--model opus` 등을 넣고 새 탭으로 실행하면 입력되는 명령 끝에 그 인자가 붙는지, 앱 재시작·세션 복구(`resume`)에서도 붙는지, 줄바꿈을 붙여넣어도 한 줄로 들어가는지 ③ 에이전트별 알림을 끄면 그 에이전트만 알림·소리가 없고 사이드바 표시는 남는지, `보고 있는 터미널도 알림`을 켜면 포커스한 터미널의 완료도 알리는지 ④ 사용량 표시 스위치가 상태바 배치 편집기의 스위치와 같이 움직이는지, 갱신 주기를 60초로 바꾸면 Network에서 `usage/status` 호출이 그 간격인지 ⑤ 캐시 타이머를 끄면 pane 헤더와 사이드바에서 사라지는지, 경고 시점을 50%로 두면 절반 남았을 때 노랗게 바뀌는지 ⑥ Follow-up 대기열을 끄면 Claude 작업 중 입력창에서 Tab이 대기열에 넣지 않고 Claude로 그대로 전달되는지. 상태바 분류에는 사용량 항목 스위치(배치)만 남고, 알림 분류는 없어졌습니다. 이전 버전에서 저장한 설정은 새 항목이 기본값으로 채워집니다.
- 성능 최적화(타입 검사·문법 검사만 통과, 아래 항목과 `pnpm check`는 아직 실행하지 않음). ① 터미널 출력이 5ms 단위로 묶여 전송됩니다: `yes | head -200000`, 큰 파일 `cat`이 끊기거나 섞이지 않고 끝까지 나오는지, 활성 모니터에서 서버(node) CPU가 이전보다 낮은지, 타이핑 반응이 느려지지 않았는지. 출력 도중 창을 새로고침해도 replay에 중복·누락이 없는지. Claude 작업 중 Tab으로 넣은 follow-up이 작업이 끝난 뒤 한 번만 전송되는지(`tests/local-server.test.mjs`의 follow-up 테스트 포함) ② 상태 파서가 ESC 사이 일반 텍스트를 건너뜁니다: 에이전트의 작업중·질문·완료 표시와 OSC 9;4 진행 표시가 이전과 같은지(`node --test tests/terminal-status.test.mjs`) ③ untracked 파일이 많은 저장소에서 diff 패널의 파일별 `+줄 수`가 맞고, 파일을 고치면 갱신되는지, 2 MiB 넘는 파일·바이너리는 이전처럼 줄 수 없이 나오는지 ④ Claude pane이 출력하는 동안 React DevTools Profiler에서 TerminalPane이 청크마다 다시 렌더되지 않는지 ⑤ 프로젝트를 2개 이상 열고 CPU·메모리 상태바가 활성 프로젝트에 계속 표시되고, 프로젝트를 바꿔도 바로 보이는지.
이 항목들은 단위 테스트 통과만으로 완료 처리하지 않습니다.
