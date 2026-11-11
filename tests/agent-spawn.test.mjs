import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveAgentCommand } from '../apps/local-server/src/agent-spawn.js';

const local = 'LOCAL', base = path.join(local, 'cursor-agent');
const env = { LOCALAPPDATA: local, Path: '' };
const fs = present => ({ exists: p => present.includes(p), list: () => ['2026.11.05-86047df', '2026.11.11-043ef28', 'promote-staged.cmd', '.download-1.zip'] });

test('Windows cursor-agent runs the newest bundled node.exe + index.js', () => {
  const root = path.join(base, 'versions', '2026.11.11-043ef28'), node = path.join(root, 'node.exe'), entry = path.join(root, 'index.js');
  assert.deepEqual(resolveAgentCommand('cursor-agent', ['acp'], { platform: 'win32', env, ...fs([node, entry]) }), { file: node, args: [entry, 'acp'] });
});

test('falls back to the original command when nothing is found or off Windows', () => {
  assert.deepEqual(resolveAgentCommand('cursor-agent', ['acp'], { platform: 'win32', env, ...fs([]) }), { file: 'cursor-agent', args: ['acp'] });
  assert.deepEqual(resolveAgentCommand('cursor-agent', ['acp'], { platform: 'darwin', env }), { file: 'cursor-agent', args: ['acp'] });
  assert.deepEqual(resolveAgentCommand('claude', ['-p'], { platform: 'win32', env }), { file: 'claude', args: ['-p'] });
});
