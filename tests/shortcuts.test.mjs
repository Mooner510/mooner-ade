import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAppState } from '../apps/local-server/src/ui-state.js';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
const resolveDir = fileURLToPath(new URL('../apps/web/src', import.meta.url));

test('shortcut overrides, defaults, punctuation and modifier conflicts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-keys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'keys.cjs');
  await build({ stdin: { contents: `export * from './shortcuts'; export { validCombo } from './chat-model';`, resolveDir }, bundle: true, platform: 'node', format: 'cjs', outfile });
  const { appKey, appKeyDefs, normalizeCombo, matches, combosOverlap, showAppKey, validCombo } = require(outfile);
  const key = (code, modifiers = {}) => ({ code, key: code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });
  assert.equal(new Set(appKeyDefs.map(def => def.id)).size, appKeyDefs.length);
  assert.equal(appKey({}, 'newTab'), 'mod+shift+t');
  assert.equal(appKey({ newTab: 'alt+k' }, 'newTab'), 'alt+k');
  assert.equal(appKey({}, 'splitRight'), 'ctrl+d');
  assert.equal(appKey({}, 'project9'), 'mod+alt+9');
  assert.ok(matches(appKey({ newTab: 'alt+k' }, 'newTab'), key('KeyK', { altKey: true })));
  assert.ok(!matches(appKey({ newTab: 'alt+k' }, 'newTab'), key('KeyT', { metaKey: true, shiftKey: true })));
  assert.ok(matches('mod+shift+t', key('KeyT', { metaKey: true, shiftKey: true })));
  assert.ok(matches('mod+shift+t', key('KeyT', { ctrlKey: true, shiftKey: true })));
  assert.ok(!matches('meta+shift+t', key('KeyT', { ctrlKey: true, shiftKey: true })));
  assert.ok(matches('ctrl+meta+k', key('KeyK', { ctrlKey: true, metaKey: true })));
  assert.ok(matches('alt+[', key('BracketLeft', { altKey: true, key: '“' })));
  assert.ok(matches('ctrl+,', key('Comma', { ctrlKey: true })));
  assert.ok(matches('f1', key('F1')));
  assert.ok(!validCombo('shift+comma') && !validCombo('shift+bracketleft') && !validCombo('shift+space'));
  assert.ok(validCombo('shift+arrowup') && validCombo('alt+comma'));
  assert.equal(normalizeCombo('shift+ctrl+bracketright'), 'ctrl+shift+]');
  assert.ok(combosOverlap('mod+shift+t', 'meta+shift+t'));
  assert.ok(combosOverlap('mod+shift+t', 'ctrl+shift+t'));
  assert.ok(combosOverlap('ctrl+shift+[', 'shift+ctrl+bracketleft'));
  assert.ok(!combosOverlap('meta+t', 'ctrl+t'));
  assert.doesNotMatch(showAppKey({ nextTab: 'ctrl+bracketright' }, 'nextTab'), /Bracketright/);
});

test('app shortcut overrides survive persistence validation; malformed values are rejected', () => {
  const state = appKeys => ({ openProjects: [], activeProjectId: '', settings: { appKeys, chatKeys: { stash: 'ctrl+k' } } });
  const overrides = { newTab: 'meta+alt+k', project9: 'ctrl+9', nextTab: 'alt+bracketright' };
  assert.deepEqual(validateAppState(state(overrides)).settings.appKeys, overrides);
  assert.deepEqual(validateAppState(state({})).settings.appKeys, {});
  for (const bad of [null, [], 'ctrl+k', { newTab: 1 }, { newTab: 'ctrl+k\n' }, { 'bad id': 'ctrl+k' }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`tab${i}`, 'alt+k']))]) {
    assert.throws(() => validateAppState(state(bad)), { code: 'INVALID_INPUT' });
  }
});

// Uses the same isolated Chrome endpoint as the sidebar UI tests.
test('shortcut editor changes, cancels, rejects duplicates and resets individual/all bindings', { skip: !process.env.ADE_TEST_CDP }, async t => {
  const bundle = await build({ stdin: { contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { SettingsModal } from './Settings';
    import { defaultSettings } from './Editor';
    function App() {
      const [settings, setSettings] = useState(defaultSettings), [version, setVersion] = useState(0);
      window.saved = settings;
      window.reopen = () => setVersion(value => value + 1);
      return <SettingsModal key={version} initialSection="keys" settings={settings} onChange={setSettings} onClose={() => {}} />;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `, loader: 'tsx', resolveDir }, bundle: true, write: false, jsx: 'automatic', external: ['monaco-editor', 'monaco-editor/*'], format: 'iife' });
  const css = await readFile(new URL('../apps/web/src/style.css', import.meta.url), 'utf8');
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : `<style>${css}</style><div id="root"></div><script src="/app.js"></script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = process.env.ADE_TEST_CDP;
  const page = await (await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' })).json();
  t.after(() => fetch(`${endpoint}/json/close/${page.id}`));
  const socket = new WebSocket(page.webSocketDebuggerUrl), pending = new Map();
  let sequence = 0;
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data), request = pending.get(message.id);
    if (request) { pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
  });
  t.after(() => socket.close());
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async label => { await evaluate(`document.querySelector('[aria-label="${label}"]').click()`); await settle(); };
  const press = async (key, code, modifiers = 0) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers }); await settle(); };
  // click() doesn't focus a button, so explicitly focus the editor before sending native key events.
  const edit = async label => { await evaluate(`document.querySelector('[aria-label="${label} 단축키 변경"]').focus()`); await click(`${label} 단축키 변경`); };
  const resetDisabled = () => evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('단축키 초기화')).disabled`);
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` });
  for (let i = 0; i < 100; i++) { if (await evaluate('!!document.querySelector(".kbd-edit")')) break; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.equal(await resetDisabled(), true);
  await edit('새 탭'); await press('k', 'KeyK', 1);
  assert.equal(await evaluate('saved.appKeys.newTab'), 'alt+k');
  assert.equal(await resetDisabled(), false);
  await edit('탭 닫기'); await press('k', 'KeyK', 1);
  assert.match(await evaluate('document.querySelector("[role=alert]").textContent'), /이미 쓰는/);
  assert.equal(await evaluate('saved.appKeys.closeTab'), undefined);
  await press('Escape', 'Escape');
  await edit('다음 탭'); await press('Escape', 'Escape');
  assert.equal(await evaluate('saved.appKeys.nextTab'), undefined);
  await edit('입력 임시 보관 / 복원'); await press('l', 'KeyL', 2);
  assert.equal(await evaluate('saved.chatKeys.stash'), 'ctrl+l');
  await evaluate('reopen()'); await settle();
  assert.equal(await evaluate('saved.appKeys.newTab'), 'alt+k');
  await click('새 탭 단축키 되돌리기');
  assert.deepEqual(await evaluate('saved.appKeys'), {});
  assert.equal(await resetDisabled(), false); // the chat override still exists
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('단축키 초기화')).click()`); await settle();
  assert.deepEqual(await evaluate('[saved.appKeys,saved.chatKeys]'), [{}, {}]);
  assert.equal(await resetDisabled(), true);
  // Entering the displayed default must not leave a redundant override or enable Reset.
  await edit('새 탭'); await press('T', 'KeyT', 4 | 8); // macOS Cmd+Shift+T
  assert.deepEqual(await evaluate('saved.appKeys'), {});
  assert.equal(await resetDisabled(), true);
});
