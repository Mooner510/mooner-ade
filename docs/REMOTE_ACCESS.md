# 원격 접속

MoonerADE Android 앱에서 이 PC의 프로젝트와 터미널에 접속하는 기능입니다. 기본으로 꺼져 있습니다. 쓰려면 MoonerADE 원격 접속 권한이 있는 mooner510 계정(Authentik)이 필요합니다. 계정이 없어도 MoonerADE의 나머지 기능은 그대로 쓸 수 있습니다.

이 문서는 공개 프로토콜 명세입니다. 중계 서버(Hub) 구현은 별도 비공개 저장소(`mooner-ade-hub`)에 있습니다. 이 문서는 Hub가 지켜야 할 계약만 적습니다.

## 구성 요소

| 구성 요소 | 하는 일 | 모르는 것 |
|---|---|---|
| 데스크톱 main 프로세스 (`apps/desktop/src/remote*.js`) | 원격 설정을 소유합니다(켜짐 여부, 계정 토큰, PC 키, 페어링한 폰). 네이티브 확인 창을 띄웁니다. | — |
| 로컬 서버 (`apps/local-server/src/remote-gateway.js`) | Hub 제어 연결을 유지합니다. Noise 응답자로 동작하고, 허용 목록(`remote-dispatch.js`)에 맞는 요청만 기존 API에 넘깁니다. | refresh token |
| Hub | 계정 로그인, 기기 등록, PC 온라인 표시, 중계, 철회 전파를 맡습니다. | 세션 내용, PC와 폰의 비밀 키 |
| Android 앱 | 로그인하고, QR로 PC를 페어링하고, Noise 개시자로 접속합니다. | — |

화면(렌더러)은 키와 토큰을 받지 않습니다. 화면이 받는 것은 `publicState()`뿐이고, 할 수 있는 일은 단계를 시작하는 것뿐입니다. 접근 권한을 주는 단계는 모두 main 프로세스의 네이티브 확인 창을 거칩니다: 켜기, 폰 승인, 제어 권한 주기, 키 새로 만들기. 그래서 화면의 XSS나 터미널 안의 에이전트가 원격 접속을 몰래 켜거나 폰을 몰래 추가할 수 없습니다.

## 신뢰 모델

- **계정만으로는 셸을 주지 않습니다.** 계정은 자격 확인, 기기 찾기, 중계, 철회 전파에만 씁니다.
- **PC 키는 QR로만 고정합니다.** 폰은 QR에 든 PC 공개 키(`k`)만 믿습니다. Hub가 알려 주는 PC 목록은 hostId를 맞추고 온라인 여부를 보여 주는 데만 씁니다.
- **폰은 PC에서 승인해야 추가됩니다.** 폰이 QR 비밀을 증명하면 PC에 확인 창이 뜨고, 사용자가 다음 중 하나를 고릅니다.
  - `제어 허용`(`control`)
  - `보기만 허용`(`view`)
  - `거부`

  기본 선택은 거부입니다. 확인 창에는 폰 키 지문이 나오므로 폰 앱에 보이는 지문과 맞춰 볼 수 있습니다.
- **Hub는 권한을 뺏을 수만 있습니다.** Hub가 PC에 보낼 수 있는 것은 `relay/open`과 `revoke`뿐입니다.
  - `relay/open`은 페어링한 기기 id만 받고, 그 기기는 페어링 때 고정한 키를 증명해야 합니다.
  - Hub가 털려도 할 수 있는 일은 서비스 거부와 철회, 그리고 메타데이터(언제 어느 기기가 접속했는지) 열람뿐입니다.
- **설정은 봉인해서 저장합니다.** 원격 설정은 `<userData>/remote.bin`에 저장하고 Electron `safeStorage`(Windows DPAPI, macOS Keychain)로 봉인합니다.
  - 암호화를 쓸 수 없거나 파일이 열리지 않으면 원격 접속은 꺼진 상태로 시작합니다.
  - 평문으로 저장하는 경우는 없습니다.
- **오래 쓰지 않은 폰은 해제됩니다.** 90일 동안 접속하지 않은 폰은 페어링이 풀리고, 다시 QR을 스캔해야 합니다.
- **연결 계정을 바꾸면 폰이 모두 해제됩니다.** 다른 계정을 연결하면 이전 계정으로 페어링한 폰이 모두 해제되고 원격 접속도 꺼집니다.

