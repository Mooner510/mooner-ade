// Every Modal closes on a backdrop click (not on an inside click or a drag that ends outside). VERIFY_TAB=<name> node scripts/verify/t-modal-backdrop.mjs   (project open)
import { connect } from './cdp.mjs'; import { eq } from './lib.mjs';
const c = await connect(p => p.url.includes('127.0.0.1'));
const mouse = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const open = () => c.ev(`return !!document.querySelector('dialog.changelog[open]:not(.closing)')`);
const settle = () => new Promise(r => setTimeout(r, 300));
// 읽지 않은 버전이 있으면 라벨이 '변경 내역 (읽지 않은 버전 있음)'이 되고, 업데이트 직후에는 창이 이미 열려 있을 수 있다: 라벨은 앞부분만 보고 열려 있으면 먼저 닫는다.
await c.waitFor(`!!document.querySelector('button[aria-label^="변경 내역"]')`, 20000);
if (await open()) { await c.key('Escape', 'Escape'); await settle(); eq(await open(), false, 'Escape closes an already open changelog'); }
await c.clickSel('button', '변경 내역'); await c.waitFor(`!!document.querySelector('dialog.changelog[open]')`);
const box = await c.ev(`return document.querySelector('dialog.changelog').getBoundingClientRect().toJSON()`);
const inside = [box.left + box.width / 2, box.top + box.height / 2], outside = [box.left / 2, box.top + box.height / 2];
await c.click(...inside); await settle(); eq(await open(), true, 'inside click keeps it open');
await mouse('mousePressed', ...inside); await mouse('mouseReleased', ...outside); await settle(); eq(await open(), true, 'drag ending on the backdrop keeps it open');
await mouse('mousePressed', ...outside); await mouse('mouseReleased', ...inside); await settle(); eq(await open(), true, 'press on the backdrop, release inside keeps it open');
await c.click(...outside); await settle(); eq(await open(), false, 'backdrop click closes');
console.log('ok', JSON.stringify(c.problems)); c.close();
