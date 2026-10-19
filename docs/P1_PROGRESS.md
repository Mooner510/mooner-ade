# P1 프레임워크 체크포인트

이 파일은 과거 단계 문서의 링크를 유지합니다. 현재 아키텍처는 [ARCHITECTURE](ARCHITECTURE.md), 실행 결과는 [VERIFICATION](VERIFICATION.md)이 기준입니다.

구현된 핵심은 정책을 거치는 파일·Git·프로세스·PTY 포트, 에이전트 이벤트 정규화·취소, 승인 브로커, 영속 세션과 recorded runner입니다. CLI 패키지의 비대화형 adapter와 로컬 서버의 승인 가능한 Codex App Server/Claude SDK transport는 서로 다릅니다.

프레임워크 Git API에는 commit이 있지만 앱 HTTP API와 UI에는 없습니다. 설치형 배포, 호스팅 격리, 실제 모델·모든 OS 수용 검사는 프레임워크 단위 테스트만으로 보증하지 않습니다.
