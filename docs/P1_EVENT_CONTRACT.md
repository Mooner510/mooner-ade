# P1 Agent event schema v1 and interruption semantics

## Stable host-owned envelope
Each new AdeEngine event contains `schemaVersion: 1`, `sessionId`, `agent`, a positive monotonic `sequence`, a timestamp, and one of `lifecycle`, `session`, `text`, `tool`, `usage`, `result`, `error`, `raw`, `progress`. The engine replaces any adapter-supplied identity/version metadata before exposing the event.

`parseAgentEvent` validates the supported schema, mandatory host metadata and discriminating required fields. Unknown kinds and future versions fail closed. Additional provider-specific fields are preserved as opaque extensions. `parseAgentEvent(record, {allowLegacy: true})` explicitly permits earlier M1 events missing the schemaVersion field, transparently reading them as v1 without rewriting historical JSON. This compatibility option is applied only on durable replay, not on new live streams.

The transport protocol (`PROTOCOL_VERSION: 1`) is a separate version from agent events (`AGENT_EVENT_SCHEMA_VERSION: 1`). Neither is a full authentication or network transport layer.

## Crash/interruption persistence

- `RecordedAgentRunner` validates live envelopes, persists them before yielding, then updates session terminal status.
- The store preserves the engine timestamp, sequence, and identity rather than changing event time on disk.
- Breaking/returning an async stream marks the durable session `interrupted` immediately. `recover()` marks any orphaned `running` session interrupted after a process restart.
- Terminal states cannot transition back to running. The store validates stored event sequence continuity, cleans up failed atomic temp saves, and serializes writes within one process.
- `interrupted` does **not** mean a provider subprocess was reattached or resumable. Native thread IDs must be treated independently from ADE invocation IDs.

## Boundaries and pending work

FileSessionStore is a **trusted local, single-writer** storage backend; no cross-process locking, multiple-app consistency guarantees, database migration tooling, retention/compaction, encryption-at-rest, transport reconnection or browser daemon are provided. Hosted webai must use its own isolated multi-user backend. Native Codex/Claude interactive approval and actual authenticated model/PTY E2E remain separate P1 items.

## Verification

Node local fallback: 50 tests passed, TypeScript public contract and all 8 package imports passed. Authoritative Node 24.21.0 / pnpm 11.27.1 PR CI must independently pass before merging.
