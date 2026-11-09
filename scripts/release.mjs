// Tags the current commit as v<version> and pushes the tag; the Release workflow then builds macOS and Windows and
// publishes them. Works from any OS since it is only git. Bump "version" in package.json and commit it first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

assert.equal(git('status', '--porcelain'), '', 'Commit or stash your changes first: the tag must match a pushed commit');
assert.equal(git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`), '', `${tag} already exists on origin; bump "version" first`);
git('tag', tag);
execFileSync('git', ['push', 'origin', tag], { cwd: root, stdio: 'inherit' });
console.log(`Pushed ${tag}. Build progress: https://github.com/Mooner510/mooner-ade/actions/workflows/release.yml`);
