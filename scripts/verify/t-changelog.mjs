// Full-screen changelog: a beta note (its own colour, BETA badge, left-aligned, no intro), version sidebar, the 0.6.0+ intro (centre -> header slot), live demos that only hover, and the plain page of older versions.
// Usage: VERIFY_TAB=<name> node scripts/verify/t-changelog.mjs   (needs a running session with a project open; shots go to <session>/shots)
// A tab that is not on screen gets no real mouse input and no animation clock, so this drives the page with DOM clicks, seeks the intro's animations by hand and forces frames with a screenshot.
import { connect } from './cdp.mjs'; import { eq, ok } from './lib.mjs';
const c = await connect(p => p.url.includes('127.0.0.1'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const click = (sel, text) => c.ev(`const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>!${JSON.stringify(text ?? '')}||e.textContent.includes(${JSON.stringify(text ?? '')})||(e.getAttribute('aria-label')||'').includes(${JSON.stringify(text ?? '')})); if(!e) throw new Error('no element '+${JSON.stringify(sel)}); e.click(); return 1`);
const phase = () => c.ev(`return document.querySelector('.changelog-main')?.dataset.phase ?? null`);
const frame = name => c.shot('changelog-' + name); // a screenshot makes the hidden tab draw a frame, which is what runs IntersectionObserver and animation events
const closeAll = async () => { for (let i = 0; i < 3; i++) { if (!await c.ev(`return !!document.querySelector('.changelog[open]:not(.closing)')`)) return; await c.ev(`document.querySelector('.changelog').dispatchEvent(new Event('cancel', { cancelable: true })); return 1`); await sleep(250); } };
const open = async () => { await closeAll(); await click('button', '변경 내역'); await c.waitFor(`!!document.querySelector('.changelog-main')`, 5000); };
const seek = ms => c.ev(`for (const a of document.getAnimations()) if (a.effect?.target?.closest?.('.changelog-intro')) { a.pause(); a.currentTime = ${ms}; } const r = document.querySelector('.changelog-hero')?.getBoundingClientRect(); return r && [r.x, r.y, r.width, r.height]`);
const settle = () => c.ev(`for (const a of document.getAnimations()) { try { if (a.timeline?.constructor.name === 'DocumentTimeline' && a.effect?.getTiming().iterations !== Infinity) a.finish(); } catch {} } return 1`); // not the scroll-driven ones: they follow the scroll
// Red dots follow the latest update (FROM..LAST) and what was already opened (VIEWED): make every version after 0.5.5 count as new and unopened.
await c.ev(`localStorage.setItem('ade-changelog-seen','0.5.5'); localStorage.setItem('ade-changelog-from','0.5.5'); localStorage.setItem('ade-changelog-last','9.9.9'); localStorage.removeItem('ade-changelog-viewed'); return 1`);
await c.waitFor(`!!document.querySelector('button[aria-label^="변경 내역"]') && !document.querySelector('.splash')`, 30000);

// 1. full screen + intro
await open();
// 0. a beta note (the newest entry while package.json is a beta): no intro, a BETA badge, left-aligned page in the one beta colour, unlike a stable note
{ const first = await c.ev(`const e = document.querySelector('.changelog-entry'); return { beta: e.hasAttribute('data-beta'), badge: document.querySelector('.changelog-beta')?.textContent ?? null, colour: getComputedStyle(e.querySelector('.changelog-version')).color === getComputedStyle(document.querySelector('.changelog-beta')).color, tagline: !!document.querySelector('.changelog-tagline'), flex: getComputedStyle(e.querySelector('h3')).display, version: e.querySelector('.changelog-version').textContent }`);
  if (first.beta) {
    eq([first.badge, first.colour, first.tagline, first.flex], ['BETA', true, false, 'flex'], 'a beta note: BETA badge, the version in the beta colour, no tagline, left-aligned header');
    eq(await c.ev(`return [!!document.querySelector('.changelog-intro'), document.querySelector('.changelog-main').dataset.phase]`), [false, 'page'], 'a beta plays no intro'); await frame('beta');
    ok(await c.ev(`return !!document.querySelector('.changelog-nav button[data-beta]')`), 'the sidebar marks the beta version');
  }
  await click('.changelog-nav button', 'v0.6.0'); await sleep(200); // the first version with an intro
}
const view = await c.ev(`return [innerWidth, innerHeight]`);
const box = await c.ev(`const r = document.querySelector('dialog.changelog').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]`);
eq(box, [0, 0, view[0], view[1]], 'the changelog fills the window');
await c.waitFor(`!!document.querySelector('.changelog-hero')`, 5000);
eq(await phase(), 'intro'); eq(await c.ev(`return getComputedStyle(document.querySelector('.changelog-nav')).opacity`), '0', 'the sidebar waits for the intro');
// the first intro of a version the app just updated to (red dot, never opened) cannot be skipped by a click
eq(await c.ev(`const i = document.querySelector('.changelog-intro'); return [i.hasAttribute('data-locked'), getComputedStyle(i).cursor]`), [true, 'default'], 'the first intro is marked as one that plays through');
await seek(100); // freeze the intro first: forced frames would otherwise let it finish by itself, which says nothing about the click
await click('.changelog-intro'); await frame('intro-clicked'); await sleep(300);
eq(await phase(), 'intro', 'a click does not skip the first intro');
const slot = await c.ev(`const r = document.querySelector('.changelog-version').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]`);
const bodyMid = await c.ev(`const b = document.querySelector('.changelog-body'); return b.getBoundingClientRect().left + b.clientWidth / 2`);
ok(Math.abs(slot[0] + slot[2] / 2 - bodyMid) < 3, `the version is centred at the top: its middle ${slot[0] + slot[2] / 2} vs the page's ${bodyMid}`);
ok(slot[1] >= 24, `with room above it: ${slot[1]}px`); ok(slot[3] >= 44 && slot[3] <= 52, `at a size a little below the first version of this header (48px): ${slot[3]}px tall`);
// the line under the version keeps its distance (box to box); the old gap was 18px
let hero = await seek(100); await frame('intro-start');
ok(Math.abs(hero[0] + hero[2] / 2 - view[0] / 2) < 3 && Math.abs(hero[1] + hero[3] / 2 - view[1] / 2) < 3, `the version starts in the middle of the screen: ${hero}`);
ok(hero[3] > 100, 'and big');
const small = await seek(1900); ok(small[3] < hero[3] && small[3] > slot[3] * 2, 'it shrinks a little first, still in the middle'); await frame('intro-small');
await seek(2300); await frame('intro-moving');
hero = await seek(2790); ok(Math.abs(hero[0] - slot[0]) < 6 && Math.abs(hero[1] - slot[1]) < 6 && Math.abs(hero[2] - slot[2]) < 6, `it lands on the header slot: ${hero} vs ${slot}`);
await c.ev(`for (const a of document.getAnimations()) if (a.effect?.target?.classList?.contains('changelog-hero')) a.finish(); return 1`);
for (let i = 0; i < 8 && await phase() !== 'page'; i++) { await frame('intro-end'); await sleep(200); }
eq(await phase(), 'page', 'the intro ends on the page'); eq(await c.ev(`return !!document.querySelector('.changelog-hero')`), false);
await settle(); await sleep(300); await frame('page-top');
{ const v = await c.ev(`const r = document.querySelector('.changelog-version').getBoundingClientRect(), t = document.querySelector('.changelog-tagline').getBoundingClientRect(); return [r.bottom, t.top]`); ok(v[1] - v[0] >= 36, `room between the version and its line: ${v[1] - v[0]}px`); }
// the header is see-through at rest (the page light shows through) and solid once the notes scroll under it
const backing = () => c.ev(`return Number(getComputedStyle(document.querySelector('.changelog-entry > h3'), '::before').opacity)`);
ok(await backing() < 0.05, 'the header has no backing at rest');
await c.ev(`document.querySelector('.changelog-body').scrollTop = 120; return 1`); await frame('scrolled'); await sleep(300); await frame('scrolled');
ok(await backing() > 0.95, 'and a solid one when scrolled');
await c.ev(`document.querySelector('.changelog-body').scrollTop = 0; return 1`); await frame('top-again'); await sleep(200);

// 2. the sidebar keeps the red dots and lists every version; one version at a time
const state = () => c.ev(`const n=[...document.querySelectorAll('.changelog-nav button')]; return { versions: n.map(b=>b.querySelector('.changelog-nav-version').textContent), pressed: n.find(b=>b.getAttribute('aria-pressed')==='true')?.querySelector('.changelog-nav-version').textContent, shown: [...document.querySelectorAll('.changelog-entry')].map(e=>e.getAttribute('aria-label')), dots: document.querySelectorAll('.changelog-new-dot').length }`);
let s = await state(); console.log(JSON.stringify(s));
ok(s.versions.length >= 2, 'sidebar lists versions'); eq(s.shown.length, 1); eq(s.shown[0], 'v0.6.0');
ok(s.dots >= 1, 'red dots for versions newer than seen');

// 3. demos: all mount, none of them works (state that would flip on a click stays), and the page's own styles do not leak into them
const total = await c.ev(`return document.querySelectorAll('.changelog-demo').length`); ok(total >= 20, `demos on the page: ${total}`);
const height = await c.ev(`return document.querySelector('.changelog-body').scrollHeight`);
for (let y = 0; y < height; y += 700) { await c.ev(`document.querySelector('.changelog-body').scrollTop = ${y}; return 1`); await frame('scroll'); await sleep(500); await settle(); }
await c.waitFor(`[...document.querySelectorAll('.changelog-demo')].every(d => d.childElementCount > 0)`, 8000);
const before = await c.ev(`return performance.getEntriesByType('resource').length`);
const inert = () => c.ev(`const q = s => document.querySelector(s); return {
  shell: q('.changelog-demo .chat-shell .chat-tool-head')?.getAttribute('aria-expanded'),
  blocked: [...document.querySelectorAll('.changelog-demo .chat-blocked input[type=checkbox]')].map(i => i.checked),
  radio: [...document.querySelectorAll('.changelog-demo input[type=radio][name]')].map(i => i.checked).join(),
  popover: document.querySelectorAll('.changelog-demo :popover-open').length,
  dialogs: document.querySelectorAll('dialog[open]').length }`);
const was = await inert();
await c.ev(`for (const b of document.querySelectorAll('.changelog-demo button, .changelog-demo input, .changelog-demo summary, .changelog-demo a')) b.click(); return 1`); await sleep(300); await frame('clicked');
eq(await inert(), was, 'clicking every button of every demo changes nothing');
eq(await c.ev(`return performance.getEntriesByType('resource').filter(e => /agent\\/update|chat\\/|feedback\\//.test(e.name)).length`), 0, 'and calls no server action');
eq(await c.ev(`return performance.getEntriesByType('resource').length`) - before <= 4, true, 'nor fetches anything else');
eq(await c.ev(`const h = document.querySelector('.changelog-demo h3'); return h ? getComputedStyle(h).position : 'none'`) !== 'sticky', true, "a demo's own headings are not the page header");
// :hover still works: force it on a segment that is not selected and see its colour change
await c.send('DOM.enable'); await c.send('CSS.enable');
const { root } = await c.send('DOM.getDocument', { depth: 0 });
const { nodeId } = await c.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.changelog-popover .usage-ttl-option[aria-checked=false]' });
const colour = () => c.ev(`return getComputedStyle(document.querySelector('.changelog-popover .usage-ttl-option[aria-checked=false]')).color`);
const idle = await colour(); await c.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] }); await frame('hover'); await sleep(400); const hot = await colour(); await c.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
ok(idle !== hot, `hover changes the demo (${idle} -> ${hot})`);

