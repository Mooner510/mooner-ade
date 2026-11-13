# 확인 대기: 설치·배포·Electron·Windows (사람 또는 외부 환경 필요)

- 상태: **미실행** (옛 `TESTING_GUIDE.md`에서 2026-11-13에 이관. 원문 이력은 git `bb5fa1d`)
- 모드: 해당 없음 (패키지된 앱·Windows·외부 저장소가 필요)
- 규칙: [TESTING_GUIDE](../../TESTING_GUIDE.md). 세션 기동·정리·캐시 규칙은 거기를 따른다. 이 문서는 **무엇을 확인할지**만 담고, 절차는 아래 원문을 그대로 옮겼다.

## 목적과 의도한 결과
격리 테스트 세션으로는 확인할 수 없는 것: 설치 스크립트, 패키지된 앱의 서버 기동, 업데이트, Windows. 사용자가 직접 하거나 그 환경에서 한다.

## 사전조건
- 설치 스크립트는 `master`에 올라간 뒤 README의 명령으로 받을 수 있다(그 전에는 로컬 파일 직접 실행). Windows 스크립트는 PowerShell 환경이 필요하다.
- 설치된 실제 앱을 건드리므로 사용자 확인 없이는 진행하지 않는다.

## 케이스 (원문)
### 한 줄 설치 스크립트 (2026-11-09)

검증 상태: `sh -n scripts/install-mac.sh` 문법 검사만 했습니다. Windows 스크립트(`scripts/install-windows.ps1`)는 PowerShell이 없는 환경에서 작성해 실행해 보지 않았습니다. 두 스크립트 모두 `master`에 올라간 뒤 README의 명령으로 받을 수 있습니다(그 전에는 로컬 파일을 직접 실행).

1. Windows(Windows PowerShell 5.1과 PowerShell 7 각각): `irm https://raw.githubusercontent.com/Mooner510/mooner-ade/master/scripts/install-windows.ps1 | iex`를 실행하면 한글 메시지가 깨지지 않고, `%LOCALAPPDATA%\Programs\MoonerADE\MoonerADE.exe`가 설치되고, 시작 메뉴·바탕 화면에 `MoonerADE` 바로 가기가 생기고, 앱이 SmartScreen 경고 없이 열린다.
2. 앱을 켠 채 같은 명령을 다시 실행하면 앱(과 같은 폴더의 `node.exe`)이 종료된 뒤 재설치되고 다시 열린다. 실행 후 PowerShell 창에 `$dest` 같은 변수가 남지 않는다.
3. Windows로 설치한 앱에서 설정 → 업데이트 확인이 동작한다(설치 폴더에 쓸 수 있어야 함).
4. 네트워크를 끊고 실행하면 "최신 릴리스에서 … 받지 못했습니다" 오류로 멈추고, 기존 설치는 지워지지 않는다.
5. macOS: README의 `curl … | sh`로 설치·재설치되고 Gatekeeper 경고 없이 열린다. Intel Mac에서는 "Intel Mac은 README의 '소스에서 실행'을 따라 주세요" 안내로 멈춘다.

### 수동 수용 검사 중 설치·배포·업데이트 항목 (옛 31줄 섹션)

- macOS·Windows에서 첫 설치, `pnpm package` 결과물 실행, PTY, 경로, 창 종료와 단축키 확인
- 업데이트 안전 재시작(`node --test tests/update-policy.test.mjs tests/claude-busy.test.mjs`로 판정부터 확인, 실제 설치 동작은 패키지된 앱에서만 확인 가능): 안내 창의 기본 버튼이 "나중에"인지. Claude가 턴을 진행 중일 때, 턴이 끝났어도 `run_in_background` shell·Monitor가 도는 중일 때, `ScheduleWakeup` 예약이 남았을 때, 일반 셸에서 명령이 실행 중일 때 안내 창 버튼이 "종료할 때 업데이트", "지금 업데이트", "나중에"이고 기본은 "나중에"인지, 진행 중인 작업 목록이 맞는지. "종료할 때 업데이트"는 작업이 끝나길 기다리지 않고 바로 받은 뒤 종료할 때 설치하는지. "지금 업데이트"는 진행 중인 작업을 보여주고 중단해도 괜찮다고 할 때만 바로 설치하는지, 취소하면 설치하지 않는지. 한가할 때 "지금 업데이트"를 고른 뒤 받는 중 작업이 시작되면 같은 확인을 다시 하는지. 설정의 업데이트 확인 버튼이 받아 둔 업데이트에 대해 "지금 재시작/받지 않기/종료할 때까지 대기"를 보여 주는지, "나중에"를 고른 버전은 10분 뒤에 자동으로 다시 묻지 않는지(앱 재시작 후에는 다시 물음). 업데이트 뒤 `%TEMP%`에 `mooner-update-*` 폴더가 남지 않는지(Windows는 헬퍼가 몇 초 뒤 지움), 설치 폴더에 이전 버전 사본이 없는지.
- 베타 업데이트(`node --test tests/update-policy.test.mjs`로 버전 순서와 릴리스 선택부터 확인): 설정 → 정보에 "베타 업데이트 받기" 스위치가 있고 끄고 켠 값이 앱을 다시 켜도 유지되는지(`@mooner/ade-desktop/update-channel.json`). 끈 상태에서는 `v0.4.1-beta1` 같은 prerelease 릴리스를 제안하지 않고, 켠 상태에서는 베타와 정식 중 가장 높은 버전을 제안하는지(`0.4.1-beta2` > `0.4.1-beta1`, 같은 번호의 정식 `0.4.1`이 베타보다 새 버전). `v*-beta*` 태그를 푸시하면 GitHub 릴리스가 Pre-release로 만들어지고 Latest가 바뀌지 않는지, `install-mac.sh`는 계속 정식 버전만 받는지.
- 설치한 앱(Finder/Dock에서 실행)이 번들 `runtime/node`로 서버를 시작하는지(`spawn node ENOENT`와 `write EPIPE`가 없어야 함).

## 결과 기록
케이스마다 `PASS / FAIL / BLOCKED / SKIP`, 증거, (AI 케이스는) 토큰을 아래에 쓴다. 실행 후 [템플릿](../_template/GUIDE.md) 형식으로 정리한다.

| 항목 | 결과 | 증거 | 메모 |
|---|---|---|---|
| | | | |
