import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('the chat status line shows usage for every agent and offers auth switching only for Claude', async t => {
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
    export const codex = render({ ...emptyState(), agent: 'codex' }, '19.5%p(5h)');
    export const cursor = render({ ...emptyState(), agent: 'cursor', auth: 'key', apiKey: true, apiCostUsd: 0.42 });
    export const basis = [usageBasis({ ...emptyState(), apiKey: true }), usageBasis(emptyState()), usageBasis(emptyState(), '12%p')];
  `, loader: 'tsx', resolveDir: fileURLToPath(new URL('../apps/web/src/', import.meta.url)) }, bundle: true, jsx: 'automatic', platform: 'node', format: 'cjs', external: ['monaco-editor', 'monaco-editor/*'], outfile });
  globalThis.innerWidth = 1200; globalThis.innerHeight = 800; globalThis.document = { addEventListener() {} };
  const { plan, measured, api, busy, codex, cursor, basis } = require(outfile);
  assert.deepEqual(basis, ['API Usage', 'Plan Usage', '12%p']); // the measured share replaces the words
  assert.match(plan, /<button[^>]*usage-basis plan[^>]*popoverTarget/); assert.match(plan, />Plan Usage</); // shown although the item is switched off in the settings
  assert.match(measured, />12\.3%p</); assert.doesNotMatch(measured, /chat-stat-swap">Plan Usage/);
  assert.match(api, /usage-basis api/); assert.match(api, /API Usage <b class="usage-money"[^>]*>\$0\.4231</);
  assert.equal(api.match(/\$0\.4231/g)?.length, 1);
  assert.match(plan, /role="radio" aria-checked="true" class="usage-option plan"/); assert.match(plan, /role="radio" aria-checked="false" class="usage-option api"/);
  assert.match(api, /role="radio" aria-checked="true" class="usage-option api"/);
  assert.match(plan, /구독 플랜<small>5시간·주간 한도<\/small>/);
  assert.match(plan, /API 키<small>토큰 사용량에 따라 과금<\/small>/);
  assert.equal(plan.match(/usage-check/g)?.length, 1);
  assert.equal(api.match(/usage-check/g)?.length, 1);
  assert.match(busy, /응답이 끝난 뒤 바꿀 수 있습니다/); assert.match(busy, /usage-option plan"[^>]*disabled/);
  assert.match(codex, /<span class="stat chat-stat chat-stat-share"><span[^>]*>speed<\/span>19\.5%p\(5h\)<\/span>/);
  assert.match(cursor, /<span class="stat chat-stat chat-stat-share"><span[^>]*>key<\/span>API Usage \$0\.4200<\/span>/);
  for (const readOnly of [codex, cursor]) assert.doesNotMatch(readOnly, /popoverTarget|usage-panel|usage-caret|role="dialog"/);
  delete globalThis.innerWidth; delete globalThis.innerHeight; delete globalThis.document;
});

test('an API key chat shows its money once: the cost item is left to the API Usage item, a CLI login keeps the cost item', async t => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
  const directory = await mkdtemp(join(tmpdir(), 'ade-chat-status-cost-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'status.cjs');
  await build({ stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { ChatStatusLine } from './ChatStatus';
    import { defaultSettings } from './Editor';
    import { emptyState } from './chat-model';
    const settings = { ...defaultSettings, chatStatusItems: ['cost', 'share'] };
    const render = state => renderToStaticMarkup(<ChatStatusLine settings={settings} context={{ state, share: null }} onSettings={() => {}} onAuth={() => {}} />);
    export const key = render({ ...emptyState(), agent: 'claude', auth: 'key', apiKey: true, costUsd: 0.4231, apiCostUsd: 0.4231 });
    export const login = render({ ...emptyState(), agent: 'claude', auth: 'login', costUsd: 0.4231 });
    export const codexKey = render({ ...emptyState(), agent: 'codex', apiKey: true, costUsd: 0.4231 });
  `, loader: 'tsx', resolveDir: fileURLToPath(new URL('../apps/web/src/', import.meta.url)) }, bundle: true, jsx: 'automatic', platform: 'node', format: 'cjs', external: ['monaco-editor', 'monaco-editor/*'], outfile });
  globalThis.innerWidth = 1200; globalThis.innerHeight = 800; globalThis.document = { addEventListener() {} };
  const { key, login, codexKey } = require(outfile);
  assert.equal(key.match(/\$0\.4231/g)?.length, 1, 'API key chat: the dollars appear once (in API Usage)');
  assert.doesNotMatch(key, /chat-stat-cost/);
  assert.match(login, /chat-stat-cost/, 'CLI login keeps the cost item');
  assert.match(codexKey, /chat-stat-cost/, 'only Claude has the API Usage item for its key cost, so other agents keep theirs');
  delete globalThis.innerWidth; delete globalThis.innerHeight; delete globalThis.document;
});
