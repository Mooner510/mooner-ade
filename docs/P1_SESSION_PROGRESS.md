# P1 checkpoint — session persistence

- Added `@mooner/ade-session-store` package with atomic filesystem JSON session snapshots, per-session write serialization, monotonic event sequences, cursor-based replay, and interrupted recovery.
- The store does **not** reconnect to a former OS subprocess: running sessions are conservatively marked `interrupted` on recovery.
- Added six tests for durable reload, replay cursor, concurrent append, interrupted restoration, terminal status and path constraints.
- The reusable store is connected through `RecordedAgentRunner` to the local server. It now supports list/recoverAll; server-owned consumers persist runs independently of browser subscriptions. Project, conversation and prompt metadata are stored with each run. See [local IDE status](LOCAL_IDE.md); this integration is not yet runtime-verified.
- Local JSON files are intended for the trusted owner machine; hosted webai must provide an isolated tenant-aware store, and should not use this host directory implementation.
- Actual authenticated Codex/Claude model E2E and real node-pty tests remain pending.