## 암호 채널

| 용도 | 패턴 |
|---|---|
| 평소 접속 | `Noise_IK_25519_AESGCM_SHA256` (폰 = 개시자, PC = 응답자) |
| 페어링 | `Noise_IKpsk2_25519_AESGCM_SHA256` |

- **페어링 psk**
  - `psk = HKDF(SHA-256("mooner-ade pair v1"), QR 비밀 32바이트)`의 첫 출력(32바이트). HKDF는 Noise 명세의 HMAC-SHA256 HKDF이고, 이는 RFC 5869 HKDF(salt = 라벨의 SHA-256, info = 빈 값, L = 32)와 같습니다.
  - QR 비밀 자체는 어디로도 전송하지 않습니다.
- **prologue**: `mooner-ade.v1|<session|pair>|<relay|direct>|<hostId>`(UTF-8)입니다. 경로나 대상 PC가 다르면 handshake가 실패합니다. 버전 협상은 하지 않습니다.
- **handshake**: 두 메시지로 끝납니다.
  - msg1(폰 → PC)과 msg2(PC → 폰)의 payload는 비어 있어야 합니다.
  - PC는 폰의 첫 transport 메시지를 받기 전에는 아무것도 처리하지 않습니다. 그래서 msg1을 replay해도 효과가 없습니다.
  - handshake는 10초 안에 끝나야 합니다.
- **청크**: transport 메시지 하나가 WebSocket 바이너리 프레임 하나입니다.
  - 평문 첫 바이트는 플래그입니다: `0x01` = 마지막 조각, `0x02` = rekey.
  - 조각의 평문은 최대 65,518바이트입니다(65535 − 16 태그 − 1 플래그).
  - 조각을 모은 앱 메시지는 최대 32 MiB입니다.
- **Rekey**: 2^20 조각 또는 1시간마다, 보내는 쪽이 그 조각에 `0x02` 플래그를 싣고 보낸 직후 Noise `REKEY()`를 합니다. 받는 쪽은 그 조각을 연 직후 rekey합니다.
- **세션 제한**: 세션은 최대 12시간이고, 90초 동안 아무 메시지가 없으면 끊습니다. 폰은 30초마다 `ping`을 보냅니다.
- **상호 운용성 테스트**: cacophony 테스트 벡터(`tests/fixtures/noise-vectors.json`)를 Node와 Kotlin 구현이 함께 씁니다.

## QR

```
moonerade://pair?v=1&k=<PC 공개 키 base64url>&h=<hostId>&t=<비밀 32바이트 base64url>&n=<PC 이름>
```

- 5분 동안만 쓸 수 있고 한 번 쓰면 끝입니다. 대기 중인 QR은 한 번에 하나뿐이고, 새로 만들면 이전 QR은 무효가 됩니다.
- 비밀은 main 프로세스 메모리에만 있습니다. 서버 자식 프로세스는 psk만 받습니다.
- 다음 경우에는 QR이 소진됩니다.
  - 페어링에 성공했을 때
  - 거부했을 때
  - 비밀을 증명하지 못한 시도가 5번 쌓였을 때
- 설정 화면에서 QR은 처음에 가려져 있고, `QR 보기`를 눌러야 나타납니다.

## 앱 프로토콜 (transport 안쪽, JSON)

| 방향 | 메시지 |
|---|---|
| 폰 → PC, 첫 메시지 | `{t:'start'}` (평소 접속) 또는 `{t:'pair', name}` (페어링) |
| PC → 폰 | `{t:'hello', host, session, scope, api[], messages[]}` / `{t:'paired', scope, host}` / `{t:'pair-denied'}` |
| 폰 → PC | `{t:'api', id, action, input}` → `{t:'api', id, ok:true, value}` 또는 `{t:'api', id, ok:false, error:{code, message}}` |
| 양방향 | `{t:'ws', message}`: 데스크톱 화면의 WebSocket 메시지와 같은 형식(subscribe, terminal 출력 등) |
| 폰 → PC | `{t:'ping'}` → `{t:'pong'}` |

