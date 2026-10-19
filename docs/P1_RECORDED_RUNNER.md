# RecordedAgentRunner 계약

`RecordedAgentRunner`는 `AdeEngine.runAgent()` 이벤트를 검증하고 **저장한 뒤** 소비자에게 전달합니다. engine의 sessionId·sequence·timestamp를 유지하며 terminal lifecycle 기록 후 세션 terminal 상태를 저장합니다.

`runner.replay(sessionId, { afterSequence })`로 이력을 재생합니다. 소비자가 스트림을 일찍 종료하면 durable 기록은 즉시 interrupted로 바뀝니다. 서버 재시작 시 고아 running 기록도 interrupted로 복구합니다. 제공자 thread ID를 통한 새 실행과 이전 프로세스 재접속은 별개입니다.

동일 저장소 디렉터리는 단일 writer가 소유해야 합니다. 로컬 서버는 브라우저 연결과 독립적으로 실행을 소비합니다. 이 wrapper는 비대화형 CLI에 승인 기능을 추가하지 않습니다. [이벤트 계약](P1_EVENT_CONTRACT.md), [저장 계약](P1_SESSION_PROGRESS.md), [검증 상태](VERIFICATION.md)를 참고하세요.
