// The actual preload UI in the isolated browser; only the Electron IPC transport is mocked.
// VERIFY_OUT=… node scripts/verify/t-update-progress.mjs [--preview]
import { readFileSync } from 'node:fs';
import { connect } from './cdp.mjs';
import { eq, ok } from './lib.mjs';

const c = await connect(p => p.url.includes('127.0.0.1'));
try {
  await c.waitFor('!!document.querySelector("button")', 20000);
  await c.ev('window.updatePreview?.(null)');
  const source = readFileSync(new URL('../../apps/desktop/src/preload.cjs', import.meta.url), 'utf8');
  await c.ev(`
    const electron = { contextBridge: { exposeInMainWorld() {} }, ipcRenderer: { on(name, handler) { if (name === 'ade:update-progress') window.updatePreview = value => handler(null, value); } } };
    new Function('require', 'process', ${JSON.stringify(source)})(() => electron, { platform: 'darwin' });
    window.updatePreview({ text: 'v0.5.12 다운로드 중… 42 / 100 MB', fraction: .42 });
  `);
  const state = await c.ev(`
    const box = document.querySelector('#ade-update-progress'), card = box.firstChild.getBoundingClientRect(), rect = box.getBoundingClientRect();
    return { modal: box.matches(':modal'), coversScreen: rect.width === innerWidth && rect.height === innerHeight,
      centered: Math.abs(card.x + card.width / 2 - innerWidth / 2) < 1 && Math.abs(card.y + card.height / 2 - innerHeight / 2) < 1,
      value: box.querySelector('[role=progressbar]').getAttribute('aria-valuenow') };
  `);
  eq(state, { modal: true, coversScreen: true, centered: true, value: '42' });
  await c.ev(`window.updateBackgroundClicks = 0; document.body.addEventListener('click', event => { if (!event.target.closest('#ade-update-progress')) window.updateBackgroundClicks++; }, { once: true });`);
  await c.click(4, 4);
  eq(await c.ev('return window.updateBackgroundClicks'), 0);
  await c.key('Tab', 'Tab');
  ok(await c.ev(`return document.querySelector('#ade-update-progress').contains(document.activeElement) || document.activeElement === document.body`), 'Tab cannot focus background controls');
  await c.key('Escape', 'Escape');
  ok(await c.ev('return document.querySelector("#ade-update-progress").matches(":modal")'), 'Escape does not dismiss an active update');
  await c.ev(`window.updatePreview({ text: '압축 푸는 중…', fraction: null });`);
  eq(await c.ev(`const box = document.querySelector('#ade-update-progress'); return [document.querySelectorAll('#ade-update-progress').length, box.querySelector('[role=progressbar]').hasAttribute('aria-valuenow')];`), [1, false]);
  for (const [fraction, expected] of [[-1, '0'], [2, '100']]) {
    await c.ev(`window.updatePreview({ text: '다운로드 중…', fraction: ${fraction} });`);
    eq(await c.ev(`return document.querySelector('#ade-update-progress [role=progressbar]').getAttribute('aria-valuenow')`), expected);
  }
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await c.ev(`window.updatePreview({ text: '압축 푸는 중…', fraction: NaN });`);
  eq(await c.ev(`const bar = document.querySelector('#ade-update-progress [role=progressbar]'); return [bar.hasAttribute('aria-valuenow'), bar.firstChild.getAnimations().length];`), [false, 0]);
  await c.send('Emulation.setEmulatedMedia', { features: [] });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: false });
  await c.waitFor('innerWidth === 360');
  ok(await c.ev(`const r = document.querySelector('#ade-update-progress').firstChild.getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth;`), 'card fits a narrow viewport');
  await c.send('Emulation.clearDeviceMetricsOverride');
  await c.ev('window.updatePreview(null)');
  eq(await c.ev('return !!document.querySelector("#ade-update-progress")'), false);
  if (process.argv.includes('--preview')) {
    await c.ev(`window.updatePreview({ text: 'v0.5.12 다운로드 중… 42 / 100 MB', fraction: .42 });`);
    await c.shot('update-progress-preview');
  }
  eq(c.problems, []);
  console.log('PASS update overlay: modal, centered, full viewport, Escape, reuse, determinate/indeterminate, bounds, narrow viewport, cleanup');
} finally { await c.send('Emulation.clearDeviceMetricsOverride'); await c.send('Emulation.setEmulatedMedia', { features: [] }); c.close(); }
