// Opens a Claude chat in the verify Chrome (project "repo", Chat 모드) and sets the cheapest model/effort: Haiku 5.5 · 낮음. Usage: VERIFY_OUT=… node scripts/verify/t-open-chat.mjs
import { connect } from './cdp.mjs';
const c = await connect(p => p.url.includes('127.0.0.1')); const sleep = ms => new Promise(r => setTimeout(r, ms));
const has = expr => c.ev(`return !!(${expr})`);
if (await has(`document.querySelector('[aria-label="프로젝트 열기"]') && !document.querySelector('textarea[aria-label="메시지 입력"]')`)) { /* start screen below */ }
for (const step of ['건너뛰기']) if (await has(`[...document.querySelectorAll('button')].some(b => b.offsetParent && b.textContent.includes('${step}'))`)) { await c.clickSel('button', step); await sleep(600); }
if (!(await has(`document.querySelector('textarea[aria-label="메시지 입력"]')`))) {
  if (await has(`[...document.querySelectorAll('button')].some(b => b.offsetParent && b.textContent.includes('Chat 모드'))`)) { await c.clickSel('button', 'Chat 모드'); await sleep(500); await c.clickSel('button', 'Claude'); await sleep(3000); }
}
const pick = async (label, text) => {
  const s = await c.ev(`const e=[...document.querySelectorAll('summary[aria-label="${label}"]')].find(x=>x.offsetParent); if(!e) return null; const r=e.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]`);
  if (!s) throw new Error('no ' + label); await c.click(...s); await sleep(400);
  const o = await c.ev(`const e=[...document.querySelectorAll('[role=listbox][aria-label="${label}"] [role=option]')].find(x=>x.offsetParent && x.textContent.includes('${text}')); if(!e) return null; const r=e.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]`);
  if (!o) throw new Error('no option ' + text); await c.click(...o); await sleep(800);
};
await pick('모델', 'Haiku 5.5'); await pick('Effort', '낮음');
console.log(await c.ev(`return [...document.querySelectorAll('summary[aria-label="모델"],summary[aria-label="Effort"]')].filter(e=>e.offsetParent).map(e=>e.textContent.trim()).join(' | ')`));
c.close();
