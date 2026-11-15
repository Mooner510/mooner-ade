// A subagent's drawer bundles a run of 3+ tools like the thread does (요약 display). Usage: VERIFY_OUT=… node scripts/verify/t-agent-bundle.mjs   (after t-open-chat.mjs; fake claude's "subtools" scenario)
import { connect } from './cdp.mjs'; import { eq, ok } from './lib.mjs';
const c = await connect(p => p.url.includes('127.0.0.1')); const sleep = ms => new Promise(r => setTimeout(r, ms));
const drawer = () => c.ev(`return !!document.querySelector('.chat-agent-drawer')`);
if (await drawer()) { await c.key('Escape', 'Escape'); await sleep(600); } // start with no drawer open
await c.clickSel('textarea[aria-label="메시지 입력"]'); await c.type('subtools'); await c.key('Enter', 'Enter', 0, '\r');
await c.waitFor(`!!document.querySelector('.chat-agents')`, 15000); await sleep(3000); // the scenario finishes within ~1 s
if (!(await c.centre('.chat-agents ul button'))) { await c.clickSel('.chat-agents-toggle'); await sleep(600); } // a finished tracker folds its list
await c.clickSel('.chat-agents ul li:last-child button');
await c.waitFor(`!!document.querySelector('.chat-agent-drawer')`); await sleep(800);
const state = () => c.ev(`const d=document.querySelector('.chat-agent-drawer'); return { bundles: d.querySelectorAll('.chat-bundle').length, bundled: d.querySelectorAll('.chat-bundle .chat-bundle-item').length, steps: d.querySelectorAll('.chat-agent-step').length, head: d.querySelector('.chat-bundle-head')?.textContent.trim() ?? null }`);
let s = await state(); console.log(JSON.stringify(s)); await c.shot('agent-bundle');
eq(s.bundles, 1); eq(s.steps, 5); ok(/도구 4개 호출 완료/.test(s.head), 'head ' + s.head); // thought, bundle, thought, 2 loose tools; the 2 loose ones stay below the 3-tool threshold
await c.clickSel('.chat-agent-drawer .chat-bundle-head'); await sleep(700); s = await state(); await c.shot('agent-bundle-open'); eq(s.bundled, 4);
console.log('problems', JSON.stringify(c.problems)); c.close();
