import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { brandBundle, brandExe } from './brand.mjs';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
assert.ok(nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 21), 'Node.js 24.21.0 or newer is required');
assert.ok(['darwin', 'win32'].includes(process.platform), 'Build on macOS or Windows to include the matching native PTY runtime');

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../../');
const dist = path.join(import.meta.dirname, 'dist');
const { productName } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const deployment = mkdtempSync(path.join(os.tmpdir(), 'mooner-ade-deploy-'));
const stage = path.join(dist, 'app');
const run = spawnSync('pnpm', ['--filter', '@mooner/ade-local-server', 'deploy', '--prod', deployment], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
assert.equal(run.status, 0, 'Production dependency deployment failed');

try {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(path.join(stage, 'apps', 'desktop'), { recursive: true });
  mkdirSync(path.join(stage, 'apps', 'local-server'), { recursive: true });
  mkdirSync(path.join(stage, 'apps', 'web'), { recursive: true });
  cpSync(path.join(import.meta.dirname, 'src'), path.join(stage, 'apps/desktop/src'), { recursive: true });
  cpSync(path.join(import.meta.dirname, 'assets'), path.join(stage, 'apps/desktop/assets'), { recursive: true });
  cpSync(path.join(root, 'apps/local-server/src'), path.join(stage, 'apps/local-server/src'), { recursive: true });
  cpSync(path.join(root, 'apps/web/dist'), path.join(stage, 'apps/web/dist'), { recursive: true });
  cpSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
  cpSync(path.join(deployment, 'node_modules'), path.join(stage, 'apps/local-server/node_modules'), { recursive: true, verbatimSymlinks: true });
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'mooner-ade', version: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, type: 'module', main: 'apps/desktop/src/main.js' }));

  const resources = process.platform === 'darwin' ? path.join(dist, `${productName}.app/Contents/Resources`) : path.join(dist, `${productName}-win32-${process.arch}/resources`);
  if (process.platform === 'darwin') {
    const executable = require('electron');
    const source = path.resolve(executable, '../../..');
    const bundle = path.join(dist, `${productName}.app`);
    if (!existsSync(bundle)) cpSync(source, bundle, { recursive: true, verbatimSymlinks: true });
    brandBundle(bundle, productName);
  } else {
    const source = path.dirname(require('electron'));
    const bundle = path.join(dist, `${productName}-win32-${process.arch}`);
    rmSync(bundle, { recursive: true, force: true });
    cpSync(source, bundle, { recursive: true });
    const exe = path.join(bundle, `${productName}.exe`);
    const electronExe = path.join(bundle, 'electron.exe');
    if (existsSync(electronExe)) await import('node:fs/promises').then(({ rename }) => rename(electronExe, exe));
    brandExe(exe, productName, JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version);
  }
  // Keep the shipped binary from doubling as a Node runner via ELECTRON_RUN_AS_NODE, NODE_OPTIONS or --inspect.
  // The local server runs on the bundled runtime/node, so the app itself never needs these.
  await flipFuses(process.platform === 'darwin' ? path.join(dist, `${productName}.app`) : path.join(dist, `${productName}-win32-${process.arch}`, `${productName}.exe`), {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  });

  rmSync(path.join(resources, 'app'), { recursive: true, force: true });
  mkdirSync(resources, { recursive: true });
  cpSync(stage, path.join(resources, 'app'), { recursive: true, verbatimSymlinks: true });
  const runtime = path.join(resources, 'app/runtime');
  mkdirSync(runtime, { recursive: true });
  cpSync(process.execPath, path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'));
  if (process.platform === 'darwin') execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', path.join(dist, `${productName}.app`)], { stdio: 'inherit' });
  assert.ok(existsSync(path.join(resources, 'app/apps/local-server/src/index.js')));
  assert.ok(existsSync(path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node')));
  console.log(`Packaged app: ${process.platform === 'darwin' ? path.join(dist, `${productName}.app`) : path.join(dist, `${productName}-win32-${process.arch}`)}`);
} finally {
  rmSync(deployment, { recursive: true, force: true });
  rmSync(stage, { recursive: true, force: true });
}
