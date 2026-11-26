// VERIFY_TAB=<name> node scripts/verify/t-update-progress.mjs [--preview] (project open)
import { readFileSync } from 'node:fs';
import { connect } from './cdp.mjs';
import { eq, ok } from './lib.mjs';

const c = await connect(p => p.url.includes('127.0.0.1'));
const progress = '#ade-update-progress';
const openSettings = 'button.bar-icon[aria-label="설정"]';
const autoDownload = 'input[aria-label="업데이트 자동 다운로드"]';
const positionLabel = '업데이트 카운트다운 위치';
const positionSelector = `summary[aria-label="${positionLabel}"]`;
const positionList = `[role=listbox][aria-label="${positionLabel}"]:popover-open`;
const positions = [
  ['top-left', '왼쪽 위'], ['middle-left', '왼쪽 중앙'], ['bottom-left', '왼쪽 아래'],
  ['top-center', '중앙 위'], ['middle-center', '중앙'], ['bottom-center', '중앙 아래'],
  ['top-right', '오른쪽 위'], ['middle-right', '오른쪽 중앙'], ['bottom-right', '오른쪽 아래'],
];
const emit = status => c.ev(`window.updatePreview(${JSON.stringify(status)})`);
const download = { kind: 'progress', text: 'v0.6.4 다운로드 중… 42 / 100 MB', fraction: .42 };
const source = readFileSync(new URL('../../apps/desktop/src/preload.cjs', import.meta.url), 'utf8');
// Hit-test before clicking so an overlay or inert background fails even in a background Chrome tab.
async function click(selector, text) {
  const find = `
    const controls = [...document.querySelectorAll(${JSON.stringify(selector)})];
    return controls.find(control => {
      if (control.closest('[inert]') || !control.textContent.includes(${JSON.stringify(text ?? '')})) return false;
      const r = control.getBoundingClientRect();
      return control.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    });`;
  await c.waitFor(`!!(() => { ${find} })()`);
  await c.ev(`(() => { ${find} })().click()`);
}
const injected = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const listeners = new Map(), ready = { kind: 'ready', version: '0.6.4', onQuit: false };
  let state = sessionStorage.getItem('ade-verify-update-ready') ? ready : null, auto = true;
  const positionKey = 'ade-verify-countdown-position';
  const getPosition = () => sessionStorage.getItem(positionKey) ?? 'middle-center';
  window.updatePreview = value => { state = value; listeners.get('ade:update-progress')?.(null, value); };
  window.previewRestart = () => window.updatePreview({ kind: 'countdown', restartAt: Date.now() + 10000, position: getPosition() });
  window.updateApplyCalls = 0;
  const electron = {
    contextBridge: { exposeInMainWorld(name, bridge) { window[name] = { updates: bridge.updates }; } },
    ipcRenderer: {
      invoke: async (name, value) => {
        if (name === 'ade:update-status') return state;
        if (name === 'ade:get-auto-download-updates') return auto;
        if (name === 'ade:set-auto-download-updates') return auto = value;
        if (name === 'ade:get-update-countdown-position') return getPosition();
        if (name === 'ade:set-update-countdown-position') { sessionStorage.setItem(positionKey, value); return getPosition(); }
        if (name === 'ade:apply-downloaded-update') { window.updateApplyCalls++; return 'staged'; }
      },
      on(name, handler) { listeners.set(name, handler); },
      off(name) { listeners.delete(name); },
    }
  };
  ((require, process) => { ${source}\n })(() => electron, { platform: '' });
})();` });

try {
  await c.send('Page.reload');
  await c.waitFor(`typeof window.updatePreview === 'function' && !!document.querySelector('${openSettings}') && !document.querySelector('.shell[inert], .splash')`, 20000);
  await c.ev(`document.querySelector('dialog.changelog[open]')?.dispatchEvent(new Event('cancel', { cancelable: true }));`);
  await c.waitFor("!document.querySelector('dialog[open]')");

  await emit(download);
  await c.waitFor(`!!document.querySelector('${progress}')`);
  eq(await c.ev(`const box = document.querySelector('${progress}'); return [box.parentElement.matches('.projects'), box.nextElementSibling.matches('.projects-foot'), box.closest('dialog') === null, box.querySelector('[role=progressbar]').getAttribute('aria-valuenow')];`), [true, true, true, '42']);

  await click(openSettings);
  await c.waitFor("!!document.querySelector('dialog.settings-modal[open]')");
  await click('.settings-nav button', '정보');
  await c.waitFor(`document.querySelector('${autoDownload}')?.checked`);
  await click(autoDownload);
  await c.waitFor(`document.querySelector('${autoDownload}')?.checked === false`);
  await c.waitFor(`document.querySelector('${positionSelector}')?.querySelector('.dd-text')?.textContent === '중앙'`);

  // A manual restart's countdown is visible even over Settings and leaves the underlying switch usable.
  await c.ev('window.updateCenterTarget = document.elementFromPoint(innerWidth / 2, innerHeight / 2);');
  await c.ev('window.previewRestart()');
  await c.waitFor("document.querySelector('#ade-update-countdown')?.matches(':popover-open')");
  ok(await c.ev(`const card = document.querySelector('#ade-update-countdown'), r = card.getBoundingClientRect();
    return card.querySelector('[role=timer]').textContent === '10' && Math.abs(r.x + r.width / 2 - innerWidth / 2) < 1 && Math.abs(r.y + r.height / 2 - innerHeight / 2) < 1;`), 'countdown starts at 10, centered');
  ok(await c.ev(`const countdown = document.querySelector('#ade-update-countdown'), style = getComputedStyle(countdown);
    const pixel = document.createElement('canvas').getContext('2d');
    const translucentWithShadow = element => {
      const { color, textShadow } = getComputedStyle(element);
      pixel.clearRect(0, 0, 1, 1);
      pixel.fillStyle = color;
      pixel.fillRect(0, 0, 1, 1);
      const alpha = pixel.getImageData(0, 0, 1, 1).data[3];
      return alpha > 0 && alpha < 255 && textShadow !== 'none';
    };
    return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.borderTopWidth === '0px' && [...countdown.children].every(translucentWithShadow);`), 'countdown has translucent, shadowed text without a card');
  ok(await c.ev(`return window.updateCenterTarget && document.elementFromPoint(innerWidth / 2, innerHeight / 2) === window.updateCenterTarget;`), 'center hit goes through the countdown');
  await click(autoDownload);
  await c.waitFor(`document.querySelector('${autoDownload}')?.checked`);
  await c.waitFor("document.querySelector('#ade-update-countdown [role=timer]')?.textContent === '9'");
  await emit(null);
  for (const [index, [position, label]] of positions.entries()) {
    await click(positionSelector);
    await c.waitFor(`!!document.querySelector('${positionList}')`);
    if (index === 0) eq(await c.ev(`return [...document.querySelectorAll('${positionList} [role=option] .dd-label')].map(label => label.textContent.trim());`), positions.map(([, name]) => name));
    await click(`${positionList} [role=option]:nth-child(${index + 1})`);
    await c.waitFor(`document.querySelector('${positionSelector}')?.querySelector('.dd-text')?.textContent === ${JSON.stringify(label)}`);
    await c.ev('window.previewRestart()');
    const [vertical, horizontal] = position.split('-');
    await c.waitFor(`!!document.querySelector('#ade-update-countdown[data-vertical="${vertical}"][data-horizontal="${horizontal}"]:popover-open')`);
    ok(await c.ev(`const countdown = document.querySelector('#ade-update-countdown'), r = countdown.getBoundingClientRect();
      const near = (actual, expected) => Math.abs(actual - expected) < 1;
      const x = { left: near(r.left, 24), center: near(r.x + r.width / 2, innerWidth / 2), right: near(r.right, innerWidth - 24) };
      const y = { top: near(r.top, 24), middle: near(r.y + r.height / 2, innerHeight / 2), bottom: near(r.bottom, innerHeight - 24) };
      return x['${horizontal}'] && y['${vertical}'] && [...countdown.children].every(text => getComputedStyle(text).textAlign === '${horizontal}');`), `${label} position and alignment`);
    await emit(null);
  }
  await click('button[aria-label="설정 닫기"]');
  await c.waitFor("!document.querySelector('dialog[open]')");

  await emit({ kind: 'progress', text: '압축 푸는 중…', fraction: null });
  await c.waitFor(`document.querySelector('${progress} [role=progressbar]')?.hasAttribute('aria-valuenow') === false`);
  for (const [fraction, expected] of [[-1, '0'], [2, '100']]) {
    await emit({ ...download, fraction });
    await c.waitFor(`document.querySelector('${progress} [role=progressbar]')?.getAttribute('aria-valuenow') === '${expected}'`);
  }
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await emit({ ...download, fraction: null });
  await c.waitFor(`document.querySelector('${progress} [role=progressbar]')?.hasAttribute('aria-valuenow') === false`);
  eq(await c.ev(`const bar = document.querySelector('${progress} [role=progressbar]'); return [bar.hasAttribute('aria-valuenow'), bar.firstChild.getAnimations().length];`), [false, 0]);

  await c.ev("sessionStorage.setItem('ade-verify-update-ready', '1')");
  await c.send('Page.reload');
  await c.waitFor("!!document.querySelector('.projects #ade-update-ready')", 20000);
  await click(openSettings);
  await c.waitFor("!!document.querySelector('dialog.settings-modal[open]')");
  await click('.settings-nav button', '정보');
  await c.waitFor(`document.querySelector('${positionSelector}')?.querySelector('.dd-text')?.textContent === '오른쪽 아래'`);
  await click('button[aria-label="설정 닫기"]');
  await c.waitFor("!document.querySelector('dialog[open]')");
  await click('#ade-update-ready button[aria-label="업데이트 지금 적용"]');
  eq(await c.ev('return window.updateApplyCalls'), 1, 'the restored notice applies the staged update');
  await emit(null);
  await c.waitFor("!document.querySelector('#ade-update-ready')");
  if (process.argv.includes('--preview')) { await emit(download); await c.waitFor(`!!document.querySelector('${progress}')`); await c.shot('update-progress-preview'); }
  eq(c.problems, []);
  console.log('PASS sidebar progress, settings, nine countdown positions with aligned text and click-through, reduced motion and saved state after reload');
} finally {
  await c.ev("sessionStorage.removeItem('ade-verify-update-ready'); sessionStorage.removeItem('ade-verify-countdown-position');");
  await c.send('Emulation.setEmulatedMedia', { features: [] });
  await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier });
  c.close();
}
