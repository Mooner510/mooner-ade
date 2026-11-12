import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchApiModelCatalog } from '../apps/local-server/src/chat.js';

// A stand-in for the Anthropic SDK client: models.list() is an async iterable of model objects (the SDK auto-paginates).
const fakeClient = (models, seen = {}) => class {
  constructor(options) { Object.assign(seen, options); }
  models = { list: params => { seen.params = params; return (async function* () { if (models instanceof Error) throw models; yield* models; })(); } };
};

test('an API key lists every model from the Models API, newest of each family marked for the quick menu', async () => {
  const seen = {};
  const catalog = await fetchApiModelCatalog({ apiKey: 'sk-ant-test-key', baseURL: 'http://127.0.0.1:9', Client: fakeClient([
    { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-10-01T00:00:00Z', max_input_tokens: 1_000_000 },
    { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z', max_input_tokens: 1_000_000 },
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-03-01T00:00:00Z' },
    { id: 'claude-3-5-haiku-20241022', display_name: 'Claude 3.5 Haiku', created_at: '2024-10-22T00:00:00Z' },
    { id: 'bad id with spaces', display_name: 'Nope' },
  ], seen) });
  assert.deepEqual(catalog, [
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5', family: 'haiku', window: 1_000_000, main: true },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', family: 'opus', window: 1_000_000, main: true },
    { id: 'claude-opus-4-8', name: 'Opus 4.8', family: 'opus', window: 0, main: false },
    { id: 'claude-3-5-haiku-20241022', name: 'Haiku 3.5', family: 'haiku', window: 0, main: false },
  ]);
  assert.equal(seen.apiKey, 'sk-ant-test-key');
  assert.equal(seen.baseURL, 'http://127.0.0.1:9');
});

test('no key or a failing request gives an empty list (the caller falls back to the CLI catalog)', async () => {
  assert.deepEqual(await fetchApiModelCatalog({ apiKey: '', Client: fakeClient([{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }]) }), []);
  assert.deepEqual(await fetchApiModelCatalog({ apiKey: 'sk-ant-bad', Client: fakeClient(new Error('401')) }), []);
});
