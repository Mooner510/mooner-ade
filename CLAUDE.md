# Project rules

## Releases
- **Only master can be released.** Never tag, run `pnpm release`, or dispatch the Release workflow from a feature/fix branch.
- Flow: merge the work into master (PR) -> bump `version` in package.json on master via a `chore: release x.y.z` commit -> push -> `pnpm release` on master.
- Enforced in `scripts/release.mjs` (must be on master, equal to origin/master) and in `.github/workflows/release.yml` (the tagged commit must be an ancestor of origin/master, otherwise the release fails). Do not weaken or bypass either.
