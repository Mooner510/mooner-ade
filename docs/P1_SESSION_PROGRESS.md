# P1 checkpoint — session persistence

- Added `@mooner/ade-session-store` package with atomic filesystem JSON session snapshots, per-session write serialization, monotonic event sequences, cursor-based replay, and interrupted recovery.
- The store does **not** reconnect to a former OS subprocess: running sessions are conservatively marked `interrupted` on recovery.
- Added six tests for durable reload, replay cursor, concurrent append, interrupted restoration, terminal status and path constraints.
- This is a reusable package, not yet wired to a browser daemon or to `AdeEngine` lifecycle hooks. The daemon integration and schema migration work remain P1 follow-ups.
- Local JSON files are intended for the trusted owner machine; hosted webai must provide an isolated tenant-aware store, and should not use this host directory implementation.
- Actual authenticated Codex/Claude model E2E and real node-pty tests remain pending.
