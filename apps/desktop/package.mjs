import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const target = `${process.platform}-${process.arch}`;
// Chromium falls back to en-US when the OS language has no .pak, so only the UI language ships besides it.
const LOCALES = ['en-US', 'ko'];
// Keep the shipped binary from doubling as a Node runner via ELECTRON_RUN_AS_NODE, NODE_OPTIONS or --inspect.
// The local server runs on the bundled runtime/node, so the app itself never needs these.
const FUSES = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
};

// Everything outside resources/app: Electron, the bundled Node, branding, fuses and locales. Releases with the same key
// differ only in resources/app, so the updater can fetch the small app-only zip instead of the whole bundle.
const shellKey = () => {
  const hash = createHash('sha256').update(JSON.stringify({
    target, productName, electron: JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version,
    node: process.versions.node, fuses: FUSES, locales: LOCALES,
  }));
  for (const file of ['brand.mjs', 'assets/icon.ico', 'assets/icon.png']) hash.update(readFileSync(path.join(import.meta.dirname, file)));
  return hash.digest('hex');
};

// Debug symbols, sources and other platforms' prebuilds are never loaded at runtime but were most of the zip.
function prune(modules) {
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.pdb')) rmSync(file);
    }
  };
  walk(modules);
  const pty = path.join(modules, 'node-pty');
  for (const dir of ['src', 'deps']) rmSync(path.join(pty, dir), { recursive: true, force: true });
  const prebuilds = path.join(pty, 'prebuilds');
  if (existsSync(prebuilds)) for (const name of readdirSync(prebuilds)) if (name !== target) rmSync(path.join(prebuilds, name), { recursive: true });
  assert.ok(existsSync(path.join(prebuilds, target)), `node-pty has no prebuild for ${target}`);
  const conpty = path.join(pty, 'third_party/conpty');
  if (existsSync(conpty)) for (const version of readdirSync(conpty)) {
    for (const name of readdirSync(path.join(conpty, version))) if (name !== `win10-${process.arch}`) rmSync(path.join(conpty, version, name), { recursive: true });
  }
}

const deployment = mkdtempSync(path.join(os.tmpdir(), 'mooner-ade-deploy-'));
const stage = path.join(dist, 'app');
// Hoisted: real folders instead of pnpm's links, which the copy below turned into a second full copy of each package.
const run = spawnSync('pnpm', ['--filter', '@mooner/ade-local-server', 'deploy', '--prod', '--config.node-linker=hoisted', deployment], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
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
  prune(path.join(stage, 'apps/local-server/node_modules'));
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
    const locales = path.join(bundle, 'locales');
    for (const name of readdirSync(locales)) if (!LOCALES.includes(path.basename(name, '.pak'))) rmSync(path.join(locales, name));
  }
  await flipFuses(process.platform === 'darwin' ? path.join(dist, `${productName}.app`) : path.join(dist, `${productName}-win32-${process.arch}`, `${productName}.exe`), {
    version: FuseVersion.V1,
    ...FUSES,
  });

  rmSync(path.join(resources, 'app'), { recursive: true, force: true });
  mkdirSync(resources, { recursive: true });
  cpSync(stage, path.join(resources, 'app'), { recursive: true, verbatimSymlinks: true });
  // The Node runtime sits beside resources/app, not in it, so an app-only update replaces resources/app wholesale.
  const runtime = path.join(resources, 'runtime');
  rmSync(runtime, { recursive: true, force: true });
  mkdirSync(runtime, { recursive: true });
  cpSync(process.execPath, path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'));
  writeFileSync(path.join(runtime, 'runtime.json'), JSON.stringify({ shell: shellKey() }));
  if (process.platform === 'darwin') execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', path.join(dist, `${productName}.app`)], { stdio: 'inherit' });
  assert.ok(existsSync(path.join(resources, 'app/apps/local-server/src/index.js')));
  assert.ok(existsSync(path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node')));
  console.log(`Packaged app: ${process.platform === 'darwin' ? path.join(dist, `${productName}.app`) : path.join(dist, `${productName}-win32-${process.arch}`)}`);
} finally {
  rmSync(deployment, { recursive: true, force: true });
  rmSync(stage, { recursive: true, force: true });
}
