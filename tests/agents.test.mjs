import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { codexAuthenticated } from '../apps/local-server/src/agents.js';

const fake = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));

test('codex: readiness reads the account from the app server', async () => {
  assert.equal(await codexAuthenticated(process.cwd(), [process.execPath, fake]), true);
  assert.equal(await codexAuthenticated(process.cwd(), [process.execPath, fake, 'nologin']), false);
});

test('codex: a missing executable rejects instead of hanging', async () => {
  await assert.rejects(codexAuthenticated(process.cwd(), ['mooner-ade-no-such-codex']), { code: 'ENOENT' });
});
