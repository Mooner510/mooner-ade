// The one entry point for verify sessions. Every agent runs this first: it tells whether the shared session runs, who started it and from which
// checkout, so nobody opens a second one by accident. Folders: <main checkout>/tmp (shared by all worktrees), see session-dirs.mjs.
//   node scripts/verify/session.mjs [status]                       what runs, who started it, what to do next
//   node scripts/verify/session.mjs up [--as <이름>] [--source <checkout>]   tmp/main: start it if it is not running (else just print it); reopens a closed Chrome
//   node scripts/verify/session.mjs tab --as <이름> [--close]       a background tab of your own in main's Chrome; then VERIFY_TAB=<이름> for cdp.mjs
//   node scripts/verify/session.mjs use [<checkout>]               main's server follows another checkout/worktree (default: this one). Chrome and data stay
//   node scripts/verify/session.mjs restart [<세션>]                restart a session's server (normally automatic on a server source edit);
//                                                                  with VERIFY_PLUGIN_DIR=<folder> the server also installs that local plugin source
//   node scripts/verify/session.mjs reset                          main with fresh data (first-run screens); everyone using main sees it
//   node scripts/verify/session.mjs new <목적> --real|--agent-dirs|--fresh-agents|--folder-only --reason "<사유>"
//                                                                  an isolated tmp/ade-<목적>-<id>, only for real accounts/API keys/usage (or a bare folder)
//   node scripts/verify/session.mjs down <세션> [--evidence <dir> | --discard-evidence] [--main]   stop and remove (main only with --main, on the user's word)
//   node scripts/verify/session.mjs prune [--legacy] [--dry-run]   remove dead tmp/run-*; --legacy also old ade-verify-* folders in the OS temp dirs
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { HERE, ROOT, MARKER, mainCheckout, tmpRoot, mainDir, sessionDir, isSessionDir, ensureSession, readEnv, readMarker, readJson, commandLines, nodeAndChrome, sessionState, sessionPids, norm, real, branchOf, EXPECT } from './session-dirs.mjs';

const argv = process.argv.slice(2), VALUED = new Set(['--as', '--source', '--reason', '--evidence']);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'status';
const opt = k => { const i = argv.indexOf(k); return i < 0 ? undefined : argv[i + 1]; };
const flag = k => argv.includes(k);
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
const who = opt('--as') || process.env.VERIFY_AGENT || basename(ROOT);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TMP = tmpRoot(), MAIN = mainDir();
const fail = msg => { console.error(msg); process.exit(1); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const when = t => t ? new Date(t).toLocaleString('sv-SE').slice(0, 16) : '?';
const PARENT = real(dirname(mainCheckout())) ?? dirname(mainCheckout()); // the folder holding the main checkout and wt/
const rel = p => p && real(p)?.startsWith(PARENT) ? '…' + real(p).slice(PARENT.length) : p;

function sessions() {
  if (!existsSync(TMP)) return [];
  return readdirSync(TMP, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(TMP, e.name, MARKER)))
    .map(e => ({ name: e.name, dir: join(TMP, e.name), marker: readMarker(join(TMP, e.name)) ?? {}, env: readEnv(join(TMP, e.name)) }))
    .sort((a, b) => (a.name === 'main' ? -1 : b.name === 'main' ? 1 : a.name.localeCompare(b.name)));
}
const stateOf = (env, cmds = commandLines(sessionPids(env))) => sessionState(env, cmds);
const running = st => st.owner && st.servers.length > 0 && st.chrome;

