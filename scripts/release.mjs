// Builds the portable Windows app, zips it and publishes it as the GitHub release the in-app updater reads.
// Bump "version" in package.json first; the release tag is v<version>.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

assert.equal(process.platform, 'win32', 'Release from Windows: the zip holds the Windows build');
const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'apps/desktop/dist');
const folder = `MoonerADE-win32-${process.arch}`;
const zip = path.join(dist, `${folder}.zip`);

execFileSync('pnpm', ['package'], { cwd: root, stdio: 'inherit', shell: true });
rmSync(zip, { force: true });
execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', dist, folder], { stdio: 'inherit' });
execFileSync('gh', ['release', 'create', `v${version}`, zip, '--repo', 'Mooner510/mooner-ade', '--title', `v${version}`, '--generate-notes'], { cwd: root, stdio: 'inherit' });