- 페어링이 승인되면 PC는 `paired`를 보내고 연결을 닫습니다. 폰은 새로 고정한 키로 다시 평소 접속을 합니다.
- `hello.api`와 `hello.messages`는 그 권한으로 쓸 수 있는 action과 메시지 목록입니다. 폰 앱은 이 목록으로 버튼을 감춥니다. 실제 차단은 PC가 합니다.

## 권한 (`remote-dispatch.js`)

기본은 거부입니다. 목록에 있는 action만, 정해진 필드만 통과합니다. 나머지 필드는 버려지므로 `force`, `restoreId` 같은 값이 서버에 닿지 않습니다.

- **view(보기만)**: system/info, shell/list, home, recent, app/state(읽기만), readiness, usage/status, snapshot, git/status, git/branches, git/show(HEAD와 staged만), subscribe, unsubscribe
- **control(제어)**: view의 전부에 더해 다음을 쓸 수 있습니다.
  - project/open: 열려 있거나 최근 목록에 있는 프로젝트만
  - git/checkout, git/worktree-setting, git/worktree/integrate
  - terminal/open, close, follow-up
  - terminal/input, resize, paste-image
  - git/show의 작업 트리
- **항상 거부**: 프로젝트 만들기/복제, 폴더 선택 창, 최근 목록 수정, 앱 상태 쓰기, WakaTime 설정, 원격 설정 자체
- **제한**
  - 원격에서 연 터미널은 모두 합쳐 8개까지입니다.
  - 붙여 넣는 이미지는 세션마다 분당 10개까지입니다.
  - 폰마다 동시 세션은 3개, 전체는 8개까지입니다.

PTY는 사용자 셸과 같은 권한이라 `control` 권한은 사실상 이 PC 사용자의 셸 권한입니다. 모르는 폰에는 주지 마세요.

## 가시성

- 원격 접속이 켜져 있으면 상태바에 표시가 생깁니다. 폰이 접속 중이면 기기 이름이 강조됩니다. 이 표시는 상태바 설정으로 숨길 수 없습니다.
- 다음 경우에 OS 알림을 띄웁니다.
  - 새 접속이 생겼을 때
  - 페어링하지 않은 키로 접속을 시도했을 때
- 감사 로그는 `<userData>/remote-audit.log`에 남깁니다. 한 줄에 JSON 하나이고, 2 MiB가 되면 `.1`로 넘깁니다.
  - 남기는 일: 접속, 끊김, 거부, 모르는 키, 페어링 요청·결과, 권한 변경, 철회, 켜기·끄기, 계정 연결·해제
- 원격 세션이 있는 동안은 자동 업데이트 재시작을 미룹니다.

## Hub API 계약

기본 주소는 `https://ade-hub.mooner510.kr`이고, `ADE_HUB_URL`로 바꿀 수 있습니다.

- 모든 응답은 JSON입니다. 오류 형식은 `{error:{code, message}}`입니다.
- 토큰은 기기별 불투명 값입니다. access 토큰은 1시간, refresh 토큰은 30일이고, refresh 토큰은 쓸 때마다 교체됩니다.
- Hub는 요청마다 계정에 Authentik capability `mooner_ade_enabled`가 있는지 확인합니다. capability가 빠지면 그 계정의 모든 기기를 철회합니다.

### 등록 (device-code 방식)

1. `POST /v1/enroll/start`
   - 요청: `{kind: 'host'|'phone', name, platform, key}`. `key`는 Noise 정적 공개 키 base64이고, Hub는 표시용으로만 씁니다.
   - 응답: `{enrollId, pollToken, userCode, verifyUrl, interval, expiresIn}`
   - `verifyUrl`은 Hub와 같은 origin이어야 합니다. 앱은 다른 origin이면 열지 않습니다.
2. 사용자는 브라우저에서 `verifyUrl`을 엽니다.
   - Authentik에 로그인합니다(auth code + PKCE).
   - `userCode`와 기기 이름, 플랫폼을 확인하고 승인합니다.
3. 기기는 `POST /v1/enroll/poll`을 `interval`초마다 보냅니다.
   - 요청: `{enrollId, pollToken}`
   - 대기 중이면 `{status:'pending'}`을 받습니다.
   - 승인되면 다음을 받습니다.
     ```
     {status:'approved', device:{id}, account:{id, name, email}, accessToken, refreshToken, accessExpiresIn}
     ```
   - 거부되었거나 만료되었거나 권한이 없으면 `410`을 받습니다.