function describe(x, st) {
  const e = x.env ?? {}, label = running(st) ? '실행 중' : st.owner ? '일부 멈춤' : x.marker.kind === 'folder' ? '' : '꺼짐';
  console.log(`\n● ${x.name}  ${label}${e.mode && e.mode !== 'dummy' ? `  [${e.mode}]` : ''}${x.marker.reason ? `  사유: ${x.marker.reason}` : ''}`);
  if (!e.pid) { console.log(x.marker.kind === 'folder' ? `  폴더만(프로세스 없음)  VERIFY_OUT=${x.dir}` : '  (기록 없음: 한 번도 뜨지 않았습니다)'); return; }
  if (st.owner) console.log(`  주소   ${e.url}`);
  console.log(`  Chrome ${st.chrome ? `${e.cdp}  (pid ${e.chromePid})` : '닫힘'}`);
  console.log(`  서버   ${st.servers.length ? `pid ${st.servers.join(', ')}` : '멈춤'}${e.serverError ? `  오류: ${e.serverError.split('\n')[0].slice(0, 200)}` : ''}`);
  console.log(`  소스   ${rel(e.source)} (${e.branch})${e.plugins ? '' : '  플러그인 검증 꺼짐(옛 checkout)'}`);
  console.log(`  시작   ${when(e.startedAt)} by ${e.startedBy ?? '?'}   start-ui pid ${e.pid}${st.owner ? '' : ' (종료됨)'}`);
  const tabs = readJson(join(x.dir, 'tabs.json')) ?? {};
  if (Object.keys(tabs).length) console.log(`  탭     ${Object.entries(tabs).map(([k, v]) => `${k}(${v.targetId.slice(0, 6)})`).join(', ')}`);
  if (x.name !== 'main') console.log(`  사용   VERIFY_OUT=${x.dir}`);
}

function status() {
  const list = sessions(), cmds = commandLines(list.flatMap(x => sessionPids(x.env)));
  console.log(`세션 폴더: ${TMP}`);
  const main = list.find(x => x.name === 'main');
  for (const x of list.filter(x => x.marker.kind !== 'run')) describe(x, stateOf(x.env, cmds));
  const st = main ? stateOf(main.env, cmds) : { owner: false, servers: [], chrome: false };
  console.log('\n판정');
  if (running(st)) {
    console.log('  → main이 실행 중입니다. 새로 띄우지 말고 이 세션을 쓰세요(드라이버 스크립트는 VERIFY_OUT 없이 main을 씁니다).');
    console.log(`  → 내 탭이 필요하면: node scripts/verify/session.mjs tab --as <이름>  그다음 VERIFY_TAB=<이름>`);
    if (main.env.source && real(main.env.source) !== real(ROOT)) console.log(`  → main의 소스는 ${rel(main.env.source)}입니다. 이 checkout(${rel(ROOT)})의 변경을 보려면 \`session.mjs use\` (다른 에이전트 화면도 바뀌니 status의 시작자를 확인).`);
  } else if (st.owner && !st.chrome) console.log('  → main의 Chrome이 닫혀 있습니다. `session.mjs up`이 Chrome만 다시 엽니다.');
  else if (st.owner) console.log('  → main의 서버가 멈춰 있습니다(위 오류). 서버 소스를 고치면 자동으로 다시 뜨고, `session.mjs restart`로도 됩니다.');
  else console.log('  → main이 꺼져 있습니다. `session.mjs up`으로 띄우세요(이전 데이터와 Chrome 프로필은 유지).');
  const runs = list.filter(x => x.marker.kind === 'run'), deadRuns = runs.filter(x => !alive(x.marker.pid));
  if (runs.length) console.log(`  · 일회용 run-* ${runs.length}개${deadRuns.length ? ` (주인이 끝난 ${deadRuns.length}개 → \`session.mjs prune\`)` : ''}`);
  const legacy = legacyDirs();
  if (legacy.length) console.log(`  · OS 임시 폴더의 옛 ade-verify-* ${legacy.length}개 → \`session.mjs prune --legacy\` (쓰는 중인 것은 남김)`);
}

