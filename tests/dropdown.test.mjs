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
        }));
        export const mode = labelOnlyTip => renderToStaticMarkup(createElement(Dropdown, {
          label: '권한 모드', value: 'auto', labelOnlyTip, onChange() {},
          options: [{ value: 'auto', label: '자동', icon: 'bolt' }]
        }));`,
      resolveDir: fileURLToPath(new URL('../apps/web/src', import.meta.url))
    },
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', outfile
  });
  const { html, mode } = require(outfile);
  // A text-only choice can show a tooltip if clipped, without adding a tooltip to the whole menu.
  assert.match(html, /<summary aria-label="색 테마" aria-haspopup="listbox"><span class="dd-label" data-tip-overflow=""><span class="dd-text">밝게<\/span><\/span>/);
  assert.doesNotMatch(html, /\s(?:title|data-tip)=/);
  assert.match(html, /role="listbox" popover="manual" aria-label="색 테마"/);
  assert.match(html, /role="option" tabindex="-1" aria-selected="false"><span class="dd-label">어둡게<\/span>/);
  assert.match(html, /role="option" tabindex="-1" aria-selected="true"><span class="dd-label">밝게<\/span>/);
  assert.doesNotMatch(html, /<select|<option/);

  assert.match(mode(false), /data-tip="권한 모드\n자동"/);
  const labelOnly = mode(true);
  assert.match(labelOnly, /data-tip="권한 모드"/);
  assert.doesNotMatch(labelOnly, /data-tip-overflow/);
  assert.match(labelOnly, /class="dd-text">자동<\/span>/);
  assert.match(labelOnly, /role="option" tabindex="-1" aria-selected="true"/);
});
