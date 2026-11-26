// Full perf suite: isolated session, frame-cost, chat-heavy, memory-soak, stream-jank. Evidence under <VERIFY_OUT>/evidence/.
//   node scripts/perf/suite.mjs [--skip-frame-cost] [--probe-turn] [--down]
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, release, type } from 'node:os';
import { join } from 'node:path';
import { readJson } from '../verify/session-dirs.mjs';
import { ROOT } from '../verify/lib.mjs';

const argv = process.argv.slice(2);
const flag = k => argv.includes(k);
const ACTIVE = join(ROOT, 'tmp', '.perf-session.json');

function runInherit(cmd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('exit', code => (code ? reject(new Error(`${cmd.join(' ')} → ${code}`)) : resolve()));
  });
}

function runCapture(cmd, env = {}, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', c => { out += c; process.stdout.write(c); });
    child.on('exit', code => (code && !allowFail ? reject(new Error(`${cmd.join(' ')} → ${code}`)) : resolve(out)));
  });
}

function lastJsonObject(stdout) {
  const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'));
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
}

function allScenarioJson(stdout) {
  return stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('{') && l.includes('"scenario"')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function main() {
  const t0 = Date.now();
  await runInherit([process.execPath, 'scripts/perf/session.mjs', 'up', '--reason', '전수 성능 suite']);
  const active = readJson(ACTIVE);
  if (!active?.dir) throw new Error('perf session missing');
  const VERIFY = active.dir;
  const env = { VERIFY_OUT: VERIFY, VERIFY_TAB: 'perf' };
  mkdirSync(join(VERIFY, 'evidence'), { recursive: true });

  let display = 'unknown';
  try {
    display = execSync('system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Resolution|Refresh" | head -4 | tr "\\n" "; "', { encoding: 'utf8' }).trim();
  } catch { /* */ }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const meta = {
    at: new Date().toISOString(),
    version: pkg.version,
    commit: execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(),
    platform: `${type()} ${release()}`,
    hostname: hostname(),
    display,
    verifyOut: VERIFY,
  };
  writeFileSync(join(VERIFY, 'evidence', 'env.json'), JSON.stringify(meta, null, 2));

  if (!existsSync(join(ROOT, 'apps/web/dist/index.html'))) {
    console.log('apps/web/dist 없음 → 빌드');
    await runInherit(['pnpm', '--filter', '@mooner/ade-web', 'build']);
  }

  if (!flag('--skip-frame-cost')) {
    console.log('\n=== frame-cost (전 시나리오, ~9분) ===');
    const out = await runCapture([process.execPath, 'scripts/perf/frame-cost.mjs'], env, { allowFail: true });
    const rows = allScenarioJson(out);
    writeFileSync(join(VERIFY, 'evidence', 'frame-cost.json'), JSON.stringify(rows, null, 2));
    if (!rows.length) throw new Error('frame-cost: 결과 없음');
  }

  console.log('\n=== chat-heavy ===');
  await runInherit([process.execPath, 'scripts/perf/chat-heavy.mjs', 'seed'], env);
  await runInherit([process.execPath, 'scripts/perf/reload-tab.mjs'], env);
  await runInherit([process.execPath, 'scripts/perf/chat-heavy.mjs', 'show'], env);
  await runInherit([process.execPath, 'scripts/perf/reload-tab.mjs'], env);
  await runInherit([process.execPath, 'scripts/perf/chat-heavy.mjs', 'show'], env);
  await new Promise(r => setTimeout(r, 6000));
  const chatOut = await runCapture([process.execPath, 'scripts/perf/chat-heavy.mjs', 'run', '6'], env);
  const chatHeavy = lastJsonObject(chatOut);
  if (chatHeavy) writeFileSync(join(VERIFY, 'evidence', 'chat-heavy.json'), JSON.stringify(chatHeavy, null, 2));
  await runInherit([process.execPath, 'scripts/perf/chat-heavy.mjs', 'clean'], env);

  console.log('\n=== memory-soak ===');
  await runInherit([process.execPath, 'scripts/perf/memory-soak.mjs', '--rounds', '12', '--chats', '8'], env);

  console.log('\n=== stream-jank ===');
  await runInherit([process.execPath, 'scripts/perf/stream-jank.mjs', '--lines', '40'], env);

  if (flag('--probe-turn')) {
    console.log('\n=== PROBE ade-chat-turn ===');
    await runInherit([process.execPath, 'scripts/perf/frame-cost.mjs', 'ade-chat-turn'], { ...env, PROBE: '1' });
  }

  meta.elapsedMs = Date.now() - t0;
  writeFileSync(join(VERIFY, 'evidence', 'env.json'), JSON.stringify(meta, null, 2));
  console.log(`\n증거: ${join(VERIFY, 'evidence')}`);
  if (flag('--down')) await runInherit([process.execPath, 'scripts/perf/session.mjs', 'down', '--discard-evidence']);
  else console.log('세션 유지. 내리려면: node scripts/perf/session.mjs down --discard-evidence');
}

await main().catch(e => { console.error(e); process.exit(1); });