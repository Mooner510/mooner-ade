import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectCommandMetadata,
  listCommands,
  lookupCommandMeta,
  mergeCommandCatalog,
  parseCommandFrontmatter,
} from '../apps/local-server/src/slash-commands.js';

test('parseCommandFrontmatter reads description, argument-hint and arguments', () => {
  const body = `---
description: Deploy app
argument-hint: [env] [version]
---
text`;
  assert.deepEqual(parseCommandFrontmatter(body), { description: 'Deploy app', hint: '[env] [version]', declaredName: undefined });
  const named = `---
name: ponytail-review
description: Review
arguments: [issue, branch]
---`;
  assert.equal(parseCommandFrontmatter(named).hint, '[issue] [branch]');
  assert.equal(parseCommandFrontmatter(named).declaredName, 'ponytail-review');
});

test('lookupCommandMeta resolves plugin namespaces by suffix', () => {
  const map = new Map([['ponytail-review', { name: 'ponytail-review', description: 'Cut bloat', hint: '[path]' }]]);
  const hit = lookupCommandMeta(map, 'ponytail:ponytail-review');
  assert.equal(hit?.description, 'Cut bloat');
  assert.equal(hit?.name, 'ponytail:ponytail-review');
});

test('mergeCommandCatalog only returns probed names with metadata attached', () => {
  const metadata = new Map([
    ['compact', { name: 'compact', description: 'Compact context' }],
    ['unused', { name: 'unused', description: 'Hidden' }],
  ]);
  const list = mergeCommandCatalog(['compact', 'missing'], metadata);
  assert.deepEqual(list.map(item => item.name), ['compact', 'missing']);
  assert.equal(list[0].description, 'Compact context');
  assert.equal(list[1].description, '');
});

test('collectCommandMetadata scans project commands, plugins and synced manifest', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'ade-slash-cwd-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'ade-slash-home-'));
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const projectDir = path.join(cwd, '.claude', 'commands');
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, 'review.md'), `---
description: Review a pull request
argument-hint: [pr-number]
---`);
  const configHome = path.join(home, '.claude');
  const synced = path.join(configHome, 'skills', 'synced', 'bundle-a');
  await mkdir(path.join(synced, 'docs'), { recursive: true });
  await writeFile(path.join(synced, 'manifest.json'), JSON.stringify({ skills: [{ skillId: 'docs', name: 'docs', description: 'Docs skill' }] }));
  await writeFile(path.join(synced, 'docs', 'SKILL.md'), `---
name: docs
description: Full docs description
argument-hint: [title]
---`);
  const pluginRoot = path.join(configHome, 'plugins', 'cache', 'acme', 'demo', '1.0.0');
  await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  await mkdir(path.join(pluginRoot, 'skills', 'lint'), { recursive: true });
  await writeFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo' }));
  await writeFile(path.join(pluginRoot, 'skills', 'lint', 'SKILL.md'), `---
description: Lint project
argument-hint: [path]
---`);
  await writeFile(path.join(configHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'demo@acme': [{ scope: 'user', installPath: pluginRoot, version: '1.0.0' }] },
  }));
  const map = await collectCommandMetadata(cwd, home);
  assert.equal(map.get('review')?.hint, '[pr-number]');
  assert.equal(lookupCommandMeta(map, 'anthropic-skills:docs')?.description, 'Full docs description');
  assert.equal(lookupCommandMeta(map, 'demo:lint')?.hint, '[path]');
  const offline = await listCommands(cwd, home, { probe: false });
  assert.ok(offline.some(item => item.name === 'review'));
});

test('codex and cursor command files provide descriptions and argument hints', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'ade-slash-providers-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'ade-slash-providers-home-'));
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const codexHome = path.join(home, '.codex');
  await mkdir(path.join(codexHome, 'skills', '.system', 'review-agent'), { recursive: true });
  await writeFile(path.join(codexHome, 'skills', '.system', 'review-agent', 'SKILL.md'), `---
name: review-agent
description: Review a change
argument-hint: [path]
---`);
  await mkdir(path.join(cwd, '.cursor', 'commands'), { recursive: true });
  await writeFile(path.join(cwd, '.cursor', 'commands', 'ship.toml'), 'description = "Ship the branch"\nprompt = "Ship {{args}}"\n');
  const codex = await listCommands(cwd, home, { probe: false, agent: 'codex', env: { CODEX_HOME: codexHome } });
  assert.equal(codex.find(item => item.name === 'review-agent')?.hint, '[path]');
  assert.equal(codex.find(item => item.name === 'compact')?.hint, '[지침]');
  const cursor = await listCommands(cwd, home, { probe: false, agent: 'cursor' });
  const ship = cursor.find(item => item.name === 'ship');
  assert.equal(ship?.description, 'Ship the branch');
  assert.equal(ship?.hint, '[args]');
  assert.equal(cursor.some(item => item.name === 'review-agent'), false);
});
