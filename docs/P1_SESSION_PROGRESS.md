# 세션 저장소 계약

`FileSessionStore`는 실행 메타를 `<id>.json`, 새 이벤트를 `<id>.events.jsonl`에 저장합니다. 메타는 임시 파일 fsync 후 rename하고 이벤트는 append 후 fsync합니다. 이전 단일 JSON의 events도 읽습니다.

실행별 쓰기를 프로세스 내부에서 직렬화하고 sequence 연속성을 확인합니다. 불완전한 마지막 줄은 제외하고 다음 append 전에 잘라냅니다. 중간 손상은 거절합니다. 서버 재시작 후 running은 interrupted로 바꾸며 기존 OS 프로세스를 복원하지 않습니다.

단일 writer를 전제합니다. 서버는 프로젝트별 잠금을 사용하지만 패키지 자체가 다중 프로세스 트랜잭션·암호화·보관기한·압축을 제공하지는 않습니다. 현재 실행 결과는 [VERIFICATION](VERIFICATION.md), 통합은 [P1_RECORDED_RUNNER](P1_RECORDED_RUNNER.md)를 참고하세요.
