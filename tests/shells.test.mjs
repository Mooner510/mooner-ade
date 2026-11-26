import test from 'node:test';
import assert from 'node:assert/strict';
import { detectShells, missingAgents, resolveShell } from '../apps/local-server/src/shells.js';

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

test('an agent counts as installed once its command sits in any PATH directory, with Windows extensions', () => {
  // missingAgents joins with path.join, which uses the host separator (backslashes when this test runs on Windows),
  // so the fake file system compares paths with the separator normalized.
  const files = new Set(['/home/me/.local/bin/claude', 'C:/npm/codex.cmd', 'C:/npm/cursor-agent']);
  const isFile = file => files.has(file.replaceAll('\\', '/'));
  assert.deepEqual(missingAgents(['/usr/bin', '/home/me/.local/bin'], { platform: 'linux', isFile }), ['codex', 'cursor']);
  assert.deepEqual(missingAgents([], { platform: 'linux', isFile: () => true }), ['claude', 'codex', 'cursor']);
  // A bare cursor-agent shim does not run on Windows, so only the .cmd one counts.
  assert.deepEqual(missingAgents(['C:\\npm'], { platform: 'win32', isFile }), ['claude', 'cursor']);
});
