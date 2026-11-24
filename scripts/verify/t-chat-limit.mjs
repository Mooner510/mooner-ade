// /limit: a chat's own limit (cost, share of a plan window, plan window usage), the stop line, the refused send and the automatic compact.
// Uses the fake claude (every turn costs $0.01, /compact answers like the CLI) and the session's example usage (5시간 23%, 주간 41%); no model and no real usage endpoint is touched.
// Run: VERIFY_OUT=… node scripts/verify/t-chat-limit.mjs  (or VERIFY_TAB=… on tmp/main). Opens its own Claude chat tab and closes it again: a project holds 16 chats at most.
import assert from 'node:assert/strict';
import { connect } from './cdp.mjs';

const c = await connect(page => page.url.includes('127.0.0.1')), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Other chat tabs stay mounted (hidden, inert), so only what is on screen counts.
const all = sel => `[...document.querySelectorAll('${sel}')].filter(e => !e.closest('[inert]') && e.getClientRects().length)`;
const has = expr => c.ev(`return !!(${expr})`);
const text = expr => c.ev(`return (${expr}) ?? ''`);
const card = `${all('.limit-card')}.at(-1)`, chip = `${all('.chat-stat-limit')}[0]`;
const line = rule => `${all('.chat-divider.note')}.some(e => e.textContent.trim() === '제한 규칙(${rule})에 따라 중지되었습니다')`;
let opened = false;
try {
  await c.waitFor(`!!document.querySelector('[aria-label="새 탭 종류 선택"]')`, 20000);
  if (!await has(`document.querySelector('.launcher-menu')`)) await c.ev(`document.querySelector('[aria-label="새 탭 종류 선택"]').click()`);
  await c.waitFor(`document.querySelectorAll('.launcher-menu button').length > 3`, 5000);
  await c.ev(`[...document.querySelectorAll('.launcher-menu button')].find(b => b.textContent.includes('Claude') && b.textContent.includes('채팅 모드')).click()`);
  opened = true; await sleep(1500);
  await c.waitFor(`${all('textarea[aria-label="메시지 입력"]')}.length`, 15000);
  const idle = () => c.waitFor(`${all('.chat-send.stop')}.length === 0`, 20000);
  const box = `${all('textarea[aria-label="메시지 입력"]')}[0]`;
  // select() first: a refused message is still in the input and the new text replaces it
  const send = async message => { await c.ev(`${box}.focus(); ${box}.select()`); await c.type(message); await c.key('Enter', 'Enter', 0, '\r'); };
  const draft = () => text(`${box}.value`);
  const openCard = async () => { const before = Number(await text(`${all('.limit-card')}.length`)); await send('/limit'); await c.waitFor(`${all('.limit-card')}.length === ${before + 1}`, 8000); await c.waitFor(`!!${card}.querySelector('.lc-foot')`, 8000); };
  const fill = async (label, value) => { await c.ev(`const el = ${card}.querySelector('input[aria-label="${label}"]'); el.focus(); el.select()`); await c.type(String(value)); };
  const toggle = label => c.ev(`[...${card}.querySelectorAll('label')].find(l => l.textContent.includes('${label}')).querySelector('input').click()`);
  const choose = (row, name) => c.ev(`[...${card}.querySelectorAll('.lc-row')].find(r => r.textContent.includes('${row}')).querySelector('.lc-seg').querySelectorAll('button')[${name === '주간' ? 1 : 0}].click()`);
  const press = label => c.ev(`[...${card}.querySelectorAll('button')].find(b => b.textContent.trim() === '${label}').click()`);
  const status = () => text(`${card}.querySelector('.mc-head span').textContent`);

  // 1. The card offers what a Claude plan chat can be limited by, and the other command text stays untouched.
  await openCard();
  assert.equal(await status(), '설정 없음');
  assert.deepEqual(await c.ev(`return [...${card}.querySelectorAll('.lc-name')].map(e => e.textContent.trim())`), ['비용', '사용량 할당', '사용량 한도', '중지되면 자동 압축']);
  assert.ok(!await has(chip), 'no chip without a limit');
  await c.shot('limit-card-empty');

  // 2. A cost limit with the automatic compact. The fake turn costs $0.01: it brings the cost to the limit, the chat stops, compacts once and refuses the next send.
  await fill('비용 제한(달러)', '0.01'); await toggle('중지되면 자동 압축'); await press('적용');
  await c.waitFor(`!!${chip}`, 8000);
  assert.equal(await status(), '적용 중');
  assert.equal(await text(`${chip}.lastChild.textContent.trim()`), '$0.01');
  await send('hello');
  await c.waitFor(line('비용 $0.01'), 20000);
  await c.waitFor(`${all('.chat-divider.compact')}.length === 1`, 20000); await idle();
  assert.equal(await text(`${chip}.lastChild.textContent.trim()`), '제한 도달');
  assert.ok(await has(`${chip}.classList.contains('stopped')`));
  assert.equal(await text(`${all('.chat-msg.user')}.filter(e => e.textContent.includes('/compact')).length`), 1, 'one automatic /compact');
  await c.shot('limit-stopped');
  await send('again');
  await c.waitFor(`document.body.innerText.includes('도달해 보낼 수 없습니다')`, 8000);
  assert.equal(await draft(), 'again', 'the refused message goes back into the input');
  assert.equal(await text(`${all('.chat-divider.compact')}.length`), 1, 'a refused send does not compact again');
  assert.equal(await text(`${all('.chat-divider.note')}.filter(e => e.textContent.includes('제한 규칙')).length`), 1, 'one stop line');

  // 3. Raising the limit lets the chat go on; clearing it removes the chip.
  await openCard(); assert.equal(await status(), '비용 $0.01 도달');
  await fill('비용 제한(달러)', '5'); await press('적용');
  await c.waitFor(`${chip}.lastChild.textContent.trim() === '$5.00'`, 8000);
  await send('again');
  await c.waitFor(`${all('.chat-msg.user')}.some(e => e.textContent.trim() === 'again')`, 8000); await idle();
  await press('해제'); await c.waitFor(`!${chip}`, 8000);
  assert.equal(await status(), '설정 없음');

  // 4. Plan usage: 사용량 한도 below the example 5시간 23% stops at once (read when it is set) and says which window; above it, the chat runs.
  await openCard();
  await toggle('사용량 한도'); await fill('사용량 한도(%)', 20); await press('적용');
  await c.waitFor(line('5시간 사용량 20%'), 8000);
  assert.equal(await text(`${chip}.lastChild.textContent.trim()`), '제한 도달');
  await send('ping'); await c.waitFor(`document.body.innerText.includes('5시간 사용량 20%)에 도달해 보낼 수 없습니다')`, 8000);
  await openCard();
  await fill('사용량 한도(%)', 50); await press('적용');
  await c.waitFor(`${chip}.lastChild.textContent.trim() === '5시간 50%'`, 8000);
  await send('ping');
  await c.waitFor(`${all('.chat-msg.user')}.some(e => e.textContent.trim() === 'ping')`, 8000); await idle();

  // 5. 사용량 할당 measures the rise since it was set: the example usage does not move, so 5% is far away; the chip says how far.
  await openCard();
  await toggle('사용량 할당'); await choose('사용량 할당', '주간'); await fill('사용량 할당(%)', 5); await press('적용');
  await c.waitFor(`${chip}.lastChild.textContent.includes('주간 할당 5%')`, 8000);
  assert.match(await text(`${chip}.lastChild.textContent.trim()`), /^5시간 50% · 주간 할당 5%$/);
  await c.ev(`${chip}.dispatchEvent(new MouseEvent('mouseenter'))`);
  await c.shot('limit-share');
  await openCard();
  await press('해제'); await c.waitFor(`!${chip}`, 8000);
  console.log('ok');
} catch (error) {
  console.error(await c.ev(`return ${all('.limit-card')}.map(e => e.innerText.replace(/\\n/g, ' / ')).join(' || ')`).catch(() => ''));
  await c.shot('limit-failure').catch(() => {});
  throw error;
} finally {
  if (opened) { await c.ev(`${all('button[aria-label="채팅 닫기"]')}[0]?.click()`).catch(() => {}); await sleep(500); }
  c.close();
}
