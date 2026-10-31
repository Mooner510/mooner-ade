import test from 'node:test';
import assert from 'node:assert/strict';
import { detectShells, resolveShell } from '../apps/local-server/src/shells.js';

const win = { platform: 'win32', env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', PATH: '' } };

test('Windows lists PowerShell 7 only when installed and prefers it automatically', () => {
  const withSeven = detectShells({ ...win, isFile: file => file.endsWith('pwsh.exe') || file.endsWith('powershell.exe') });
  assert.deepEqual(withSeven.map(item => item.id), ['pwsh', 'powershell', 'cmd']);
  assert.equal(resolveShell('', withSeven, win).id, 'pwsh');
  const without = detectShells({ ...win, isFile: file => file.endsWith('powershell.exe') });
  assert.deepEqual(without.map(item => item.id), ['powershell', 'cmd']);
  assert.equal(resolveShell('', without, win).id, 'powershell');
});

test('a saved shell wins, and one that is gone falls back to automatic', () => {
  const shells = detectShells({ ...win, isFile: file => file.endsWith('pwsh.exe') || file.endsWith('powershell.exe') });
  assert.equal(resolveShell('powershell', shells, win).id, 'powershell');
  assert.equal(resolveShell('gitbash', shells, win).id, 'pwsh');
});

test('POSIX uses the login shell unless another listed one is chosen', () => {
  const posix = { platform: 'linux', env: { SHELL: '/bin/zsh' }, isFile: file => ['/bin/zsh', '/bin/bash'].includes(file), etcShells: () => ['/bin/bash', '/bin/zsh'] };
  const shells = detectShells(posix);
  assert.equal(resolveShell('', shells, posix).path, '/bin/zsh');
  assert.equal(resolveShell('/bin/bash', shells, posix).path, '/bin/bash');
});
