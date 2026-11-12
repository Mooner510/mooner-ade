import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('custom dropdown exposes its label, choices and selected option', async t => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
  const directory = await mkdtemp(join(tmpdir(), 'ade-dropdown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'dropdown.cjs');
  await build({
    stdin: {
      contents: `import { createElement } from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { Dropdown } from './views';
        export const html = renderToStaticMarkup(createElement(Dropdown, {
          label: '색 테마', value: 'light', onChange() {},
          options: [{value:'dark',label:'어둡게'},{value:'light',label:'밝게'}]
        }));`,
      resolveDir: fileURLToPath(new URL('../apps/web/src', import.meta.url))
    },
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', outfile
  });
  const { html } = require(outfile);
  // The shown choice sits in a .dd-text span so a layout can hide the words and keep the icon (the feedback footer does when narrow).
  assert.match(html, /<summary aria-label="색 테마" aria-haspopup="listbox"><span class="dd-label"><span class="dd-text">밝게<\/span><\/span>/);
  assert.match(html, /role="listbox" popover="manual" aria-label="색 테마"/);
  assert.match(html, /role="option" tabindex="-1" aria-selected="false"><span class="dd-label">어둡게<\/span>/);
  assert.match(html, /role="option" tabindex="-1" aria-selected="true"><span class="dd-label">밝게<\/span>/);
  assert.doesNotMatch(html, /<select|<option/);
});
