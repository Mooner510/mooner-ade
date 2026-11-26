// Stream jank during fake claude e2e-stream, with and without CPU throttling. Needs VERIFY_OUT + VERIFY_TAB=perf.
//   VERIFY_OUT=... VERIFY_TAB=perf node scripts/perf/stream-jank.mjs [--lines 80]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect, env as cdpEnv } from '../verify/cdp.mjs';
import { sleep, S } from '../verify/lib.mjs';

const lines = +(process.argv.find((_, i, a) => a[i - 1] === '--lines') ?? 80);
const streamMs = lines * 600 + 8000;
const e = cdpEnv();
const post = (action, body) => fetch(`${e.origin}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: e.cookie, origin: e.origin }, body: JSON.stringify(body) }).then(r => r.json());

async function ensureOnboarded() {
  const state = await post('app/state', {});
  if (state.settings?.onboarded) return;
  await post('app/state', { state: { ...state, settings: { ...state.settings, onboarded: true, tourVersion: 2 } } });
}

async function frames(c, span) {
  await c.ev(`window.__fr=[]; window.__frOn=true; let last=0; const tick=t=>{ if(!window.__frOn) return; if(last) window.__fr.push(t-last); last=t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); return 1`);
  await sleep(200);
  await c.ev(`window.__fr.length=0; return 1`);
  await sleep(span);
  const list = await c.ev(`window.__frOn=false; return window.__fr`);
  return {
    jankMs: list.filter(x => x > 20).reduce((a, b) => a + b - 16.7, 0),
    worst: Math.max(0, ...list),
    over50: list.filter(x => x > 50).length,
    frames: list.length,
  };
}

async function openChatUi(c) {
  const click = text => c.ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.offsetParent&&b.textContent.includes(${JSON.stringify(text)})); b?.click(); return !!b; })()`);
  await click('알겠어요').catch(() => {});
  await sleep(400);
  await click('Chat 모드');
  await sleep(600);
  await click('Claude');
  for (let i = 0; i < 40 && !await c.ev(`!!document.querySelector('textarea[aria-label="메시지 입력"]')`); i++) await sleep(200);
  await sleep(500);
}

async function measure(throttleRate) {
  const id = 'perf-stream';
  await post('chat/close', { projectId: e.projectId, id, forget: true }).catch(() => {});
  await post('chat/open', { projectId: e.projectId, id, agent: 'claude', show: true });
  await sleep(800);
  const c = await connect(() => true);
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (throttleRate > 1) await c.send('Emulation.setCPUThrottlingRate', { rate: throttleRate });
  await openChatUi(c);
  await c.ev(`window.__fr=[]; window.__frOn=true; let last=0; const tick=t=>{ if(!window.__frOn) return; if(last) window.__fr.push(t-last); last=t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); return 1`);
  await sleep(200);
  await c.ev(`window.__fr.length=0; return 1`);
  await post('chat/send', { projectId: e.projectId, id, text: `e2e-stream ${lines} perf` });
  await sleep(streamMs);
  const list = await c.ev(`window.__frOn=false; return window.__fr`);
  const fr = {
    jankMs: list.filter(x => x > 20).reduce((a, b) => a + b - 16.7, 0),
    worst: Math.max(0, ...list),
    over50: list.filter(x => x > 50).length,
    frames: list.length,
  };
  const heapMB = await c.ev(`return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null`);
  if (throttleRate > 1) await c.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  c.close();
  await post('chat/close', { projectId: e.projectId, id });
  return { throttleRate, lines, streamMs, ...fr, heapMB };
}

async function run() {
  mkdirSync(join(S, 'evidence'), { recursive: true });
  await ensureOnboarded();
  const out = { env: { origin: e.origin, lines }, results: [await measure(1), await measure(4)] };
  writeFileSync(join(S, 'evidence', 'stream-jank.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 1));
}

await run();