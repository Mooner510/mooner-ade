import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The usage item (Plan Usage / API Usage) is a button that cannot be switched off, and says why the login cannot be changed mid-chat.
test('the chat status line always shows the usage button, even when the item is switched off', async t => {
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
    const render = state => renderToStaticMarkup(<ChatStatusLine settings={settings} context={{ state, share: null }} onSettings={() => {}} />);
    export const plan = render({ ...emptyState(), agent: 'claude' });
    export const api = render({ ...emptyState(), agent: 'claude', apiKey: true });
    export const other = render({ ...emptyState(), agent: 'codex' });
    export const basis = [usageBasis({ ...emptyState(), apiKey: true }), usageBasis(emptyState()), usageBasis(emptyState(), '12%p')];
  `, loader: 'tsx', resolveDir: new URL('../apps/web/src/', import.meta.url).pathname }, bundle: true, jsx: 'automatic', platform: 'node', format: 'cjs', external: ['monaco-editor', 'monaco-editor/*'], outfile });
  globalThis.innerWidth = 1200; globalThis.innerHeight = 800; globalThis.document = { addEventListener() {} };
  const { plan, api, other, basis } = require(outfile);
  assert.deepEqual(basis, ['API Usage', 'Plan Usage', 'Plan Usage · 12%p']);
  assert.match(plan, /<button[^>]*usage-basis plan[^>]*popoverTarget/); assert.match(plan, />Plan Usage</);
  assert.match(plan, /API 키로 바꿔 이어갈 수 없습니다/); assert.match(plan, /조직·워크스페이스별로 격리/); assert.match(plan, /1시간, API 키는 5분/);
  assert.match(api, /usage-basis api/); assert.match(api, />API Usage</); assert.match(api, /CLI 플랜로 바꿔 이어갈 수 없습니다/);
  assert.match(other, /채팅을 시작할 때 정해지고/); assert.doesNotMatch(other, /조직·워크스페이스별로 격리/);
  delete globalThis.innerWidth; delete globalThis.innerHeight; delete globalThis.document;
});
