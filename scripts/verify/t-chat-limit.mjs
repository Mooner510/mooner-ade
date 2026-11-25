// 제한: a chat's own limit (cost, share of a plan window, plan window usage), set from the status line's 제한 button; the stop line, the refused send and the automatic compact.
// Uses the fake claude (every turn costs $0.01, /compact answers like the CLI) and the session's example usage (5시간 23%, 주간 41%); no model and no real usage endpoint is touched.
// Run: VERIFY_OUT=… node scripts/verify/t-chat-limit.mjs  (or VERIFY_TAB=… on tmp/main). Opens its own Claude chat tab and closes it again: a project holds 16 chats at most.
import assert from 'node:assert/strict';
import { connect } from './cdp.mjs';

const c = await connect(page => page.url.includes('127.0.0.1')), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Other chat tabs stay mounted (hidden, inert), so only what is on screen counts.
const all = sel => `[...document.querySelectorAll('${sel}')].filter(e => !e.closest('[inert]') && e.getClientRects().length)`;
const has = expr => c.ev(`return !!(${expr})`);
const text = expr => c.ev(`return (${expr}) ?? ''`);
const button = `${all('button.chat-stat-limit')}[0]`, panel = `${all('.limit-panel .lp')}.at(-1)`, chip = `${all('button.chat-stat-limit.set')}[0]`;
const chipText = () => text(`${chip}.querySelector('.stat-text').textContent.trim()`);
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
  // The panel is mounted only while it is open; applying closes it again.
  const openPanel = async () => { await c.waitFor(`!!${button}`, 8000); await c.ev(`${button}.click()`); await c.waitFor(`!!${panel}`, 8000); };
  const fill = async (label, value) => { await c.ev(`const el = ${panel}.querySelector('input[aria-label="${label}"]'); el.focus(); el.select()`); await c.type(String(value)); };
  const toggle = label => c.ev(`[...${panel}.querySelectorAll('label')].find(l => l.textContent.includes('${label}')).querySelector('input').click()`);
  const choose = (row, name) => c.ev(`[...${panel}.querySelectorAll('.lp-row')].find(r => r.textContent.includes('${row}')).querySelector('.lp-seg').querySelectorAll('button')[${name === '주간' ? 1 : 0}].click()`);
  const press = label => c.ev(`[...${panel}.querySelectorAll('button')].find(b => b.textContent.trim() === '${label}').click()`);
  const status = () => text(`${panel}.querySelector('.lp-foot em').textContent`);

  // 1. Without a limit the button is a quiet icon; the panel offers what a Claude plan chat can be limited by.
  // The start screen shows only the usage meter: the 제한 button appears with the first turn (which costs the fake $0.01).
  await send('warmup'); await c.waitFor(`${all('.chat-msg.user')}.length === 1`, 8000); await idle();
  await c.waitFor(`!!${button}`, 8000);
  assert.ok(await has(`${button}.classList.contains('idle')`) && !await has(chip), 'an icon without a limit');
  await openPanel();
  assert.equal(await status(), '설정 없음');
  assert.deepEqual(await c.ev(`return [...${panel}.querySelectorAll('.lp-name')].map(e => e.textContent.trim())`), ['비용', '사용량 할당', '사용량 한도', '중지되면 자동 압축']);
  // The global `label` rule is a column: the checkbox must sit beside its name, every row must fit the panel, and the panel must not scroll sideways.
  assert.ok(await has(`[...${panel}.querySelectorAll('.lp-name')].every(e => getComputedStyle(e).flexDirection === 'row') && [...${panel}.querySelectorAll('.lp-row')].every(e => getComputedStyle(e).flexDirection === 'row')`), 'rows and names lay out in a row');
  assert.ok(await has(`${panel}.closest('.limit-panel').scrollWidth <= ${panel}.closest('.limit-panel').clientWidth`), 'no sideways scroll');
  await c.shot('limit-panel-empty');
  // A chosen window is a filled segment: its background differs from the unchosen one's.
  await choose('사용량 할당', '주간');
  assert.notEqual(await text(`getComputedStyle(${panel}.querySelectorAll('.lp-seg')[0].querySelectorAll('button')[1]).backgroundColor`), await text(`getComputedStyle(${panel}.querySelectorAll('.lp-seg')[0].querySelectorAll('button')[0]).backgroundColor`));
  assert.ok(await has(`${panel}.querySelectorAll('input[type=checkbox]')[0].checked`), 'choosing a window turns its row on');
  await c.ev(`${button}.click()`); // closed without applying: nothing is kept
  await c.waitFor(`!${panel}`, 5000);

  // 2. A cost limit with the automatic compact. The cost item beside the chip already shows the amount, so the chip says only the limit ($0.02, not $0.01/$0.02).
  // The fake turn reports a total of $0.01 (the warmup already did): lowering the limit to $0.01 stops the chat at once. A stop found when the limit is set is not live,
  // so no automatic compact follows (the live stop + compact is covered by tests/chat-session.test.mjs); the next send is refused.
  await openPanel();
  await fill('비용 제한(달러)', '0.02'); await toggle('중지되면 자동 압축'); await press('적용');
  await c.waitFor(`!!${chip}`, 8000);
  assert.equal(await chipText(), '제한 $0.02', 'no amount repeated');
  assert.ok(await has(`${all('.chat-stat-cost')}.length`), 'the cost item shows the amount');
  await c.shot('limit-cost-once');
  await openPanel(); await fill('비용 제한(달러)', '0.01'); await press('적용');
  await c.waitFor(line('비용 $0.01'), 20000);
  await send('hello'); await idle();
  assert.equal(await chipText(), '제한 도달');
  assert.ok(await has(`${chip}.classList.contains('stopped')`));
  assert.equal(await text(`${all('.chat-msg.user')}.filter(e => e.textContent.includes('/compact')).length`), 0, 'a stop found at set time does not compact');
  await c.shot('limit-stopped');
  await send('again');
  await c.waitFor(`document.body.innerText.includes('도달해 보낼 수 없습니다')`, 8000);
  assert.equal(await draft(), 'again', 'the refused message goes back into the input');
  assert.equal(await text(`${all('.chat-divider.compact')}.length`), 0, 'a refused send does not compact');
  assert.equal(await text(`${all('.chat-divider.note')}.filter(e => e.textContent.includes('제한 규칙')).length`), 1, 'one stop line');

  // 3. Raising the limit lets the chat go on; clearing it turns the button back into the icon.
  await openPanel(); assert.equal(await status(), '비용 $0.01 도달');
  await fill('비용 제한(달러)', '5'); await press('적용');
  await c.waitFor(`/\\$5\\.00$/.test(${chip}.textContent.trim())`, 8000);
  await send('again');
  await c.waitFor(`${all('.chat-msg.user')}.some(e => e.textContent.trim() === 'again')`, 8000); await idle();
  await openPanel(); await press('해제'); await c.waitFor(`!${chip}`, 8000);

  // 4. Plan usage: 사용량 한도 below the example 5시간 23% stops at once (read when it is set) and says which window; above it, the chat runs.
  await openPanel();
  await toggle('사용량 한도'); await fill('사용량 한도(%)', 20); await press('적용');
  await c.waitFor(line('5시간 사용량 20%'), 8000);
  assert.equal(await chipText(), '제한 도달');
  await send('ping'); await c.waitFor(`document.body.innerText.includes('5시간 사용량 20%)에 도달해 보낼 수 없습니다')`, 8000);
  await openPanel();
  await fill('사용량 한도(%)', 50); await press('적용');
  await c.waitFor(`${chip}.textContent.trim() === '제한 5시간 23/50%'`, 8000);
  await send('ping');
  await c.waitFor(`${all('.chat-msg.user')}.some(e => e.textContent.trim() === 'ping')`, 8000); await idle();

  // 5. 사용량 할당 measures the rise since it was set: the example usage does not move, so 5% is far away; the chip says how far.
  await openPanel();
  await toggle('사용량 할당'); await choose('사용량 할당', '주간'); await fill('사용량 할당(%)', 5); await press('적용');
  await c.waitFor(`${chip}.textContent.includes('주간 할당')`, 8000);
  assert.match(await chipText(), /^제한 5시간 23\/50%, 주간 할당 \d+\/5%$/);
  await openPanel(); await c.shot('limit-share');
  await press('해제'); await c.waitFor(`!${chip}`, 8000);
  console.log('ok');
} catch (error) {
  console.error(await c.ev(`return ${all('.limit-panel')}.map(e => e.innerText.replace(/\\n/g, ' / ')).join(' || ')`).catch(() => ''));
  await c.shot('limit-failure').catch(() => {});
  throw error;
} finally {
  if (opened) { await c.ev(`${all('button[aria-label="채팅 닫기"]')}[0]?.click()`).catch(() => {}); await sleep(500); }
  c.close();
}
