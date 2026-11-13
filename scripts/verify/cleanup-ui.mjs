// Tear down ONE verify session from its env.json (VERIFY_OUT): only what the session recorded, never by process name, only under the OS temp dir.
//   node scripts/verify/cleanup-ui.mjs --evidence <dir>      copy shots/results into <dir>/evidence, then clean up
//   node scripts/verify/cleanup-ui.mjs --discard-evidence    clean up without keeping shots/results
//   node scripts/verify/cleanup-ui.mjs --list                leftover ade-verify-* folders in the temp dir (nothing is removed)
// Removes: start-ui/server/Chrome processes (checked against their command line first), the session's temp (data, repo, HOME), the Chrome profile, VERIFY_OUT,
// and, with AGENT_FRESH, the Claude keychain entry. With the kept ~/.ade-test/agents it removes only this session's transcripts (matched by the temp folder's unique name).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { basename, join, sep } from 'node:path';
const S = process.env.VERIFY_OUT || join(tmpdir(), 'ade-verify-out'), sleep = ms => new Promise(r => setTimeout(r, ms));
const TMP = realpathSync(tmpdir()), args = process.argv.slice(2), arg = k => { const i = args.indexOf(k); return i < 0 || args[i + 1]?.startsWith('--') ? undefined : args[i + 1]; };
const inTmp = p => { try { const r = realpathSync(p); return r.startsWith(TMP + sep); } catch { return false; } };
if (args.includes('--list')) {
  for (const n of readdirSync(TMP).filter(n => /^ade-verify-/.test(n))) console.log(n.padEnd(40), `${Math.round((Date.now() - statSync(join(TMP, n)).mtimeMs) / 60000)}분 전`);
  process.exit(0);
}
const file = join(S, 'env.json'); if (!existsSync(file)) { console.log(`세션 없음: ${file}`); process.exit(1); }
const env = JSON.parse(readFileSync(file, 'utf8')), shots = existsSync(join(S, 'shots')) ? readdirSync(join(S, 'shots')) : [], results = readdirSync(S).filter(n => /^results-.*\.json$/.test(n));
if ((shots.length || results.length) && !arg('--evidence') && !args.includes('--discard-evidence')) { console.log(`증거 ${shots.length + results.length}개가 있습니다. --evidence <dir>로 옮기거나 --discard-evidence로 버리세요.`); process.exit(1); }
const say = (what, how) => console.log(`${how.padEnd(8)} ${what}`);
if (arg('--evidence')) { const to = join(arg('--evidence'), 'evidence'); cpSync(join(S, 'shots'), to, { recursive: true }); for (const r of results) cpSync(join(S, r), join(to, r)); say(`증거 → ${to}`, '보관'); }

const cmd = pid => { try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const stop = async (name, pid, expect) => { // PIDs are reused by the OS: kill only if the command line is still the one recorded
  const c = cmd(pid); if (!pid || !c) return say(name, '이미 없음'); if (!c.includes(expect)) return say(`${name} (pid ${pid}는 다른 프로세스: ${c.slice(0, 50)})`, '건너뜀');
  process.kill(pid, 'SIGTERM'); for (let i = 0; i < 50 && cmd(pid); i++) await sleep(100); if (cmd(pid)) process.kill(pid, 'SIGKILL'); say(name, '종료');
};
await stop('start-ui', env.pid, 'start-ui.mjs'); // its SIGTERM handler also stops the servers and fake Hub
for (const pid of env.serverPids ?? []) await stop('서버', pid, 'local-server/src/index.js');
await stop('Chrome', env.chromePid, env.chromeProfile ?? '\0');

const rm = (p, prefix) => { if (p && existsSync(p) && inTmp(p) && basename(p).startsWith(prefix)) { rmSync(p, { recursive: true, force: true }); say(p, '삭제'); } else if (p) say(`${p} (없거나 임시 폴더 밖/이름 불일치)`, '건너뜀'); };
const tag = basename(env.temp ?? ''); // mkdtemp's random name: unique to this session, appears in the transcript paths of every CLI that ran in its repo
if (env.agentBase && !env.agentFresh && tag.startsWith('ade-verify-')) {
  const claude = join(env.agentBase, 'claude'), codex = join(env.agentBase, 'codex');
  const mine = p => { try { return statSync(p).size < 5e6 && readFileSync(p, 'utf8').includes(tag); } catch { return false; } };
  const walk = dir => { try { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []); } catch { return []; } };
  for (const n of existsSync(join(claude, 'projects')) ? readdirSync(join(claude, 'projects')).filter(n => n.includes(tag)) : []) { rmSync(join(claude, 'projects', n), { recursive: true, force: true }); say(`claude/projects/${n}`, '삭제'); }
  for (const f of walk(join(claude, 'sessions')).concat(walk(join(codex, 'sessions'))).filter(mine)) { rmSync(f, { force: true }); say(f.replace(env.agentBase, '~agents'), '삭제'); }
  const cfg = join(claude, '.claude.json'); try { const j = JSON.parse(readFileSync(cfg, 'utf8')), keys = Object.keys(j.projects ?? {}).filter(k => k.includes(tag)); if (keys.length) { for (const k of keys) delete j.projects[k]; writeFileSync(cfg, JSON.stringify(j, null, 2)); say(`.claude.json projects ${keys.length}개`, '삭제'); } } catch {}
  const left = walk(env.agentBase).filter(f => f.includes(tag) || mine(f)); // what the rules above do not know (e.g. Cursor chats): report, never guess-delete
  if (left.length) say(`남은 흔적 ${left.length}개, 직접 확인: ${left.slice(0, 5).join(', ')}`, '주의');
}
if (env.keychain?.startsWith('Claude Code-credentials-')) { try { execFileSync('security', ['delete-generic-password', '-s', env.keychain], { stdio: 'ignore' }); say(`Keychain ${env.keychain}`, '삭제'); } catch { say(`Keychain ${env.keychain}`, '없음'); } }
rm(env.temp, 'ade-verify-'); rm(env.chromeProfile, 'ade-verify-chrome-');
if (inTmp(S)) { rmSync(S, { recursive: true, force: true }); say(S, '삭제'); } else say(`${S} (임시 폴더 밖)`, '건너뜀');
