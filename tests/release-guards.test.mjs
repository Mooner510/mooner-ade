import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// scripts/release.mjs run for real, but in a throw-away repository whose "origin" is a bare repository next to it: the guards that keep a release on
// master (CLAUDE.md "Releases") and the changelog entry a stable release needs must keep holding. Nothing here touches this repository or GitHub.
const root = path.resolve(import.meta.dirname, '..');
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-release-guards-config-')), noConfig = path.join(configDir, 'gitconfig');
fs.writeFileSync(noConfig, '');
test.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
const env = { ...process.env, GIT_CONFIG_GLOBAL: noConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_TERMINAL_PROMPT: '0' };
const run = (cwd, file, args) => spawnSync(file, args, { cwd, env, encoding: 'utf8' });
const git = (cwd, ...args) => { const result = run(cwd, 'git', args); assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`); return result.stdout.trim(); };

const changelog = [{ version: '0.6.0', date: '2026-11-20', time: '12:00', items: [{ kind: '신규 기능', title: '무언가', text: '새 기능이에요.' }] }];
const kinds = JSON.parse(fs.readFileSync(path.join(root, 'apps/web/src/changelog-kinds.json'), 'utf8'));

// A repository on master with the release scripts, in sync with its origin. `version` and `entries` are what package.json and changelog.json hold.
function repository(t, { version = '0.6.0', entries = changelog } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-release-guards-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const origin = path.join(base, 'origin.git'), work = path.join(base, 'work');
  git(base, 'init', '-q', '--bare', '-b', 'master', origin);
  git(base, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'master');
  for (const file of ['scripts/release.mjs', 'scripts/release-notes.mjs']) { fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true }); fs.copyFileSync(path.join(root, file), path.join(work, file)); }
  fs.mkdirSync(path.join(work, 'apps/web/src'), { recursive: true });
  fs.writeFileSync(path.join(work, 'apps/web/src/changelog-kinds.json'), JSON.stringify(kinds));
  fs.writeFileSync(path.join(work, 'apps/web/src/changelog.json'), JSON.stringify(entries));
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'x', version, type: 'module' }));
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'chore: release');
  git(work, 'push', '-q', 'origin', 'master');
  return { work, origin, release: () => run(work, process.execPath, ['scripts/release.mjs']), tags: () => git(work, 'ls-remote', '--tags', 'origin') };
}

test('a release is refused anywhere but on master that equals origin/master, and when the tag already exists', t => {
  const onBranch = repository(t);
  git(onBranch.work, 'checkout', '-q', '-b', 'feat/x');
  const refused = onBranch.release();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Releases are cut from master only/);
  assert.equal(onBranch.tags(), '', 'nothing was tagged or pushed');

  const ahead = repository(t);
  fs.writeFileSync(path.join(ahead.work, 'more.txt'), 'x'); git(ahead.work, 'add', '-A'); git(ahead.work, 'commit', '-q', '-m', 'unpushed');
  assert.match(ahead.release().stderr, /Local master differs from origin\/master/);
  assert.equal(ahead.tags(), '');

  const dirty = repository(t);
  fs.writeFileSync(path.join(dirty.work, 'more.txt'), 'x');
  assert.match(dirty.release().stderr, /Commit or stash your changes first/);
  assert.equal(dirty.tags(), '');

  const done = repository(t);
  assert.equal(done.release().status, 0, 'the first release goes out');
  const again = done.release();
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /v0\.6\.0 already exists on origin/);
});

test('a stable release needs its changelog entry, a beta does not, and an empty entry does not count', t => {
  const missing = repository(t, { entries: [{ ...changelog[0], version: '0.5.12' }] });
  const refused = missing.release();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Add 0\.6\.0 to apps\/web\/src\/changelog\.json first/);
  assert.equal(missing.tags(), '', 'no tag without notes');

  const empty = repository(t, { entries: [{ ...changelog[0], items: [] }] });
  assert.notEqual(empty.release().status, 0, 'an entry with no items would publish an empty release body');
  assert.equal(empty.tags(), '');

  const beta = repository(t, { version: '0.6.0-beta6', entries: [] });
  assert.equal(beta.release().status, 0, beta.work);
  assert.match(beta.tags(), /refs\/tags\/v0\.6\.0-beta6$/m);

  const stable = repository(t);
  assert.equal(stable.release().status, 0);
  assert.match(stable.tags(), /refs\/tags\/v0\.6\.0$/m);
});

test('the release workflow keeps its own gate: the tagged commit must already be on origin/master', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /git merge-base --is-ancestor HEAD origin\/master \|\|/, 'the ancestor check fails the release when it is not on master');
  assert.match(workflow, /\[ "\$TAG" = "\$version" \]/, 'the tag has to match package.json');
  assert.match(workflow, /case "\$TAG" in \*-\*\) pre=--prerelease/, 'a beta is published as a prerelease, so it never becomes "latest"');
  assert.match(workflow, /os: \[macos-latest, windows-latest\]/);
  assert.match(workflow, /node scripts\/build-release\.mjs/);
  assert.match(workflow, /secrets\.MACOS_SIGN_P12\b/, 'the macOS build imports the signing certificate');
  assert.match(workflow, /ADE_SIGN_IDENTITY: /, 'and tells the builder its name');
});

test('the release builder publishes the assets the updater looks for: three on Windows, the signed full zip on macOS', () => {
  const builder = fs.readFileSync(path.join(root, 'scripts/build-release.mjs'), 'utf8');
  assert.match(builder, /const name = `MoonerADE-\$\{process\.platform\}-\$\{process\.arch\}`/);
  assert.match(builder, /const zip = path\.join\(dist, `\$\{name\}\.zip`\)/);
  assert.match(builder, /const appZip = path\.join\(dist, `\$\{name\}-app\.zip`\)/);
  assert.match(builder, /const manifest = path\.join\(dist, `\$\{name\}\.json`\)/);
  assert.match(builder, /JSON\.stringify\(\{ version, shell \}\)/, 'the manifest the updater reads: version and shell key');
  assert.match(builder, /const assets = mac \? \[zip\] : \[zip, appZip, manifest\]/, 'macOS ships no app-only zip: swapping files in the bundle would break the certificate signature');
  assert.match(builder, /process\.platform !== 'darwin' \|\| process\.env\.ADE_SIGN_IDENTITY/, 'a macOS release is never ad hoc signed');
  const updater = fs.readFileSync(path.join(root, 'apps/desktop/src/updater.js'), 'utf8');
  assert.match(updater, /asset\.replace\(\/\\\.zip\$\/, '-app\.zip'\)/, 'the updater derives the app-only zip name the same way');
  assert.match(updater, /asset\.replace\(\/\\\.zip\$\/, '\.json'\)/, 'and the manifest name');
  assert.match(updater, /shell && process\.platform !== 'darwin'/, 'the macOS updater always takes the full zip');
  assert.doesNotMatch(updater, /'--sign'/, 'the updater never signs: only the release certificate does');
  assert.match(fs.readFileSync(path.join(root, 'apps/desktop/src/main.js'), 'utf8'), /asset: `MoonerADE-\$\{process\.platform\}-\$\{process\.arch\}\.zip`/);
});
