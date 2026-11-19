// VERIFY_TAB=<name> node scripts/verify/t-mermaid.mjs (dummy Claude chat)
import assert from 'node:assert/strict';
import { connect } from './cdp.mjs';

const c = await connect();
const chat = 'main.app:not([hidden]) .tab-page:not([hidden]) .chat-pane.focused';
const preview = `${chat} .md-mermaid-preview`;
const modal = 'dialog.mermaid-modal[open]:not(.closing)';
const before = await c.ev(`return document.querySelectorAll('${preview}').length`);

const metrics = () => c.ev(`
  const dialog = document.querySelector('${modal}');
  const box = dialog?.getBoundingClientRect();
  const view = dialog?.querySelector('.mermaid-viewer-viewport')?.getBoundingClientRect();
  const svg = dialog?.querySelector('.mermaid-viewer-canvas > svg');
  const diagram = svg?.getBoundingClientRect();
  if (!box || !view || !diagram) return null;
  return {
    width: diagram.width, height: diagram.height,
    viewW: view.width, viewH: view.height,
    modalDx: box.x + box.width / 2 - document.documentElement.clientWidth / 2,
    modalDy: box.y + box.height / 2 - document.documentElement.clientHeight / 2,
    diagramDx: diagram.x + diagram.width / 2 - (view.x + view.width / 2),
    diagramDy: diagram.y + diagram.height / 2 - (view.y + view.height / 2),
    shapes: svg.querySelectorAll('path,rect,line,polygon,text').length,
  };
`);
const assertCentered = ({ modalDx, modalDy, diagramDx, diagramDy }) => {
  assert.ok([modalDx, modalDy, diagramDx, diagramDy].every(offset => Math.abs(offset) <= 2),
    JSON.stringify({ modalDx, modalDy, diagramDx, diagramDy }));
};

try {
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await c.waitFor(`document.querySelector('${chat} textarea[aria-label="메시지 입력"]')`);
  await c.ev(`document.querySelector('${chat} textarea[aria-label="메시지 입력"]').focus()`);
  await c.type('mermaid');
  const send = `${chat} button[aria-label="보내기"]:enabled`;
  await c.waitFor(`document.querySelector('${send}')`);
  await c.ev(`document.querySelector('${send}').click()`);
  await c.waitFor(`[...document.querySelectorAll('${preview} img')].slice(${before}).filter(img => img.naturalWidth > 0).length >= 2`, 30000);
  for (const index of [before, before + 1]) {
    if (index === before + 1) {
      await c.send('Emulation.setDeviceMetricsOverride', { width: 520, height: 500, deviceScaleFactor: 1, mobile: false });
      await c.waitFor('innerWidth === 520');
    }
    const inline = await c.ev(`
      const button = document.querySelectorAll('${preview}')[${index}];
      const card = button.parentElement;
      const rect = el => el.getBoundingClientRect().toJSON();
      return {
        card: rect(card), preview: rect(button), image: rect(button.querySelector('img')),
        expand: rect(card.querySelector('.md-mermaid-expand')), copy: rect(card.querySelector('.md-mermaid-copy')),
      };
    `);
    assert.ok(Math.abs(inline.card.bottom - inline.preview.bottom) <= 2, 'preview must fill the card without a footer');
    assert.ok(Math.abs(inline.expand.top - inline.copy.top) <= 1 && inline.expand.right < inline.copy.left,
      'expand and copy must share a row');
    assert.ok(inline.copy.right < inline.card.right && inline.copy.bottom <= inline.image.top &&
      inline.image.left >= inline.card.left && inline.image.right <= inline.card.right, 'controls and image must stay inside the card');

    if (index === before + 1) {
      await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 500, deviceScaleFactor: 1, mobile: false });
      await c.waitFor('innerWidth === 360');
    }
    await c.ev(`document.querySelectorAll('${preview}')[${index}].click()`);
    await c.waitFor(`(() => {
      const dialog = document.querySelector('${modal}');
      return dialog?.querySelector('.mermaid-viewer-canvas')?.style.transform;
    })()`);
    const fitted = await metrics();
    assertCentered(fitted);
    assert.ok(fitted.width > 80 && fitted.height > 80 && fitted.shapes > 4, JSON.stringify(fitted));
    assert.ok(fitted.width <= fitted.viewW && fitted.height <= fitted.viewH, JSON.stringify(fitted));
    await c.ev(`document.querySelector('${modal} button[aria-label="확대"]').click()`);
    await c.waitFor(`document.querySelector('${modal} .mermaid-viewer-canvas > svg').getBoundingClientRect().width > ${fitted.width + 1}`);
    assertCentered(await metrics());

    await c.ev(`[...document.querySelectorAll('${modal} button')].find(button => button.textContent === '맞춤').click()`);
    await c.waitFor(`Math.abs(document.querySelector('${modal} .mermaid-viewer-canvas > svg').getBoundingClientRect().width - ${fitted.width}) < 1`);
    assertCentered(await metrics());

    if (index === before) {
      await c.ev(`document.querySelector('${modal}').dispatchEvent(new Event('cancel', { cancelable: true }))`);
    } else {
      await c.ev(`document.querySelector('${modal} button[aria-label="닫기"]').click()`);
    }
    await c.waitFor(`!document.querySelector('dialog.mermaid-modal[open]')`);
  }

  assert.deepEqual(c.problems, []);
  console.log('ok: Mermaid previews, centered modal and zoom, narrow-window fit, cancel and close');
} finally {
  await c.send('Emulation.clearDeviceMetricsOverride');
  await c.send('Emulation.setEmulatedMedia');
  c.close();
}
process.exit(0);
