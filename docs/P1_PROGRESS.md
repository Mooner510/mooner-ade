# P1: portable runtime, approvals and integration test hardening

This document records the original framework checkpoint. The subsequent local IDE implementation and its **unverified** acceptance status are tracked in [LOCAL_IDE.md](LOCAL_IDE.md). Hosted isolation remains out of scope.

## Implemented

- `AdeEngine` supports policy-gated Git diff, stage, unstage and commit, while preserving runtime portability.
- Agent events have engine-assigned session identity, monotonically increasing sequence number and timestamp; provider native thread IDs are recorded separately. Externally supplied identity fields cannot override engine metadata. Early stream disposal cancels active work.
- `ApprovalBroker` defaults to denial with timeout/cancellation, explicit trusted approval decisions and a pending-request interface. Engine rejects `approvalMode: 'interactive'` when the transport lacks native approval support. **The current Codex/Claude JSONL CLI adapters remain noninteractive.** A host must not treat broker events as upstream CLI approvals until an approval-aware native transport is integrated.
- The local Git port uses argv-only subprocesses with `--` for file operands and staged/unstaged diffs.
- PTY port supports dependency injection for testable terminal input, resize, exit events and close; real platform PTY requires separately installed `node-pty`.
- `LocalWorkspace.watch` uses the asynchronous `node:fs/promises` API.
- 11 additional Node tests cover real temporary Git repos, mocked native PTY, deny-by-default approval, event integrity, premature stream disposal and real JSONL subprocess streaming with fake Codex/Claude outputs.
- An explicit opt-in `scripts/live-agent-check.mjs` exercises both **real authenticated CLI binaries** using the owner's own sign-ins; it will make model calls when `ADE_LIVE_TEST=1` is set. Running without the opt-in exits without invoking agents.

## Local verification

- 32/32 Node tests passed using local Node 22.16.0.
- All 6 packages import, `tsc --project tsconfig.contract.json` passes, and the local smoke exercise passes.
- The canonical Node 24.21.0 / pnpm 11.27.1 CI remains the authoritative GitHub verification.

## Still pending in P1

- Real Codex/Claude CLI authentication, login status, native session resume and live model invocation on a machine with those CLIs installed and signed in; match test adapters against actual current CLI versions.
- True interactive tool approvals using Codex App Server and Claude Agent SDK or a similarly authenticated approval-aware native transport. Current CLI JSONL streams cannot accept host UI permission decisions.
- `node-pty` native installation and real terminal E2E on supported macOS/Windows/Linux hosts.
- Durable store and RecordedAgentRunner are implemented and connected to the local server; replay/restart/browser acceptance is pending. Legacy event reading is preserved, with additive approval/text-update contracts.
- File searching/indexing, preview tasks, workspace save/move/remove operations, richer Git workflows and exhaustive runtime policy tests.

## Non-dev repository governance

Use `feature/*` branches, pull requests into `master`, and canonical CI. Do not create `dev` or add a server deployment. The framework is a package implementation, not a daemon.
