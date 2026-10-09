# ADE framework contracts

## Separation of concerns

- **ADE Core**: capability-gated user-facing actions, agent registry, lifecycle and cancellation. It imports no local filesystem, shell, Git command, browser implementation or container runtime.
- **Platform runtime**: the `workspace`, `processes`, `git`, `terminal` ports. Local runtime is deliberately trusted and may inherit the current user's shell credentials. Hosted runtime must implement all ports through an isolated process/container boundary.
- **Agent protocol**: each native upstream JSONL event is normalized into small common event categories; raw provider payloads remain available. UI can render normalized events without knowing which CLI produced them.
- **Transport**: wire messages have `v`, `id`, `channel`, `kind`, `payload`, `timestamp`. This is a pure data contract; network transport and authentication are **consumer responsibilities**.

## Agent lifecycle and guarantees

`runAgent()` returns an async event stream. Each invocation gets an internal session UUID and an AbortController. `stopAgent(id)` aborts the controller and the subprocess adapter sends SIGTERM. Historical sessions record completed/failed/cancelled status. A native upstream thread ID is emitted in `session` events and can be supplied as `threadId` on a later call. These are **separate** identities: the ADE invocation ID is not the native provider thread ID.

CLI-native noninteractive invocation does **not** support browser-rendered interactive permission prompting. The local app adds separate Codex App Server and Claude Agent SDK transports in `apps/local-server/src/agents.js`; existing CLI package adapters remain unchanged. Only actual native permission requests create actionable approval UI. See [local IDE contracts and verification limits](LOCAL_IDE.md).

## Local-only behavior

- LocalWorkspace's default scope is unrestricted, including absolute paths, matching a trusted single-user IDE.
- `scope: 'root'` blocks common traversal and symlink escape, but must **never** be treated as a security sandbox; filesystem races, spawned processes and other side effects require OS isolation in a hostile multitenant environment.
- `LocalProcesses.exec(file, argv)` uses `shell: false`, timeouts and output byte caps. Full shell is provided via the PTY port. Using `fullAccess` skips CLI sandbox/approval protections and is only an explicit owner choice.
- LocalTerminal uses the current user's shell and `node-pty`. `node-pty` is deliberately optional to keep pure-core tests free of native modules.

## Public API stability

This is an initial `0.1.0` API. Before a `1.0` contract, define stable discriminated event schemas and compatibility tests against pinned official Codex/Claude versions. Keep the CLI-specific event transformers in dedicated adapters: never embed provider event shapes in the core.
