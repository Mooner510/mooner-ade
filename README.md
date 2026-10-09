# mooner-ade (무너에이드)

**Local-first AI-native Development Environment.** Reusable **ADE Framework** packages and a local web IDE consumer. The new IDE implementation passes type/syntax checks and the web build; runtime verification remains pending; see [한국어 실행 안내와 검증 상태](docs/LOCAL_IDE.md).

## Boundaries

- `mooner-ade`: a single trusted local user, their own Codex/Claude CLI sign-in and normal host filesystem/terminal permissions.
- `webai`: a different product, hosted on the owner's server and used by other people's own accounts, with **container-enforced** filesystem, process, identity, and network isolation.
- Both applications consume the framework as packages. Neither depends on the other's running application or daemon.

```text
ADE UI / applications
       |
       v
@mooner/ade-core ── @mooner/ade-protocol
       |                   |
       |                   +── versioned event envelope
       |
       +─ Workspace / Processes / Git / Terminal ports
       |     ├─ @mooner/ade-runtime-local     (implemented)
       |     └─ ContainerRuntime              (webai supplies later)
       |
       +─ Agent adapters
             ├─ @mooner/ade-agent-codex
             └─ @mooner/ade-agent-claude
                    ^
              @mooner/ade-agent-core
```

## What is implemented

| Package | Public contract |
|---|---|
| `@mooner/ade-core` | AdeEngine, capability policy, agent lifecycle, operation gates |
| `@mooner/ade-protocol` | Versioned message envelope and validation |
| `@mooner/ade-runtime-local` | Host filesystem, bounded spawn, Git read operations, optional PTY bridge |
| `@mooner/ade-agent-core` | Bounded UTF-8 JSONL streaming and subprocess handling |
| `@mooner/ade-agent-codex` | `codex exec --json` events normalized to ADE events |
| `@mooner/ade-agent-claude` | Claude Code `-p --output-format stream-json` event normalization |

All agent adapters emit `session`, `text`, `tool`, `usage`, `result`, `error`, or `raw` events. Tool and raw events intentionally preserve upstream data for evolving CLI schemas. The core emits a separate `lifecycle` event and owns cancellation state.

## Repository workflow

This repository uses **non-dev** branch governance: `feature/*` -> pull request to `master` -> canonical CI -> merge. There is **no `dev` branch** and no development or production server deployment for this local-only framework project. The initial import of M1 source is the explicitly authorized one-time direct `master` bootstrap.

## Requirements and checks

Canonical project toolchain: **Node 24.21.0** and **pnpm 11.27.1**. Package runtime has no mandatory third-party dependencies.

Run in the repository root:

```text
pnpm install --no-frozen-lockfile
pnpm typecheck
pnpm web:build
pnpm start
```

The user installed the application dependencies and regenerated the lockfile. Fresh installations can use `--frozen-lockfile`. `pnpm typecheck` is static-only. `pnpm check` also runs automatic tests, so run it only when tests are authorized. The included CI caller delegates to `Mooner510/workflows` `project-checks.yml@v1`, not custom repository CI. After user installation, type checks, JavaScript syntax checks and the web build passed on Node 24.12.0 / pnpm 11.27.1. Tests and live acceptance remain unrun; the required Node version is 24.21.0 or newer.

## Example: local-only trusted consumer

```js
import { AdeEngine, AllowAllPolicy } from '@mooner/ade-core';
import { createLocalRuntime } from '@mooner/ade-runtime-local';
import { CodexAgent } from '@mooner/ade-agent-codex';
import { ClaudeAgent } from '@mooner/ade-agent-claude';

const ade = new AdeEngine({
  runtime: createLocalRuntime({ root: process.cwd(), scope: 'unrestricted' }),
  policy: new AllowAllPolicy(),
  agents: [new CodexAgent(), new ClaudeAgent()]
});

console.log(await ade.listFiles());
for await (const event of ade.runAgent('codex', 'Summarize this repository', { cwd: process.cwd() })) {
  console.log(event);
}
```

The SDK uses your **existing local CLI authentication**. It does not copy, broker, or store your secrets and does not use the app author's AI account. Sign in using the official CLI separately. `fullAccess: true` can be supplied to an agent run for the owner's personal machine; do not pass this in `webai`.

A real interactive terminal requires an installed `node-pty` runtime dependency on the target OS. The framework keeps the Terminal port injectable: the local implementation dynamically imports `node-pty`; the hosted implementation must supply its own isolated PTY service. The Node smoke test does not imply PTY or live AI-model E2E success.

## Status / out-of-scope

**Framework M1/P1:** reusable core, local runtime, legacy CLI adapters, typed contracts, event protocol, durable sessions and recorded runner.

**Local IDE implementation:** `apps/web` (React, Monaco, xterm) and `apps/local-server` (authenticated HTTP/WebSocket, server-owned runs, native approval transports, PTY, file/Git/worktree flows). Dependencies were installed by the user and the lockfile was regenerated. Type/syntax checks and the web build passed. `pnpm check` (73 tests) and the headless-Chrome smoke `pnpm e2e` pass; real Codex/Claude runs are verified opt-in with `ADE_LIVE_TEST=1 pnpm test:live`. Preview server, debugger, hosted multi-user and container isolation remain out of scope.

See [architecture](docs/ARCHITECTURE.md), [webai porting boundaries](docs/PORTING.md) and [test matrix](docs/VERIFICATION.md).
