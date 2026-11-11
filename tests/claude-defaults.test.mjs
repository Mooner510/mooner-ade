import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readClaudeDefaults } from '../apps/local-server/src/claude-defaults.js';

test('claude defaults follow settings layers: user, project, project local', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ade-defaults-'));
  const config = path.join(root, 'config'), project = path.join(root, 'project');
  await mkdir(config, { recursive: true }); await mkdir(path.join(project, '.claude'), { recursive: true });
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'medium', permissions: { defaultMode: 'acceptEdits' } }));
  assert.deepEqual(await readClaudeDefaults(config, project, {}), { model: 'opus', effort: 'medium', permissionMode: 'acceptEdits' });
  await writeFile(path.join(project, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'high', permissions: { defaultMode: 'plan' } }));
  await writeFile(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ model: 'sonnet', permissions: { allow: [] } }));
  assert.deepEqual(await readClaudeDefaults(config, project, {}), { model: 'sonnet', effort: 'high', permissionMode: 'plan' });
  assert.equal((await readClaudeDefaults(config, project, { CLAUDE_CODE_EFFORT_LEVEL: 'max' })).effort, 'max');
});

test('claude defaults are empty without settings or with unknown values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ade-defaults-'));
  assert.deepEqual(await readClaudeDefaults(root, root, {}), { model: null, effort: null, permissionMode: null });
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ effortLevel: 'ultra', permissions: { defaultMode: 'dontAsk' } }));
  assert.deepEqual(await readClaudeDefaults(root, null, {}), { model: null, effort: null, permissionMode: null });
});
