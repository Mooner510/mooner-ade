// Dummy isolated verify session for perf (own Chrome + ADE_DATA_DIR). Does not use tmp/main.
//   node scripts/perf/session.mjs up [--reason "..."]
//   node scripts/perf/session.mjs down [--discard-evidence]
//   node scripts/perf/session.mjs status
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandLines, ensureSession, readEnv, readJson, sessionDir, sessionPids, sessionState, tmpRoot } from '../verify/session-dirs.mjs';
import { ROOT, sleep } from '../verify/lib.mjs';

const HERE = join(fileURLToPath(import.meta.url), '..');
const VERIFY = join(HERE, '..', 'verify');
const ACTIVE = () => join(tmpRoot(), '.perf-session.json');
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'status';
const opt = k => { const i = argv.indexOf(k); return i < 0 ? undefined : argv[i + 1]; };
const flag = k => argv.includes(k);
const who = process.env.VERIFY_AGENT || 'perf';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const fail = msg => { console.error(msg); process.exit(2); };

function spawnStartUi(dir, reason) {
  mkdirSync(dir, { recursive: true });
  const log = openSync(join(dir, 'start-ui.log'), 'a');
  const clean = { ...process.env };
  for (const k of ['REAL_AGENTS', 'AGENT_DIRS', 'AGENT_FRESH', 'VERIFY_OUT', 'VERIFY_TEMP', 'VERIFY_CHROME', 'VERIFY_REASON', 'VERIFY_SOURCE']) delete clean[k];
  const child = spawn(process.execPath, [join(VERIFY, 'start-ui.mjs')], {
    cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    env: { ...clean, VERIFY_OUT: dir, VERIFY_AGENT: who, VERIFY_REASON: reason, VERIFY_SOURCE: ROOT },
  });
  closeSync(log);
  let exited = null; child.on('exit', code => { exited = code ?? 'signal'; });
  return { child, exited: () => exited };
}

async function waitReady(dir, started) {
  for (let i = 0; i < 1200; i++) {
    const env = readEnv(dir);
    if (env?.pid === started.child.pid && env.cdp) { started.child.unref(); return env; }
    if (started.exited() !== null) break;
    await sleep(100);
  }
  const tail = (() => { try { return readFileSync(join(dir, 'start-ui.log'), 'utf8').split('\n').slice(-15).join('\n'); } catch { return ''; } })();
  fail(`start-ui가 준비되지 않았습니다. ${join(dir, 'start-ui.log')}\n${tail}`);
}

async function openTab(env, tabName) {
  const WebSocket = createRequire(join(ROOT, 'apps/local-server/package.json'))('ws');
  const browser = async (method, params) => {
    const ws = new WebSocket((await (await fetch(`${env.cdp}/json/version`)).json()).webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.send(JSON.stringify({ id: 1, method, params }));
    try { return await new Promise((r, j) => ws.on('message', m => { const msg = JSON.parse(m); if (msg.id === 1) msg.error ? j(new Error(msg.error.message)) : r(msg.result); })); }
    finally { ws.close(); }
  };
  const file = join(env.temp, 'tabs.json'), tabs = readJson(file) ?? {};
  if (tabs[tabName]) {
    const pages = await (await fetch(`${env.cdp}/json/list`)).json();
    if (pages.some(p => p.id === tabs[tabName].targetId)) return tabs[tabName].targetId;
  }
  const { targetId } = await browser('Target.createTarget', { url: env.url, background: true });
  tabs[tabName] = { targetId, at: Date.now() };
  writeFileSync(file, JSON.stringify(tabs, null, 2));
  return targetId;
}

async function up() {
  const reason = opt('--reason') ?? '전수 성능';
  const existing = readJson(ACTIVE());
  const prevEnv = existing?.dir ? readEnv(existing.dir) : null;
  if (prevEnv && sessionState(prevEnv, commandLines(sessionPids(prevEnv))).owner) {
    console.log(`이미 떠 있습니다: ${existing.name}\nVERIFY_OUT=${existing.dir}\nVERIFY_TAB=perf`);
    return;
  }
  const name = `ade-perf-${randomBytes(3).toString('hex')}`, dir = sessionDir(name);
  ensureSession(dir, { kind: 'isolated', mode: 'dummy', reason, startedBy: who });
  console.log(`격리 perf 세션 ${name} 기동 중…`);
  const env = await waitReady(dir, spawnStartUi(dir, reason));
  await openTab(env, 'perf');
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  writeFileSync(ACTIVE(), JSON.stringify({ name, dir, reason, startedAt: Date.now() }, null, 2));
  console.log(`준비됨\nVERIFY_OUT=${dir}\nVERIFY_TAB=perf\n이름: ${name}`);
}

function status() {
  const existing = readJson(ACTIVE());
  if (!existing?.dir) { console.log('perf 격리 세션이 없습니다. `session.mjs up`'); return; }
  const env = readEnv(existing.dir), st = sessionState(env ?? {}, commandLines(sessionPids(env ?? {})));
  console.log(`이름   ${existing.name}\n폴더   ${existing.dir}\n실행   ${st.owner ? '예' : '아니오'}`);
  if (env?.url) console.log(`주소   ${env.url}`);
}

async function down() {
  const existing = readJson(ACTIVE());
  if (!existing?.name) fail('활성 perf 세션이 없습니다.');
  const args = ['scripts/verify/session.mjs', 'down', existing.name];
  if (flag('--discard-evidence')) args.push('--discard-evidence');
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  const code = await new Promise(r => child.on('exit', r));
  rmSync(ACTIVE(), { force: true });
  if (code) process.exit(code ?? 1);
  console.log('perf 세션을 내렸습니다.');
}

const commands = { up, down, status };
if (!commands[cmd]) fail(`사용법: session.mjs up [--reason "..."] | down [--discard-evidence] | status`);
await commands[cmd]();