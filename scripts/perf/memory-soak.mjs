// Memory soak: repeated chat open/close while sampling RSS and JS heap. Needs perf session (VERIFY_OUT, VERIFY_TAB=perf).
//   VERIFY_OUT=... VERIFY_TAB=perf node scripts/perf/memory-soak.mjs [--rounds 15] [--chats 10] [--sample-every 1]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, env as cdpEnv } from '../verify/cdp.mjs';
import { sleep, S } from '../verify/lib.mjs';
import { readEnv } from '../verify/session-dirs.mjs';
import { rssByType, rssKb } from './ps-tree.mjs';

const rounds = +(process.argv.find((_, i, a) => a[i - 1] === '--rounds') ?? 15);
const chatsPerRound = +(process.argv.find((_, i, a) => a[i - 1] === '--chats') ?? 10);
const sampleEvery = +(process.argv.find((_, i, a) => a[i - 1] === '--sample-every') ?? 1);

const e = cdpEnv();
const post = (action, body) => fetch(`${e.origin}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: e.cookie, origin: e.origin }, body: JSON.stringify(body) }).then(r => r.json());

async function ensureOnboarded() {
  const state = await post('app/state', {});
  if (state.settings?.onboarded) return;
  await post('app/state', { state: { ...state, settings: { ...state.settings, onboarded: true, tourVersion: 2 } } });
}

async function sample(label) {
  const session = readEnv(S);
  const serverPid = session?.serverPids?.[0];
  const chromePid = session?.chromePid;
  let heapMB = null;
  try {
    const c = await connect(() => true);
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    heapMB = await c.ev(`return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null`);
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    c.close();
  } catch { /* tab may be busy */ }
  return {
    at: Date.now(),
    label,
    serverRssMb: serverPid ? Math.round(rssKb(serverPid) / 1024) : null,
    chromeRssMb: chromePid ? Math.round(rssByType(chromePid).total / 1024) : null,
    heapMB,
  };
}

async function onboard(c) {
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const ok = await c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('알겠어요')); if(b){b.click();return 1} return 0`);
  await sleep(ok ? 800 : 200);
}

async function run() {
  mkdirSync(join(S, 'evidence'), { recursive: true });
  await ensureOnboarded();
  const samples = [await sample('start')];
  const c = await connect(() => true);
  await onboard(c);

  for (let r = 0; r < rounds; r++) {
    const ids = [];
    for (let i = 0; i < chatsPerRound; i++) {
      const id = `soak-${r}-${i}`;
      ids.push(id);
      await post('chat/open', { projectId: e.projectId, id, agent: 'claude', show: i === 0 });
      await sleep(120);
    }
    await sleep(400);
    for (const id of ids) await post('chat/close', { projectId: e.projectId, id });
    if ((r + 1) % sampleEvery === 0 || r === rounds - 1) samples.push(await sample(`round-${r + 1}`));
  }
  c.close();

  const first = samples.slice(0, Math.max(1, Math.floor(samples.length / 3)));
  const last = samples.slice(-Math.max(1, Math.floor(samples.length / 3)));
  const med = arr => { const v = arr.filter(x => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const drift = (key) => {
    const a = med(first.map(s => s[key])), b = med(last.map(s => s[key]));
    return a && b ? +(((b - a) / a) * 100).toFixed(1) : null;
  };
  const out = {
    rounds, chatsPerRound, samples,
    driftPct: { serverRssMb: drift('serverRssMb'), chromeRssMb: drift('chromeRssMb'), heapMB: drift('heapMB') },
    leakSuspect: [drift('serverRssMb'), drift('chromeRssMb'), drift('heapMB')].some(d => d != null && d > 15),
  };
  writeFileSync(join(S, 'evidence', 'memory-soak.json'), JSON.stringify(out, null, 2));
  console.error(JSON.stringify(out, null, 1));
}

await run();