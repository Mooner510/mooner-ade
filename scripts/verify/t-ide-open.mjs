// "Open in IDE" in the verify Chrome: the sidebar project menu (folder / file / detected editors) and the clickable file chips in a chat reply.
// Needs a chat already open (node scripts/verify/t-open-chat.mjs). OPEN=explorer,code also launches the file manager / VS Code for real (a window appears on this desktop).
// Usage: VERIFY_OUT=… [OPEN=explorer,code] node scripts/verify/t-ide-open.mjs
import { connect } from './cdp.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const c = await connect(p => p.url.includes('127.0.0.1'));
const real = new Set((process.env.OPEN ?? '').split(',').filter(Boolean));
let failed = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!cond) failed++; };
const rightClick = async (x, y) => {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
};
const options = () => c.ev(`return [...document.querySelectorAll('.quick li[role=option]')].map(e => e.textContent.trim())`);
const title = () => c.ev(`return document.querySelector('.quick .quick-head')?.innerText ?? ''`);
const pickOption = async text => { const at = await c.ev(`const e=[...document.querySelectorAll('.quick li[role=option]')].find(x=>x.textContent.includes(${JSON.stringify(text)})); if(!e) return null; const r=e.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]`); if (!at) throw new Error('no option ' + text); await c.click(...at); await sleep(400); };
const LAST_MD = "[...document.querySelectorAll('.md')].filter(e => e.querySelector('.md-file')).at(-1)";
const chip = async text => { const at = await c.ev(`const e=[...(${LAST_MD}).querySelectorAll('.md-file')].find(x=>x.textContent===${JSON.stringify(text)}); if(!e) return null; const r=e.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]`); if (!at) throw new Error('no chip ' + text); await c.click(...at); };
const errors = () => c.ev(`return [...document.querySelectorAll('.error-toast, .error-corner, [role=alert]')].map(e => e.textContent.trim()).filter(Boolean)`);

// ---- sidebar project menu ----
const head = await c.ev(`const e=document.querySelector('.folder-head'); if(!e) return null; const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]`);
ok(head, 'a project row is in the sidebar');
await rightClick(...head);
await c.waitFor(`document.querySelector('.tab-menu[aria-label$="메뉴"]')?.innerText.includes('편집기')`);
await sleep(500);
const menu = await c.ev(`return [...document.querySelectorAll('.tab-menu [role=menuitem]')].map(e => e.querySelector('.menu-label').textContent.trim())`);
console.log('menu items:', JSON.stringify(menu));
ok(menu.includes('탐색기에서 폴더 열기'), 'menu: show folder in the file manager');
ok(menu.includes('파일 열기…'), 'menu: open a file');
ok(menu.includes('경로 복사'), 'menu: copy path');
ok(['Visual Studio Code', 'Cursor', 'WebStorm'].every(name => menu.includes(name)), 'menu: detected editors are listed', menu.join(' | '));
await c.shot('ide-project-menu');

if (real.has('explorer')) {
  await c.clickSel('.tab-menu [role=menuitem]', '폴더 열기'); await sleep(1500);
  ok(!(await errors()).length, 'no error after showing the project folder in Explorer', JSON.stringify(await errors()));
  await rightClick(...head); await c.waitFor(`document.querySelector('.tab-menu[aria-label$="메뉴"]')?.innerText.includes('편집기')`);
}
// "파일 열기…": pick a file, then choose how to open it.
await c.clickSel('.tab-menu [role=menuitem]', '파일 열기');
await c.waitFor(`!!document.querySelector('.quick')`);
const files = await options();
ok(files.includes('src/b.ts') && !files.some(name => name.endsWith('/')), 'file picker lists files only', files.join(', '));
await c.shot('ide-file-picker');
await pickOption('src/b.ts');
const ask = await title(), choices = await options();
ok(ask.includes('파일을 열까요?') && ask.includes('src/b.ts'), 'asks how to open the picked file', JSON.stringify(ask));
ok(choices.some(x => x.includes('Visual Studio Code에서 열기')) && choices.some(x => x.includes('탐색기에서 위치 열기')) && choices.includes('경로 복사') && choices.includes('취소'), 'choices: editors, file manager, copy, cancel', choices.join(' | '));
await c.shot('ide-open-dialog');
if (real.has('code')) { await pickOption('Visual Studio Code에서 열기'); await sleep(1500); ok(!(await errors()).length, 'no error after launching VS Code', JSON.stringify(await errors())); }
else { await c.key('Escape', 'Escape'); await sleep(300); }
ok(!(await c.ev(`return !!document.querySelector('.quick')`)), 'dialog closes');