### 토큰과 계정

| 요청 | 응답 / 동작 |
|---|---|
| `POST /v1/token/refresh {refreshToken}` | `{accessToken, refreshToken, accessExpiresIn}`. 무효면 `401`, 앱은 계정 연결을 끝냅니다. |
| `GET /v1/me` | `{account, device}` |
| `DELETE /v1/me` | 이 기기의 등록을 지웁니다(연결 해제). |

### PC (host) 제어 연결

- 접속: `GET /v1/host`. WebSocket이고, subprotocol은 `mooner-ade.v1`, 헤더는 `Authorization: Bearer <access>`입니다.
  - 토큰이 만료되었으면 업그레이드 응답이 `401`입니다. 앱은 토큰을 갱신하고 다시 접속합니다.
  - 권한이 없으면 `403`입니다. 앱은 원격 접속을 끕니다.
- PC → Hub
  - `{type:'presence', host:{name, platform, version}}`
  - `{type:'relay/reject', relayId, reason}`. reason은 `no-pairing`, `unknown-device`, `bad-mode`, `busy` 중 하나입니다.
  - `{type:'pong'}`
- Hub → PC
  - `{type:'relay/open', relayId, mode:'pair'|'session', device:{id, name}}`
  - `{type:'revoke', deviceId}`
  - `{type:'ping'}`
- 둘 다 25초마다 WebSocket ping을 보냅니다. PC는 끊기면 1초부터 60초까지 지터를 넣어 다시 접속합니다.

### 중계

- 폰은 `GET /v1/connect/{hostId}?mode=pair|session`로 접속합니다. 폰의 access 토큰을 쓰는 WebSocket입니다.
  - Hub는 같은 계정의 PC인지 확인한 뒤 PC에 `relay/open`을 보냅니다. 이때 `device`는 토큰으로 인증한 폰 기기입니다.
- PC는 `GET /v1/relay/{relayId}`로 접속합니다. PC의 access 토큰을 쓰는 WebSocket입니다.
  - Hub는 두 연결을 짝짓고 바이너리 프레임을 그대로 전달합니다. 프레임은 최대 64 KiB입니다.
  - 텍스트 프레임은 전달하지 않습니다.
  - 짝이 15초 안에 오지 않거나 한쪽이 닫히면 다른 쪽도 닫습니다.
- Hub는 연결마다 폰 토큰을 확인하고 나서 `relay/open`을 보냅니다.
  - 그래서 철회한 폰은 중계 단계에서 막힙니다.
  - PC는 그 위에서 페어링 여부와 키를 다시 확인합니다.
  - 중계를 거치지 않는 직접 연결(Tailscale, 선택 기능)에는 Hub의 확인이 없습니다. 그래서 PC가 연결 때마다 `GET /v1/devices/{id}/status`로 확인하고, 확인할 수 없으면 거부합니다.

### 닫힘 코드 (PC가 보내는 것)

| 코드 | 뜻 |
|---|---|
| 4000 | 세션 최대 시간 경과 |
| 4002 | 프로토콜 오류 |
| 4003 | 접근 거부(모르는 기기·키, 철회, 권한 변경, 페어링 거부) |
| 4008 | handshake 시간 초과 또는 idle |
| 1013 | 폰이 출력을 받지 못해 버퍼가 8 MiB를 넘음 |

권한이 바뀌거나 폰이 해제되면 그 폰의 세션은 즉시 4003으로 닫힙니다. 폰은 바뀐 권한으로 다시 접속합니다.

## 개발

- 로컬 Hub를 쓰려면 `ADE_HUB_URL=http://127.0.0.1:<port>`처럼 지정합니다. `http`는 루프백 주소에만 허용합니다.
- 테스트
  - `tests/noise.test.mjs`: 벡터, 변조, replay, 청크, rekey
  - `tests/remote-dispatch.test.mjs`: 허용 목록
  - `tests/remote-gateway.test.mjs`: 가짜 Hub와 Node 폰 클라이언트로 페어링, 권한, 철회, 실제 서버 프로세스와의 터미널 왕복
  - `tests/remote-store.test.mjs`: 봉인 저장, fail-closed, 만료
