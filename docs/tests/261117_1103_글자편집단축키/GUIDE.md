# 글자 편집 단축키: 실기기 확인

- 일시: 2026-11-17 11:03 (KST) · 브랜치/커밋: `master` `14d54c3` 이후 작업 트리
- 이 GUIDE는 이번 세션에서 확인하지 못한 항목만 담습니다. 모두 확인되면 이 폴더를 삭제합니다.

## 목적

브라우저에서 검증한 키 전달이 운영체제·Electron 메뉴·실제 CLI 키맵을 거쳐도 글자 이동·선택·삭제로 이어지는지 확인합니다. 설치 앱과 실제 사용자 설정을 쓰지 않고 [테스트 규칙](../../TESTING_GUIDE.md)에 따라 격리합니다.

## 미확인 항목

| 항목 | 못 한 이유·필요한 것 | 확인 절차 | 기대 |
|---|---|---|---|
| macOS Electron·물리 키보드·한글 IME | Chrome CDP 입력으로 확인했으며 설치 앱은 조작하지 않음 | 별도 userData·ADE_DATA_DIR로 Electron 실행. 채팅·터미널에서 한글 조합 후 Shift/Option/Cmd+방향키, Cmd+Delete, Fn+Delete, Shift/Option+Enter 확인 | 조합 글자 중복·유실 없음. 채팅 선택 중 모델·Effort가 바뀌지 않음. 터미널은 해당 CLI 키맵대로 편집 |
| Windows·PowerShell/PSReadLine | Windows 실기기 없음 | 격리 Windows 세션에서 Ctrl+방향키, Ctrl+Backspace/Delete, Tab/Shift+Tab, Enter/Shift+Enter, Ctrl+C/V 확인 | 단어 이동·삭제·자동완성이 CLI 지원 범위대로 동작하고 문자 입력이 앱 이동·분할로 바뀌지 않음 |
| 실제 Claude/Codex/Cursor 및 SSH/tmux | 실제 제공자 호출 대신 격리 더미와 zsh로 확인 | 격리 CLI 설정으로 제공자별 실행. Cmd/Option 이동·삭제, Shift 선택, Tab/Shift+Tab과 작업 중 Claude 후속 입력 큐 확인. SSH/tmux에서도 반복 | 시퀀스가 한 번씩 전달됨. 선택·여러 줄 이동은 CLI의 지원 범위대로 작동. 일반 Tab 자동완성과 기존 큐 동작 유지 |

## 참고

- 전달 규칙과 새 기본키: [사용 안내](../../LOCAL_IDE.md#글자-편집).
- 자동 회귀 검사: `tests/terminal-keys.test.mjs`, `tests/shortcuts.test.mjs` (`ADE_TEST_CDP`는 격리 Chrome 주소).
- 이번 세션에서는 격리 Chrome의 실제 컴포넌트·앱 입력과 zsh 삭제 동작을 확인했습니다.
