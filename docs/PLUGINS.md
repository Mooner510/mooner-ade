# 플러그인

MoonerADE가 기본으로 갖고 있지 않은 기능을, 받은 플러그인을 넣어 더하는 방법입니다. MoonerADE 자체에는 플러그인이
들어 있지 않습니다.

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

압축을 푼 플러그인 폴더(안에 `plugin.json`이 있는 폴더)를 직접 넣어도 됩니다. 이때는 플러그인 카드의
**승인하고 실행**을 누릅니다(플러그인 사용이 꺼져 있으면 **켜고 승인**으로 함께 켭니다).

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
  "mcp": { "name": "example_tools", "script": "bin/example.js", "args": ["mcp"] },
  "workspace": true
}
```

- `id`: `[a-z0-9][a-z0-9-]{1,39}`. 폴더가 둘이면 먼저 읽힌 것만 씁니다.
- 경로는 모두 플러그인 폴더 안의 상대 경로이고 `/`로 씁니다. `..`과 절대 경로, `:`(NTFS 대체 데이터 스트림)는 받지 않습니다.
- `name`과 `description`은 승인 확인 창에 그대로 나오므로 제어 문자와 글자 방향을 바꾸는 문자를 쓸 수 없습니다.
  `name`에 있으면 받지 않고, `description`에서는 지웁니다(줄바꿈은 두 줄까지 남깁니다).
- `terminal`, `mcp`, `workspace`는 선택입니다.
- `workspace: true`는 플러그인이 이 PC의 프로젝트와 터미널을 열고 조작할 수 있는 권한입니다. 승인 확인 창에 표시됩니다.
  선언하지 않은 플러그인의 `workspace` 메시지는 무시됩니다.

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
| `{type:'shutdown'}` | 2초 안에 끝내세요. 안 끝나면 종료시킵니다 |

플러그인 → MoonerADE

| 메시지 | 뜻 |
|---|---|
| `{type:'ready'}` | 준비 끝. 이때부터 터미널 추가가 적용됩니다 |
| `{type:'view', view}` | 설정 화면 내용: `{status:{tone,text}, info:[{label,value,mono,copy}], fields:[{key,label,value,placeholder,hint}], actions:[{id,label,primary}], qr:{label,value}}`. `qr`의 `value`(1000자 이하)는 MoonerADE가 QR 코드로 그립니다 |
| `{type:'notify', title, body}` | OS 알림. 제목은 `플러그인: <이름>`이고, `title`(100자)과 `body`(300자)가 본문입니다. 플러그인마다 1분에 10개까지 보여 주고 나머지는 버립니다. 누르면 설정 → 플러그인이 열립니다 |
| `{type:'badge', badge}` / `{type:'badge', badge:null}` | 상태바 표시 `{text, tone}`(24자, 한 줄) / 지움. 실행 중인 동안 항상 보이고(숨길 수 없음), 누르면 설정 → 플러그인이 열립니다. 플러그인이 멈추면 사라집니다 |
| `{type:'storage', value}` | 봉인해 저장할 값(JSON 64 KiB 이하). 다음 `init`의 `storage`로 돌아옵니다 |
| `{type:'confirm', id, message, detail, confirmLabel}` | 네이티브 확인 창 |
| `{type:'terminal', env, mcpArgs}` / `{type:'terminal', enabled:false}` | 새 터미널에 더할 환경 변수와 MCP 인자 / 더하지 않음 |
| `{type:'action-result', id, ok, message?, error?}` | `action`에 대한 답 |
| `{type:'log', level, message}` | MoonerADE 로그에 남깁니다 |
| `{type:'workspace', ...}` | 작업공간 세션 요청(아래 [작업공간](#작업공간-workspace)) |

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

## 터미널과 에이전트

승인되어 실행 중인 플러그인이 `terminal`을 보내면, 그 뒤로 여는 ADE 터미널에:

- PATH 앞에 플러그인의 `terminal.bin` 폴더가 들어가고, `ADE_PLUGIN_NODE`(MoonerADE의 Node 경로)가 생깁니다.
- 플러그인이 보낸 환경 변수가 들어갑니다(선언한 접두사만).
- ADE 터미널에서 실행한 `claude`에는 `--mcp-config <파일>`이, `codex`에는 `-c mcp_servers.<name>.command=…`,
  `-c mcp_servers.<name>.args=[…]`가 붙습니다. 사용자 설정 파일은 바꾸지 않습니다.

이미 열린 터미널은 바뀌지 않습니다.
