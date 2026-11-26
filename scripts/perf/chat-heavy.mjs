// Measures what a long conversation costs in the real UI: Ctrl+D / Ctrl+Shift+D (split), switching tabs and switching projects.
// Results and method: docs/perf/CHAT_SPLIT_SWITCH.md. Needs the shared session (`node scripts/verify/session.mjs up --as <name>`, then `tab --as <name>`).
//
//   VERIFY_TAB=<name> node scripts/perf/chat-heavy.mjs seed          two projects: a 500-turn and a 3-turn chat in one, a 500-turn chat in the other (stored in tmp/main)
//   VERIFY_TAB=<name> node scripts/perf/chat-heavy.mjs show         adds the tabs again (after a page reload, the second project's tab)
//   VERIFY_TAB=<name> node scripts/perf/chat-heavy.mjs run [reps]    prints JSON (medians of reps, default 8)
//   VERIFY_TAB=<name> node scripts/perf/chat-heavy.mjs clean         closes the seeded tabs and chats, takes the second project out
//
// The tab is put in the foreground for the page only (Emulation.setFocusEmulationEnabled), the window is never raised. The numbers are for comparing
// two states of the code on the same machine in the same session (dev build, 120Hz display): run before and after, not against another machine.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
import { connect, env } from '../verify/cdp.mjs';

const LONG = 500, LABEL = { long: process.env.PERF_LONG || '긴 대화', short: process.env.PERF_SHORT || '짧은 대화' }, IDS = { long: 'perf-long', short: 'perf-short', other: 'perf-other-long' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), median = list => { const sorted = list.map(Number).filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };

