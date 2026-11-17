import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('plugin tab renders documents as text and provides masked secret inputs', async t => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
  const directory = await mkdtemp(join(tmpdir(), 'ade-plugin-tab-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'panel.cjs');
  await build({ stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { PluginTabPanel } from './PluginSettings';
    globalThis.window = { adeDesktop: { plugins: { action() {} } } };
    export const html = renderToStaticMarkup(<PluginTabPanel plugin={{ id:'example', folder:'example', name:'Example', state:'running', view:{ status:null, info:[], fields:[{key:'key',label:'API key',type:'password',value:'',placeholder:'',hint:''}], actions:[], document:{title:'Evidence',text:'<script>alert(1)</script>'} } }} />);
  `, loader: 'tsx', resolveDir: new URL('../apps/web/src/', import.meta.url).pathname }, bundle: true, jsx: 'automatic', platform: 'node', format: 'cjs', external: ['monaco-editor', 'monaco-editor/*'], outfile });
  globalThis.innerWidth = 1200; globalThis.innerHeight = 800;
  globalThis.document = { addEventListener() {} };
  const { html } = require(outfile);
  assert.match(html, /type="password"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  delete globalThis.window; delete globalThis.innerWidth; delete globalThis.innerHeight; delete globalThis.document;
});
