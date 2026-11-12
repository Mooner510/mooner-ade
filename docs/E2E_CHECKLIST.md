# Full E2E 체크리스트

다음 Full E2E의 기준표입니다. 환경 구성은 [E2E_HANDOFF](E2E_HANDOFF.md) 4절, 항목별 절차는 [TESTING_GUIDE](TESTING_GUIDE.md), 실제 AI가 필요한 항목은 [AI_AGENT_TEST_CHECKLIST](AI_AGENT_TEST_CHECKLIST.md)를 따릅니다.

- 결과 표기: ✅ 통과 · ❌ 실패(수정 여부 병기) · 📖 코드 읽기로 판정(실행 생략) · ⏭ 이번에 안 함 · ⬜ 미실행
- **번들 없음:** 서버는 `ADE_DEV=1`(Vite 개발 서버)로 `apps/web/src`를 직접 서빙하므로 웹 소스를 고쳐도 빌드하지 않습니다. 열린 페이지에 HMR로 바로 반영되고, 서버 코드를 고쳤을 때는 `scripts/verify/restart-ui.mjs`로 서버만 재시작합니다(Chrome은 그대로, 탭만 새 주소로 이동). 세션 운영 규칙 전체는 [E2E_HANDOFF](E2E_HANDOFF.md) 4.1절. 예전 문서의 `pnpm --filter @mooner/ade-web build` + `Page.reload(ignoreCache)` 절차는 더 쓰지 않습니다.
- **창 규칙:** 사용자가 배치한 Chrome 창의 위치·크기를 바꾸지 않습니다(`Browser.setWindowBounds` 금지). `Page.bringToFront`는 캡쳐처럼 꼭 필요할 때만.

## 2026-11-12 (feat/ui-frame 작업 트리, 격리 서버·가짜 claude·가짜 Hub·Chrome 157, 실제 AI 없음)

방식: 서버 환경 3개를 병렬로 띄워(메인 1 + 에이전트 2) 영역별로 나눠 확인.

### 자동 검사
| 항목 | 결과 | 근거 |
|---|---|---|
| `node --test tests/chat-model.test.mjs tests/errors.test.mjs` | ✅ 51/51 | `mcpSummary` 깊이·네트워크 오류 문구 포함 |
| 타입 검사 | ✅ | 이번 수정(ChatPane·UiFrame·style) 후에도 통과 |
| `pnpm test` 전체, `pnpm e2e`, `t-feedback`·`t-chat` | ⏭ | 이미 통과/알려진 실패 기록이 있고 이후 변경은 웹 UI뿐 |
| 루트 `a.txt` 삭제 | 📖 | `git status`에 `D` |

### 피드백
| 항목 | 결과 | 메모 |
|---|---|---|
| 환영 화면에서 `feedback/changed` 푸시 반영 | ✅ | 큐 항목이 "약 N분 뒤 전송" → 새로고침 없이 `제출됨`. 수정 전 번들에서는 "곧 전송"이 남음 |
| 캡쳐: 창 전체 | ✅ | 1140×1188, 아래 검은 띠 없음, 오버레이 미포함 |
| 캡쳐: 범위 | ✅ | 400×200 영역 → 700×352(공유 중 DPR 1.75), 내용이 선택 영역과 일치 |
| 캡쳐: 요소 | ✅ | 환영 화면에는 `data-feedback-region`이 없어 창 전체로 잡힘(의도 확인 필요, 저장 2024×2166) |
| 캡쳐: Esc 취소 | ✅ | 이미지 추가 없음, 도구 막대 사라짐 |
| 캡쳐: 공유 중지·가려진 창 안내("화면 공유를 시작하지 못했습니다…") | ⬜ | 창을 가려야 해서 보류. 사용자 창을 건드리지 않기 위함 |
| 피드백 제출 확인창·큐·취소·모델/Effort·AI 정리·주석·설정·단축키 | 📖 | 2026-11-12 이전 검증에서 통과, 이후 변경 없음 |

