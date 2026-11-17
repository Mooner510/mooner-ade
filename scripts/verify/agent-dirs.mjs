import { homedir } from 'node:os'; import { join } from 'node:path'; import { mkdirSync } from 'node:fs';
// Kept apart from lib.mjs: importing lib creates VERIFY_OUT/shots, which agents.mjs must not do.
// AGENT_DIRS=1: the real CLIs (not the fake), signed in with the user's subscription, but each CLI's config dir is private to the tests, so the user's own
// ~/.claude, ~/.codex and ~/.cursor (global CLAUDE.md, hooks, MCP, memory, sessions) are never read or written. HOME stays real: the macOS keychain lookup needs it.
// Default base ~/.ade-test/agents: log in once (agents.mjs login), kept between runs. AGENT_FRESH=1: base inside this session's folder, log in every run, `session.mjs down` removes it.
// Cursor keeps its login in the shared keychain, so only its config/sessions are isolated, not the sign-in.
// usage.js is loaded only for AGENT_FRESH: start-ui imports this file, and a server source mid-edit (a syntax error) must not take the session down with it.
export async function agentDirs(temp) {
  const fresh = Boolean(process.env.AGENT_FRESH), base = fresh ? join(temp, 'agents') : join(homedir(), '.ade-test', 'agents');
  const dirs = { CLAUDE_CONFIG_DIR: join(base, 'claude'), CODEX_HOME: join(base, 'codex'), CURSOR_CONFIG_DIR: join(base, 'cursor') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const keychain = fresh ? (await import('../../apps/local-server/src/usage.js')).claudeKeychainServices({ CLAUDE_CONFIG_DIR: dirs.CLAUDE_CONFIG_DIR })[0] : undefined;
  return { base, fresh, dirs, keychain };
}
