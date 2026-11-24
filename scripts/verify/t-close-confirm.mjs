// The sidebar X always asks before it closes a project or a tab (Workspace.tsx `forceAsk`), and the question is drawn on document.body so it also shows for a project that is not on screen.
// Also checks that the context ring has its hover text. Non-destructive: every question is cancelled, nothing is closed.
// Needs the shared session with a project open that has at least one tab (any tab). Usage: VERIFY_TAB=<name> node scripts/verify/t-close-confirm.mjs
import { connect } from './cdp.mjs';
const c = await connect(p => p.url.includes('127.0.0.1'));
const sleep = ms => new Promise(r => setTimeout(r, ms)), results = [];
const check = (name, actual, expected) => { const ok = JSON.stringify(actual) === JSON.stringify(expected); results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`); };
const labelled = suffix => c.ev(`return [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || '').filter(l => l.endsWith(${JSON.stringify(suffix)}))`);
const press = label => c.ev(`const b = [...document.querySelectorAll('button')].filter(e => e.getAttribute('aria-label') === ${JSON.stringify(label)}).at(-1); if (!b) return false; b.click(); return true`);
const question = () => c.ev(`const q = document.querySelector('.quick'); return q ? { text: q.querySelector('.quick-message, .quick-title')?.textContent ?? '', onBody: q.closest('.quick-backdrop')?.parentElement === document.body } : null`);
const answer = async text => { // a real click: the list takes pointer input, not a synthetic click()
  const at = await c.ev(`const e = [...document.querySelectorAll('.quick [role=option]')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]`);
  if (!at) return false; await c.click(...at); await sleep(700); return true;
};

// ---- the sidebar X of a project ----
const projects = await labelled('프로젝트 닫기');
check('P0 the sidebar lists a project X', projects.length > 0, true);
await press(projects[0]); await sleep(700);
const asked = await question();
check('P1 the project X asks first (not just closes)', Boolean(asked), true);
check('P2 the question is drawn on document.body', asked?.onBody, true);
check('P3 it asks about closing the project', /프로젝트를 닫을까요/.test(asked?.text ?? ''), true);
check('P4 cancel is answerable', await answer('취소'), true);
check('P5 after cancel the question is gone and the project stays', [Boolean(await question()), (await labelled('프로젝트 닫기')).length], [false, projects.length]);

// ---- the sidebar X of a tab ----
const tabs = await labelled('탭 닫기');
if (tabs.length) {
  await press(tabs[tabs.length - 1]); await sleep(700);
  const tabAsked = await question();
  check('T1 the tab X asks first and names the tab', /탭을 닫을까요/.test(tabAsked?.text ?? '') && tabAsked.text.includes(tabs[tabs.length - 1].replace(/ 탭 닫기$/, '')), true);
  check('T2 cancel is answerable', await answer('취소'), true);
  check('T3 after cancel the tab stays', [Boolean(await question()), (await labelled('탭 닫기')).length], [false, tabs.length]);
} else console.log('SKIP T1-T3 no tab in the sidebar');

// ---- the context ring has its hover text ----
const ring = await c.ev(`const e = [...document.querySelectorAll('button.chat-ring')].find(x => x.offsetParent); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]`);
if (ring) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await sleep(250);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ring[0], y: ring[1] }); await sleep(700);
  const tip = await c.ev(`const t = document.querySelector('#app-tooltip'); return t && t.matches(':popover-open') ? t.innerText : null`);
  check('R1 hovering the context ring shows its text', /컨텍스트/.test(tip ?? ''), true);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
} else console.log('SKIP R1 no chat is open (open a Claude chat tab)');

console.log(`${results.filter(Boolean).length}/${results.length} passed`);
c.close();
process.exit(results.every(Boolean) ? 0 : 1);
