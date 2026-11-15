# Windows 업데이트 뒤 CMD 창: Windows Terminal 환경 확인

- 일시: 2026-11-16 01:21 (KST) · 브랜치/커밋: `fix/windows-update-console` `c5fa4c2` (기준 `origin/master` 3956ad5)
- 이 GUIDE는 이번 세션에서 확인하지 못한 항목만 담습니다. 모두 확인되면 이 폴더를 삭제합니다.

## 목적
Windows 11에서 기본 터미널이 Windows Terminal일 때도 업데이트 중에 콘솔(터미널) 창이 한 번도 뜨지 않아야 한다. 이전 버전 도우미가 시작하는 첫 업데이트에서는 창이 뜨더라도, 그 창을 닫는 것만으로 앱이 종료되면 안 된다.

원인: 업데이트 도우미(PowerShell)를 WMI로 띄우면 보이는 콘솔 창이 생기고, `-WindowStyle Hidden`은 창이 생긴 뒤에야 숨기며 Windows Terminal에서는 아예 숨기지 못한다([microsoft/terminal#12464](https://github.com/microsoft/terminal/issues/12464)). 새로 시작한 ADE는 Electron의 기본 동작대로 그 콘솔에 붙어, 창을 닫으면 같이 종료된다. 수정은 도우미를 `CREATE_NO_WINDOW`로 만들고, 새 앱을 `ELECTRON_NO_ATTACH_CONSOLE`로 띄우며, 콘솔에 붙은 채 시작한 앱은 스스로 분리된 복사본으로 다시 시작하는 것이다.

## 미확인 항목
| 항목 | 못 한 이유·필요한 것 | 확인 절차 | 기대 |
|---|---|---|---|
| 1. 수정본끼리 업데이트(Windows Terminal) | 이 PC는 Windows 10(19045)이라 기본 터미널이 클래식 콘솔뿐이다. Windows 11 PC와 `pnpm package`가 필요하다 | Windows 11에서 설정 › 개인 정보 및 보안 › 개발자용 › 터미널을 `Windows 터미널`로 둔다. 이 브랜치에서 `pnpm package` 뒤 `VERIFY_OUT=<임시 폴더> node scripts/verify/t-update-win.mjs`. 끝나면 `VERIFY_OUT=<같은 경로> node scripts/verify/cleanup-ui.mjs --discard-evidence` | 13/13 통과. 특히 "업데이트 동안 콘솔 창이 한 번도 보이지 않음"(감시 대상에 `CASCADIA_HOSTING_WINDOW_CLASS` 포함)과 "새 앱이 콘솔에 붙어 있지 않음" |
| 2. 이전 버전 도우미가 시작하는 첫 업데이트(Windows Terminal) | 수정 전 빌드가 필요하다: `git worktree add ../ade-before origin/master` 후 거기서 `pnpm install && pnpm package` | 1번과 같은 환경에서 `... t-update-win.mjs --installed-from ../ade-before/apps/desktop/dist/MoonerADE-win32-x64` | 이전 도우미의 터미널 창은 보여도 된다(그래서 "콘솔 창이 한 번도 보이지 않음"은 FAIL 가능). 나머지는 PASS여야 한다: "새 앱이 콘솔에 붙어 있지 않음", "콘솔 창을 닫아도 앱이 살아 있음". NOTE의 시작 기록이 2번(`console=true` → `marker=1`) |
| 3. 실제 릴리스로 업데이트 | 이 수정이 들어간 릴리스가 있어야 한다 | Windows Terminal 기본 상태에서 설치된 앱을 수정된 릴리스로 올리고, 이어서 그다음 릴리스로 한 번 더 올린다 | 첫 업데이트는 터미널 창이 있어도 닫아도 앱이 살아 있고, 두 번째 업데이트부터는 창이 아예 뜨지 않는다 |
| 4. 설치 스크립트 직후의 앱 | 설치 스크립트는 `master`의 것을 받아 실제 설치 위치(`%LOCALAPPDATA%\Programs\MoonerADE`)와 바로 가기를 바꾼다. 격리해서 돌릴 수 없고, 이 세션에서는 문법 검사(`ParseFile` 오류 0)만 했다 | 수정이 `master`에 올라간 뒤 README의 설치 명령을 실행하고, 앱이 뜬 다음 그 PowerShell 창을 닫는다 | 앱이 계속 실행된다(`ELECTRON_NO_ATTACH_CONSOLE`을 이 실행에만 넣고 지운다. 실행 뒤 `$env:ELECTRON_NO_ATTACH_CONSOLE`이 비어 있어야 함) |

## 참고
- 이 세션에서 확인한 것(Windows 10, 격리 사본, 실제 패키지 앱, `t-update-win.mjs`): 수정 전 빌드는 업데이트 중 PowerShell 콘솔 창이 보이고(62ms), 새 앱이 그 콘솔에 붙으며, 콘솔 창을 닫으면 앱이 종료됨을 재현했다. 수정본끼리(앱 전용 zip·전체 zip 둘 다)는 13/13, 이전 버전 도우미 → 수정본은 12/13(이전 도우미의 깜박임만 남음).
- 시작 스크립트는 WMI가 `CREATE_NO_WINDOW` 단독을 거부하는(반환값 21) 점 때문에 `CREATE_UNICODE_ENVIRONMENT`와 함께 넘기고, 막히면 `ShowWindow=0`, 그다음 예전 방식으로 물러난다. Windows 11에서 어느 단계가 쓰이는지는 1번에서 같이 보면 된다(도우미가 시작하지 못하면 앱은 종료되지 않고 오류 창을 띄운다).
- 관련 파일: `apps/desktop/src/update-windows.js`, `console-detach.js`, `updater.js`, `main.js`, `scripts/verify/t-update-win.mjs`, `console-watch.ps1`, `console-tool.ps1`.
