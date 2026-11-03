import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Start an isolated Chrome with --remote-debugging-port, then set ADE_TEST_CDP to its HTTP URL.
test('a saved project that fails to reopen keeps its place unless its folder is gone', { skip: !process.env.ADE_TEST_CDP }, async t => {
  const require = createRequire(import.meta.url);
  const viteRequire = createRequire(require.resolve('vite', { paths: ['apps/web'] }));
  const { build } = viteRequire('esbuild');
  const bundle = await build({
    entryPoints: ['apps/web/src/main.tsx'], bundle: true, write: false, jsx: 'automatic', format: 'iife', nodePaths: ['apps/web/node_modules'],
    plugins: [{ name: 'restore-fixtures', setup(build) {
      build.onResolve({ filter: /^\.\/Workspace$/ }, () => ({ path: fileURLToPath(new URL('./fixtures/restore-failed/workspace.jsx', import.meta.url)) }));
      build.onResolve({ filter: /^\.\/(api|Editor|Settings|views|sound)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ resolveDir: process.cwd(), contents: {
        './api': `export class ApiError extends Error { constructor(code, message) { super(message); this.code = code; } }
          export const basename = path => path.split('/').pop();
          export async function api(name, input = {}) {
            if (name === 'app/state') { if (input.state) { window.saved = input.state; return {}; } return { openProjects: window.fixtureOpen.map(root => ({ root, id: root.slice(1) })), activeProjectId: '' }; }
            if (name === 'home') return { path: '/home' };
            if (name === 'recent') return [];
            return {};
          }`,
        './Editor': `export const defaultSettings = { sidebarWidth:252, statusItems:[], theme:'dark' };`,
        './Settings': `export const SettingsModal = () => null;`,
        './views': `export const Modal = () => null;`,
        './sound': `export const playSound = () => {};`
      }[path] }));
      build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'css' }));
    } }], outdir: '/tmp/ade-restore-test'
  });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const server = createServer((req, res) => {
    const open = new URL(req.url, 'http://x').searchParams.get('open') || '';
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/app.js' ? script : `<div id="root"></div><script>window.fixtureOpen=${JSON.stringify(open.split(','))};</script><script src="/app.js"></script>`);
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
  // The open list is saved 400 ms after it settles; wait for a save that reflects every failure.
  const saved = async (open, settled) => {
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/?open=${open.join(',')}` });
    for (let i = 0; i < 150; i++) {
      const value = await evaluate('window.saved ? window.saved.openProjects.map(entry => entry.root) : null');
      if (value && settled(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('The open list was never saved');
  };

  await t.test('a locked project keeps its place, a deleted one is dropped', async () => {
    const roots = await saved(['/a', '/locked', '/b', '/deleted'], value => !value.includes('/deleted'));
    assert.deepEqual(roots, ['/a', '/locked', '/b']);
  });
  await t.test('when every project fails, they stay saved and the project picker is shown', async () => {
    const roots = await saved(['/locked-one', '/locked-two'], value => value.length === 2);
    assert.deepEqual(roots, ['/locked-one', '/locked-two']);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepEqual(await evaluate('window.saved.openProjects.map(entry => entry.root)'), ['/locked-one', '/locked-two']);
    assert.equal(await evaluate('Boolean(document.querySelector("main.welcome"))'), true);
  });
});
