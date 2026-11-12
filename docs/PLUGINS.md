# 플러그인

MoonerADE가 기본으로 갖고 있지 않은 기능을, 받은 플러그인을 넣어 더하는 방법입니다. 설치하는 플러그인은 기본으로 꺼져 있고
하나씩 승인해야 합니다. MoonerADE에는 [내장 플러그인](#내장-플러그인)이 몇 개 함께 들어 있습니다.

## 내장 플러그인

앱에 함께 들어 있는 플러그인(`apps/desktop/builtin-plugins/<id>/`)입니다. 같은 플러그인 API로 만들어졌고 설정 → 플러그인에 **내장**
표시로 나옵니다. 설치한 플러그인과 다른 점은 이렇습니다.

- **승인이 없습니다.** 앱의 일부이므로 승인 확인 창도, 파일 해시 고정도 없습니다. 위의 **플러그인 사용** 스위치와도 상관없이 실행됩니다.
- **각자 켜고 끕니다.** 기본은 켜짐입니다. 상세 화면의 **사용** 스위치로 끄면 플러그인 프로세스를 멈추고 에이전트에 주던 도구도 거둡니다.
  확인 창은 없습니다(끄는 것은 더하는 것이 아니고, 켜는 것도 앱에 들어 있는 기능일 뿐입니다). 선택은 `plugins.bin`에 봉인됩니다.
- **id는 내장 플러그인이 먼저 갖습니다.** 플러그인 폴더에 같은 id의 플러그인을 넣거나 같은 id의 zip을 설치할 수 없습니다.
- 에이전트 도구를 **확인 없이 실행**하도록 요청할 수 있습니다(`terminal` 메시지의 `autoApprove`). 설치한 플러그인이 보내면 무시됩니다.

지금 들어 있는 것: **에이전트 버스**(`agent-bus`) — 채팅의 Claude·Codex·Cursor 에이전트가 서로 메시지를 주고받습니다. [AGENT_BUS.md](AGENT_BUS.md) 참고.

## 쓰는 법

1. 받은 플러그인 zip을 플러그인 폴더에 넣거나, 설정 → 플러그인 → **zip으로 설치**로 고릅니다.
   - 플러그인 폴더는 설정 → 플러그인 → 폴더 아이콘(플러그인 폴더 열기)으로 엽니다.
   - Windows: `%APPDATA%\@mooner\ade-desktop\plugins`
   - macOS: `~/Library/Application Support/@mooner/ade-desktop/plugins`
   - 개발 중에는 `ADE_PLUGINS_DIR`로 바꿉니다.
2. 확인 창에 플러그인 이름과 버전, 받는 권한, SHA-256이 나옵니다. **설치**를 누르면 설치되고 바로 실행됩니다.
   - 플러그인 기능이 꺼져 있으면 함께 켭니다.
   - 같은 플러그인이 이미 있으면 업데이트(현재 버전 → 새 버전)로 표시되고, 플러그인이 저장한 데이터는 그대로 남습니다.
   - 플러그인 폴더에 넣은 zip은 설치한 뒤 지워집니다. **취소**하면 zip은 그대로 두고, 앱을 다시 켤 때까지 다시 묻지 않습니다.
3. zip 안에는 맨 위에 `plugin.json`이 있거나, 폴더 하나가 있고 그 안에 `plugin.json`이 있어야 합니다.

압축을 푼 플러그인 폴더(안에 `plugin.json`이 있는 폴더)를 직접 넣어도 됩니다. 이때는 목록에서 플러그인을 열고
**승인하고 실행**을 누릅니다(플러그인 사용이 꺼져 있으면 **켜고 승인**으로 함께 켭니다).

### 설정 화면

설정 → 플러그인은 설치된 플러그인 목록입니다. 한 줄에 이름, 상태, 제공하는 것(명령, MCP 도구 수, 작업공간)이 나오고,
누르면 그 플러그인의 상세 화면이 열립니다(왼쪽 위 **← 플러그인**으로 돌아갑니다).

- **제공하는 기능**: 터미널 명령(`terminal.bin` 폴더의 실행 파일 이름), 플러그인이 넣는 환경 변수 이름(값은 보이지 않음),
  에이전트 도구(MCP), 작업공간 권한.
- **에이전트 도구 (MCP)**: 플러그인이 MCP 서버를 주기 시작하면 MoonerADE가 그 서버를 에이전트와 같은 방식으로 한 번 실행해
  `tools/list`로 도구 목록(이름, 설명, 인자, 읽기 전용/변경 작업 표시)을 받아 보여 줍니다. 서버 전체와 도구 하나하나를
  끄고 켤 수 있습니다. 바꾼 설정은 새로 시작하는 에이전트부터 적용됩니다.
  - 서버를 끄면 터미널과 채팅의 에이전트에 그 서버를 주지 않습니다.
  - 도구를 끄면 Claude Code에는 `--settings`의 `permissions.deny`(`mcp__<서버>__<도구>`)로, Codex에는
    `mcp_servers.<서버>.disabled_tools`로 전합니다. Cursor(ACP)는 도구 하나만 뺄 수 없어, 끈 도구가 있는 서버는 주지 않습니다.
  - 이 선택은 `plugins.bin`에 함께 봉인되고, 플러그인을 다시 승인하거나 업데이트해도 남습니다.
- **설정**: 플러그인이 보내는 `view`(상태, 정보, 입력칸, 버튼).
- **정보**: id, 버전, 폴더, SHA-256. **사용 중지**는 맨 아래에 있습니다.

## 보안 모델

플러그인은 이 컴퓨터에서 MoonerADE와 같은 사용자 권한으로 실행되는 프로그램입니다. 그래서 막을 수 있는 것은 "몰래
설치되거나 바뀐 플러그인이 실행되는 것"이고, 승인한 플러그인이 하는 일 자체가 아닙니다. 믿을 수 있는 곳에서 받고 배포처의
`SHA256SUMS`와 맞춰 본 것만 승인하세요.

- **기본 꺼짐.** 플러그인 사용, 플러그인마다의 승인, zip 설치는 Electron main의 네이티브 확인 창에서만 됩니다. 화면(렌더러)은
  상태를 읽고 단계를 시작할 수만 있습니다. 렌더러 XSS나 터미널 안의 에이전트가 플러그인을 켜거나 승인할 수 없습니다.
- **승인은 내용에 고정됩니다.** 승인할 때 폴더 전체의 SHA-256(파일 경로, 크기, 내용)을 `plugins.bin`에 저장합니다.
  실행 직전에 다시 계산해서 다르면 실행하지 않고 `파일이 바뀜` 상태로 둡니다. 폴더 감시로 실행 중에 바뀐 것도 멈춥니다.
  링크(symlink, junction)나, 파일도 폴더도 아닌 것(FIFO, 소켓 등)이 들어 있는 폴더는 받지 않습니다.
- **zip도 확인 창 하나를 거칩니다.** 플러그인 폴더에 zip을 넣어도 확인 창에서 **설치**를 누르기 전에는 아무것도 실행되지
  않습니다. 링크나 플러그인 폴더 밖을 가리키는 경로가 든 zip, 파일 수나 크기가 한도를 넘는 zip은 받지 않습니다. 확인 창이
  떠 있는 동안 zip이나 풀어 둔 파일이 바뀌면 설치하지 않습니다.
- **설정 봉인.** 켜짐 여부, 승인 목록, 플러그인이 저장한 데이터(예: 플러그인의 키)는 `<userData>/plugins.bin`에
  `safeStorage`로 봉인합니다. 암호화를 쓸 수 없으면 플러그인을 쓸 수 없습니다. 파일을 열 수 없으면 꺼진 상태로 시작합니다.
- **분리된 프로세스.** 승인한 플러그인은 각자 Node 프로세스로 실행되고 main과는 IPC로만 이야기합니다. 렌더러에는
  접근할 수 없습니다. 화면에 보이는 플러그인 내용은 정해진 모양(상태, 정보, 입력칸, 버튼)의 텍스트로만 그려집니다.
- **선언한 것만 더합니다.** 터미널에 더하는 환경 변수는 `plugin.json`의 `terminal.envPrefix`로 시작하는 것만 받습니다
  (`PATH`, `NODE_*`, `ADE_*`, `CLAUDE*`, 그리고 셸 시작·프록시·TLS 신뢰·언어 런타임에 닿는 `BASH_*`, `PROMPT_*`,
  `HTTPS_*`, `SSL_*`, `JAVA_*` 같은 접두사는 선언할 수 없습니다). PATH에는 플러그인의 `terminal.bin` 폴더만,
  에이전트에는 `mcp.script`만 더합니다.
- **확인 창 표시.** 플러그인이 요청한 확인 창은 제목이 항상 `플러그인: <이름>`이고 본문 끝에 요청한 플러그인을 적습니다.
  MoonerADE 자체의 확인 창으로 보이게 할 수 없습니다.
- 3번 넘게 1분 안에 죽은 플러그인은 다시 시작하지 않습니다(설정에서 **다시 시작**).

## `plugin.json`

```json
{
  "id": "example",
  "name": "예시",
  "version": "0.1.0",
  "apiVersion": 1,
  "description": "…",
  "main": "host.js",
  "terminal": { "bin": "bin", "envPrefix": "EXAMPLE_" },
  "mcp": { "name": "example_tools", "script": "bin/example.js", "args": ["mcp"], "chatOnly": false },
  "workspace": true,
  "feedback": true
}
```

- `id`: `[a-z0-9][a-z0-9-]{1,39}`. 폴더가 둘이면 먼저 읽힌 것만 씁니다.
- 경로는 모두 플러그인 폴더 안의 상대 경로이고 `/`로 씁니다. `..`과 절대 경로, `:`(NTFS 대체 데이터 스트림)는 받지 않습니다.
- `name`과 `description`은 승인 확인 창에 그대로 나오므로 제어 문자와 글자 방향을 바꾸는 문자를 쓸 수 없습니다.
  `name`에 있으면 받지 않고, `description`에서는 지웁니다(줄바꿈은 두 줄까지 남깁니다).
- `terminal`, `mcp`, `workspace`, `feedback`은 선택입니다.
- `mcp.chatOnly: true`는 MCP 서버를 **채팅의 에이전트에게만** 주고 터미널에는 주지 않는다는 뜻입니다. 이 서버는 자기가 섬기는 채팅을
  환경 변수 `ADE_CHAT_ID`, `ADE_PROJECT_ID`, `ADE_CHAT_AGENT`(claude, codex, cursor)로 받습니다. 이 변수는 채팅에서만 생깁니다.
- `workspace: true`는 플러그인이 이 PC의 프로젝트와 터미널을 열고 조작할 수 있는 권한입니다. 승인 확인 창에 표시됩니다.
  선언하지 않은 플러그인의 `workspace` 메시지는 무시됩니다.
- `feedback: true`는 피드백 창고에서 제출한 피드백(본문과 스크린샷 파일)을 받아 대신 보내는 권한입니다. 승인 확인 창에
  표시됩니다. 아래 [피드백](#피드백-feedback)을 보세요.

## 호스트 프로토콜 (apiVersion 1)

`main`은 MoonerADE에 들어 있는 Node로 실행됩니다(`cwd`는 플러그인 폴더). `process.send` / `process.on('message')`로
JSON 메시지를 주고받습니다.

MoonerADE → 플러그인

| 메시지 | 뜻 |
|---|---|
| `{type:'init', apiVersion, id, appVersion, dataDir, storage}` | 시작. `dataDir`은 `<userData>/plugin-data/<id>`(0700). `storage`는 지난번에 저장한 값 |
| `{type:'action', id, action, values}` | 설정 화면에서 버튼을 눌렀습니다. `values`는 입력칸 값 |
| `{type:'confirm-result', id, ok}` | 확인 창 결과 |
| `{type:'workspace', ...}` | 작업공간 세션의 응답과 출력(아래 [작업공간](#작업공간-workspace)) |
| `{type:'feedback/submit', ...}` | 피드백 제출 요청(아래 [피드백](#피드백-feedback)) |
| `{type:'shutdown'}` | 2초 안에 끝내세요. 안 끝나면 종료시킵니다 |

플러그인 → MoonerADE

| 메시지 | 뜻 |
|---|---|
| `{type:'ready'}` | 준비 끝. 이때부터 터미널 추가가 적용됩니다 |
| `{type:'view', view}` | 설정 화면 내용: `{status:{tone,text}, info:[{label,value,mono,copy}], fields:[{key,label,type,value,placeholder,hint,options}], actions:[{id,label,primary}], qr:{label,value}}`. `qr`의 `value`(1000자 이하)는 MoonerADE가 QR 코드로 그립니다. `type`은 `text`(기본), `select`(`options:[{value,label}]` 필요), `switch`, `number`이고 값은 늘 문자열입니다(스위치는 `'true'`/`'false'`). 입력칸은 24개까지입니다 |
| `{type:'notify', title, body}` | OS 알림. 제목은 `플러그인: <이름>`이고, `title`(100자)과 `body`(300자)가 본문입니다. 플러그인마다 1분에 10개까지 보여 주고 나머지는 버립니다. 누르면 설정 → 플러그인이 열립니다 |
| `{type:'badge', badge}` / `{type:'badge', badge:null}` | 상태바 표시 `{text, tone}`(24자, 한 줄) / 지움. 실행 중인 동안 항상 보이고(숨길 수 없음), 누르면 설정 → 플러그인이 열립니다. 플러그인이 멈추면 사라집니다 |
| `{type:'storage', value}` | 봉인해 저장할 값(JSON 64 KiB 이하). 다음 `init`의 `storage`로 돌아옵니다 |
| `{type:'confirm', id, message, detail, confirmLabel}` | 네이티브 확인 창 |
| `{type:'terminal', env, mcpArgs, autoApprove}` / `{type:'terminal', enabled:false}` | 새 터미널에 더할 환경 변수와 MCP 인자 / 더하지 않음. `autoApprove`는 내장 플러그인만 쓸 수 있습니다 |
| `{type:'action-result', id, ok, message?, error?}` | `action`에 대한 답 |
| `{type:'log', level, message}` | MoonerADE 로그에 남깁니다 |
| `{type:'workspace', ...}` | 작업공간 세션 요청(아래 [작업공간](#작업공간-workspace)) |
| `{type:'feedback', ...}` / `{type:'feedback/result', ...}` | 피드백 제출 가능 여부와 제출 결과(아래 [피드백](#피드백-feedback)) |

### 작업공간 (`workspace`)

`plugin.json`에 `"workspace": true`가 있는 플러그인은 세션을 열어 MoonerADE 화면과 같은 방식으로 프로젝트와 터미널을 쓸 수
있습니다. 세션은 화면이 받는 것과 같은 알림(프로젝트 상태, 터미널 출력 등)을 받습니다.

플러그인 → MoonerADE

| 메시지 | 뜻 |
|---|---|
| `{type:'workspace', op:'open', session}` | 세션을 엽니다. `session`은 `[A-Za-z0-9_-]{1,64}`로 플러그인이 정합니다 |
| `{type:'workspace', op:'close', session}` | 세션을 닫습니다 |
| `{type:'workspace', op:'api', session, id, action, input}` | 화면의 API와 같은 작업을 실행합니다(예: `recent`, `app/state`, `project/open`, `snapshot`, `terminal/open`, `terminal/close`). `id`는 정수 |
| `{type:'workspace', op:'send', session, message}` | 화면이 보내는 것과 같은 메시지를 보냅니다(예: `{type:'subscribe', projectId}`, `{type:'terminal/input', projectId, id, data}`, `{type:'terminal/resize', …}`). 터미널 크기는 [터미널 크기](#터미널-크기) |

MoonerADE → 플러그인

| 메시지 | 뜻 |
|---|---|
| `{type:'workspace', op:'api-result', session, id, ok, value?, error?}` | `api`의 결과. `error`는 `{code, message}` |
| `{type:'workspace', op:'message', session, text}` | 세션이 받은 알림(JSON 문자열) |
| `{type:'workspace', op:'closed', session}` | 세션이 닫혔습니다(열 수 없었을 때도 옵니다) |
| `{type:'workspace', op:'reset'}` | MoonerADE가 다시 시작되어 모든 세션이 닫혔습니다. 필요한 세션을 다시 여세요 |

- 플러그인 하나가 세션을 16개, 터미널을 8개까지 열 수 있습니다.
- 알림을 읽지 않아 쌓이면 그 세션을 닫습니다.
- 플러그인이 멈추거나 종료되면 그 플러그인의 세션을 모두 닫습니다.
- 세션이 열려 있는 동안 자동 업데이트는 작업 중으로 보고 기다립니다.

#### 터미널 크기

터미널 하나를 MoonerADE 창과 여러 세션이 함께 볼 수 있지만, 터미널의 크기(열 × 행)는 하나뿐입니다. 크기는 마지막으로 입력한 쪽을
따르고, 모두가 그 크기로 그립니다. 세션 하나가 화면 하나이므로, 기기마다 세션을 따로 여세요.

- `{type:'terminal/resize', projectId, id, cols, rows}`는 "이 화면에 맞는 크기"입니다. 지금 크기를 가진 쪽이 보냈거나 아무도 크기를
  갖지 않았으면 바로 적용되고, 보낸 쪽이 크기를 갖습니다. 다른 쪽이 크기를 갖고 있으면 기억만 해 둡니다.
- 크기를 갖지 않은 쪽이 `terminal/input`이나 `terminal/paste-image`를 보내면 그쪽이 크기를 갖고, 기억해 둔 크기가 있으면 입력을
  쓰기 전에 그 크기로 바꿉니다. 터미널 화면이 스스로 보내는 답(프로그램의 질의에 대한 답, 포커스 알림, 버튼 없는 마우스 이동)은
  입력으로 치지 않습니다.
- 크기를 가진 세션이 닫히거나 그 프로젝트 구독을 끊으면 아무도 크기를 갖지 않습니다. 크기 자체는 그대로입니다.
- 크기가 실제로 바뀔 때마다 그 프로젝트를 구독한 모두(보낸 쪽 포함)가 `{type:'terminal/size', projectId, id, cols, rows}`를 받습니다.
  구독하면 터미널마다 `terminal/replay` 바로 앞에 `terminal/size`가 오고, `snapshot`의 `terminals` 항목에도 `cols`·`rows`가 있습니다.
  크기를 아직 모르는 터미널(업데이트 전부터 열려 있던 터미널 등)은 둘 다 없으니, 그때는 화면에 맞는 크기로 그리세요.
- 받은 크기로 그리세요. 화면보다 크면 줄이거나 스크롤해서 보여 주세요.
- 화면 키보드처럼 잠깐 바뀌는 영역 때문에 `terminal/resize`를 보내지 마세요. 크기가 바뀔 때마다 프로그램이 화면을 다시 그립니다.

#### 이어 받기 (`since`)

구독할 때마다 터미널마다 최대 256K자의 `terminal/replay`가 옵니다. 이미 받은 출력을 가진 화면은 그 뒤만 받을 수 있습니다.

- 터미널의 출력 버퍼에는 이름(`stream`)이 있고, `offset`은 그 버퍼에 지금까지 쓰인 글자 수입니다. `terminal/replay`에는
  `stream`·`offset`·`sequence`가 함께 옵니다. 구독 중에 열린 터미널은 `{type:'terminal/stream', projectId, id, stream, offset, sequence}`가
  먼저 옵니다.
- 화면은 터미널마다 `offset`을 셉니다. replay의 `offset`에서 시작해, 그 뒤로 받은 `terminal` 출력 중 `sequence`가 replay보다 큰
  것의 `data` 길이를 더합니다. `terminal/exit`를 받은 터미널은 세지 않습니다.
- 다시 구독할 때 `{type:'subscribe', projectId, since:{[terminalId]:{stream, offset}}}`를 보냅니다. 버퍼 이름이 같고 그 뒤의 출력이
  아직 남아 있으면 replay는 `append:true`이고, `data`는 그 뒤의 출력뿐입니다(없으면 빈 문자열). 화면을 지우지 말고 이어 붙이세요.
  그렇지 않으면(재시작, 오래되어 밀려남, 잘못된 값) `append` 없이 전체를 보냅니다.
- `snapshot`의 `terminals` 항목에는 `startedAt`(연 시각), `activeAt`(마지막 출력), `inputAt`(어느 기기에서든 마지막으로 직접 입력한
  시각)이 ms로 옵니다. 아직 없으면 `null`입니다. 화면이 스스로 보내는 답은 입력으로 치지 않습니다.
- `recent` 항목에는 PC에서 마지막으로 연 시각 `openedAt`(ms)이 있습니다. 이 기능 이전에 기록된 항목에는 없습니다.

### 피드백 (`feedback`)

`plugin.json`에 `"feedback": true`가 있는 플러그인은 피드백 창고의 **제출**을 맡습니다. 피드백은 사람이 확인하고 제출을 누른
것만 옵니다(AI·에이전트가 쓴 초안도 사람이 연 뒤에만 제출할 수 있습니다).

플러그인 → MoonerADE

| 메시지 | 뜻 |
|---|---|
| `{type:'feedback', available, account?, reason?}` | 지금 제출할 수 있는지. `ready` 뒤에 한 번, 바뀔 때마다 보내세요. `account`(100자)는 피드백 창고에 보이는 계정 이름, `reason`(200자)은 제출할 수 없을 때 보여 줄 한 문장입니다 |
| `{type:'feedback/result', id, ok, issueUrl?, issueNumber?, error?}` | `feedback/submit`에 대한 답. `issueUrl`은 `https://github.com/<owner>/<repo>/issues/<n>` 모양만 받습니다. `error`는 `{code, message, retryAfter?}`이고 `message`가 사용자에게 보입니다. `retryAfter`(초)가 있으면 그만큼 기다렸다 다시 보냅니다 |

MoonerADE → 플러그인

| 메시지 | 뜻 |
|---|---|
| `{type:'feedback/submit', id, meta, images}` | `meta`: `{clientKey, title, body, source:'human'\|'ai'\|'agent', appVersion, platform}`. `images`: `[{path, mime}]`(PNG/JPEG 10장 이하, 순서대로, MoonerADE 데이터 폴더 안의 절대 경로). `id`는 정수 |

- 실행 중이고 `available: true`인 플러그인 하나에만 보냅니다. 120초 안에 답이 없으면 실패로 보고, MoonerADE의 전송 큐가 나중에 같은 `clientKey`로 다시 보냅니다. 제출할 수 있는 플러그인이 없으면 MoonerADE가 Hub에 익명으로 보냅니다.
- `clientKey`는 피드백마다 고정입니다. 같은 피드백을 다시 제출하면 같은 `clientKey`가 오므로, 받는 쪽은 이것으로 중복을 막으세요.
- 플러그인이 멈추거나 종료되면 진행 중인 제출은 실패로 끝나고, 제출할 수 없는 상태가 됩니다.

## 터미널과 에이전트

승인되어 실행 중인 플러그인이 `terminal`을 보내면, 그 뒤로 여는 ADE 터미널에:

- PATH 앞에 플러그인의 `terminal.bin` 폴더가 들어가고, `ADE_PLUGIN_NODE`(MoonerADE의 Node 경로)가 생깁니다.
- 플러그인이 보낸 환경 변수가 들어갑니다(선언한 접두사만).
- ADE 터미널에서 실행한 `claude`에는 `--mcp-config <파일>`이, `codex`에는 `-c mcp_servers.<name>.command=…`,
  `-c mcp_servers.<name>.args=[…]`가 붙습니다. 사용자 설정 파일은 바꾸지 않습니다.

이미 열린 터미널은 바뀌지 않습니다.
