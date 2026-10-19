import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

test('Windows launcher copies the runtime, launches MoonerADE.exe and reuses it', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-desktop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'electron');
  const desktop = path.join(root, 'desktop');
  fs.mkdirSync(path.join(source, 'resources'), { recursive: true });
  fs.mkdirSync(desktop);
  for (const file of ['electron.exe', 'chrome_elf.dll', 'icudtl.dat', 'resources/default_app.asar']) {
    fs.writeFileSync(path.join(source, file), file);
  }
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({ productName: 'MoonerADE' }));
  const script = fs.readFileSync(new URL('../apps/desktop/launch.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replaceAll('import.meta.dirname', JSON.stringify(desktop))
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(desktop, 'launch.mjs')).href));
  let copies = 0;
  for (const args of [[], ['--dev']]) {
    const child = new EventEmitter();
    const process = Object.assign(new EventEmitter(), { platform: 'win32', arch: 'x64', argv: ['node', 'launch.mjs', ...args] });
    const executable = path.join(desktop, 'dist/electron-44.7.0-win32-x64/MoonerADE.exe');
    runInNewContext(script, {
      ...fs, assert, path, process, console, URL,
      createRequire: () => name => name === 'electron' ? path.join(source, 'electron.exe') : { version: '44.7.0' },
      cpSync: (...args) => { copies++; fs.cpSync(...args); },
      spawn: (file, argv) => { assert.equal(file, executable); assert.deepEqual(Array.from(argv), [desktop, ...args]); return child; }
    });
    assert.equal(fs.readFileSync(executable, 'utf8'), 'electron.exe');
    assert.equal(fs.readFileSync(path.join(path.dirname(executable), 'chrome_elf.dll'), 'utf8'), 'chrome_elf.dll');
    assert.equal(fs.readFileSync(path.join(path.dirname(executable), 'resources/default_app.asar'), 'utf8'), 'resources/default_app.asar');
    assert.equal(fs.existsSync(path.join(path.dirname(executable), 'electron.exe')), false);
  }
  assert.equal(copies, 1);
  assert.equal(fs.readFileSync(path.join(source, 'electron.exe'), 'utf8'), 'electron.exe');
});
