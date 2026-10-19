# P1 Agent event schema v1 and interruption semantics

## Stable host-owned envelope
Each new AdeEngine event contains `schemaVersion: 1`, `sessionId`, `agent`, a positive monotonic `sequence`, a timestamp, and one of `lifecycle`, `session`, `text`, `tool`, `usage`, `result`, `error`, `raw`, `progress`, `approval`. The engine replaces any adapter-supplied identity/version metadata before exposing the event.

`parseAgentEvent` validates the supported schema, mandatory host metadata and discriminating required fields. Unknown kinds and future versions fail closed. Additional provider-specific fields are preserved as opaque extensions. `parseAgentEvent(record, {allowLegacy: true})` explicitly permits earlier M1 events missing the schemaVersion field, transparently reading them as v1 without rewriting historical JSON. This compatibility option is applied only on durable replay, not on new live streams.

The transport protocol (`PROTOCOL_VERSION: 1`) is a separate version from agent events (`AGENT_EVENT_SCHEMA_VERSION: 1`). Neither is a full authentication or network transport layer.

## Crash/interruption persistence

- `RecordedAgentRunner` validates live envelopes, persists them before yielding, then updates session terminal status.
- The store preserves the engine timestamp, sequence, and identity rather than changing event time on disk.
- Breaking/returning an async stream marks the durable session `interrupted` immediately. `recover()` marks any orphaned `running` session interrupted after a process restart.
- Terminal states cannot transition back to running. The store validates stored event sequence continuity, cleans up failed atomic temp saves, and serializes writes within one process.
- `interrupted` does **not** mean a provider subprocess was reattached or resumable. Native thread IDs must be treated independently from ADE invocation IDs.

## Boundaries and pending work

FileSessionStore is a **trusted local, single-writer** storage backend; no cross-process locking, multiple-app consistency guarantees, database migration tooling, retention/compaction, encryption-at-rest, transport reconnection or browser daemon are provided. Hosted webai must use its own isolated multi-user backend. Native approval transports are implemented in the local server and tested with fake providers. Real PTY is covered by server tests; actual authenticated model calls remain opt-in. The current UI uses terminal CLI approval screens rather than an SDK conversation panel.

## Verification

Current results and unverified environments are tracked in [VERIFICATION](VERIFICATION.md). Replay compatibility tests are in `tests/p1-event-contract.test.mjs` and `tests/p1-recorded-runner.test.mjs`.
