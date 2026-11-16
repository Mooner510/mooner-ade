# Project rules

## Releases
- **Only master can be released.** Never tag, run `pnpm release`, or dispatch the Release workflow from a feature/fix branch.
- Flow: merge the work into master (PR) -> bump `version` in package.json on master via a `chore: release x.y.z` commit -> push -> `pnpm release` on master.
- **Version must be explicit.** If the user asks for a release without naming the version (e.g. "릴리스 해줘"), never pick one yourself. Ask which version to release (AskUserQuestion, one question) and always include your recommendation as the first option, marked "(Recommended)". Base it on the current `version` in package.json and the changes since the last tag (`git log <last-tag>..master`): patch for fixes/polish only, minor for new features, major for breaking changes. Show the current version and the reason for the recommendation. Bump, commit, and release only after the user answers.
- **Release notes are mandatory.** Every stable release must have its entry in `apps/web/src/changelog.json` (version, date, items by kind from `changelog-kinds.json`), written and merged to master before the release commit. The in-app 변경 내역 window (version sidebar) and the GitHub release body (`scripts/release-notes.mjs`) are both built from it, and `scripts/release.mjs` refuses a stable release without it. Write the notes in the user's terms (what they can now do or what was fixed), not commit messages. Betas need none.
- Enforced in `scripts/release.mjs` (must be on master, equal to origin/master) and in `.github/workflows/release.yml` (the tagged commit must be an ancestor of origin/master, otherwise the release fails). Do not weaken or bypass either.

## Merging PRs
- **Merge with a merge commit (`gh pr merge --merge`), never `--squash` or `--rebase`.** The history is `Merge pull request #N from <branch>` throughout; keep each branch's own commits.
- Delete the remote branch after the merge (`--delete-branch`).

## Testing
- The session that develops also tests, in an isolated session only (temp `ADE_DATA_DIR`/repo, temp-profile Chrome over CDP). Never touch the installed app or the real `~/.claude`/`~/.codex`/`~/.cursor`. Real-AI runs use `AGENT_DIRS=1`: HOME stays real and only the CLI config dirs are isolated (`~/.ade-test/agents`); Cursor shares its Keychain login.
- Pass `VERIFY_OUT=...` on every verify command (an `export` does not survive between commands; the scripts refuse to run without it).
- Full basic checks (`pnpm typecheck`, `node --test`) only at the start (baseline) and the end (compare). Mid-run, a single test file for the module you touched is fine.
- Real-AI runs: cheapest model/effort (Haiku 5.5 · low).
- Always clean up with `scripts/verify/cleanup-ui.mjs` (manifest-based). Never kill by process name or `rm -rf` a path you have not verified.
- If the testing can be finished in this session, finish it here and report the results in the reply; write no `docs/tests/.../GUIDE.md`. A guide is only for what could not be verified in this session (and only for those items), or when the user asks for one. Rules: `docs/TESTING_GUIDE.md`.
