import fs from 'node:fs/promises';
import path from 'node:path';
import { writeIfChanged } from './file-util.js';

// No AI agent leaves its own signature (Co-Authored-By trailer, "Generated with ..." line) in a user's commits or PRs.
// Two layers, because no single switch covers every agent:
//  1. Claude: its settings say not to add the trailer / PR line at all (merged into the --settings file ADE already passes).
//  2. Every chat agent (Claude, Codex, Cursor): the process gets a git hooks directory through its environment only. Its commit-msg hook removes
//     the signature lines (Cursor adds its trailer to the `git commit` call itself, before any hook), then each hook hands over to the
//     repository's own hook of the same name, so husky and friends keep working. Nobody's git config is changed, and terminals are untouched.
export const ATTRIBUTION_OFF = { attribution: { commit: '', pr: '', sessionUrl: false } };

const SIGNATURE_LINES = String.raw`/^[[:space:]]*[Cc]o-[Aa]uthored-[Bb]y:/d; /^[[:space:]]*(🤖 )?[Gg]enerated with .*(Claude|Cursor|Codex)/d; /^[[:space:]]*[Mm]ade[- ]with:? *Cursor/d`;

const HOOK = `#!/bin/sh
# MoonerADE: removes agent signature lines from the commit message, then runs the repository's own hook of this name, if any.
name=$(basename "$0")
if [ "$name" = commit-msg ] && [ -n "$1" ]; then
  sed -i.ade-bak -E '${SIGNATURE_LINES}' "$1" && rm -f "$1.ade-bak"
fi
dir=$(GIT_CONFIG_COUNT=0 git rev-parse --git-path hooks 2>/dev/null)
if [ -n "$dir" ] && [ -x "$dir/$name" ]; then exec "$dir/$name" "$@"; fi
exit 0
`;

// Hooks a commit, merge, rebase, checkout or push can run. The hooks dir replaces the repository's, so each one forwards.
const HOOK_NAMES = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit',
  'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-auto-gc', 'post-rewrite'];

// Writes the hooks directory (only the files whose content changed) and returns the environment that points git at it.
// An existing GIT_CONFIG_COUNT of the server's own environment is continued, not replaced.
export async function signatureGuard(dataRoot, base = process.env) {
  const dir = path.join(dataRoot, 'launch', 'git-hooks');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await Promise.all(HOOK_NAMES.map(name => writeIfChanged(path.join(dir, name), HOOK, 0o700)));
  const index = Number.parseInt(base.GIT_CONFIG_COUNT, 10) || 0;
  return {
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${index}`]: dir.replaceAll('\\', '/')
  };
}
