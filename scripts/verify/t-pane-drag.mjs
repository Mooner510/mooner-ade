// VERIFY_TAB=<name> node scripts/verify/t-pane-drag.mjs with a single chat or terminal pane open.
import assert from 'node:assert/strict';
import { connect } from './cdp.mjs';

const c = await connect();
const page = 'main.app:not([hidden]) .tab-page:not([hidden]) .pane-layout';
const mouse = (type, x, y) => c.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
});
const rect = selector => c.ev(`return document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
const frames = () => c.ev('await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
let launcher;
const reduced = !!process.env.REDUCED;
try {
  // Keep animation frames ticking in our background tab without activating the Chrome window.
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (reduced) await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await c.waitFor(`!!document.querySelector('${page} .pane-content')`);
  assert.equal(await c.ev(`return document.querySelectorAll('${page} .pane-content').length`), 1);
  await c.clickSel(`${page} button[aria-label="분할"]`);
  await c.waitFor(`!!document.querySelector('${page} [aria-label="좌우 분할"]')?.offsetWidth`);
  await c.clickSel(`${page} [aria-label="좌우 분할"]`);
  await c.waitFor(`!!document.querySelector('${page} .pane-content > .launcher-pane')`);
  const id = await c.ev(`return document.querySelector('${page} .pane-content > .launcher-pane').closest('[data-leaf]').dataset.leaf`);
  launcher = `${page} [data-leaf="${id}"]`;
  await c.ev(`await Promise.all(document.querySelector('${launcher}').getAnimations({subtree:true}).filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  const host = `${launcher} .pane-content`, neighbour = `${page} [data-leaf]:not([data-leaf="${id}"]) .pane-content`;
  const dropSlot = `${page} [data-pane-drop-slot][data-preview-leaf="${id}"]`;
  const from = await rect(host), other = await rect(neighbour);
  const [x, y] = await c.centre(`${launcher} .pane-label`);
  const grabX = (x - from.left) / from.width, grabY = y - from.top;
  const panes = [host, neighbour];
  const assertReflow = async () => {
    for (const selector of panes) {
      const undistorted = await c.ev(`
        const pane = document.querySelector(${JSON.stringify(selector)});
        const header = pane.querySelector('.pane-tools');
        const scale = pane.hasAttribute('data-pane-drag-source') ? Number(getComputedStyle(pane).scale) : 1;
        if (Math.abs(header.offsetWidth - pane.firstElementChild.clientWidth) > 1 ||
            Math.abs(pane.firstElementChild.offsetWidth - pane.offsetWidth) > 1) return false;
        return [pane, header, header.querySelector('button')].every(el => {
          const r = el.getBoundingClientRect();
          return Math.abs(r.width - el.offsetWidth * scale) < 1 && Math.abs(r.height - el.offsetHeight * scale) < 1;
        });`);
      assert.ok(undistorted, 'pane, header and button keep their proportions at preview scale');
    }
  };
  const targetX = Math.round(other.left + other.width * .2);
  const targetY = Math.round(other.bottom - other.height * .1);
  for (const cancel of [true, false]) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await mouse('mousePressed', x, y);
    for (const [mx, my] of [[x - 12, y], [targetX, y], [x - 20, y], [targetX, targetY]]) {
      await mouse('mouseMoved', mx, my);
      await frames();
      const { held, scale } = await c.ev(`const el = document.querySelector('${host}');
        return { held: el.getBoundingClientRect().toJSON(), scale: Number(getComputedStyle(el).scale) }`);
      assert.ok(Math.abs(held.x + held.width * grabX - mx) < 2 && Math.abs(held.y + grabY * scale - my) < 2,
        'the header stays under the pointer as it changes shape');
      assert.ok(await c.ev(`const slot = document.querySelector('${dropSlot}');
        const copy = slot?.firstElementChild;
        if (!copy || !copy.inert || !copy.matches('.launcher-pane') ||
            document.querySelectorAll('${page} [data-pane-drop-slot]').length !== 1) return false;
        if (${mx === x - 12}) copy.dataset.verifiedCopy = '';
        const style = getComputedStyle(copy);
        return copy.hasAttribute('data-verified-copy') &&
          copy.querySelector('.launchers').textContent === document.querySelector('${host} .launchers').textContent &&
          style.visibility === 'visible' && style.filter.includes('blur(') &&
          Number(style.opacity) < 1 && style.pointerEvents === 'none';`),
        'the same blurred and translucent copy of the panel moves between destinations');
      await assertReflow();
    }
    if (reduced) assert.equal(await c.ev(`return document.querySelector('${neighbour}').getAnimations().length`), 0);
    const slot = await rect(dropSlot);
    assert.ok(slot.height < from.height * .6 && slot.width > from.width * 1.8, 'preview shows the vertical split');
    const otherSlot = await rect(`${page} [data-preview-leaf]:not([data-preview-leaf="${id}"])`);
    for (const [selector, target] of [[host, slot], [neighbour, otherSlot]]) {
      await c.waitFor(`Math.abs(document.querySelector('${selector}').offsetWidth - ${target.width}) < 1 &&
        Math.abs(document.querySelector('${selector}').offsetHeight - ${target.height}) < 1`);
    }
    await c.waitFor(`Number(getComputedStyle(document.querySelector('${host}')).scale) === .25`);
    const miniature = await rect(host);
    for (const key of ['width', 'height']) assert.ok(Math.abs(miniature[key] - slot[key] * .25) < 1);
    assert.equal(await c.ev(`return getComputedStyle(document.querySelector('${host} > section')).filter`), 'blur(3px)');
    await assertReflow();
    if (!cancel) console.log(`Held pane before release: ${Math.round(from.width)} × ${Math.round(from.height)} → ${Math.round(miniature.width)} × ${Math.round(miniature.height)} CSS px`);
    if (cancel) await c.key('Escape', 'Escape');
    await mouse('mouseReleased', targetX, targetY);
    await c.waitFor(`!document.querySelector('${page} .pane-preview') && !document.querySelector('${host}').getAnimations().length`);
    const landed = await rect(host), expected = cancel ? from : slot;
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(landed[key] - expected[key]) < 2, JSON.stringify({cancel, key, landed, expected}));
    assert.equal(await c.ev(`return getComputedStyle(document.querySelector('${host} > section')).filter`), 'none');
  }
  console.log('PASS pointer tracking, reversal, lightly blurred 25%-size preview, Escape and nested drop');
} finally {
  if (launcher) {
    if (await c.ev(`return !!document.querySelector('[data-pane-drag-source]')`)) await c.key('Escape', 'Escape');
    await c.ev(`document.querySelector('${launcher} .launcher-pane [aria-label="pane 닫기"]')?.click()`);
  }
  await c.waitFor(`!document.querySelector('${page} .pane-ghost')`);
  if (reduced) await c.send('Emulation.setEmulatedMedia', { features: [] });
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  c.close();
}
