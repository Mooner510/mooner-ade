// Every Modal closes on a backdrop click (not on an inside click or a drag that ends outside). VERIFY_TAB=<name> node scripts/verify/t-modal-backdrop.mjs   (project open)
import { connect } from './cdp.mjs'; import { eq } from './lib.mjs';
const c = await connect(p => p.url.includes('127.0.0.1'));
const mouse = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const open = () => c.ev(`return !!document.querySelector('dialog.settings-modal[open]:not(.closing)')`);
const settle = () => new Promise(r => setTimeout(r, 300));
// 변경 내역은 전체화면이라 바깥(백드롭)이 없다: 같은 Modal 규칙을 설정 창으로 확인한다.
await c.waitFor(`!!document.querySelector('button[aria-label="설정"]')`, 20000);
if (await open()) { await c.key('Escape', 'Escape'); await settle(); eq(await open(), false, 'Escape closes an already open settings window'); }
await c.clickSel('button[aria-label="설정"]'); await c.waitFor(`!!document.querySelector('dialog.settings-modal[open]')`);
const box = await c.ev(`return document.querySelector('dialog.settings-modal').getBoundingClientRect().toJSON()`);
const inside = [box.left + 14, box.top + 14], outside = [box.left / 2, box.top + box.height / 2];
await c.click(...inside); await settle(); eq(await open(), true, 'inside click keeps it open');
await mouse('mousePressed', ...inside); await mouse('mouseReleased', ...outside); await settle(); eq(await open(), true, 'drag ending on the backdrop keeps it open');
await mouse('mousePressed', ...outside); await mouse('mouseReleased', ...inside); await settle(); eq(await open(), true, 'press on the backdrop, release inside keeps it open');
await c.click(...outside); await settle(); eq(await open(), false, 'backdrop click closes');
// 명령 팔레트(QuickInput, Ctrl+Shift+P)도 같은 규칙: 안에서 눌러 바깥에서 놓기·바깥에서 눌러 안에서 놓기는 유지, 바깥 클릭만 닫는다. 안쪽은 제목 줄을 눌러 항목이 실행되지 않게 한다.
const palette = () => c.ev(`return !!document.querySelector('.quick')`);
await c.key('P', 'KeyP', 2 | 8, 'P'); await c.waitFor(`!!document.querySelector('.quick')`);
const pbox = await c.ev(`return document.querySelector('.quick').getBoundingClientRect().toJSON()`);
const pin = [pbox.left + pbox.width / 2, pbox.top + 18], pout = [pbox.left / 2, pbox.top + pbox.height / 2];
await c.click(...pin); await settle(); eq(await palette(), true, 'palette: inside click keeps it open');
await mouse('mousePressed', ...pin); await mouse('mouseReleased', ...pout); await settle(); eq(await palette(), true, 'palette: drag ending on the backdrop keeps it open');
await mouse('mousePressed', ...pout); await mouse('mouseReleased', ...pin); await settle(); eq(await palette(), true, 'palette: press on the backdrop, release inside keeps it open');
await c.click(...pout); await settle(); eq(await palette(), false, 'palette: backdrop click closes');
console.log('ok', JSON.stringify(c.problems)); c.close();
