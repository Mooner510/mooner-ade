// Frame cost (CPU) of ADE vs a blank Electron window, same harness, same display. Results/how to read them: docs/perf/FRAME_COST.md
//   pnpm --filter @mooner/ade-web build   (ade-* scenarios load apps/web/dist)
//   VERIFY_OUT=$(mktemp -d -t ade-verify-out) node scripts/perf/frame-cost.mjs [scenario ...]
// Scenarios: see ALL below and the ablation keys in electron/main.cjs. PROBE=1 also prints running animations, composited layers, rAF callers,
// main-thread metrics and a 2 s trace of style invalidations (diagnosis only; the probes skew that run's numbers).
// The window stays invisible and never takes focus (SHOW=1 to watch). Other heavy work on the Mac still shows up in the numbers.
import { spawn, execSync } from 'node:child_process'; import { createRequire } from 'node:module'; import { mkdtemp, rm } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { boot, sleep, ROOT, S } from '../verify/lib.mjs';
const ALL = ['blank-idle', 'blank-spinner', 'blank-webgl', 'ade-idle', 'ade-spinner', 'ade-chat', 'ade-chat-spinner', 'ade-chat-turn',
  'ade-chat-turn-nospin', 'ade-chat-turn-nobreathe', 'ade-chat-turn-noring', 'ade-chat-turn-freezering', 'ade-chat-turn-still', 'ade-chat-turn-still-noring', 'ade-chat-turn-still-freezering', 'ade-chat-turn-nospin-nobreathe-noring-spinner', 'ade-chat-turn-nospin-nobreathe-freezering-spinner'];
const WARM = 5000, WINDOW = 15000;
const electron = createRequire(join(ROOT, 'apps/desktop/package.json'))('electron');
const HERE = join(ROOT, 'scripts/perf/electron');
// CPU seconds per Chromium process type (--type=renderer|gpu-process|utility, none = browser) under one root pid
const cpu = root => {
  const rows = execSync('ps -A -o pid=,ppid=,time=,args=', { maxBuffer: 1 << 24 }).toString().trim().split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean);
  const ids = new Set([String(root)]); for (let grew = true; grew;) { grew = false; for (const r of rows) if (ids.has(r[2]) && !ids.has(r[1])) { ids.add(r[1]); grew = true; } }
  const sec = t => t.split(':').reduce((a, v) => a * 60 + +v, 0), out = {};
  for (const r of rows) if (ids.has(r[1])) { const k = /--type=(\S+)/.exec(r[4])?.[1] ?? 'browser'; out[k] = (out[k] ?? 0) + sec(r[3]); }
  return out;
};
const results = [];
for (const sc of process.argv.slice(2).length ? process.argv.slice(2) : ALL) {
  const s = sc.startsWith('ade') ? await boot() : null; await s?.setCtl({ slowms: 120000 });
  // past the first-run tutorial, with the temp repo open (the state a returning user sees); the rest of the settings are the app defaults
  await s?.api('app/state', { state: { openProjects: [{ id: s.projectId, root: s.repo }], activeProjectId: s.projectId, settings: { onboarded: true, tourVersion: 2 } } });
  const target = s ? `${s.origin}/#token=${s.token}` : `file://${HERE}/blank.html?mode=${sc.slice(6)}`;
  const ud = await mkdtemp(join(tmpdir(), 'ade-perf-ud-'));
  const p = spawn(electron, [HERE, `--user-data-dir=${ud}`], { env: { ...process.env, SCENARIO: sc, TARGET: target, SHOT: join(S, `${sc}.png`) } });
  try {
  let display = ''; await new Promise((ok, fail) => { let out = '', ready = false; p.stdout.on('data', c => { out += c; display = /DISPLAY (.*)/.exec(out)?.[1] ?? display; if (!ready && out.includes('READY')) { ready = true; if (process.env.PROBE) for (const l of out.split('\n')) if (/^(ANIMATIONS|EFFECTS|SURFACES|TIME|ARGS|LAYERS|RAF|METRICS|TRACE|NOT_COMPOSITED|INVALIDATIONS) /.test(l)) console.log(sc, l); ok(); } }); p.once('exit', () => fail(new Error(sc + ': electron exited'))); setTimeout(() => fail(new Error(sc + ': no READY')), 30000); });
  let focus = null; p.stdout.on('data', c => { for (const m of String(c).matchAll(/FOCUS (true|false)/g)) if (focus) focus[m[1] === 'true' ? 0 : 1]++; });
  await sleep(WARM); const a = cpu(p.pid); focus = [0, 0]; await sleep(WINDOW); const b = cpu(p.pid);
  const pct = k => +(((b[k] ?? 0) - (a[k] ?? 0)) / (WINDOW / 1000) * 100).toFixed(1);
  const r = { scenario: sc, display, focused: `${focus[0]}/${focus[0] + focus[1]}s`, renderer: pct('renderer'), gpu: pct('gpu-process'), browser: pct('browser'), utility: pct('utility') }; r.rendererPlusGpu = +(r.renderer + r.gpu).toFixed(1);
  results.push(r); console.log(JSON.stringify(r));
  } catch (e) { console.error(e.message); process.exitCode = 1; } finally { // a failed scenario must not leave its Electron or server behind
    if (p.exitCode === null && p.signalCode === null) { const gone = new Promise(r => p.once('exit', r)); p.kill(); await gone; } await s?.stop(); await rm(ud, { recursive: true, force: true });
  }
}
console.log(`% = one core, ${WINDOW / 1000}s window after ${WARM / 1000}s warm-up`);
console.table(results);
