import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Start an isolated Chrome with --remote-debugging-port, then set ADE_TEST_CDP to its HTTP URL.
test('sidebar native mouse dragging and Shift clicks', { skip: !process.env.ADE_TEST_CDP }, async t => {
  const require = createRequire(import.meta.url);
  const viteRequire = createRequire(require.resolve('vite', { paths: ['apps/web'] }));
  const { build } = viteRequire('esbuild');
  const bundle = await build({
    entryPoints: ['apps/web/src/main.tsx'], bundle: true, write: false, jsx: 'automatic', format: 'iife', nodePaths: ['apps/web/node_modules'],
    plugins: [{ name: 'sidebar-fixtures', setup(build) {
      build.onResolve({ filter: /^\.\/Workspace$/ }, () => ({ path: fileURLToPath(new URL('./fixtures/sidebar-drag/workspace.jsx', import.meta.url)) }));
      build.onResolve({ filter: /^\.\/(api|Editor|Settings|views|sound)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
        './api': `export const basename = path => path.split('/').pop(); export async function api(name) { if (name === 'app/state') return { openProjects: [{root:'/fixture', id:'project'}], activeProjectId:'project' }; if (name === 'recent') return []; return {}; }`,
        './Editor': `export const defaultSettings = { sidebarWidth:252, statusItems:[], theme:'dark' };`,
        './Settings': `export const SettingsModal = () => null;`,
        './views': `export const Modal = () => null;`,
        './sound': `export const playSound = () => {};`
      }[path] }));
      build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'css' }));
    } }], outdir: '/tmp/ade-sidebar-test'
  });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = await readFile(new URL('../apps/web/src/style.css', import.meta.url), 'utf8');
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/app.js' ? script : `<style>${css}</style><div id="root"></div><script>window.calls=[];window.events=[];for(const type of ['pointerdown','mousedown','mousemove','dragstart','drop','dragend','click'])document.addEventListener(type,e=>events.push({type,target:e.target.className,shift:e.shiftKey,buttons:e.buttons}),true);</script><script src="/app.js"></script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const endpoint = process.env.ADE_TEST_CDP;
  const page = await (await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' })).json();
  t.after(() => fetch(`${endpoint}/json/close/${page.id}`));
  const socket = new WebSocket(page.webSocketDebuggerUrl), pending = new Map();
  let sequence = 0;
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data), result = pending.get(message.id);
    if (result) { pending.delete(message.id); message.error ? result.reject(new Error(JSON.stringify(message.error))) : result.resolve(message.result); }
  });
  t.after(() => socket.close());
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const reset = async (reverse = false) => {
    await send('Page.bringToFront');
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}${reverse ? '/reverse' : '/'}` });
    for (let i = 0; i < 100; i++) {
      if (await evaluate('!!document.querySelector(".group-pane")')) { await settle(); return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Sidebar did not load');
  };
  const point = selector => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+${selector === '.group-pane' ? '3' : 'r.width/2'},y:r.y+r.height/2}})()`);
  let held = false;
  const mouse = async (type, p, shift = false) => {
    if (type === 'mousePressed') held = true;
    await send('Input.dispatchMouseEvent', { type, ...p, button: held ? 'left' : 'none', buttons: held && type !== 'mouseReleased' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, modifiers: shift ? 8 : 0 });
    if (type === 'mouseReleased') held = false;
    await settle();
  };
  const mutations = () => evaluate('calls.filter(([name])=>["movePane","moveTab","mergeTabs"].includes(name))');
  const start = async (selector, shift) => {
    const p = await point(selector);
    await mouse('mouseMoved', p, shift); await mouse('mousePressed', p, shift);
    await mouse('mouseMoved', { x: p.x + 12, y: p.y + 1 }, shift);
    return p;
  };
  for (const selector of ['.group-pane', '.group-pane .folder-tab-label', '.group-pane .icon', '.group-pane:nth-child(2) svg path']) {
    await t.test(`Shift click keeps the group: ${selector}`, async () => {
      await reset(); const p = await point(selector);
      await mouse('mousePressed', p, true); await mouse('mouseReleased', p, true);
      assert.deepEqual(await mutations(), []);
      assert.equal(await evaluate('calls.filter(([name])=>name==="selectPane").length'), 1);
      assert.equal(await evaluate('document.querySelector(".folder-group").draggable'), true);
    });
    await t.test(`Shift drag detaches only on drop: ${selector}`, async () => {
      await reset(); await start(selector, true);
      assert.equal(await evaluate('!!document.querySelector(".pane-drop-zone")'), true, JSON.stringify(await evaluate('events')));
      assert.deepEqual(await mutations(), []);
      const target = await point('.pane-drop-zone');
      await mouse('mouseMoved', target, true); await mouse('mouseMoved', target, true); await mouse('mouseReleased', target, true);
      const pane = selector.includes('nth-child(2)') ? 'two' : 'one';
      assert.deepEqual(await mutations(), [['movePane', 'group', pane, null, 'after']]);
    });
    await t.test(`Shift drag released inside its group stays put: ${selector}`, async () => {
      await reset(); const p = await start(selector, true);
      await mouse('mouseReleased', { x: p.x + 12, y: p.y + 1 }, true);
      assert.deepEqual(await mutations(), []);
      assert.equal(await evaluate('!!document.querySelector(".pane-drop-zone")'), false);
      assert.equal(await evaluate('!!document.querySelector(".drop-before, .drop-after, .drop-merge")'), false);
    });
  }
  await t.test('leaving the group and returning to another pane cancels the move', async () => {
    await reset(); await start('.group-pane .folder-tab-label', true);
    await mouse('mouseMoved', await point('.folder-tab'), true);
    await mouse('mouseMoved', await point('.folder-tab'), true);
    const target = await point('.group-pane:nth-child(2)');
    await mouse('mouseMoved', target, true); await mouse('mouseMoved', target, true);
    assert.equal(await evaluate('!!document.querySelector(".drop-before, .drop-after, .drop-merge")'), false);
    await mouse('mouseReleased', target, true);
    assert.deepEqual(await mutations(), []);
    assert.equal(await evaluate('!!document.querySelector(".pane-drop-zone")'), false);
  });
  for (const edge of ['top', 'bottom']) {
    await t.test(`dropping in the group's ${edge} padding keeps the group`, async () => {
      await reset(); await start('.group-pane .folder-tab-label', true);
      const target = await evaluate(`(()=>{const r=document.querySelector('.folder-group').getBoundingClientRect();return {x:r.x+r.width/2,y:r.${edge}${edge === 'top' ? '+2' : '-2'}}})()`);
      await mouse('mouseMoved', target, true); await mouse('mouseMoved', target, true); await mouse('mouseReleased', target, true);
      assert.deepEqual(await mutations(), []);
      assert.equal(await evaluate('!!document.querySelector(".pane-drop-zone")'), false);
    });
  }
  await t.test('plain drag moves the whole group from its label', async () => {
    await reset(); await start('.group-pane .folder-tab-label', false);
    assert.equal(await evaluate('!!document.querySelector(".pane-drop-zone")'), false);
    const target = await point('.folder-tab');
    await mouse('mouseMoved', target); await mouse('mouseMoved', target); await mouse('mouseReleased', target);
    assert.deepEqual(await mutations(), [['mergeTabs', 'group', 'other']]);
  });
  for (const [source, target, edge, reverse, expected] of [
    ['.folder-tab .folder-tab-label', '.folder-group', 'top', false, ['moveTab', 'other', 'group', false]],
    ['.group-pane .folder-tab-label', '.folder-tab', 'bottom', false, ['moveTab', 'group', 'other', true]],
    ['.folder-tab .folder-tab-label', '.folder-group', 'bottom', true, ['moveTab', 'other', 'group', true]],
    ['.group-pane .folder-tab-label', '.folder-tab', 'top', true, ['moveTab', 'group', 'other', false]]
  ]) {
    for (const inset of [2, -1]) {
      await t.test(`reorder ${source} at ${target} ${edge} inset ${inset}`, async () => {
        await reset(reverse); await start(source, false);
        const p = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(target)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.${edge}${edge === 'top' ? '+' : '-'}(${inset})}})()`);
        await mouse('mouseMoved', p); await mouse('mouseMoved', p); await mouse('mouseReleased', p);
        assert.deepEqual(await mutations(), [expected], JSON.stringify(await evaluate('events')));
      });
    }
  }
  await t.test('Shift drag merges just the selected pane into another tab', async () => {
    await reset(); await start('.group-pane:nth-child(2) svg path', true);
    const target = await point('.folder-tab');
    await mouse('mouseMoved', target, true); await mouse('mouseMoved', target, true); await mouse('mouseReleased', target, true);
    assert.deepEqual(await mutations(), [['movePane', 'group', 'two', 'other', 'merge']]);
  });
  await t.test('dropping outside a target keeps the group and clears drag state', async () => {
    await reset(); await start('.group-pane .folder-tab-label', true);
    const target = { x: 500, y: 300 };
    await mouse('mouseMoved', target, true); await mouse('mouseReleased', target, true);
    assert.deepEqual(await mutations(), []);
    assert.equal(await evaluate('!!document.querySelector(".pane-drop-zone")'), false);
  });
  await t.test('native drag cancellation keeps the group', async () => {
    await reset(); const p = await start('.group-pane .icon', true);
    await send('Input.cancelDragging');
    await mouse('mouseReleased', p, true);
    assert.deepEqual(await mutations(), []);
    assert.equal(await evaluate('!!document.querySelector(".pane-drop-zone")'), false);
  });
  await t.test('close button still clicks and cannot start a drag', async () => {
    await reset(); await mouse('mouseMoved', await point('.group-pane'));
    const p = await point('.group-pane .ptab-close');
    await mouse('mousePressed', p, true); await mouse('mouseReleased', p, true);
    assert.deepEqual(await evaluate('calls'), [['closePane', 'one']]);
    await reset(); await mouse('mouseMoved', await point('.group-pane'));
    await start('.group-pane .ptab-close .icon', true);
    assert.equal(await evaluate('!!document.querySelector(".pane-drop-zone")'), false);
    await mouse('mouseReleased', { x: 500, y: 300 }, true);
    assert.deepEqual(await mutations(), []);
  });
});
