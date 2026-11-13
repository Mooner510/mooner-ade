import test from 'node:test';
import assert from 'node:assert/strict';
import { modelSettingsFor, parseTokenAmount, resolveAutoCompact, writeAutoCompact } from '../apps/local-server/src/claude-auto-compact.js';

test('parseTokenAmount accepts numbers and k/M suffixes', () => {
  assert.equal(parseTokenAmount(350000), 350000);
  assert.equal(parseTokenAmount('350k'), 350000);
  assert.equal(parseTokenAmount('1M'), 1_000_000);
  assert.equal(parseTokenAmount('auto'), 'auto');
  assert.equal(parseTokenAmount('off'), null);
});

test('resolveAutoCompact uses modelSettings and caps at max window', () => {
  const settings = { modelSettings: { 'claude-sonnet-5-5': { autoCompactWindow: 350000 } } };
  assert.deepEqual(resolveAutoCompact({ settings, model: 'claude-sonnet-5-5', maxWindow: 1_000_000 }), { window: 350000, maxWindow: 1_000_000, auto: false, source: 'modelSettings' });
  assert.equal(resolveAutoCompact({ settings, model: 'claude-sonnet-5-5', maxWindow: 200_000 }), null);
  assert.equal(resolveAutoCompact({ settings: { ...settings, autoCompactEnabled: false }, model: 'claude-sonnet-5-5', maxWindow: 1_000_000 }), null);
});

test('auto mode estimates a smaller window than 1M max', t => {
  // A test run from inside an ADE chat inherits the window ADE handed to that chat's CLI; the case is about nothing being set.
  const saved = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, DISABLE_AUTO_COMPACT: process.env.DISABLE_AUTO_COMPACT };
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW; delete process.env.DISABLE_AUTO_COMPACT;
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const resolved = resolveAutoCompact({ settings: {}, env: {}, model: 'claude-sonnet-5-5', maxWindow: 1_000_000 });
  assert.equal(resolved?.window, 350000);
  assert.equal(resolved?.auto, true);
});

test('writeAutoCompact saves what /autocompact saves and validates the window', async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os'), path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ade-autocompact-'));
  try {
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', modelSettings: { other: { autoCompactWindow: 200000 } } }));
    assert.equal(await writeAutoCompact(dir, 'claude-sonnet-5-5[1m]', '350k'), 350000);
    let saved = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'));
    assert.deepEqual(saved.modelSettings, { other: { autoCompactWindow: 200000 }, 'claude-sonnet-5-5': { autoCompactWindow: 350000 } });
    assert.equal(saved.theme, 'dark');
    assert.equal(await writeAutoCompact(dir, 'claude-sonnet-5-5', 'auto'), 'auto');
    saved = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(saved.modelSettings['claude-sonnet-5-5'].autoCompactWindow, 'auto');
    await assert.rejects(writeAutoCompact(dir, 'claude-sonnet-5-5', '50k'), /100k/);
    await assert.rejects(writeAutoCompact(dir, 'claude-sonnet-5-5', 'abc'));
    await writeAutoCompact(dir, null, '300k');
    assert.equal(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')).autoCompactWindow, 300000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
