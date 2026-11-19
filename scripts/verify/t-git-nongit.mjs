// A project without any Git repository (a plain folder, `multiRepo` with 0 repositories): its Git drawer says so in a normal tab bar (no repository dropdown crammed into the
// header) and the one-time "Git 그래프" card does not offer to open that empty drawer. Needs a session with such a project active and the Git drawer open:
//   VERIFY_OUT=… node scripts/verify/t-git-nongit.mjs      (the drawer is opened here through its shortcut when it is closed)
import assert from 'node:assert/strict';
import { connect } from './cdp.mjs';
const c = await connect(page => page.url.includes('127.0.0.1')), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const shown = `[...document.querySelectorAll('.git-head')].find(h => h.getClientRects().length)`;
  if (!await c.ev(`return Boolean(${shown})`)) { await c.key('d', 'KeyD', 3); await sleep(800); } // Ctrl+Alt+D (gitLog)
  await c.waitFor(`Boolean(${shown})`);
  const head = await c.ev(`const h=${shown}; const r=h.getBoundingClientRect(); return { height: r.height, text: h.innerText.replace(/\\s+/g,' ').trim(), dropdown: !!h.querySelector('[aria-label="Git 저장소"]'), message: document.body.innerText.includes('Git 저장소가 없습니다.') }`);
  assert.equal(head.dropdown, false, `no repository dropdown without repositories: ${head.text}`);
  assert.ok(head.height > 0 && head.height <= 40, `the drawer header keeps one row (height ${head.height})`);
  assert.equal(head.message, true, 'the drawer says there is no repository');
  assert.equal(await c.ev(`return Boolean(document.querySelector('.git-graph-tip'))`), false, 'the Git graph card is not shown for a project without a repository');
  await c.shot('git-nongit');
  assert.deepEqual(c.problems, []);
  console.log('PASS: project without Git repository: drawer header, message and card');
} catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
finally { c.close(); setTimeout(() => process.exit(process.exitCode ?? 0), 100); } // the CDP timers would keep the process alive for 20 s otherwise