// 4. an older version: the plain page, no intro, no demos
await c.ev(`document.querySelector('.changelog-body').scrollTop = 0; return 1`);
await click('.changelog-nav button', 'v0.5.5'); await sleep(200);
s = await state(); console.log(JSON.stringify(s));
eq(s.shown, ['v0.5.5']); eq(s.pressed, 'v0.5.5');
eq(await c.ev(`return [!!document.querySelector('.changelog-main[data-rich]'), !!document.querySelector('.changelog-intro'), document.querySelectorAll('.changelog-demo').length, !!document.querySelector('.changelog-tagline')]`), [false, false, 0, false], 'older versions keep the old page');
await frame('old');

// 5. picking a new-format version again replays the intro; a click on it skips to the page; Esc skips first, then closes
await click('.changelog-nav button', 'v0.6.0'); await c.waitFor(`!!document.querySelector('.changelog-intro')`, 3000); eq(await phase(), 'intro');
eq(await c.ev(`const i = document.querySelector('.changelog-intro'); return [i.hasAttribute('data-locked'), getComputedStyle(i).cursor]`), [false, 'pointer'], 'a version already opened can be skipped by a click');
await click('.changelog-intro'); await c.waitFor(`document.querySelector('.changelog-main')?.dataset.phase === 'page'`, 3000);
await closeAll(); await open(); await click('.changelog-nav button', 'v0.6.0'); await c.waitFor(`!!document.querySelector('.changelog-intro')`, 3000);
await c.ev(`document.querySelector('.changelog').dispatchEvent(new Event('cancel', { cancelable: true })); return 1`); await sleep(200);
eq([await phase(), await c.ev(`return !!document.querySelector('.changelog[open]:not(.closing)')`)], ['page', true], 'the first Esc skips the intro');
await c.ev(`document.querySelector('.changelog').dispatchEvent(new Event('cancel', { cancelable: true })); return 1`);
await c.waitFor(`!document.querySelector('.changelog[open]:not(.closing)')`, 3000);

// 6. reduced motion: no intro
await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await open(); await click('.changelog-nav button', 'v0.6.0'); await sleep(300);
eq([await phase(), await c.ev(`return !!document.querySelector('.changelog-intro')`)], ['page', false], 'reduced motion goes straight to the page');
await c.send('Emulation.setEmulatedMedia', { features: [] });

// 7. narrow window: one column, nothing wider than the screen
await c.send('Emulation.setDeviceMetricsOverride', { width: 520, height: 800, deviceScaleFactor: 1, mobile: false }); await sleep(500); await frame('narrow');
ok(await c.ev(`const b = document.querySelector('.changelog-body'); return b.scrollWidth <= b.clientWidth + 1`), 'no sideways scroll at 520px');
await c.send('Emulation.clearDeviceMetricsOverride');
await closeAll();
console.log('problems', JSON.stringify(c.problems)); eq(c.problems.length, 0, 'no console errors'); c.close();
