# Project rules

## Releases
- **Only master can be released.** Never tag, run `pnpm release`, or dispatch the Release workflow from a feature/fix branch.
- Flow: merge the work into master (PR) -> bump `version` in package.json on master via a `chore: release x.y.z` commit -> push -> `pnpm release` on master.
- Enforced in `scripts/release.mjs` (must be on master, equal to origin/master) and in `.github/workflows/release.yml` (the tagged commit must be an ancestor of origin/master, otherwise the release fails). Do not weaken or bypass either.

## Testing
- The session that develops also tests, in an isolated session only (temp `ADE_DATA_DIR`/repo, temp-profile Chrome over CDP). Never touch the installed app or the real `~/.claude`/`~/.codex`/`~/.cursor`; real-AI runs use `AGENT_DIRS=1`.
- Basic checks (`pnpm typecheck`, `node --test`) only at the start (baseline) and the end (compare); never mid-run. Cheapest model/effort (Haiku 5.5 · low).
- Always clean up with `scripts/verify/cleanup-ui.mjs` (manifest-based). Never kill by process name or `rm -rf` a path you have not verified.
- If the testing can be finished in this session, finish it here and report the results in the reply; write no `docs/tests/.../GUIDE.md`. A guide is only for what could not be verified in this session (and only for those items), or when the user asks for one. Rules: `docs/TESTING_GUIDE.md`.
