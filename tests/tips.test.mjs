import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTipClaims } from '../apps/local-server/src/ui-state.js';
import { TIPS_VERSION } from '../apps/web/src/tips.ts';

test('tips survive a server restart, are claimed only once and reset on a higher tip version', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-tips-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'app-tips.json');
  const newServer = () => createTipClaims({
    read: async () => {
      try { return JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    write: state => writeFile(file, JSON.stringify(state))
  });
  const claim = newServer(), version = TIPS_VERSION;
  assert.deepEqual(await Promise.all([claim('bganim', version), claim('bganim', version), claim('tourhint', version)]), [true, false, true]);
  const restarted = newServer();
  assert.equal(await restarted('bganim', version), false);
  assert.equal(await restarted('tourhint', version), false);
  assert.equal(await restarted('bganim', version + 1), true);
  assert.equal(await restarted('tourhint', version), false, 'an old page cannot overwrite the new history');
  assert.equal(await restarted('tourhint', version + 1), true);
  assert.equal(await restarted('tourhint', version + 1), false);
  assert.throws(() => restarted('../bganim', version), { code: 'INVALID_INPUT' });
});
