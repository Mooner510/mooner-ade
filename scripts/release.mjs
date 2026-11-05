// Builds the packaged app for the current OS (Windows or macOS), zips it and attaches it to the GitHub release
// that the in-app updater reads. Run it once per OS: the first run creates the release, later runs add their files to it.
// Each OS adds three assets: the full bundle zip, an app-only zip of resources/app, and a manifest with the shell key
// that tells the updater when the app-only zip is enough (see apps/desktop/package.mjs and src/updater.js).
// Bump "version" in package.json first; the release tag is v<version>.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

assert.ok(['win32', 'darwin'].includes(process.platform), 'Release from Windows or macOS: the zip holds that OS build');
const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const repo = 'Mooner510/mooner-ade';
const tag = `v${version}`;
const dist = path.join(root, 'apps/desktop/dist');
const mac = process.platform === 'darwin';
const name = `MoonerADE-${process.platform}-${process.arch}`;
const zip = path.join(dist, `${name}.zip`);
const appZip = path.join(dist, `${name}-app.zip`);
const manifest = path.join(dist, `${name}.json`);
const resources = mac ? path.join(dist, 'MoonerADE.app/Contents/Resources') : path.join(dist, `MoonerADE-win32-${process.arch}`, 'resources');

execFileSync('pnpm', ['package'], { cwd: root, stdio: 'inherit', shell: !mac });
for (const file of [zip, appZip, manifest]) rmSync(file, { force: true });
if (mac) {
  // ditto keeps the framework symlinks and the code signature that a plain zip would break.
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(dist, 'MoonerADE.app'), zip], { stdio: 'inherit' });
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(resources, 'app'), appZip], { stdio: 'inherit' });
} else {
  const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', dist, `MoonerADE-win32-${process.arch}`], { stdio: 'inherit' });
  execFileSync(tar, ['-a', '-c', '-f', appZip, '-C', resources, 'app'], { stdio: 'inherit' });
}
const { shell } = JSON.parse(readFileSync(path.join(resources, 'runtime', 'runtime.json'), 'utf8'));
assert.match(shell, /^[0-9a-f]{64}$/, 'runtime.json has no shell key');
writeFileSync(manifest, JSON.stringify({ version, shell }));

const assets = [zip, appZip, manifest];
const exists = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { cwd: root, stdio: 'ignore', shell: !mac }).status === 0;
if (exists) execFileSync('gh', ['release', 'upload', tag, ...assets, '--repo', repo, '--clobber'], { cwd: root, stdio: 'inherit', shell: !mac });
else execFileSync('gh', ['release', 'create', tag, ...assets, '--repo', repo, '--title', tag, '--generate-notes'], { cwd: root, stdio: 'inherit', shell: !mac });