// ---- start-ui and its control file
function spawnStartUi(dir, env) {
  mkdirSync(dir, { recursive: true });
  const log = openSync(join(dir, 'start-ui.log'), 'a');
  const clean = { ...process.env }; for (const k of ['REAL_AGENTS', 'AGENT_DIRS', 'AGENT_FRESH', 'VERIFY_OUT', 'VERIFY_TEMP', 'VERIFY_CHROME', 'VERIFY_REASON', 'VERIFY_SOURCE']) delete clean[k];
  const child = spawn(process.execPath, [join(HERE, 'start-ui.mjs')], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...clean, VERIFY_OUT: dir, VERIFY_AGENT: who, ...env } });
  closeSync(log);
  let exited = null; child.on('exit', code => { exited = code ?? 'signal'; });
  return { child, exited: () => exited };
}
async function waitReady(dir, started) {
  for (let i = 0; i < 1200; i++) {
    const env = readEnv(dir); if (env?.pid === started.child.pid && env.cdp) { started.child.unref(); return env; }
    if (started.exited() !== null) break; await sleep(100);
  }
  const tail = (() => { try { return readFileSync(join(dir, 'start-ui.log'), 'utf8').split('\n').slice(-15).join('\n'); } catch { return ''; } })();
  fail(`start-ui가 준비되지 않았습니다(종료 코드 ${started.exited()}). ${join(dir, 'start-ui.log')}\n${tail}`);
}
async function control(dir, action, extra = {}) {
  const env = readEnv(dir); if (!stateOf(env).owner) fail(`${basename(dir)} 세션이 꺼져 있습니다. 먼저 \`session.mjs up\`(main) 또는 \`new\`.`);
  const id = randomBytes(6).toString('hex'), pluginDir = process.env.VERIFY_PLUGIN_DIR && resolve(process.env.VERIFY_PLUGIN_DIR);
  writeFileSync(join(dir, 'control.json'), JSON.stringify({ id, action, by: who, ...(pluginDir && { pluginDir }), ...extra }));
  for (let i = 0; i < 1200; i++) { const now = readEnv(dir); if (now?.lastControl === id) return now; await sleep(100); }
  fail('start-ui가 요청을 처리하지 않았습니다(120초). start-ui.log를 확인하세요.');
}
function report(env) {
  console.log(`주소   ${env.url}\nCDP    ${env.cdp}\n소스   ${rel(env.source)} (${env.branch})`);
  if (env.serverError) console.log(`서버 오류: ${env.serverError}`);
}

async function withLock(fn) { // two agents calling `up` at the same moment start one session
  mkdirSync(TMP, { recursive: true }); const lock = join(TMP, 'main.lock');
  for (let i = 0; ; i++) {
    try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = Number(readFileSync(lock, 'utf8')); if (!holder || !alive(holder)) { rmSync(lock, { force: true }); continue; }
      if (i === 0) console.log(`다른 에이전트(pid ${holder})가 main을 띄우는 중입니다. 기다립니다…`);
      if (i > 1500) fail('잠금을 150초 안에 얻지 못했습니다.'); await sleep(100);
    }
  }
  try { return await fn(); } finally { rmSync(lock, { force: true }); }
}

async function up() {
  await withLock(async () => {
    const env = readEnv(MAIN), st = stateOf(env);
    if (st.owner) {
      if (!st.chrome) { console.log('main의 Chrome이 닫혀 있어 다시 엽니다.'); report(await control(MAIN, 'chrome')); return; }
      console.log(`main이 이미 실행 중입니다(시작 ${when(env.startedAt)}, by ${env.startedBy}). 새로 띄우지 않았습니다.`); report(env);
      if (real(env.source) !== real(ROOT)) console.log(`참고: 소스가 이 checkout(${rel(ROOT)})이 아닙니다. 바꾸려면 \`session.mjs use\`.`);
      return;
    }
    ensureSession(MAIN, { kind: 'main' });
    console.log('main을 띄웁니다(서버·가짜 Hub·Chrome).');
    report(await waitReady(MAIN, spawnStartUi(MAIN, { VERIFY_SOURCE: resolve(opt('--source') ?? ROOT) })));
  });
}

