// Drives the open verification Chrome (an open Claude chat tab): composer history (↑/↓), taking a steering message back with ↑, and Esc with a waiting
// steering message. Needs ctl.json {"slowms":30000} in the session temp dir so a `slow` turn stays busy. Usage: VERIFY_OUT=… node scripts/verify/t-composer-keys.mjs
import { connect } from './cdp.mjs';
const c = await connect(p => p.url.includes('127.0.0.1'));
const sleep = ms => new Promise(r => setTimeout(r, ms)), results = [];
const BOX = 'textarea[aria-label="메시지 입력"]';
const value = () => c.ev(`return document.querySelector('${BOX}').value`);
const users = () => c.ev(`return [...document.querySelectorAll('.chat-msg.user .chat-bubble:not(.steer)')].map(e=>e.textContent.trim())`);
const steers = () => c.ev(`return [...document.querySelectorAll('.chat-bubble.steer')].map(e=>e.textContent.trim())`);
const busy = () => c.ev(`return !!document.querySelector('button.chat-send.stop')`);
const focus = async () => { await c.click(...await c.centre(BOX)); await sleep(100); };
const press = async (k, mods = 0) => { await c.key(k, k, mods); await sleep(120); };
const idle = async () => { await c.waitFor(`!document.querySelector('button.chat-send.stop')`, 15000); await sleep(300); };
const clearBox = () => c.ev(`const t=document.querySelector('${BOX}'); const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t,''); t.dispatchEvent(new Event('input',{bubbles:true}));`);
const send = async text => { await focus(); await c.type(text); await sleep(100); await press('Enter'); };
const check = (name, actual, expected) => { const ok = JSON.stringify(actual) === JSON.stringify(expected); results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`); };

const only = process.argv[2];
if (only !== 'steer') {
// ---- history ----
for (const text of ['one', 'two', 'three']) { await send(text); await idle(); }
check('H0 three messages are in the thread', await users(), ['one', 'two', 'three']);
await focus();
await press('ArrowUp'); check('H1 ↑ on an empty box → last message', await value(), 'three');
await press('ArrowUp'); check('H1 ↑ again → the one before', await value(), 'two');
await press('ArrowDown'); check('H2 ↓ → next message', await value(), 'three');
await press('ArrowDown'); check('H2 ↓ past the newest → the original (empty) box', await value(), '');
await press('ArrowDown'); check('H2 ↓ with nothing to restore does nothing', await value(), '');
await c.type('draft'); await sleep(100);
await press('ArrowUp'); check('H3 ↑ with a draft → last message', await value(), 'three');
await press('ArrowDown'); check('H3 ↓ → the draft is back as typed', await value(), 'draft');
await press('ArrowUp'); await c.type(' EDIT'); await sleep(100);
check('H4 the recalled message can be edited', await value(), 'three EDIT');
await press('ArrowDown'); check('H4 ↓ drops the edit and restores the draft', await value(), 'draft');
await press('ArrowUp'); check('H4 ↑ again shows the history as it was, not the edit', await value(), 'three');
await press('ArrowUp'); check('H5 ↑ to "two"', await value(), 'two');
await c.shot('history-recalled');
await press('Enter'); await idle();
check('H5 sending a recalled message adds it as the newest', await users(), ['one', 'two', 'three', 'two']);
check('H5 the box is empty after sending', await value(), '');
await press('ArrowDown'); check('H5 ↓ after sending does not bring the old draft back', await value(), '');
await press('ArrowUp'); check('H5 ↑ → the message just sent', await value(), 'two');
await press('ArrowUp'); check('H5 ↑ → the one before it', await value(), 'three');
await press('ArrowDown'); await press('ArrowDown'); check('H5 ↓↓ → back to empty', await value(), '');

}
// ---- steering ----
await idle(); await clearBox();
await send('slow one'); await c.waitFor(`!!document.querySelector('button.chat-send.stop')`, 8000);
await send('steer A'); await c.waitFor(`!!document.querySelector('.chat-bubble.steer')`, 8000);
check('S1 a steering message waits under the running reply, with the new hint', (await steers()).map(text => text.replace(/steer A$/, '')), ['스티어링 · 대기 중 · ↑ 되돌리기 · Esc 바로 보내기']);
await focus(); await press('ArrowUp'); await sleep(800);
check('S1 ↑ takes the last steering message back into the box', await value(), 'steer A');
check('S1 and it is gone from the thread, while the turn keeps running', [await steers(), await busy()], [[], true]);
await clearBox(); await sleep(100);
await send('steer B'); await c.waitFor(`!!document.querySelector('.chat-bubble.steer')`, 8000);
await c.shot('steer-waiting');
await focus(); await press('Escape'); await sleep(2500);
await c.shot('after-esc');
const after = await users();
check('S2 Esc stops the turn and sends the waiting message as a normal one', [after.at(-1), await steers()], ['steer B', []]);
check('S2 the box is not refilled with it', await value(), '');
await idle();
check('S2 the chat is idle again and answered it', [await busy(), await c.ev(`return document.body.innerText.includes('ok')`)], [false, true]);
console.log(`${results.filter(Boolean).length}/${results.length} passed; page problems: ${JSON.stringify(c.problems)}`);
c.close();
process.exit(results.every(Boolean) ? 0 : 1);
