// Auto mode's refusals can be allowed and retried from the chat. Run after t-open-chat.mjs: VERIFY_OUT=… node scripts/verify/t-auto-denial.mjs
// The fake claude's `autoblock` trigger refuses two Bash calls the way the CLI does (only the error result's text names the classifier);
// a message containing "다시 실행해" is answered with the permissions.allow the host sent through apply_flag_settings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, env } from './cdp.mjs';

const c = await connect(page => page.url.includes('127.0.0.1')), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = () => readFileSync(join(env().temp, 'fake-claude.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const card = '.chat-blocked', rows = `${card} .chat-blocked-list li`;
const button = text => `[...document.querySelectorAll('${card} footer button')].find(b => b.textContent.trim() === '${text}')`;
try {
  await c.key('Escape', 'Escape');
  await c.clickSel('textarea[aria-label="메시지 입력"]');
  // A card from an earlier run may still be on screen: wait for this turn's own answer, then for both rows of this turn.
  const answers = `(document.querySelector('.chat-scroll').textContent.match(/머지가 자동 모드에 막혔습니다/g) || []).length`, answersBefore = await c.ev(`return ${answers}`);
  await c.type('autoblock'); await c.key('Enter', 'Enter', 0, '\r');
  await c.waitFor(`${answers} > ${answersBefore}`, 20000);
  await c.waitFor(`document.querySelectorAll('${rows}').length === 2`, 8000);
  assert.equal(await c.ev(`return document.querySelectorAll('${rows}').length`), 2, 'both refusals are listed');
  const usersBefore = log().filter(e => e.kind === 'user').length;
  const text = await c.ev(`return document.querySelector('${card}').textContent`);
  assert.match(text, /차단했습니다/); assert.match(text, /Merge Without Review/); assert.match(text, /Bash\(gh pr merge 13 --merge --delete-branch\)/);
  assert.match(text, /규칙으로 만들 수 없어/, 'the compound command has no exact rule');
  assert.equal(await c.ev(`return ${button('승인만')}.disabled`), true, 'allow-only needs a rule for every picked row');
  await c.shot('blocked-card');
  // Only the plain command: allow-only becomes possible, and nothing is sent to the agent.
  await c.clickSel(`${rows}:nth-child(2) input`);
  assert.equal(await c.ev(`return ${button('승인만')}.disabled`), false);
  await c.ev(`${button('승인만')}.click()`);
  await c.waitFor(`!!document.querySelector('${rows}:nth-child(1) small')?.textContent.includes('허용됨')`, 8000);
  assert.ok(log().some(e => e.kind === 'control' && e.sub === 'apply_flag_settings' && e.request?.settings?.permissions?.allow?.[0] === 'Bash(gh pr merge 13 --merge --delete-branch)'), 'the exact rule reached the CLI');
  assert.equal(log().filter(e => e.kind === 'user').length, usersBefore, 'allow-only sent no message');
  await c.shot('blocked-allowed');
  // Allow and retry (both rows again): the card goes, a message names the actions, and the agent answers with the rules it holds.
  await c.clickSel(`${rows}:nth-child(2) input`);
  await c.ev(`${button('승인하고 다시 시도')}.click()`);
  await c.waitFor(`!document.querySelector('${card}')`, 8000);
  await c.waitFor(`!!document.querySelector('.chat-scroll')?.textContent.includes('retry allow=')`, 15000);
  const thread = await c.ev(`return document.querySelector('.chat-scroll').textContent`);
  assert.match(thread, /직접 승인합니다/); assert.match(thread, /git push && echo done/);
  assert.match(thread, /retry allow=\["Bash\(gh pr merge 13 --merge --delete-branch\)"\]/);
  await c.shot('blocked-retried');
  assert.deepEqual(c.problems.filter(problem => !/favicon/.test(problem)), [], 'no console errors');
  console.log('PASS auto-denial card');
} finally { c.close(); }