async function tab() {
  if (!opt('--as')) fail('탭 이름을 주세요: session.mjs tab --as <이름>');
  const dir = positional[0] ? sessionDir(positional[0]) : MAIN, env = readEnv(dir);
  if (!running(stateOf(env))) fail(`${basename(dir)} 세션이 실행 중이 아닙니다. \`session.mjs status\`.`);
  const file = join(dir, 'tabs.json'), tabs = readJson(file) ?? {};
  const pages = await (await fetch(`${env.cdp}/json/list`)).json(), open = tabs[who] && pages.some(p => p.id === tabs[who].targetId);
  const browser = async (method, params) => {
    const WebSocket = createRequire(join(ROOT, 'apps/local-server/package.json'))('ws');
    const ws = new WebSocket((await (await fetch(`${env.cdp}/json/version`)).json()).webSocketDebuggerUrl); await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.send(JSON.stringify({ id: 1, method, params }));
    try { return await new Promise((r, j) => ws.on('message', m => { const msg = JSON.parse(m); if (msg.id === 1) msg.error ? j(new Error(msg.error.message)) : r(msg.result); })); } finally { ws.close(); }
  };
  if (flag('--close')) {
    if (open) await browser('Target.closeTarget', { targetId: tabs[who].targetId });
    delete tabs[who]; writeFileSync(file, JSON.stringify(tabs, null, 2));
    console.log(open ? `탭 ${who}을 닫았습니다.` : `열린 탭 ${who}이 없습니다.`); return;
  }
  if (open) { console.log(`이미 있는 탭을 씁니다.\nVERIFY_TAB=${who}`); return; }
  // background: the new tab does not take the window's focus (the user keeps working while tests run)
  const { targetId } = await browser('Target.createTarget', { url: env.url, background: true });
  tabs[who] = { targetId, at: Date.now() }; writeFileSync(file, JSON.stringify(tabs, null, 2));
  console.log(`탭을 열었습니다(백그라운드).\nVERIFY_TAB=${who}`);
}

async function newSession() {
  const purpose = (positional[0] ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30), reason = opt('--reason');
  const mode = ['--real', '--agent-dirs', '--fresh-agents', '--folder-only'].filter(flag);
  if (!purpose || !reason || mode.length !== 1) fail('사용법: session.mjs new <목적> --real|--agent-dirs|--fresh-agents|--folder-only --reason "<사유>"\n격리 세션은 실제 계정·API 키·사용량을 분리해야 할 때만 씁니다. UI·플러그인·서버 로직은 main으로 확인합니다.');
  const name = `ade-${purpose}-${randomBytes(3).toString('hex')}`, dir = sessionDir(name);
  ensureSession(dir, { kind: mode[0] === '--folder-only' ? 'folder' : 'isolated', mode: mode[0].slice(2), reason, startedBy: who });
  if (mode[0] === '--folder-only') { console.log(`빈 세션 폴더를 만들었습니다(프로세스 없음).\nVERIFY_OUT=${dir}`); return; }
  const env = { '--real': { REAL_AGENTS: '1' }, '--agent-dirs': { AGENT_DIRS: '1' }, '--fresh-agents': { AGENT_DIRS: '1', AGENT_FRESH: '1' } }[mode[0]];
  console.log(`격리 세션 ${name}을 띄웁니다(자기 Chrome 사용).`);
  report(await waitReady(dir, spawnStartUi(dir, { ...env, VERIFY_REASON: reason, VERIFY_SOURCE: resolve(opt('--source') ?? ROOT) })));
  console.log(`이 세션의 스크립트에는 VERIFY_OUT=${dir} 를 붙입니다. 끝나면: node scripts/verify/session.mjs down ${name} --discard-evidence`);
}

