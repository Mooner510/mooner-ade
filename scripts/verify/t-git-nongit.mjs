// A project without any Git repository (a plain folder, `multiRepo` with 0 repositories). Its Git drawer never opens (toggleGit refuses without a repository): the shortcut does
// nothing, the dimmed Git button says why for a few seconds, and the one-time "Git 그래프" card does not offer to open an empty drawer. A drawer that is already open (restored
// from a saved layout) has a normal tab bar with the message instead of a repository dropdown crammed into the header. Needs a session with such a project active:
//   VERIFY_OUT=… node scripts/verify/t-git-nongit.mjs
import assert from 'node:assert/strict';
import { connect } from './cdp.mjs';
const c = await connect(page => page.url.includes('127.0.0.1')), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const shown = `[...document.querySelectorAll('.git-head')].find(h => h.getClientRects().length)`;
  const button = `[...document.querySelectorAll('button[aria-label="Git 커밋 그래프"]')].find(b => b.getClientRects().length)`;
  assert.equal(await c.ev(`return Boolean(${button})`), true, 'the Git button is on the bar');
  assert.equal(await c.ev(`return ${button}.getAttribute('aria-disabled')`), 'true', 'the Git button is dimmed without a repository');
  if (await c.ev(`return Boolean(${shown})`)) {
    // A restored drawer: its header is one row with the message, no repository dropdown.
    const head = await c.ev(`const h=${shown}; const r=h.getBoundingClientRect(); return { height: r.height, text: h.innerText.replace(/\\s+/g,' ').trim(), dropdown: !!h.querySelector('[aria-label="Git 저장소"]'), message: document.body.innerText.includes('Git 저장소가 없습니다.') }`);
    assert.equal(head.dropdown, false, `no repository dropdown without repositories: ${head.text}`);
    assert.ok(head.height > 0 && head.height <= 40, `the drawer header keeps one row (height ${head.height})`);
    assert.equal(head.message, true, 'the drawer says there is no repository');
  } else {
    await c.key('g', 'KeyG', 10); await sleep(800); // Ctrl+Shift+G (gitLog)
    assert.equal(await c.ev(`return Boolean(${shown})`), false, 'the shortcut does not open a Git drawer without a repository');
    await c.ev(`${button}.click()`);
    await c.waitFor(`Boolean(document.querySelector('.bar-note'))`, 3000);
    assert.match(await c.ev(`return document.querySelector('.bar-note').textContent`), /Git 저장소가 없는 폴더/, 'the button explains why it does nothing');
    assert.equal(await c.ev(`return Boolean(${shown})`), false, 'the button does not open it either');
    await c.shot('git-nongit-note');
    await c.waitFor(`!document.querySelector('.bar-note')`, 6000); // the note goes away by itself
  }
  assert.equal(await c.ev(`return Boolean(document.querySelector('.git-graph-tip'))`), false, 'the Git graph card is not shown for a project without a repository');
  assert.deepEqual(c.problems, []);
  console.log('PASS: project without Git repository: no drawer, note on the button, no card');
} catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
finally { c.close(); setTimeout(() => process.exit(process.exitCode ?? 0), 100); } // the CDP timers would keep the process alive for 20 s otherwise
