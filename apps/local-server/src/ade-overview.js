// What an AI that writes MoonerADE feedback is told about MoonerADE itself, so a draft names features the way the app does and
// does not ask for something that already exists. Used by "AI로 정리" (feedback-agent.js) and the agents' `ade_feedback_draft` tool
// (feedback-mcp.js). Hand-written and short on purpose: it sits in every agent's tool list. Keep it in step with README.md, CHAT_MODE_FEATURES.md
// and the Settings sections (apps/web/src/Settings.tsx) when a feature is added, renamed or removed.
export const ADE_OVERVIEW = `MoonerADE: Claude Code·Codex·Cursor Agent의 공식 CLI를 한 창에서 쓰는 macOS·Windows 데스크톱 앱. 모델 호출·도구 실행·로그인은 모두 CLI가 하고, ADE는 화면·세션·설정을 맡는다.
- 화면: 왼쪽 사이드바(프로젝트 목록) · 가운데 분할 pane(탭: 터미널·채팅·Diff) · 오른쪽 패널(변경사항 Diff, 피드백 요청) · 아래 상태바(브랜치·변경 수·사용량·시계·CPU·메모리·경로·연결). 명령 팔레트(mod+Shift+P)로 분할·2×3 그리드·pane 최대화. 새 탭 메뉴에서 셸·에이전트 터미널 또는 채팅을 연다.
- 터미널: 자유 분할·크기 조절, 질문·승인·완료 상태 표시, Claude 작업 중 다음 요청 예약(Tab), 프롬프트 캐시 타이머.
- 채팅 탭: 질문 카드·계획 검토·서브에이전트 카드·도구 카드(요약/상세)·이미지 첨부·\`@\` 파일 언급·이전 대화 불러오기(/resume)·응답 중 입력(스티어링·대기열)·중단/재시도·Branch/Rewind·터미널↔채팅 전환. 권한 모드(기본·편집 허용·계획·자동·Bypass, Cursor는 질문 전용)와 모델·Effort는 입력창 아래에서 고르고(Shift+Tab으로 권한 모드 순환), 하단 상태 줄에 진행 상태·모델·권한 모드·컨텍스트·토큰·비용·사용량 기여도·턴·시간·세션 ID를 보인다. 컨텍스트 링·Auto Compact(/compact)·세션 통계(/stats). 슬래시 명령 /resume /retry /clear /model /effort /permissions /cost /stats /status /help /config /exit는 ADE가 처리하고 나머지는 에이전트로 전달. 에이전트는 답변에 차트·상태 카드·입력 폼·미리보기를 그릴 수 있다(인터랙티브 UI).
- Diff: 읽기 전용 변경사항 비교(통합/좌우). 파일 편집·검색·커밋 UI는 없고 커밋은 터미널이나 에이전트에 맡긴다.
- 그 밖: 저장소별 worktree, WakaTime 기록, 자동 업데이트(실행 중 터미널 유지), 플러그인과 내장 에이전트 버스(채팅 에이전트끼리 메시지), 화면 배치 복원.
- 설정(mod+,): 외관·터미널·AI 툴(공용/Claude Code/Codex/Cursor)·채팅·상태바·변경사항·WakaTime·플러그인·피드백·단축키·정보.
- 피드백 요청(mod+Alt+F): 캡쳐(요소·창 전체·범위)나 이미지 붙여넣기에 사각형·화살표 주석을 달고 글로 정리한다. 제출 전에 사람이 열어 검토해야 하고 큐에 넣어 자동 전송한다.`;

// How the AI is to use the overview. Both users of ADE_OVERVIEW share it: a Haiku·low run kept asking for a queue that exists (and wrote "개요에는..."
// into the draft) when it was only told not to say a feature is missing, so the rule spells out the "already exists" case and that the reader never saw the overview.
export const OVERVIEW_RULE = '개요에 있는 기능을 없다고 쓰지 말고, 기능·화면 이름은 개요의 표기를 따르세요. 사용자가 원하는 기능이 개요에 이미 있으면 새 기능 요청으로 쓰지 말고 "이미 ~가 있으나 찾기 어렵다/기대와 다르다"로 쓰며, 개선 제안은 발견성·동작 개선으로 하세요. 개요에 없는 동작은 확인하지 못한 추측이라고 밝히세요. 본문에 "개요"라는 말은 쓰지 마세요(받는 개발자는 이 개요를 보지 않으니 "ADE에는 ~가 있다"처럼 쓰세요).';
