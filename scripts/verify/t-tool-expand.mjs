// Run after opening a fake-Claude chat: VERIFY_OUT=… node scripts/verify/t-tool-expand.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, env } from './cdp.mjs';

const c = await connect(page => page.url.includes('127.0.0.1'));
const ctlFile = join(env().temp, 'ctl.json'), previous = await readFile(ctlFile, 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bundle = '.chat-scroll .chat-bundle:last-child';
try {
  await writeFile(ctlFile, JSON.stringify({ ...JSON.parse(previous), mtms: 4000 }));
  await c.key('Escape', 'Escape');
  await c.clickSel('textarea[aria-label="메시지 입력"]');
  await c.type('manytools'); await c.key('Enter', 'Enter', 0, '\r');
  await c.waitFor(`document.querySelector('${bundle} .chat-bundle-list')?.children.length >= 5`, 30000);
  const head = `${bundle} .chat-bundle-item:nth-child(4) .chat-tool-head`;
  await c.centre(head);
  await sleep(400);
  const top = await c.ev(`return document.querySelector('${head}').getBoundingClientRect().top`);
  const point = await c.ev(`const r=document.querySelector('${head}').getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]`);
  await c.click(...point);
  await c.waitFor(`document.querySelector('${bundle}')?.classList.contains('expanded')`);
  await sleep(600);
  const opened = await c.ev(`const h=document.querySelector('${head}'), l=h.closest('.chat-bundle-list'); return { top:h.getBoundingClientRect().top, open:h.getAttribute('aria-expanded'), max:getComputedStyle(l).maxHeight, height:l.clientHeight }`);
  assert.equal(opened.open, 'true'); assert.equal(opened.max, 'none'); assert.ok(opened.height > 91);
  assert.ok(Math.abs(opened.top - top) < 3, `heading moved ${opened.top - top}px`);
  await c.shot('tool-open');
  await c.waitFor(`document.querySelector('${bundle} .chat-bundle-list')?.children.length >= 7`, 15000);
  const later = await c.ev(`return document.querySelector('${head}').getBoundingClientRect().top`);
  assert.ok(Math.abs(later - opened.top) < 3, 'new tools moved the reading position');
  // The clicked button keeps focus: keyboard closing must not shrink the bundle.
  await c.key('Enter', 'Enter', 0, '\r'); await sleep(400);
  assert.equal(await c.ev(`return document.querySelector('${head}').getAttribute('aria-expanded')`), 'false');
  assert.equal(await c.ev(`return document.querySelector('${bundle}').classList.contains('expanded')`), true);
  await c.clickSel(`${bundle} .chat-bundle-head`); await sleep(500);
  await c.waitFor(`!document.querySelector('${bundle}').classList.contains('expanded')`);
  assert.notEqual(await c.ev(`return getComputedStyle(document.querySelector('${bundle} .chat-bundle-list')).maxHeight`), 'none');
  // Keyboard opening from the compact preview follows the same expansion path.
  await c.key('Tab', 'Tab'); await c.key('Enter', 'Enter', 0, '\r'); await sleep(400);
  assert.equal(await c.ev(`return document.querySelector('${bundle}').classList.contains('expanded')`), true);
  assert.equal(await c.ev(`return document.querySelector('${bundle} .chat-tool-head').getAttribute('aria-expanded')`), 'true');
  await c.shot('tool-expand');
  assert.deepEqual(c.problems, []);
  console.log('PASS: tool expansion, heading anchor, streaming, persistent bundle and keyboard');
} finally {
  await writeFile(ctlFile, previous); c.close();
}
