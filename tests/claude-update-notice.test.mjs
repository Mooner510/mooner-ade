import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('an outdated CLI shows the new version, and when it takes effect is the smaller note', async t => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('vite', { paths: [fileURLToPath(new URL('../apps/web', import.meta.url))] }))('esbuild');
  const directory = await mkdtemp(join(tmpdir(), 'ade-cli-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'notice.cjs');
  await build({
    stdin: {
      contents: `
        import { renderToStaticMarkup } from 'react-dom/server';
        import { CliUpdateNotice } from './ClaudeUpdateNotice';
        export const html = renderToStaticMarkup(<CliUpdateNotice agent="claude" />);
      `,
      loader: 'tsx',
      resolveDir: fileURLToPath(new URL('../apps/web/src/', import.meta.url)),
    },
    bundle: true,
    jsx: 'automatic',
    platform: 'node',
    format: 'cjs',
    outfile,
    plugins: [{
      name: 'stub-cli-update',
      setup(b) {
        b.onResolve({ filter: /^\.\/claude-update$/ }, args => ({ path: args.path, namespace: 'stub-cli-update' }));
        b.onLoad({ filter: /.*/, namespace: 'stub-cli-update' }, () => ({
          contents: `export function useCliUpdate() { return { status: { installed: true, current: '2.0.0', latest: '2.1.9', outdated: true }, run: { phase: 'idle' }, update() {}, dismiss() {}, snoozed: () => false, snooze() {} }; }`,
          loader: 'js',
        }));
      },
    }],
  });
  const { html } = require(outfile);
  assert.match(html, /Claude Code 업데이트 가능 \(v2\.1\.9\)/);
  assert.match(html, /class="chat-update-cur"/);
  assert.match(html, /다음 대화부터 적용됩니다/);
  const css = await readFile(new URL('../apps/web/src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-update-cur \{ margin-left: 6px; color: var\(--muted\); font-size: 10px; font-weight: 400; \}/);
});
