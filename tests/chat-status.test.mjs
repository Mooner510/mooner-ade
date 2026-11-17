import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The usage item (Plan Usage / API Usage) is a button that cannot be switched off. It is also the switch between the CLI plan and the API key.
test('the chat status line always shows the usage button; API Usage shows what it cost, Plan Usage the measured share', async t => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
  const directory = await mkdtemp(join(tmpdir(), 'ade-chat-status-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'status.cjs');
  await build({ stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { ChatStatusLine, usageBasis } from './ChatStatus';
    import { defaultSettings } from './Editor';
    import { emptyState } from './chat-model';
    const settings = { ...defaultSettings, chatStatusItems: ['tokens'] };
    const render = (state, share = null) => renderToStaticMarkup(<ChatStatusLine settings={settings} context={{ state, share }} onSettings={() => {}} onAuth={() => {}} />);
    export const plan = render({ ...emptyState(), agent: 'claude', auth: 'login' });
    export const measured = render({ ...emptyState(), agent: 'claude', auth: 'login' }, '12.3%p');
    export const api = render({ ...emptyState(), agent: 'claude', auth: 'key', apiKey: true, apiCostUsd: 0.4231 });
    export const busy = render({ ...emptyState(), agent: 'claude', auth: 'key', apiKey: true, status: 'working' });
    export const other = render({ ...emptyState(), agent: 'codex' });
    export const basis = [usageBasis({ ...emptyState(), apiKey: true }), usageBasis(emptyState()), usageBasis(emptyState(), '12%p')];
  `, loader: 'tsx', resolveDir: new URL('../apps/web/src/', import.meta.url).pathname }, bundle: true, jsx: 'automatic', platform: 'node', format: 'cjs', external: ['monaco-editor', 'monaco-editor/*'], outfile });
  globalThis.innerWidth = 1200; globalThis.innerHeight = 800; globalThis.document = { addEventListener() {} };
  const { plan, measured, api, busy, other, basis } = require(outfile);
  assert.deepEqual(basis, ['API Usage', 'Plan Usage', '12%p']); // the measured share replaces the words
  assert.match(plan, /<button[^>]*usage-basis plan[^>]*popoverTarget/); assert.match(plan, />Plan Usage</); // shown although the item is switched off in the settings
  assert.match(measured, />12\.3%p</); assert.doesNotMatch(measured, /chat-stat-swap">Plan Usage/);
  assert.match(api, /usage-basis api/); assert.match(api, /API Usage <b class="usage-money"[^>]*>\$0\.4231</); assert.match(api, /API로 보낸 턴의 요금<\/span><b>\$0\.4231</);
  assert.match(plan, /role="radio" aria-checked="true" class="usage-option plan"/); assert.match(plan, /role="radio" aria-checked="false" class="usage-option api"/);
  assert.match(api, /role="radio" aria-checked="true" class="usage-option api"/);
  assert.match(plan, /전환하면 기존 캐시를 쓸 수 없어 비용이 더 발생할 수 있습니다/);
  assert.match(busy, /응답이 끝난 뒤 바꿀 수 있습니다/); assert.match(busy, /usage-option plan"[^>]*disabled/);
  assert.match(other, /채팅을 시작할 때 정해집니다/); assert.doesNotMatch(other, /role="radio"/);
  delete globalThis.innerWidth; delete globalThis.innerHeight; delete globalThis.document;
});