// A conversation shaped like real work: markdown, code, a table, two tool calls per turn (7 events a turn).
function events(turns, label) {
  const out = []; let seq = 1;
  for (let i = 0; i < turns; i++) {
    const text = `## 작업 ${i}\n\n문장 **강조**와 \`inline\` 코드, [링크](https://example.com/${i}).\n\n- 하나\n- 둘\n- 셋\n\n\`\`\`ts\nexport function f${i}(a: number, b: number) {\n  return (a + b) * ${i};\n}\n\`\`\`\n\n| 열1 | 열2 |\n|---|---|\n| a | ${i} |\n| b | ${i * 2} |\n\n${'긴 설명 문단입니다. '.repeat(12)}`;
    out.push({ seq: seq++, kind: 'user', text: `${label} ${i}: ${'이걸 해줘 '.repeat(5)}` },
      { seq: seq++, kind: 'message', id: `m${i}a`, uuid: `u${i}a`, blocks: [{ type: 'text', text: '먼저 파일을 읽어볼게요.' }, { type: 'tool_use', id: `t${i}a`, name: 'Read', input: { file_path: `/src/file${i}.ts` } }] },
      { seq: seq++, kind: 'tool_result', toolUseId: `t${i}a`, content: Array.from({ length: 30 }, (_, n) => `${n + 1}\tline ${n} of file ${i}`).join('\n') },
      { seq: seq++, kind: 'message', id: `m${i}b`, uuid: `u${i}b`, blocks: [{ type: 'tool_use', id: `t${i}b`, name: 'Bash', input: { command: `npm test -- ${i}`, description: '테스트' } }] },
      { seq: seq++, kind: 'tool_result', toolUseId: `t${i}b`, content: 'PASS all\n'.repeat(10) },
      { seq: seq++, kind: 'message', id: `m${i}c`, uuid: `u${i}c`, blocks: [{ type: 'text', text }] },
      { seq: seq++, kind: 'result', status: 'success', durationMs: 5000, usage: { input: 1000, output: 500, cacheRead: 2000, cacheCreate: 100 }, at: Date.now() - (turns - i) * 60000 });
  }
  return out;
}
const e = env(), post = (action, body) => fetch(`${e.origin}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: e.cookie, origin: e.origin }, body: JSON.stringify(body) }).then(response => response.json());
const second = join(e.temp, 'repo-perf2');

async function seed() {
  const state0 = await post('app/state', {});
  if (!state0.settings?.onboarded) await post('app/state', { state: { ...state0, settings: { ...state0.settings, onboarded: true, tourVersion: 2 } } });
  const write = (pid, root, id, turns, label) => {
    const dir = join(e.data, pid, 'chat', id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), events(turns, label).map(item => JSON.stringify(item) + '\n').join(''));
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ agent: 'claude', cwd: root, effort: 'low', model: 'claude-haiku-5-5', worktree: false, addDirs: [], permissionMode: 'default', costBase: 0, auth: 'login', title: '' }));
  };
  mkdirSync(second, { recursive: true });
  const other = (await post('project/open', { path: second })).id;
  write(e.projectId, e.repo, IDS.long, LONG, LABEL.long); write(e.projectId, e.repo, IDS.short, 3, LABEL.short); write(other, second, IDS.other, LONG, LABEL.long);
  const state = await post('app/state', {}); state.openProjects = [...state.openProjects.filter(project => project.id !== other), { id: other, root: second }];
  await post('app/state', { state }); await show(other); console.log('seeded. Reload the tab (the second project appears), then run `show` once more to add its tab.');
}
// A chat opened with `show` becomes a tab in the windows that have its project open, so close and open again to get the tab.
async function show(other = null) {
  other ??= (await post('app/state', {})).openProjects.find(project => project.root === second)?.id;
  for (const [pid, id] of [[e.projectId, IDS.long], [e.projectId, IDS.short], [other, IDS.other]]) if (pid) { await post('chat/close', { projectId: pid, id }); await post('chat/open', { projectId: pid, id, agent: 'claude', show: true }); }
}

async function clean() {
  const c = await connect(page => page.url().includes('127.0.0.1')); await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // The tab's X only shows on hover; closing asks first (a menu with 확인 / 취소).
  const closeButton = `[...document.querySelectorAll('.folder-tab')].filter(t=>/${LABEL.long}|${LABEL.short}/.test(t.textContent))[0]`;
  for (let guard = 0; guard < 10; guard++) {
    const tab = await c.ev(`const t=${closeButton}; if(!t) return null; const r=t.getBoundingClientRect(); return r.width ? [r.x+40,r.y+r.height/2] : 'hidden'`);
    if (!tab) break;
    if (tab === 'hidden') { const heads = await c.ev(`return document.querySelectorAll('section.folder .folder-head').length`); let shown = false; for (let i = 0; i < heads && !shown; i++) { await c.click(...await c.ev(`const r=document.querySelectorAll('section.folder .folder-head')[${i}].getBoundingClientRect(); return [r.x+60,r.y+r.height/2]`)); await sleep(800); shown = await c.ev(`return ${closeButton}?.getBoundingClientRect().width > 0`); } continue; }
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tab[0], y: tab[1] }); await sleep(250);
    await c.click(...await c.ev(`const r=${closeButton}.querySelector('.ptab-close').getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]`)); await sleep(500);
    const ok = await c.ev(`const e=[...document.querySelectorAll('*')].filter(x=>x.children.length===0 && x.textContent.trim()==='확인' && x.offsetParent)[0]; if(!e) return null; const r=e.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]`);
    if (ok) await c.click(...ok); await sleep(700);
  }
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: false }); c.close();
  const state = await post('app/state', {}), other = state.openProjects.find(project => project.root === second);
  for (const [pid, id] of [[e.projectId, IDS.long], [e.projectId, IDS.short], [other?.id, IDS.other]]) if (pid) await post('chat/close', { projectId: pid, id, forget: true });
  if (other) { await post('project/close', { projectId: other.id, force: true }); state.openProjects = state.openProjects.filter(project => project !== other); await post('app/state', { state }); }
  for (const [pid, id] of [[e.projectId, IDS.long], [e.projectId, IDS.short], [other?.id, IDS.other]]) if (pid) rmSync(join(e.data, pid, 'chat', id), { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true }); console.log('cleaned');
}

async function waitTab(c, expr, ms = 30000) {
  for (let t = 0; t < ms; t += 400) { if (await c.ev(`return !!(${expr})`)) return; await sleep(400); }
  throw new Error(`chat-heavy: UI 대기 시간 초과 (${expr.slice(0, 80)})`);
}

async function run(reps) {
  const c = await connect(page => page.url().includes('127.0.0.1')); await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await c.send('Performance.enable');
  await c.ev(`if (!window.__perf) { window.__perf = { t0: 0, res: null }; for (const type of ['keydown', 'pointerdown']) addEventListener(type, event => { window.__perf.t0 = event.timeStamp; }, true); } return 1`);
  const V = `document.querySelector('main.app:not([hidden]) .tab-page:not([hidden])')`;
  const where = (selector, text, index = -1) => c.ev(`const e=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.textContent.includes(${JSON.stringify(text)})).at(${index}); const r=e.getBoundingClientRect(); return [r.x+Math.min(40,r.width/2),r.y+r.height/2]`);
  const select = async text => {
    await waitTab(c, `[...document.querySelectorAll('section.folder.active .folder-tab')].some(t=>t.textContent.includes(${JSON.stringify(text)}))`);
    await c.click(...await where('section.folder.active .folder-tab', text));
    await sleep(1200);
  };
  const project = async index => { await c.click(...await c.ev(`const e=document.querySelectorAll('section.folder .folder-head')[${index}]; const r=e.getBoundingClientRect(); return [r.x+60,r.y+r.height/2]`)); await sleep(1300); };
  const metrics = async fn => { const read = async () => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value])); const a = await read(); await fn(); await sleep(900); const b = await read(); return { layoutMs: (b.LayoutDuration - a.LayoutDuration) * 1000, scriptMs: (b.ScriptDuration - a.ScriptDuration) * 1000, styleMs: (b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000 }; };
  // Frame pacing for `span` ms after the trigger. jank = time beyond one 16.7ms frame, summed over the frames longer than 20ms.
  const frames = async (trigger, span) => {
    await c.ev(`window.__fr=[]; window.__frOn=true; let last=0; const tick=t=>{ if(!window.__frOn) return; if(last) window.__fr.push(t-last); last=t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); return 1`);
    await sleep(100); await c.ev(`window.__fr.length=0; return 1`); await trigger(); await sleep(span);
    const list = (await c.ev(`window.__frOn=false; return window.__fr`)) || [];
    return { jankMs: list.filter(x => x > 20).reduce((a, b) => a + b - 16.7, 0), worst: list.length ? Math.max(...list) : 0, over50: list.filter(x => x > 50).length };
  };
  // Input event → the second frame after `done` is true.
  const latency = async (trigger, done) => {
    await c.ev(`if (!window.__perf) { window.__perf = { t0: 0, res: null }; for (const type of ['keydown', 'pointerdown']) addEventListener(type, event => { window.__perf.t0 = event.timeStamp; }, true); } const p=window.__perf; p.res=null; p.t0=0; const check=()=>{ if(!(${done})) return requestAnimationFrame(check); requestAnimationFrame(()=>requestAnimationFrame(()=>{ p.res=performance.now()-p.t0; })); }; requestAnimationFrame(check); return 1`);
    await trigger(); for (let i = 0; i < 200; i++) { const res = await c.ev(`return window.__perf.res`); if (res != null) return res; await sleep(30); } return null;
  };
  const out = { reps };
  await waitTab(c, `document.querySelector('section.folder .folder-head')`);
  await project(0);
  await waitTab(c, V);
  for (const [name, label] of [['long', LABEL.long], ['short', LABEL.short]]) {
    await select(label);
    const base = await c.ev(`return { turnsInDom: ${V}.querySelectorAll('.chat-turn').length, elementsInTab: ${V}.getElementsByTagName('*').length }`);
    const field = await where('textarea[aria-label="메시지 입력"]', '');
    const result = { ...base };
    for (const [key, modifiers, letter] of [['ctrlD', 2, 'd'], ['ctrlShiftD', 10, 'D']]) {
      const rows = [];
      for (let i = 0; i <= reps; i++) {
        const at = await c.ev(`const t=${V}?.querySelector('textarea[aria-label="메시지 입력"]'); if(!t) return null; const r=t.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]`);
        if (!at) throw new Error('chat-heavy: no composer in active tab');
        await c.click(...at); await sleep(250);
        const before = await c.ev(`return (${V}&&${V}.querySelectorAll('.launcher-pane').length)||0`);
        const toFirstPaint = await latency(() => c.key(letter, 'KeyD', modifiers), `(${V})&&${V}.querySelectorAll('.launcher-pane').length > ${before}`); await sleep(900);
        await c.key('Escape', 'Escape'); await sleep(900);
        const fr = await frames(() => c.key(letter, 'KeyD', modifiers), 900); await c.key('Escape', 'Escape'); await sleep(900);
        const m = await metrics(() => c.key(letter, 'KeyD', modifiers)); await c.key('Escape', 'Escape'); await sleep(900);
        if (i) rows.push({ toFirstPaint, ...fr, ...m });
      }
      result[key] = Object.fromEntries(['toFirstPaint', 'jankMs', 'worst', 'over50', 'scriptMs', 'styleMs', 'layoutMs'].map(k => [k, Math.round(median(rows.map(r => r[k])) * 10) / 10]));
    }
    out[name] = result;
  }
  out.tabSwitchMs = {};
  for (const [from, to, key] of [[LABEL.short, LABEL.long, 'toLong'], [LABEL.long, LABEL.short, 'toShort']]) {
    const list = [];
    for (let i = 0; i <= reps; i++) { await select(from); const at = await where('section.folder.active .folder-tab', to); const ms = await latency(() => c.click(...at), `document.querySelector('section.folder.active .folder-tab[aria-selected=true]')?.textContent.includes(${JSON.stringify(to)}) && ${V}?.querySelector('textarea')`); if (i) list.push(ms); }
    out.tabSwitchMs[key] = Math.round(median(list) * 10) / 10;
  }
  out.projectSwitchMs = {};
  for (const [from, to] of [[0, 1], [1, 0]]) {
    const list = [];
    for (let i = 0; i <= reps; i++) { await project(from); const at = await c.ev(`const e=document.querySelectorAll('section.folder .folder-head')[${to}]; const r=e.getBoundingClientRect(); return [r.x+60,r.y+r.height/2]`); const ms = await latency(() => c.click(...at), `document.querySelectorAll('section.folder')[${to}]?.classList.contains('active') && !document.querySelectorAll('main.app')[${to}]?.hidden`); if (i) list.push(ms); }
    out.projectSwitchMs[`${from}→${to}`] = Math.round(median(list) * 10) / 10;
  }
  await project(0);
  out.wholePage = await c.ev(`return { elements: document.getElementsByTagName('*').length, turnsInDom: document.querySelectorAll('.chat-turn').length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1e6) }`);
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: false }); c.close(); console.log(JSON.stringify(out, null, 1));
}

const [mode, reps = '8'] = process.argv.slice(2);
if (mode === 'seed') await seed(); else if (mode === 'show') await show(); else if (mode === 'run') await run(Number(reps)); else if (mode === 'clean') await clean(); else console.log('usage: seed | show | run [reps] | clean');