// ---- chat file chips ----
const typed = await c.ev(`const t=document.querySelector('textarea[aria-label="메시지 입력"]'); if(!t) return false; t.focus(); return true`);
ok(typed, 'a chat composer is open (run t-open-chat.mjs first)');
if (typed) {
  // Earlier runs leave their replies in this chat: only the newest reply is looked at.
  const before = await c.ev(`return document.querySelectorAll('.md-file').length`);
  await c.type('filechips'); await c.key('Enter', 'Enter');
  await c.waitFor(`document.querySelectorAll('.md-file').length > ${before}`, 15000);
  await sleep(500);
  const chips = await c.ev(`return [...(${LAST_MD}).querySelectorAll('.md-file')].map(e => ({ text: e.textContent, icon: e.querySelector('img.file-glyph')?.getAttribute('src') ?? null }))`);
  console.log('chips:', JSON.stringify(chips));
  ok(JSON.stringify(chips.map(x => x.text)) === JSON.stringify(['src/b.ts:2', 'README.md', 'src/', 'a.txt']), 'chips: [[file:…]] and a path link, nothing else', chips.map(x => x.text).join(' | '));
  ok(chips.every(x => x.icon), 'every chip has its Material icon');
  ok(new Set(chips.map(x => x.icon)).size >= 3, 'icons differ by file type and folder', chips.map(x => x.icon?.split('/').pop()).join(' '));
  const plain = await c.ev(`return [...(${LAST_MD}).querySelectorAll('li, p')].map(e => e.textContent).join(' / ')`);
  ok(plain.includes('https://') === false && plain.includes('문서') && plain.includes('[[1, 2]]'), 'an address link and [[1, 2]] stay as they were', plain.slice(0, 160));
  ok(await c.ev(`return [...(${LAST_MD}).querySelectorAll('code')].some(e => e.textContent === '[[file:code.ts]]')`), 'a chip written inside backticks stays code');
  await c.shot('ide-chat-chips');
  // Click: asks first, with the line in the question.
  await chip('src/b.ts:2');
  await c.waitFor(`!!document.querySelector('.quick')`);
  const chipAsk = await title(), chipChoices = await options();
  ok(chipAsk.includes('파일을 열까요?') && chipAsk.includes('src/b.ts:2'), 'click: asks which way to open it', JSON.stringify(chipAsk));
  ok(chipChoices.some(x => x.includes('Visual Studio Code에서 열기')) && chipChoices.some(x => x.includes('탐색기에서 위치 열기')), 'click: editors and file manager offered', chipChoices.join(' | '));
  await c.shot('ide-chip-dialog');
  if (real.has('explorer')) { await pickOption('탐색기에서 위치 열기'); await sleep(1200); ok(!(await errors()).length, 'no error after showing the file in Explorer', JSON.stringify(await errors())); }
  else { await c.key('Escape', 'Escape'); await sleep(300); }
  // A folder chip asks about a folder.
  await chip('src/');
  await c.waitFor(`!!document.querySelector('.quick')`);
  const folderAsk = await title(), folderChoices = await options();
  ok(folderAsk.includes('폴더를 열까요?') && folderChoices.some(x => x.includes('탐색기에서 폴더 열기')), 'folder chip: asks about a folder', JSON.stringify(folderAsk) + ' ' + folderChoices.join(' | '));
  await c.key('Escape', 'Escape'); await sleep(300);
}
console.log('problems:', JSON.stringify(c.problems));
c.close();
process.exit(failed ? 1 : 0);
