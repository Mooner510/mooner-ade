// Builds the packaged app for the current OS (Windows or macOS), zips it and attaches it to the GitHub release
// that the in-app updater reads. Run it once per OS: the first run creates the release, later runs add their zip to it.
// Bump "version" in package.json first; the release tag is v<version>.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

assert.ok(['win32', 'darwin'].includes(process.platform), 'Release from Windows or macOS: the zip holds that OS build');
const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const repo = 'Mooner510/mooner-ade';
const tag = `v${version}`;
const dist = path.join(root, 'apps/desktop/dist');
const mac = process.platform === 'darwin';
const zip = path.join(dist, `MoonerADE-${process.platform}-${process.arch}.zip`);

execFileSync('pnpm', ['package'], { cwd: root, stdio: 'inherit', shell: !mac });
rmSync(zip, { force: true });
if (mac) {
  // ditto keeps the framework symlinks and the code signature that a plain zip would break.
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(dist, 'MoonerADE.app'), zip], { stdio: 'inherit' });
} else {
  const folder = `MoonerADE-win32-${process.arch}`;
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', dist, folder], { stdio: 'inherit' });
}

const exists = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { cwd: root, stdio: 'ignore', shell: !mac }).status === 0;
if (exists) execFileSync('gh', ['release', 'upload', tag, zip, '--repo', repo, '--clobber'], { cwd: root, stdio: 'inherit', shell: !mac });
else execFileSync('gh', ['release', 'create', tag, zip, '--repo', repo, '--title', tag, '--generate-notes'], { cwd: root, stdio: 'inherit', shell: !mac });
