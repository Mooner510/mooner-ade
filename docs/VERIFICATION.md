# Verification scope

`pnpm check` (contract typecheck, web typecheck, 62 Node tests) passes on Node 24.12.0 / pnpm 11.27.1 (macOS). The local IDE/ADE additionally passed a headless-Chrome run and server tests with a real PTY and a real typescript-language-server (see [LOCAL_IDE.md](LOCAL_IDE.md)). Real Codex/Claude acceptance, Windows/Linux and Node >=24.21.0 remain **unrun**. The list below describes the framework checkpoints.

Included Node tests cover:

- wire message validation and forward incompatibility rejection;
- default-deny engine policy and trusted local permissions;
- file read/write/list, absolute paths, traversal and symlink escape checks;
- argv-safe subprocess execution, timeout, output bounds, AbortSignal;
- Unicode JSONL chunking, trailing records, malformed and oversized records;
- Codex and Claude native-event normalization and command argument construction;
- real spawned JSONL child process and nonzero process exit;
- ADE agent lifecycle, error propagation and cancellation;
- Git status against a disposable real Git repository;
- dependency injection of an alternate runtime port implementation.

Latest local run (Node 24.12.0, macOS): `pnpm check` 73/73 tests, `pnpm e2e` headless-Chrome smoke (auth, project open, explorer, ADE/IDE switch, AI composer). Earlier notes below were written on Node 22.16.0 and are partly superseded: the Codex App Server transport, Claude SDK transport, real PTY and real LSP now have automated tests (`tests/agents.test.mjs`, `tests/local-server.test.mjs`). Target `pnpm` was unavailable locally and registry lookup failed. The TypeScript 5.8.3 public type contract was verified with the installed compiler, and the TypeScript dependency was pinned from the npm registry with its published SHA-512 integrity. `pnpm install --frozen-lockfile` with the new dependency and updated security gates still require canonical Gharp CI verification. Automated tests use fake Codex/Claude transports; real model calls run only via `ADE_LIVE_TEST=1 pnpm test:live` (run, approval, resume, full-access for both providers).

On the official project runner, verify exact Node 24.21.0 + pnpm 11.27.1, frozen lockfile, canonical security gates, and an opt-in live CLI smoke test on a machine with authenticated Codex/Claude.

P0 follow-up: Security CI initially failed three pnpm workspace policy rules and OSV Scanner 2.6.0 returned exit 128 for a lockfile containing only local workspace dependencies. The updated project explicitly pins pnpm supply-chain policies and uses the existing public TypeScript contract as an actual compiled, pinned development dependency rather than adding a scanner-only placeholder.
