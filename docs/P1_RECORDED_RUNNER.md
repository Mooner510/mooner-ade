# P1 Session integration checkpoint

`RecordedAgentRunner` wires the existing `AdeEngine.runAgent()` stream to a persistent `FileSessionStore`. It records each event **before yielding it**, preserves the engine-owned session identity and checks monotonic event sequence. A terminal lifecycle event is written before the store status becomes terminal.

Consumers can replay with `runner.replay(sessionId, { afterSequence })` or recover an interrupted snapshot after restart.

Safety limits: only one process should write a given session store directory; the store serializes writes **within a process** but does not implement cross-process database transactions or file locking. Closing a consumer stream early does not falsely label the work completed; call `recover` after restart to mark orphan sessions interrupted. Reattaching to the previous native model/PTY process remains unsupported. This wrapper does not turn a noninteractive CLI into an approval-aware transport.

## P2 unchanged

- Worktree opt-in only, default shared workspace.
- Terminal design: iTerm-style Ctrl+D / Ctrl+Shift+D, 2 rows x 3 columns preset (see P2_UX_SPEC.md).

## Validation

Run `node --test tests/p1-recorded-runner.test.mjs`, then the canonical Node 24.21.0 / pnpm 11.27.1 PR checks. Live model authentication requires an actual owner-signed-in machine.