// ---- stopping: only PIDs recorded in env.json whose command line still matches, the whole tree (plugin hosts, Chrome's helpers)
// tree: also the process's children by parent PID (server: plugin hosts; Chrome: its helpers). Not for start-ui: Windows counts the detached Chrome as its child.
async function kill(label, pid, expect, tree = true) {
  const c = commandLines([pid]).get(pid); if (!pid || c === undefined) return console.log(`이미 없음 ${label}`);
  if (!norm(c).includes(norm(expect))) return console.log(`건너뜀   ${label} (pid ${pid}는 다른 프로세스: ${c.slice(0, 60)})`);
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(pid), ...(tree ? ['/T'] : []), '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ } }
  else { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } for (let i = 0; i < 50 && alive(pid); i++) await sleep(100); if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  console.log(`종료     ${label} (pid ${pid})`);
}
async function removeDir(dir) {
  if (flag('--dry-run')) { console.log(`지울 것   ${dir}`); return true; }
  for (let i = 0; i < 40; i++) { try { rmSync(dir, { recursive: true, force: true }); console.log(`삭제     ${dir}`); return true; } catch (e) { if (i === 39) { console.log(`실패     ${dir}: ${e.code} (잠긴 파일이 있습니다. 잠시 뒤 다시 실행하세요)`); return false; } await sleep(250); } }
}

async function down() {
  const name = positional[0]; if (!name) fail('사용법: session.mjs down <세션> [--evidence <dir> | --discard-evidence] [--main]');
  const dir = sessionDir(name);
  if (!isSessionDir(dir) || dirname(real(dir)) !== real(TMP)) fail(`세션 폴더가 아닙니다: ${dir}`);
  if (name === 'main' && !flag('--main')) fail('main은 모두가 함께 쓰는 세션입니다. 사용자가 끄라고 했을 때만 --main을 붙여 내립니다.');
  const env = readEnv(dir) ?? {};
  const shots = existsSync(join(dir, 'shots')) ? readdirSync(join(dir, 'shots')) : [], results = readdirSync(dir).filter(n => /^results-.*\.json$/.test(n));
  if ((shots.length || results.length) && !opt('--evidence') && !flag('--discard-evidence')) fail(`증거 ${shots.length + results.length}개가 있습니다. --evidence <dir>로 옮기거나 --discard-evidence로 버리세요.`);
  if (opt('--evidence')) { const to = join(resolve(opt('--evidence')), 'evidence'); if (shots.length) cpSync(join(dir, 'shots'), to, { recursive: true }); for (const r of results) cpSync(join(dir, r), join(to, r)); console.log(`보관     증거 → ${to}`); }
  await kill('start-ui', env.pid, EXPECT.startUi, false); // first, so it does not restart the server
  for (const pid of env.serverPids ?? []) await kill('서버', pid, EXPECT.server);
  await kill('Chrome', env.chromePid, env.chromeProfile ?? '\0');
  cleanAgentTraces(env, name);
  await removeDir(dir);
}
// With the kept ~/.ade-test/agents, remove only this session's transcripts: their paths contain the session folder's unique name.
function cleanAgentTraces(env, tag) {
  if (env.keychain?.startsWith('Claude Code-credentials-') && process.platform === 'darwin') { try { execFileSync('security', ['delete-generic-password', '-s', env.keychain], { stdio: 'ignore' }); console.log(`삭제     Keychain ${env.keychain}`); } catch { /* none */ } }
  if (!env.agentBase || env.agentFresh || !tag.startsWith('ade-')) return;
  const claude = join(env.agentBase, 'claude'), codex = join(env.agentBase, 'codex');
  const mine = p => { try { return statSync(p).size < 5e6 && readFileSync(p, 'utf8').includes(tag); } catch { return false; } };
  const walk = d => { try { return readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : e.isFile() ? [join(d, e.name)] : []); } catch { return []; } };
  for (const n of existsSync(join(claude, 'projects')) ? readdirSync(join(claude, 'projects')).filter(n => n.includes(tag)) : []) { rmSync(join(claude, 'projects', n), { recursive: true, force: true }); console.log(`삭제     claude/projects/${n}`); }
  for (const f of walk(join(claude, 'sessions')).concat(walk(join(codex, 'sessions'))).filter(mine)) { rmSync(f, { force: true }); console.log(`삭제     ${f.replace(env.agentBase, '~agents')}`); }
  const cfg = join(claude, '.claude.json'); try { const j = JSON.parse(readFileSync(cfg, 'utf8')), keys = Object.keys(j.projects ?? {}).filter(k => k.includes(tag)); if (keys.length) { for (const k of keys) delete j.projects[k]; writeFileSync(cfg, JSON.stringify(j, null, 2)); console.log(`삭제     .claude.json projects ${keys.length}개`); } } catch { /* none */ }
  const left = walk(env.agentBase).filter(f => f.includes(tag) || mine(f)); // what the rules above do not know (e.g. Cursor chats): report, never guess-delete
  if (left.length) console.log(`주의     남은 흔적 ${left.length}개, 직접 확인: ${left.slice(0, 5).join(', ')}`);
}

