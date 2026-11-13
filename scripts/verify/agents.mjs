// Sign-in state and login of the tests' own CLI dirs (see agentDirs in lib.mjs). No model call.
//   node scripts/verify/agents.mjs status            exit 1 if Claude or Codex is not signed in
//   node scripts/verify/agents.mjs login claude|codex|cursor   interactive, run it in your own terminal (browser OAuth)
// AGENT_FRESH=1 needs the session's folder: it is read from VERIFY_OUT's env.json (or VERIFY_TEMP).
import { spawnSync } from 'node:child_process'; import { existsSync, readFileSync } from 'node:fs'; import { join } from 'node:path';
import { tmpdir } from 'node:os'; import { agentDirs } from './agent-dirs.mjs';
const S = process.env.VERIFY_OUT || join(tmpdir(), 'ade-verify-out');
const recorded = existsSync(join(S, 'env.json')) ? JSON.parse(readFileSync(join(S, 'env.json'), 'utf8')).temp : undefined;
const { base, dirs } = agentDirs(process.env.VERIFY_TEMP || recorded || '/nonexistent'), env = { ...process.env, ...dirs };
// stdout and stderr together: `codex login status` prints "Logged in" on stderr even when it succeeds.
const run = (cmd, args) => { const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }); return `${r.stdout ?? ''}${r.stderr ?? ''}`; };
const login = { claude: ['claude', ['auth', 'login']], codex: ['codex', ['login']], cursor: ['cursor-agent', ['login']] };
const [cmd, which] = process.argv.slice(2);
if (cmd === 'login' && login[which]) process.exit(spawnSync(login[which][0], login[which][1], { env, stdio: 'inherit' }).status ?? 1);
if (cmd !== 'status') { console.log('usage: agents.mjs status | login claude|codex|cursor'); process.exit(2); }
const state = {
  claude: (() => { try { return JSON.parse(run('claude', ['auth', 'status'])).loggedIn === true; } catch { return false; } })(),
  codex: /Logged in/.test(run('codex', ['login', 'status'])),
  cursor: /Logged in/.test(run('cursor-agent', ['status'])), // shared keychain login: not per dir
};
console.log(`dirs: ${base}`);
for (const [name, ok] of Object.entries(state)) console.log(`${name.padEnd(7)} ${ok ? '로그인됨' : '로그인 필요 → node scripts/verify/agents.mjs login ' + name}${name === 'cursor' ? ' (로그인은 Keychain 공유, 설정·세션만 격리)' : ''}`);
process.exit(state.claude && state.codex ? 0 : 1);
