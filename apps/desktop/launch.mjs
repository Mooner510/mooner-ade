import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let executable = require('electron');
const { productName } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// macOS reads the Dock name from the app bundle, not Electron's app.setName().
if (process.platform === 'darwin') {
  const source = path.resolve(executable, '../../..');
  const { version } = require('electron/package.json');
  const folder = path.join(import.meta.dirname, 'dist', `electron-${version}`);
  const bundle = path.join(folder, `${productName}.app`);
  const plist = path.join(bundle, 'Contents/Info.plist');
  const ready = path.join(folder, '.ready');
  executable = path.join(bundle, 'Contents/MacOS/Electron');
  if (!existsSync(ready)) {
    mkdirSync(folder, { recursive: true });
    cpSync(source, bundle, { recursive: true, verbatimSymlinks: true });
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      execFileSync('/usr/bin/plutil', ['-replace', key, '-string', productName, plist]);
    }
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', bundle], { stdio: 'inherit' });
    writeFileSync(ready, '');
  }
  const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
  assert.equal(info.CFBundleName, productName);
  assert.equal(info.CFBundleDisplayName, productName);
  assert.ok(existsSync(executable));
} else if (process.platform === 'win32') {
  const source = path.dirname(executable);
  const { version } = require('electron/package.json');
  const folder = path.join(import.meta.dirname, 'dist', `electron-${version}-win32-${process.arch}`);
  const ready = path.join(folder, '.ready');
  executable = path.join(folder, `${productName}.exe`);
  if (!existsSync(ready)) {
    cpSync(source, folder, { recursive: true });
    renameSync(path.join(folder, 'electron.exe'), executable);
    writeFileSync(ready, '');
  }
  assert.ok(existsSync(executable));
}

const child = spawn(executable, [import.meta.dirname, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: false });
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) process.on(signal, () => child.kill(signal));
