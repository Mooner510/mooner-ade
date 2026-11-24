// The approval card: 거부 also stops the turn; 허용 is a split button (this request only) whose menu holds "이 세션에서 허용" and, for an MCP tool,
// "이 도구 신뢰" / "이 MCP 신뢰" (kept in the provider's settings, removable there). Uses the fake claude's `bashperm` (a Bash approval) and `mcpperm`
// (an MCP tool with no suggestions) triggers; no model is called.
// Run: VERIFY_TAB=… node scripts/verify/t-approval-menu.mjs  (opens its own Claude chat tab from the new-tab menu and closes it again: a project holds 16 chats at most)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, env } from './cdp.mjs';

const c = await connect(page => page.url.includes('127.0.0.1')), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = () => readFileSync(join(env().temp, 'fake-claude.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const replies = () => log().filter(entry => entry.kind === 'approval-reply').map(entry => entry.reply);
const interrupts = () => log().filter(entry => entry.kind === 'control' && entry.sub === 'interrupt').length;
// Other chat tabs stay mounted (hidden, inert), so only what is on screen counts.
const all = sel => `[...document.querySelectorAll('${sel}')].filter(e => !e.closest('[inert]') && e.getClientRects().length)`;
const has = expr => c.ev(`return !!(${expr})`);
const card = '.chat-approval', menuItem = text => `${all('.approve-menu [role=menuitem]')}.find(b => b.textContent.trim() === '${text}')`;
let opened = false;
try {
  // A fresh chat: the one on screen may be mid-turn from an earlier run.
  await c.waitFor(`!!document.querySelector('[aria-label="새 탭 종류 선택"]')`, 20000);
  if (!await has(`document.querySelector('.launcher-menu')`)) await c.ev(`document.querySelector('[aria-label="새 탭 종류 선택"]').click()`);
  await c.waitFor(`document.querySelectorAll('.launcher-menu button').length > 3`, 5000);
  await c.ev(`[...document.querySelectorAll('.launcher-menu button')].find(b => b.textContent.includes('Claude') && b.textContent.includes('채팅 모드')).click()`);
  opened = true; await sleep(1500);
  await c.waitFor(`${all('textarea[aria-label="메시지 입력"]')}.length`, 15000);
  const idle = () => c.waitFor(`${all('.chat-send.stop')}.length === 0`, 20000);
  const send = async text => { await c.ev(`${all('textarea[aria-label="메시지 입력"]')}[0].focus()`); await c.type(text); await c.key('Enter', 'Enter', 0, '\r'); };
  const ask = async text => { await send(text); await c.waitFor(`${all(`${card} footer .approve-split`)}.length`, 40000); };
  // The agent asks and the chat answers by itself: a reply is logged and no card ever shows.
  const answeredAlone = async text => { const before = replies().length; await send(text); await c.waitFor(`1`, 1); for (let i = 0; i < 60 && replies().length === before; i++) await sleep(150); assert.equal(replies().length, before + 1, `${text}: answered without a card`); assert.ok(!await has(`${all(card)}.length`), 'no card'); await idle(); };
  const footer = () => c.ev(`return ${all(`${card} footer button`)}.filter(b => !b.closest('.approve-menu')).map(b => b.getAttribute('aria-label') || b.textContent.trim()).join(' | ')`);
  const items = () => c.ev(`return ${all('.approve-menu [role=menuitem]')}.map(b => b.textContent.trim()).join(' | ')`);
  const openMenu = async () => { await c.ev(`${all(`${card} .approve-caret`)}[0].click()`); await c.waitFor(`${all('.approve-menu')}.length`, 4000); };
  const choose = async text => { await openMenu(); await c.ev(`${menuItem(text)}.click()`); await c.waitFor(`${all(card)}.length === 0`, 8000); await sleep(300); };
  const answer = (label) => c.ev(`${all(`${card} .approve-split > button`)}[0].click()`).then(() => c.waitFor(`${all(card)}.length === 0`, 8000)).then(() => sleep(300));

  const settingsList = async () => {
    if (!await has(`document.querySelector('dialog.settings-modal[open]')`)) { await c.ev(`[...document.querySelectorAll('button.bar-icon[aria-label="설정"]')].find(b => b.getClientRects().length).click()`); await c.waitFor(`!!document.querySelector('dialog.settings-modal[open]')`, 10000); }
    await sleep(400);
    await c.ev(`[...document.querySelectorAll('dialog.settings-modal button')].find(b => b.textContent.includes('AI 툴')).click()`); await sleep(400);
    await c.ev(`[...document.querySelectorAll('dialog.settings-modal [role=tab]')].find(b => b.textContent.includes('Claude Code')).click()`); await sleep(500);
    return c.ev(`const h = [...document.querySelectorAll('dialog.settings-modal h4.setting-group')].find(h => h.textContent.trim() === '신뢰한 MCP'); const out = []; for (let e = h?.nextElementSibling; e && e.tagName !== 'H4'; e = e.nextElementSibling) out.push(e.textContent.replace(/\\s+/g, ' ').trim()); return out`);
  };
  const unTrustAll = async () => { // earlier runs may have left entries (they would answer the MCP card by themselves)
    for (let rows = await settingsList(); rows.length && rows[0] !== ''; rows = await settingsList()) { if (rows[0].startsWith('신뢰한 MCP가 없습니다')) break; await c.ev(`[...document.querySelectorAll('dialog.settings-modal button')].find(b => b.getAttribute('aria-label')?.endsWith('신뢰 해제'))?.click()`); await sleep(600); }
    await c.key('Escape', 'Escape'); await c.waitFor(`!document.querySelector('dialog.settings-modal[open]')`, 5000);
  };
  await unTrustAll();

  // A Bash request: only "이 세션에서 허용" (the old "이 도구 항상 허용"): the chat then stops asking for Bash.
  await ask('bashperm');
  assert.equal(await footer(), '거부 | 허용 | 허용 방식 선택', 'no 다르게 하기 / 항상 허용 / 이 도구 항상 허용 buttons');
  await openMenu();
  assert.equal(await items(), '이 세션에서 허용');
  assert.ok(await has(`document.activeElement?.closest('.approve-menu')`), 'focus moves into the menu');
  const box = await c.ev(`const m = ${all('.approve-menu')}[0].getBoundingClientRect(), k = ${all(`${card} .approve-caret`)}[0].getBoundingClientRect(); return { menuTop: m.top, menuBottom: m.bottom, caretTop: k.top }`);
  assert.ok(box.menuBottom <= box.caretTop && box.menuTop >= 0, 'the menu opens above the caret and stays on screen');
  await c.key('Escape', 'Escape'); await c.waitFor(`${all('.approve-menu')}.length === 0`, 3000);
  assert.ok(await has(`${all(card)}.length`), 'Esc closes only the menu');
  let before = replies().length;
  await choose('이 세션에서 허용'); await idle();
  assert.equal(replies().length, before + 1);
  assert.deepEqual(replies().at(-1).updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }]);
  await answeredAlone('bashperm');

  // An MCP request: 허용 is this request only; the menu adds the two trusts.
  await ask('mcpperm');
  await openMenu();
  assert.equal(await items(), '이 세션에서 허용 | 이 도구 신뢰 | 이 MCP 신뢰');
  await c.shot('approval-menu');
  await c.key('Escape', 'Escape'); await c.waitFor(`${all('.approve-menu')}.length === 0`, 3000);
  before = replies().length; await answer(); await idle();
  assert.equal(replies().length, before + 1); assert.ok(!replies().at(-1).updatedPermissions?.length, 'a plain allow sends no rule');
  await ask('mcpperm');
  // 이 도구 신뢰: allowed now, and without a card from then on, until removed in the settings.
  await choose('이 도구 신뢰'); await idle();
  await answeredAlone('mcpperm');
  assert.deepEqual(await settingsList(), ['mooner_serverserver_exec해제'], 'the trusted tool is listed in the Claude settings');
  await c.shot('approval-trust-settings');
  await c.ev(`[...document.querySelectorAll('dialog.settings-modal button')].find(b => b.getAttribute('aria-label')?.endsWith('신뢰 해제')).click()`); await sleep(600);
  assert.deepEqual(await c.ev(`const h = [...document.querySelectorAll('dialog.settings-modal h4.setting-group')].find(h => h.textContent.trim() === '신뢰한 MCP'); return h.nextElementSibling.textContent.slice(0, 13)`), '신뢰한 MCP가 없습니다');
  await c.key('Escape', 'Escape'); await c.waitFor(`!document.querySelector('dialog.settings-modal[open]')`, 5000);
  await ask('mcpperm'); // removed: it asks again
  // 이 MCP 신뢰: every tool of the server.
  await choose('이 MCP 신뢰'); await idle();
  await answeredAlone('mcpperm');
  assert.deepEqual(await settingsList(), ['mooner_server모든 도구해제']);
  await c.ev(`[...document.querySelectorAll('dialog.settings-modal button')].find(b => b.getAttribute('aria-label')?.endsWith('신뢰 해제')).click()`); await sleep(600);
  await c.key('Escape', 'Escape'); await c.waitFor(`!document.querySelector('dialog.settings-modal[open]')`, 5000);

  // 거부 also stops the turn.
  await ask('mcpperm'); const stops = interrupts();
  await c.ev(`${all(`${card} footer > button`)}.find(b => b.textContent.trim() === '거부').click()`);
  await c.waitFor(`${all(card)}.length === 0`, 8000); await sleep(800);
  assert.equal(replies().at(-1).behavior, 'deny');
  assert.equal(interrupts(), stops + 1, '거부 sent an interrupt');
  console.log('ok');
} finally {
  if (opened) { // a pending card is refused first, then the chat is closed; a trust left by a failed run is removed
    await c.ev(`${all(`${card} footer > button`)}.find(b => b.textContent.trim() === '거부')?.click()`).catch(() => {}); await sleep(1200);
    await c.ev(`${all('button[aria-label="채팅 닫기"]')}[0]?.click()`).catch(() => {}); await sleep(500);
  }
  c.close();
}
