import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTRIBUTION_OFF, signatureGuard } from '../apps/local-server/src/agent-signature.js';

const posix = process.platform !== 'win32';
const git = (cwd, env, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });

async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'ade-sig-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'repo');
  await mkdir(dir);
  git(dir, {}, 'init', '-q');
  await writeFile(join(dir, 'f'), 'a');
  git(dir, {}, 'add', 'f');
  return { root, dir };
}
const message = dir => git(dir, {}, 'log', '-1', '--format=%B').trimEnd();

test('Claude is told not to add its commit trailer or PR line', () => {
  assert.deepEqual(ATTRIBUTION_OFF, { attribution: { commit: '', pr: '', sessionUrl: false } });
});

test('the guard points git at a hooks dir through the environment only, continuing an existing GIT_CONFIG_COUNT', async t => {
  const { root } = await repo(t);
  const env = await signatureGuard(root, {});
  assert.deepEqual(Object.keys(env).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']);
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath');
  assert.equal(env.GIT_CONFIG_VALUE_0, join(root, 'launch', 'git-hooks').replaceAll('\\', '/'));
  const next = await signatureGuard(root, { GIT_CONFIG_COUNT: '2' });
  assert.equal(next.GIT_CONFIG_COUNT, '3');
  assert.equal(next.GIT_CONFIG_KEY_2, 'core.hooksPath');
  if (posix) assert.ok((await stat(join(root, 'launch', 'git-hooks', 'commit-msg'))).mode & 0o100, 'hooks are executable');
});

test('a commit made with the guard loses the signature trailers, even ones the tool adds to the git call itself', { skip: !posix }, async t => {
  const { root, dir } = await repo(t);
  const env = await signatureGuard(root, {});
  git(dir, env, 'commit', '-q', '-m', 'feat: x\n\nbody stays', '--trailer', 'Co-authored-by: Cursor <cursoragent@cursor.com>', '--trailer', 'Made-with: Cursor');
  assert.equal(message(dir), 'feat: x\n\nbody stays');
  await writeFile(join(dir, 'f'), 'b'); git(dir, {}, 'add', 'f');
  git(dir, env, 'commit', '-q', '-m', 'fix: y\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  assert.equal(message(dir), 'fix: y');
});

test('commits made without the guard (the user\'s own, in a terminal) keep their trailers', { skip: !posix }, async t => {
  const { dir } = await repo(t);
  git(dir, {}, 'commit', '-q', '-m', 'feat: x', '--trailer', 'Co-authored-by: Someone <s@example.com>');
  assert.match(message(dir), /Co-authored-by: Someone/);
});

test('the repository\'s own hooks still run after the guard: its commit-msg sees the cleaned message and its pre-commit can still block', { skip: !posix }, async t => {
  const { root, dir } = await repo(t);
  const env = await signatureGuard(root, {});
  const hooks = join(dir, '.git', 'hooks');
  await writeFile(join(hooks, 'commit-msg'), '#!/bin/sh\nprintf "\\nchecked" >> "$1"\n', { mode: 0o755 });
  git(dir, env, 'commit', '-q', '-m', 'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  assert.equal(message(dir), 'feat: x\n\nchecked', 'signature removed first, then the repository hook ran');
  await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(join(dir, 'f'), 'c'); git(dir, {}, 'add', 'f');
  assert.throws(() => git(dir, env, 'commit', '-q', '-m', 'blocked'), 'a failing repository hook still blocks the commit');
  assert.match(await readFile(join(hooks, 'pre-commit'), 'utf8'), /exit 1/);
});
