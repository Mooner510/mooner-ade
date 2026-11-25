import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('system certificate preferences use the main window and an affirmative answer', async t => {
  const handlers = new Map(), answers = [], prompts = [];
  const webContents = { mainFrame: {} }, window = { webContents, isDestroyed: () => false };
  const userData = mkdtempSync(join(tmpdir(), 'ade-ca-test-'));
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  globalThis.caTestElectron = {
    app: {},
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { async showMessageBox(parent, options) {
      assert.equal(parent, window);
      prompts.push(options.message);
      return { response: answers.shift() };
    } }
  };
  const hook = registerHooks({ resolve(specifier, ctx, next) {
    if (specifier === 'electron') return { url: 'data:text/javascript,export const {app,dialog,ipcMain}=globalThis.caTestElectron', shortCircuit: true };
    return next(specifier, ctx);
  } });
  t.after(() => { hook.deregister(); delete globalThis.caTestElectron; });
  const { setupSystemCa } = await import('../apps/desktop/src/system-ca.js');
  setupSystemCa({ userData, nodeBinary: '', getWindow: () => window, trusted: event => event.allowed });
  const event = { sender: webContents, senderFrame: webContents.mainFrame, allowed: true };
  const invoke = (name, source, ...args) => handlers.get('ade:system-ca:' + name)(source, ...args);
  for (const name of ['get', 'set', 'offer']) {
    for (const change of [{ allowed: false }, { sender: {} }, { senderFrame: {} }])
      assert.throws(() => invoke(name, { ...event, ...change }, true), /허용되지/);
  }
  assert.equal(prompts.length, 0);
  answers.push(0);
  assert.equal(await invoke('set', event, true), false);
  answers.push(1, 1);
  assert.equal(await invoke('set', event, true), true);
  assert.equal(invoke('get', event), true);
});
