# 플러그인

MoonerADE가 기본으로 갖고 있지 않은 기능을, 받은 플러그인 폴더를 넣어 더하는 방법입니다. MoonerADE 자체에는 플러그인이
들어 있지 않습니다.

## 쓰는 법

1. 설정 → 플러그인 → **플러그인 폴더 열기**. 기본 위치는 `<userData>/plugins`입니다.
   - Windows: `%APPDATA%\MoonerADE\plugins`
   - macOS: `~/Library/Application Support/MoonerADE/plugins`
   - 개발 중에는 `ADE_PLUGINS_DIR`로 바꿉니다.
2. 압축을 푼 플러그인 폴더(안에 `plugin.json`이 있는 폴더)를 넣습니다. 바로 목록에 나타납니다.
3. **플러그인 사용**을 켭니다. 네이티브 확인 창이 뜹니다.
4. 플러그인의 **승인**을 누릅니다. 확인 창에 플러그인이 받는 권한과 폴더의 SHA-256이 나옵니다.

## 보안 모델

플러그인은 이 컴퓨터에서 MoonerADE와 같은 사용자 권한으로 실행되는 프로그램입니다. 그래서 막을 수 있는 것은 "몰래
설치되거나 바뀐 플러그인이 실행되는 것"이고, 승인한 플러그인이 하는 일 자체가 아닙니다. 믿을 수 있는 곳에서 받고 배포처의
`SHA256SUMS`와 맞춰 본 것만 승인하세요.

- **기본 꺼짐.** 플러그인 사용과 플러그인마다의 승인은 Electron main의 네이티브 확인 창에서만 됩니다. 화면(렌더러)은
  상태를 읽고 단계를 시작할 수만 있습니다. 렌더러 XSS나 터미널 안의 에이전트가 플러그인을 켜거나 승인할 수 없습니다.
- **승인은 내용에 고정됩니다.** 승인할 때 폴더 전체의 SHA-256(파일 경로, 크기, 내용)을 `plugins.bin`에 저장합니다.
  실행 직전에 다시 계산해서 다르면 실행하지 않고 `파일이 바뀜` 상태로 둡니다. 폴더 감시로 실행 중에 바뀐 것도 멈춥니다.
  링크(symlink, junction)나, 파일도 폴더도 아닌 것(FIFO, 소켓 등)이 들어 있는 폴더는 받지 않습니다.
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
| `{type:'view', view}` | 설정 화면 내용: `{status:{tone,text}, info:[{label,value,mono,copy}], fields:[{key,label,value,placeholder,hint}], actions:[{id,label,primary}]}` |
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
| `{type:'workspace', op:'send', session, message}` | 화면이 보내는 것과 같은 메시지를 보냅니다(예: `{type:'subscribe', projectId}`, `{type:'terminal/input', projectId, id, data}`, `{type:'terminal/resize', …}`) |

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

## 터미널과 에이전트

승인되어 실행 중인 플러그인이 `terminal`을 보내면, 그 뒤로 여는 ADE 터미널에:

- PATH 앞에 플러그인의 `terminal.bin` 폴더가 들어가고, `ADE_PLUGIN_NODE`(MoonerADE의 Node 경로)가 생깁니다.
- 플러그인이 보낸 환경 변수가 들어갑니다(선언한 접두사만).
- ADE 터미널에서 실행한 `claude`에는 `--mcp-config <파일>`이, `codex`에는 `-c mcp_servers.<name>.command=…`,
  `-c mcp_servers.<name>.args=[…]`가 붙습니다. 사용자 설정 파일은 바꾸지 않습니다.

이미 열린 터미널은 바뀌지 않습니다.