// ---- leftovers
function tempRoots() { return [...new Set([tmpdir(), process.env.TEMP, process.env.TMP, process.env.TMPDIR, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Temp')].filter(Boolean).map(real).filter(Boolean))]; }
function legacyDirs() { return tempRoots().flatMap(root => { try { return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && /^ade-verify-/.test(e.name)).map(e => join(root, e.name)); } catch { return []; } }); }
async function prune() {
  for (const x of sessions().filter(x => x.marker.kind === 'run' && !alive(x.marker.pid))) await removeDir(x.dir);
  if (!flag('--legacy')) { const n = legacyDirs().length; if (n) console.log(`OS 임시 폴더의 옛 ade-verify-* ${n}개는 --legacy로 정리합니다.`); return; }
  // An old folder is in use when a live process records it (env.json PIDs that still match) or a live node/Chrome names it on its command line.
  const dirs = legacyDirs(), procs = nodeAndChrome(), cmds = new Map(procs), used = new Set();
  for (const d of dirs) {
    const env = readEnv(d); if (!env) continue;
    const st = sessionState(env, cmds); if (!(st.owner || st.servers.length || st.chrome)) continue;
    for (const p of [d, env.temp, env.temp2, env.chromeProfile]) if (p) used.add(norm(real(p) ?? p));
  }
  const named = d => procs.some(([, c]) => norm(c).includes(norm(d)));
  const recent = d => { const t = [d, join(d, 'data')].map(p => { try { return statSync(p).mtimeMs; } catch { return 0; } }); return Date.now() - Math.max(...t) < 2 * 3600e3; };
  for (const d of dirs) {
    if (used.has(norm(d)) || named(d)) { console.log(`남김     ${d} (실행 중인 세션이 씀)`); continue; }
    if (recent(d)) { console.log(`남김     ${d} (2시간 안에 바뀜: 누가 쓰는 중일 수 있음)`); continue; }
    await removeDir(d);
  }
}

const commands = { status, up, tab, new: newSession, down, prune,
  restart: async () => report(await control(positional[0] ? sessionDir(positional[0]) : MAIN, 'restart')),
  use: async () => { const to = resolve(positional[0] ?? ROOT); console.log(`main의 소스를 ${rel(to)} (${branchOf(to)})로 바꿉니다. main을 보는 다른 에이전트의 화면도 바뀝니다.`); report(await control(MAIN, 'source', { source: to })); },
  reset: async () => { console.log('main의 데이터(data·home·repo)를 비우고 서버를 다시 띄웁니다. Chrome 프로필은 그대로입니다.'); report(await control(MAIN, 'reset')); } };
if (!commands[cmd]) fail(`알 수 없는 명령: ${cmd}\n${readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//   ')).join('\n')}`);
await commands[cmd]();
