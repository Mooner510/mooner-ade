// Changelog window with the version sidebar. Usage: VERIFY_OUT=… node scripts/verify/t-changelog.mjs   (needs a running start-ui.mjs session with a project open)
import { connect } from './cdp.mjs'; import { eq, ok } from './lib.mjs';
const c = await connect(p => p.url.includes('127.0.0.1'));
// Red dots follow the latest update (FROM..LAST) and what was already opened (VIEWED): make every version after 0.5.5 count as new and unopened.
await c.ev(`localStorage.setItem('ade-changelog-seen','0.5.5'); localStorage.setItem('ade-changelog-from','0.5.5'); localStorage.setItem('ade-changelog-last','9.9.9'); localStorage.removeItem('ade-changelog-viewed'); return 1`);
await c.waitFor(`!!document.querySelector('button[aria-label="변경 내역"]')`, 20000); await c.clickSel('button', '변경 내역'); await c.waitFor(`!!document.querySelector('.changelog-nav')`);
const state = () => c.ev(`const n=[...document.querySelectorAll('.changelog-nav button')]; return { versions: n.map(b=>b.textContent.trim()), pressed: n.find(b=>b.getAttribute('aria-pressed')==='true')?.textContent.trim(), shown: [...document.querySelectorAll('.changelog-entry')].map(e=>e.getAttribute('aria-label')), dots: document.querySelectorAll('.changelog-new-dot').length, h: document.querySelector('.changelog').getBoundingClientRect().height }`);
let s = await state(); console.log(JSON.stringify(s)); await c.shot('changelog-latest');
ok(s.versions.length >= 2, 'sidebar lists versions'); eq(s.shown.length, 1); eq(s.shown[0], s.versions[0].match(/^v[\d.]+/)[0]); // the button also holds how long ago it was released ok(s.dots >= 1, 'new dot for versions newer than seen');
await c.clickSel('.changelog-nav button', 'v0.5.5'); s = await state(); console.log(JSON.stringify(s)); await c.shot('changelog-old');
eq(s.shown, ['v0.5.5']); eq(s.pressed.startsWith('v0.5.5'), true);
await c.send('Emulation.setDeviceMetricsOverride', { width: 520, height: 800, deviceScaleFactor: 1, mobile: false }); await new Promise(r => setTimeout(r, 400)); await c.shot('changelog-narrow'); await c.send('Emulation.clearDeviceMetricsOverride');
await c.key('Escape', 'Escape'); await c.waitFor(`!document.querySelector('.changelog[open]:not(.closing)')`);
console.log('problems', JSON.stringify(c.problems)); c.close();
