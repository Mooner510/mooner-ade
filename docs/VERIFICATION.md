# Verification scope

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

Executed in the build environment on **Node 22.16.0** (not the target Node 24.21.0): imports, tests, smoke run. Target `pnpm` was unavailable and registry lookup failed; `pnpm install --frozen-lockfile` and canonical Gharp CI are therefore unverified. Tests use mocked AI responses; neither Codex nor Claude CLI live authentication or model calls were exercised. PTY requires a native `node-pty` installation and is not yet integration-tested.

On the official project runner, verify exact Node 24.21.0 + pnpm 11.27.1, frozen lockfile, canonical security gates, and an opt-in live CLI smoke test on a machine with authenticated Codex/Claude.
