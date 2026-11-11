import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('missing provider usage is rendered as unavailable instead of zero', async t => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
  const directory = await mkdtemp(join(tmpdir(), 'ade-chat-ui-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'ui.cjs');
  await build({ stdin: { contents: `
    import { chatItemView } from './ChatStatus';
    import { emptyState } from './chat-model';
    const state = { ...emptyState(), costUsd: null, capabilities: { tokens: false, context: false } };
    export const modelColors = ['astra','sol','terra','luna'].map(family => chatItemView('model', {state: {...emptyState(), agent: 'codex', model: 'gpt-6.1-' + family}}).color);
    export const cursorColor = chatItemView('model', {state: {...emptyState(), agent: 'cursor', model: 'composer-2'}}).color;
    export const views = ['cost','tokens','context'].map(id => chatItemView(id, {state})?.text ?? null);
  `, resolveDir: fileURLToPath(new URL('../apps/web/src', import.meta.url)) }, bundle: true, external: ['monaco-editor'], platform: 'node', format: 'cjs', jsx: 'automatic', outfile });
  const result = require(outfile);
  assert.deepEqual(result.views, [null, null, null]);
  assert.deepEqual(result.modelColors, ['astra','sol','terra','luna'].map(family => `var(--model-${family})`));
  assert.equal(result.cursorColor, 'var(--provider-cursor)');
});

test('Cursor model modal renders party tabs, provider groups and readable names', async t => {
  const { readFile } = await import('node:fs/promises');
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
  const directory = await mkdtemp(join(tmpdir(), 'ade-model-tabs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'models.cjs');
  const source = await readFile(new URL('../apps/web/src/ChatPane.tsx', import.meta.url), 'utf8');
  await build({ stdin: { contents: `import { useState, useEffect, useMemo, useId, useRef } from 'react';
    import { Icon } from './Icon';
    import { Modal, ModelLabel } from './views';
    import { modelRows, modelValue, modelAppearance, modelProvider, cursorModelGroups } from './chat-model';
  ` + source.slice(source.indexOf('function ModelsModal('), source.indexOf('// Handled here')) + `
    import { renderToStaticMarkup } from 'react-dom/server';
    const ids = ['composer-2.5', 'grok-4.7', 'claude-sonnet-4', 'claude-opus-5-5', 'glm-5p3', 'muse-wonder-1.0'];
    const fallback = ids.map(id => ({id, name:id, family:'', window:0, main:true}));
    const render = current => renderToStaticMarkup(<ModelsModal current={current} agent="cursor" fallback={fallback} aliases={{}} call={async () => ({})} onPick={() => {}} onClose={() => {}} />);
    export const thirdParty = render('glm-5p3');
    export const firstParty = render('grok-4.7');
  `, loader: 'tsx', resolveDir: fileURLToPath(new URL('../apps/web/src', import.meta.url)) }, bundle: true, external: ['monaco-editor'], platform: 'node', format: 'cjs', jsx: 'automatic', outfile });
  const { thirdParty, firstParty } = require(outfile);
  assert.match(thirdParty, /role="tab" aria-selected="true"[^>]*>Third Party/);
  assert.match(thirdParty, /role="tabpanel"/);
  for (const provider of ['Anthropic', 'Meta', 'Z.ai']) assert.ok(thirdParty.includes(`>${provider}</span>`));
  for (const name of ['Claude Sonnet 4', 'Claude Opus 5.5', 'GLM 5p3', 'Muse Wonder 1.0']) assert.ok(thirdParty.includes(`>${name}</span>`));
  assert.ok(thirdParty.indexOf('Claude Opus 5.5</span>') < thirdParty.indexOf('Claude Sonnet 4</span>'));
  assert.doesNotMatch(thirdParty, />Grok 4.7<|>Composer 2.5</);
  assert.match(firstParty, /role="tab" aria-selected="true"[^>]*>First Party/);
  for (const name of ['Grok 4.7', 'Composer 2.5']) assert.ok(firstParty.includes(`color:var(--provider-cursor)">${name}</span>`));
});

test('chat dev draft storage is compiled out when import.meta.env.DEV is false', async t => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
  const directory = await mkdtemp(join(tmpdir(), 'ade-chat-draft-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = async (dev) => {
    const outfile = join(directory, dev ? 'dev.cjs' : 'prod.cjs');
    await build({
      stdin: {
        contents: `
          globalThis.localStorage = { store: new Map(), getItem(k) { return this.store.get(k) ?? null; }, setItem(k, v) { this.store.set(k, v); }, removeItem(k) { this.store.delete(k); } };
          import { loadChatDevDraft, saveChatDevDraft, clearChatDevDraft } from './chat-dev-draft';
          saveChatDevDraft('p', 'c', 'hello');
          export const loaded = loadChatDevDraft('p', 'c');
          clearChatDevDraft('p', 'c');
          export const cleared = loadChatDevDraft('p', 'c');
        `,
        resolveDir: fileURLToPath(new URL('../apps/web/src', import.meta.url))
      },
      bundle: true, platform: 'node', format: 'cjs', outfile,
      define: { 'import.meta.env.DEV': dev ? 'true' : 'false' }
    });
    return require(outfile);
  };
  assert.deepEqual(await bundle(true), { loaded: 'hello', cleared: null });
  assert.deepEqual(await bundle(false), { loaded: null, cleared: null });
  assert.equal(globalThis.localStorage?.store?.size ?? 0, 0);
});
