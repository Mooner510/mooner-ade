import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');

test('quick launch groups providers by mode and keeps the configured shell separate', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-launch-menu-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'menu.cjs');
  await build({ stdin: { contents: `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { LauncherMenu } from './LauncherMenu';
    import { launchersFor } from './launchers';
    export const render = (mode, hidden = []) => renderToStaticMarkup(createElement(LauncherMenu, {
      mode, items: launchersFor(mode, 'zsh').filter(item => !hidden.includes(item.id)), onModeChange() {}, onLaunch() {}, onClose() {}
    }));
  `, resolveDir: join(process.cwd(), 'apps/web/src') }, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', outfile });
  const { render } = require(outfile);
  for (const mode of ['chat', 'cli']) {
    const html = render(mode);
    assert.match(html, /role="dialog" aria-label="새 탭에서 실행"/);
    assert.match(html, new RegExp(`role="group" aria-label="${mode === 'chat' ? 'Chat으로' : 'CLI로'} 열기"`));
    assert.equal(html.split(`<small>${mode === 'chat' ? '채팅 모드' : 'CLI 모드'}</small>`).length - 1, 3);
    for (const name of ['Claude', 'Codex', 'Cursor']) assert.equal(html.split(`<strong>${name}</strong>`).length - 1, 1);
    assert.match(html, /class="launcher-menu-shell".*<strong>터미널<\/strong><small>zsh<\/small>/);
  }
  const hidden = render('chat', ['claude', 'codex', 'cursor']);
  assert.doesNotMatch(hidden, /launcher-menu-providers/);
  assert.match(hidden, /<strong>터미널<\/strong>/);
});
