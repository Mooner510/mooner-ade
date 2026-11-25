// Idle auto-compact for chats: the ADE setting (Claude tab), the per-chat /idlecompact, the chip's "자동 Compact 예정" and the compact ADE sends before the 1h cache expires.
// Uses the fake claude (no model, no usage): its ctl.json leaves a 1h-cache transcript of a 250K context whose request started 3200 s ago, so the compact is due
// 0.9 x 3600 s = 3240 s after it, i.e. about 40 s from the first message. Opens its own Claude chat tab and closes it again: a project holds 16 chats at most.
// Run: VERIFY_OUT=… node scripts/verify/t-idle-compact.mjs  (or VERIFY_TAB=… on tmp/main; it leaves the ADE setting off again).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from './cdp.mjs';
import { S } from './lib.mjs';

const c = await connect(page => page.url.includes('127.0.0.1')), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Other chat tabs stay mounted (hidden, inert), so only what is on screen counts.
const all = sel => `[...document.querySelectorAll('${sel}')].filter(e => !e.closest('[inert]') && e.getClientRects().length)`;
const has = expr => c.ev(`return !!(${expr})`);
const text = expr => c.ev(`return (${expr}) ?? ''`);
const chipTitle = `(${all('.cache-timer')}[0]?.getAttribute('title') ?? '')`;
let opened = false, settingsOn = false;
const toggleSetting = async () => {
  await c.ev(`document.querySelector('[aria-label="설정"]').click()`);
  await c.waitFor(`!!document.querySelector('[aria-label="설정 닫기"]')`, 8000);
  await c.ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('AI 툴')).click()`); await sleep(500);
  await c.ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Claude Code').click()`); await sleep(500);
  await c.waitFor(`[...document.querySelectorAll('.setting-row')].some(r => r.textContent.includes('캐시 만료 전 자동 Compact'))`, 8000);
  const row = `[...document.querySelectorAll('.setting-row')].find(r => r.textContent.includes('캐시 만료 전 자동 Compact'))`;
  await c.ev(`${row}.scrollIntoView({ block: 'center' })`);
  const before = await has(`${row}.querySelector('input[role=switch]').checked`);
  await c.ev(`${row}.querySelector('input[role=switch]').click()`); await sleep(400);
  const threshold = await has(`[...document.querySelectorAll('.setting-row')].some(r => r.textContent.includes('자동 Compact 기준(k 토큰)'))`);
  await c.shot(before ? 'idle-setting-off' : 'idle-setting-on');
  await c.ev(`document.querySelector('[aria-label="설정 닫기"]').click()`); await sleep(400);
  settingsOn = !before; await sleep(1500); // the page saves the setting, the server then repaints every chat
  return { on: !before, threshold };
};
try {
  // 0. The fake claude's transcript: a 250K context on the 1h cache, the request started 3200 s ago.
  writeFileSync(join(S, 'ctl.json'), JSON.stringify({ transcript: true, sessionUuid: true, ttl: 3600, transcriptAgeSec: 3200, tokens: 250000 }));
  await c.waitFor(`!!document.querySelector('[aria-label="새 탭 종류 선택"]')`, 20000);
  if (!await has(`document.querySelector('.launcher-menu')`)) await c.ev(`document.querySelector('[aria-label="새 탭 종류 선택"]').click()`);
  await c.waitFor(`document.querySelectorAll('.launcher-menu button').length > 3`, 5000);
  await c.ev(`[...document.querySelectorAll('.launcher-menu button')].find(b => b.textContent.includes('Claude') && b.textContent.includes('채팅 모드')).click()`);
  opened = true; await sleep(1500);
  await c.waitFor(`${all('textarea[aria-label="메시지 입력"]')}.length`, 15000);
  const box = `${all('textarea[aria-label="메시지 입력"]')}[0]`;
  const idle = () => c.waitFor(`${all('.chat-send.stop')}.length === 0`, 20000);
  const send = async message => { await c.ev(`${box}.focus(); ${box}.select()`); await c.type(message); await c.key('Enter', 'Enter', 0, '\r'); };
  // The space after the name closes the slash menu, whose Enter would only complete the name (the command has a hint).
  // The answer is a line in the thread: wait until one more line than before matches `answer`.
  const threadText = `${all('.chat-thread')}[0]?.innerText ?? ''`;
  const seen = answer => text(`(${threadText}).split('\\n').filter(line => ${answer}.test(line)).length`).then(Number);
  const ask = async (argument, answer) => { const before = await seen(answer); await send(`/idlecompact ${argument}`); await c.waitFor(`(${threadText}).split('\\n').filter(line => ${answer}.test(line)).length > ${before}`, 8000); };

  // 1. Off by default; the command says so and where the choice comes from.
  await ask('', /꺼짐 \(앱 설정을 따름\).*200K/);
  await ask('maybe', /on, off 또는 auto/);

  // 2. The ADE setting (Claude tab) turns it on for chats that follow it; its threshold row shows up with it.
  const on = await toggleSetting(); assert.deepEqual(on, { on: true, threshold: true });
  await ask('', /켜짐 \(앱 설정을 따름\).*200K/);

  // 3. The chat's own choice wins, off and on, and auto goes back to following the setting.
  await ask('off', /꺼짐 \(이 채팅 설정\)/);
  await ask('on', /켜짐 \(이 채팅 설정\)/);
  await ask('auto', /켜짐 \(앱 설정을 따름\)/);

  // 4. A message: the chip announces the compact (1h cache, 250K context), and ADE sends /compact itself near the end of the window.
  await send('hello'); await idle();
  await c.waitFor(`${chipTitle}.includes('자동 Compact 예정')`, 15000);
  const announced = await text(chipTitle); assert.match(announced, /1시간 갱신, 250K 토큰/);
  await c.shot('idle-chip-announced');
  const waited = Date.now();
  await c.waitFor(`${all('.chat-divider.compact')}.length === 1`, 90000);
  console.log(`compact after ${Math.round((Date.now() - waited) / 1000)} s of waiting`);
  assert.match(await text(`${all('.chat-divider.compact')}[0].textContent`), /^캐시 만료 전 자동 압축, 231k → 14\.6k 토큰/, 'the divider says ADE compacted it');
  await idle();
  assert.equal(await text(`${all('.chat-msg.user')}.filter(e => e.textContent.trim() === '/compact').length`), 1, 'one /compact, sent by ADE');
  await c.waitFor(`${chipTitle}.includes('자동 Compact, ') && !${chipTitle}.includes('자동 Compact 예정')`, 10000);
  await c.shot('idle-compacted');

  // 5. Never twice for the same cache window.
  await sleep(4000);
  assert.equal(await text(`${all('.chat-divider.compact')}.length`), 1);

  // 6. Back to how it was.
  await toggleSetting(); settingsOn = false;
  await ask('', /꺼짐 \(앱 설정을 따름\)/);
  console.log('ok');
} catch (error) {
  console.error(await c.ev(`return ${all('.chat-divider')}.map(e => e.textContent.trim()).join(' || ') + ' // chip: ' + (${chipTitle}).replace(/\\n/g, ' / ')`).catch(() => ''));
  await c.shot('idle-failure').catch(() => {});
  throw error;
} finally {
  if (settingsOn) await toggleSetting().catch(() => {});
  if (opened) { await c.ev(`${all('button[aria-label="채팅 닫기"]')}[0]?.click()`).catch(() => {}); await sleep(500); }
  c.close();
}
