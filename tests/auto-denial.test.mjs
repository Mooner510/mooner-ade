import assert from 'node:assert/strict';
import test from 'node:test';
import { autoDenialReason, pendingBlocked, retryText, sessionRule } from '../apps/local-server/src/auto-denial.js';

test('autoDenialReason: only the classifier refusal counts, with or without a stated reason', () => {
  assert.equal(autoDenialReason("Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Git Destructive]. If you have other tasks"), 'Git Destructive');
  assert.equal(autoDenialReason('Permission for this action was denied by the Claude Code auto mode classifier. Reason: The server-side auto mode classifier judged this action dangerous (it gave no explanation). If you'), '');
  assert.equal(autoDenialReason('Error: ENOENT'), null);
  assert.equal(autoDenialReason(undefined), null);
});

test('sessionRule: one exact rule for a plain command, an MCP tool or a host; nothing the CLI would read differently', () => {
  assert.equal(sessionRule('Bash', { command: 'gh pr merge 13 --merge --delete-branch' }), 'Bash(gh pr merge 13 --merge --delete-branch)');
  assert.equal(sessionRule('PowerShell', { command: 'Get-Date' }), 'PowerShell(Get-Date)');
  for (const command of ['a && b', 'a | b', 'a; b', 'echo $(id)', 'echo `id`', 'rm -rf *', 'echo (x)', 'a\nb', 'x > y', 'echo "a\\b"', '', 'a'.repeat(401)]) assert.equal(sessionRule('Bash', { command }), null, command);
  assert.equal(sessionRule('mcp__github__merge_pull_request', {}), 'mcp__github__merge_pull_request');
  assert.equal(sessionRule('WebFetch', { url: 'https://example.com/a?b=1' }), 'WebFetch(domain:example.com)');
  assert.equal(sessionRule('WebFetch', { url: 'not a url' }), null);
  assert.equal(sessionRule('Write', { file_path: '/x' }), null);
});

test('pendingBlocked: refusals since the last message, minus those retried; allowing alone leaves them open', () => {
  const denied = id => ({ kind: 'auto_denied', toolUseId: id, tool: 'Bash', input: {}, rule: null });
  const events = [denied('old'), { kind: 'user' }, denied('a'), denied('b'), denied('c'), { kind: 'denial_allow', toolUseIds: ['a'], retry: true }, { kind: 'denial_allow', toolUseIds: ['b'], retry: false }];
  assert.deepEqual(pendingBlocked(events).map(event => event.toolUseId), ['b', 'c']);
  assert.deepEqual(pendingBlocked([...events, { kind: 'user' }]), []);
  assert.deepEqual(pendingBlocked([...events, { kind: 'divider' }]), []);
});

test('retryText names every action, with the command of a shell call', () => {
  const text = retryText([{ tool: 'Bash', input: { command: 'git push' } }, { tool: 'mcp__x__y', input: { a: 1 } }]);
  assert.match(text, /2개 작업을/); assert.match(text, /- Bash: `git push`/); assert.match(text, /- mcp__x__y: `\{"a":1\}`/);
});