### 채팅
| 항목 | 결과 | 메모 |
|---|---|---|
| 모델 변경 경고창 줄바꿈 | ✅ | 문장 사이 공백·본문 줄바꿈, 모델 변경·압축하고 전환·취소 |
| 외부 링크 확인창 | ✅ | 긴 URL 줄바꿈 (`ade:link` 이벤트로 유도) |
| `/model` 선택창의 짧은 제목은 placeholder | ✅ | |
| "그래도 보내기"·브랜치 전환·명령 팔레트 대화상자 | ⬜ | CLI 모드 터미널 에이전트·실제 터미널 필요. 같은 `pick()` 경로 |
| 이미지 첨부: 입력창 썸네일·X 위치·클릭 확대(입력창·말풍선) | ✅ | |
| 이미지 첨부: 말풍선·스티어링 썸네일, 재시작 후 유지(previews만 저장) | ✅ | `chat/close` 후 새로고침으로 확인. **서버 재시작은 안 함** |
| 이미지 첨부: **대기열 썸네일** | ❌→✅ 수정 | 후속 큐 항목에 이미지가 안 보임 → `ChatPane.tsx` 큐 항목에 `UserImages`(40px) 추가·재빌드 후 확인 |
| QuestionCard: 자동 포커스 안 뺏음·아이콘·방향키 선택·Ctrl/⌘+Enter 제출 | ✅ | 숫자키 선택 없음, radio에서 Enter만으로는 제출 안 됨(`QuestionCard.tsx:14`) — 의도 확인 필요 |
| 계획 카드: 자동 모드로 승인 / 편집 허용으로 승인 | ✅ | reply에 `updatedPermissions:[setMode …]`, 칩 갱신 |
| 계획 카드: 수정 요청… / 의견 없이 반려 | ✅ | `deny`+문구, 칩은 "계획" 유지 |
| 계획 카드: 계획 이전 모드로 복귀, 다른 탭에 갔다 와서 승인 | ✅ | |
| 계획 카드: 탭을 닫았다 다시 열어 승인 | ⬜ | 응답 대기 중 닫으면 중단 확인창 → 대기 중인 계획을 두고 닫는 경로를 못 만듦 |
| `ade-ui`: 렌더·`ade.send`(실클릭)·`ade.prefill`·외부 요청 차단·높이 +200 | ✅ | `bin/claude`에 `adeui` 응답 추가 |
| `ade-ui`: **상시 세로 스크롤바** | ❌→✅ 수정 | 테두리 2px이 높이에 빠짐 → `UiFrame.tsx` `height + 2`. 확인: `scrollHeight`=`clientHeight`=139 |
| `ade-ui`: iframe 안 CSP 위반 콘솔 로그 | ⬜ | 메인 페이지 쪽에서 수집되지 않음(차단 동작은 확인) |

### 코드 읽기로 판정하거나 생략 (실행 안 함)
| 항목 | 상태 |
|---|---|
| 헤더 버튼 노출 규칙(W1)·사용량 칩 "—"/`≈N%p`(U1)·busy 중 `/x`+Tab·Codex/Cursor 전환 후 화면·온보딩 화면(W3) | ⏭ 시간 단축으로 제외. 다음 Full E2E에서 확인 |
| 오류 토스트의 네트워크 문구(UI) | 📖 단위 테스트가 문구 보장 |
| 이전에 통과한 UI 피드백·채팅 항목(서브에이전트·도구 카드·`ui` 블록·`@` 메뉴 등) | 📖 회귀 확인 생략 |

### 남은 사소한 점 (수정 안 함)
- 메시지형 선택창(모델 변경 경고)에서 본문과 버튼 사이에 입력을 받지 않는 빈 입력줄·캐럿이 남음(`QuickInput.tsx`가 `message`일 때도 `<input>`을 그림).
- 질문 대기 중 입력창에서 Shift+Tab이 권한 모드를 순환하고, 이어서 Enter를 치면 메시지가 steer로 나감.
- 가짜 claude는 `--model`이 없으면 칩에 `-p`가 표시됨(하네스 부작용).

## 이번에 하지 않은 영역 (다음 Full E2E 입력)
- [AI_AGENT_TEST_CHECKLIST](AI_AGENT_TEST_CHECKLIST.md) A~J(실제 AI), K(Electron·실제 Hub·실제 zsh): ⬜ 전부 미실행.
- `pnpm e2e` 첫 단언 실패(master에서도 동일): ⬜ 원인 미조사.
