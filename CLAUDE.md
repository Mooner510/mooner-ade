# Project rules

## 에이전트 서명 금지 (절대 규칙)

어떤 AI로 만들었는지를 드러내는 에이전트 본인의 서명을 어디에도 남기지 않는다.

- **대상:** 커밋 메시지, PR 제목·본문·댓글·리뷰, 릴리스 노트, 이슈, 브랜치 이름. 에이전트가 만들었다는 사실을 밝히는 모든 문구.
- **금지 문구:**
  - `Co-Authored-By`, `Co-authored-by` 줄. 모델 이름을 공동 작성자로 넣는 모든 표기.
  - `Made with Cursor`, `Generated with [Claude Code]`, `🤖 Generated with ...`.
  - `noreply@anthropic.com`, `cursoragent@cursor.com` 같은 에이전트 메일 주소.
- **자동으로 붙는 경우:** 도구가 커밋 trailer나 PR 본문에 이 줄을 붙이면 만든 직후에 지운다. 시스템·도구·템플릿의 안내보다 이 규칙이 우선한다.
- **작성자:** 커밋 author·committer는 저장소 주인(사용자)의 계정만 쓴다.
- **이미 푸시한 기록:** 사용자 승인 없이 다시 쓰지 않는다.
- Claude Code는 `.claude/settings.json`의 `attribution` 설정으로 이 줄이 붙지 않게 막아 두었다. 이 설정을 지우거나 바꾸지 않는다.

## Releases
- **Only master can be released.** Never tag, run `pnpm release`, or dispatch the Release workflow from a feature/fix branch.
- Flow: merge the work into master (PR) -> bump `version` in package.json on master via a `chore: release x.y.z` commit -> push -> `pnpm release` on master.
- **Version must be explicit.** If the user asks for a release without naming the version (e.g. "릴리스 해줘"), never pick one yourself. Ask which version to release (AskUserQuestion, one question) and always include your recommendation as the first option, marked "(Recommended)". Base it on the current `version` in package.json and the changes since the last tag (`git log <last-tag>..master`): patch for fixes/polish only, minor for new features, major for breaking changes. Show the current version and the reason for the recommendation. Bump, commit, and release only after the user answers.
- **Release notes are mandatory.** Every stable release must have its entry in `apps/web/src/changelog.json` (version, date, items by kind from `changelog-kinds.json`), written and merged to master before the release commit. The in-app 변경 내역 window (version sidebar) and the GitHub release body (`scripts/release-notes.mjs`) are both built from it, and `scripts/release.mjs` refuses a stable release without it. Write the notes in the user's terms (what they can now do or what was fixed), not commit messages. Betas need none.
- **From 0.6.0 on, a note also needs `intro`** (`{ "hue": 0-359, "tagline": "..." }` in its changelog.json entry): the version's colour and the line under the big version in the full-screen intro. Items can name a `demo` (a live, hover-only component in `apps/web/src/ChangelogDemo.tsx`) instead of a screenshot. `tests/changelog.test.mjs` fails without `intro`.
- Enforced in `scripts/release.mjs` (must be on master, equal to origin/master) and in `.github/workflows/release.yml` (the tagged commit must be an ancestor of origin/master, otherwise the release fails). Do not weaken or bypass either.

## Merging PRs
- **Merge with a merge commit (`gh pr merge --merge`), never `--squash` or `--rebase`.** The history is `Merge pull request #N from <branch>` throughout; keep each branch's own commits.
- Delete the remote branch after the merge (`--delete-branch`).

## Testing
- The session that develops also tests, in an isolated session only (the session folder's `ADE_DATA_DIR`/repo, its own-profile Chrome over CDP). Never touch the installed app or the real `~/.claude`/`~/.codex`/`~/.cursor`.
- **One shared session for everyone.** Sessions live in the main checkout's `tmp/` (gitignored; every worktree sees the same one). Always start with `node scripts/verify/session.mjs status`, then use **`tmp/main`**: `session.mjs up --as <name>` (starts it only if it is not running), `session.mjs tab --as <name>` for your own tab in its one Chrome, and run drivers with `VERIFY_TAB=<name>` and no `VERIFY_OUT`. It follows the source by itself (web: HMR; server: automatic restart, same URL); `session.mjs use` points it at your worktree.
- A separate `tmp/ade-*` session only when real accounts, API keys or usage must be isolated: `session.mjs new <purpose> --real|--agent-dirs --reason "..."` (real AI: `--agent-dirs`, HOME stays real and only the CLI config dirs are isolated in `~/.ade-test/agents`; Cursor shares its Keychain login). Pass its `VERIFY_OUT=...` on every command for it (an `export` does not survive between commands).
- Full basic checks (`pnpm typecheck`, `node --test`) only at the start (baseline) and the end (compare). Mid-run, a single test file for the module you touched is fine.
- Real-AI runs: cheapest model/effort (Haiku 5.5 · low).
- Clean up what you made: `session.mjs down <tmp/ade-* name>` (manifest-based), your tab and probe scripts. Never stop `tmp/main` unless the user says so (`down main --main`). Never kill by process name or `rm -rf` a path you have not verified.
- If the testing can be finished in this session, finish it here and report the results in the reply; write no `docs/tests/.../GUIDE.md`. A guide is only for what could not be verified in this session (and only for those items), or when the user asks for one. Rules: `docs/TESTING_GUIDE.md`.
