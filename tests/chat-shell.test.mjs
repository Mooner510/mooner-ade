import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { interactiveHint, pendingShellRuns, runShell, shellContext, shellInvocation, wantsTerminal, SHELL_CONTEXT_CHARS } from '../apps/local-server/src/chat-shell.js';
import { detectShells, resolveShell } from '../apps/local-server/src/shells.js';
import { openChatSession } from '../apps/local-server/src/chat.js';

const probe = fileURLToPath(new URL('./fixtures/shell-probe.mjs', import.meta.url)).replaceAll('\\', '/');
const fakeEcho = fileURLToPath(new URL('./fixtures/fake-claude-echo.mjs', import.meta.url));
const shell = resolveShell('', detectShells());
const node = (...args) => `node "${probe}" ${args.join(' ')}`;
const until = async predicate => { for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 15)); } assert.fail('did not settle'); };

test('shellInvocation: PowerShell, cmd and POSIX shells get a one-shot, non-interactive command line', () => {
  const ps = shellInvocation({ path: 'C:/x/pwsh.exe' }, 'ls', 'win32');
  assert.deepEqual(ps.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.match(ps.args[4], /ls\nif \(\$\?\)/);
  const cmd = shellInvocation({ path: 'C:/Windows/System32/cmd.exe' }, 'dir', 'win32');
  assert.deepEqual(cmd.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(cmd.options.windowsVerbatimArguments, true);
  assert.deepEqual(shellInvocation({ path: '/bin/zsh' }, 'ls -la', 'darwin').args, ['-lc', 'ls -la']);
  assert.deepEqual(shellInvocation({ path: 'C:/Git/bin/bash.exe' }, 'ls', 'win32').args, ['-lc', 'ls']);
});

test('runShell: exit code, stdout and stderr stay apart, and stdin is closed', async () => {
  const seen = [];
  const result = await runShell({ command: node('echo', 3), cwd: os.tmpdir(), shell, onOutput: (stream, text) => seen.push([stream, text]) });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout.trim(), 'hello 한글');
  assert.equal(result.stderr.trim(), 'warn');
  assert.ok(seen.some(([stream]) => stream === 'stdout') && seen.some(([stream]) => stream === 'stderr'));
  assert.equal((await runShell({ command: node('echo', 0), cwd: os.tmpdir(), shell })).status, 'done');
  assert.match((await runShell({ command: node('stdin'), cwd: os.tmpdir(), shell, timeoutMs: 20_000 })).stdout, /stdin closed after 0 bytes/);
});

test('runShell: runs in the given folder with the given environment, without a terminal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ade-shell-'));
  try {
    const where = await runShell({ command: node('cwd'), cwd: dir, shell });
    assert.equal(path.resolve(where.stdout.trim()).toLowerCase(), path.resolve(dir).toLowerCase());
    const env = await runShell({ command: node('env', 'ADE_SHELL_TEST'), cwd: dir, shell, env: { ...process.env, ADE_SHELL_TEST: 'yes' } });
    assert.equal(env.stdout.trim(), 'yes|dumb');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runShell: stopping and the timeout end the command and everything it started', async () => {
  const controller = new AbortController(), started = [];
  const running = runShell({ command: node('sleep'), cwd: os.tmpdir(), shell, signal: controller.signal, onOutput: (stream, text) => started.push(text) });
  await until(() => started.join('').includes('started'));
  controller.abort();
  const stopped = await running;
  assert.equal(stopped.status, 'stopped');
  assert.match(stopped.stdout, /started/);
  const timed = await runShell({ command: node('sleep'), cwd: os.tmpdir(), shell, timeoutMs: 1500 });
  assert.equal(timed.status, 'timeout');
  assert.match(timed.stdout, /started/);
});

test('runShell: a command that floods its output is stopped, and what it printed is kept whole', async () => {
  const result = await runShell({ command: node('loud'), cwd: os.tmpdir(), shell, outputLimit: 512 * 1024, timeoutMs: 20_000 });
  assert.equal(result.status, 'limit');
  assert.ok(result.stdout.length >= 512 * 1024);
});

test('runShell: a missing folder is reported, not thrown', async () => {
  const result = await runShell({ command: node('cwd'), cwd: path.join(os.tmpdir(), 'ade-no-such-folder-xyz'), shell });
  assert.ok(result.status === 'error' || result.status === 'failed');
  assert.notEqual(result.exitCode, 0);
});

test('interactiveHint: login, editors and REPLs go to the terminal; ordinary commands and pipelines run', () => {
  for (const command of ['vim a.txt', 'claude', 'claude login', 'gh auth login', 'npm login', 'python', 'ssh host', 'sudo nano x', 'less log.txt']) assert.ok(interactiveHint(command), command);
  for (const command of ['git status', 'ls -la', 'python -c "print(1)"', 'python script.py', 'node -v', 'claude -p hi', 'claude --version', 'gh auth status', 'ssh host uptime', 'echo hi | less', 'npm run build', 'gh auth login --with-token']) assert.equal(interactiveHint(command), '', command);
  assert.ok(wantsTerminal('', 'sudo: a terminal is required to read the password'));
  assert.ok(!wantsTerminal('ok', ''));
});

test('shellContext and pendingShellRuns: runs not yet sent ride with the next message, long output is clipped only in that copy', () => {
  const events = [
    { kind: 'shell', phase: 'start', id: 'a', command: 'git status', cwd: '/p' },
    { kind: 'shell', phase: 'end', id: 'a', status: 'done', exitCode: 0, stdout: 'clean', stderr: '' },
    { kind: 'shell', phase: 'start', id: 'b', command: 'make', cwd: '/p' },
    { kind: 'shell', phase: 'end', id: 'b', status: 'failed', exitCode: 2, stdout: 'x'.repeat(SHELL_CONTEXT_CHARS * 2), stderr: 'boom' },
    { kind: 'shell', phase: 'start', id: 'c', command: 'sleep 99', cwd: '/p' }];
  const pending = pendingShellRuns(events);
  assert.deepEqual(pending.map(run => run.id), ['a', 'b']);
  const text = shellContext(pending);
  assert.match(text, /<bash-input>git status<\/bash-input>/);
  assert.match(text, /<bash-stdout>clean<\/bash-stdout>/);
  assert.match(text, /exit code 2/);
  assert.match(text, /채팅 기록에는 전부 남아 있습니다/);
  assert.ok(text.length < SHELL_CONTEXT_CHARS * 2 + 2000);
  assert.deepEqual(pendingShellRuns([...events, { kind: 'shell', phase: 'sent', ids: ['a'] }]).map(run => run.id), ['b']);
  assert.deepEqual(pendingShellRuns([...events, { kind: 'divider' }]), []);
  assert.equal(shellContext([]), '');
});

async function open(t, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-shell-')), events = [];
  const options = { directory, id: 'chat', cwd: directory, agent: 'claude', executable: process.execPath, executableArgs: [fakeEcho], onEvent: event => events.push(event), shell, ...extra };
  let session = await openChatSession(options);
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, events, options, get session() { return session; }, async reopen() { await session.close(); session = await openChatSession(options); return session; } };
}
const shellEvents = (events, phase) => events.filter(event => event.kind === 'shell' && event.phase === phase);
const replies = events => events.filter(event => event.kind === 'message').map(event => event.blocks.map(block => block.text ?? '').join('')).join('\n');

test('chat session: ! runs without a turn, stores start and the whole end, and leaves the chat idle', async t => {
  const ctx = await open(t), { session, events } = ctx;
  const { id, done } = session.shell(node('echo', 2));
  assert.equal(shellEvents(events, 'start')[0].id, id);
  assert.equal(session.state().status, 'idle');
  await done;
  const end = shellEvents(events, 'end')[0];
  assert.equal(end.id, id);
  assert.equal(end.exitCode, 2);
  assert.equal(end.status, 'failed');
  assert.equal(end.stdout.trim(), 'hello 한글');
  assert.equal(end.stderr.trim(), 'warn');
  assert.equal(typeof end.seq, 'number');
  assert.equal(path.resolve(shellEvents(events, 'start')[0].cwd), path.resolve(ctx.directory));
  const log = (await readFile(path.join(ctx.directory, 'chat/chat/events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(log.some(event => event.kind === 'shell' && event.phase === 'end' && event.stdout.includes('한글')));
  assert.ok(session.replay().events.some(event => event.kind === 'shell' && event.phase === 'end'));
});

test('chat session: skipShell toggles one waiting run out of (and back into) what rides with the next message', async t => {
  const { session, events } = await open(t);
  const { id, done } = session.shell(node('echo', 0)); await done;
  assert.equal(pendingShellRuns(events).length, 1);
  assert.equal(session.skipShell(id, true), true);
  assert.equal(pendingShellRuns(events).length, 0);
  assert.equal(session.skipShell(id, false), true);
  assert.equal(pendingShellRuns(events).length, 1);
  assert.equal(session.skipShell('nope', true), false);
});

test('chat session: stop ends a running command; an interactive command is refused; at most four run at once', async t => {
  const { session, events } = await open(t);
  const { id, done } = session.shell(node('sleep'));
  await until(() => events.some(event => event.kind === 'shell' && event.phase === 'output' && event.text.includes('started')));
  assert.equal(session.stopShell(id), true);
  await done;
  assert.equal(shellEvents(events, 'end')[0].status, 'stopped');
  assert.equal(session.stopShell(id), false);
  assert.throws(() => session.shell('vim file.txt'), error => error.code === 'SHELL_INTERACTIVE' && /터미널/.test(error.message));
  assert.throws(() => session.shell('   '), /명령/);
  const runs = [1, 2, 3, 4].map(() => session.shell(node('sleep')));
  assert.throws(() => session.shell(node('sleep')), error => error.code === 'CHAT_BUSY');
  for (const run of runs) session.stopShell(run.id);
  await Promise.all(runs.map(run => run.done));
});

test('chat session: a timeout is recorded as such', async t => {
  const { session, events } = await open(t, { shellTimeoutMs: 1200 });
  await session.shell(node('sleep')).done;
  assert.equal(shellEvents(events, 'end')[0].status, 'timeout');
});

test('chat session: what the user ran goes ahead of their next message once; the thread shows only what they typed', async t => {
  const { session, events } = await open(t);
  await session.shell(node('echo', 0)).done;
  await session.send('요약해줘');
  await until(() => session.state().status === 'idle');
  const user = events.filter(event => event.kind === 'user').at(-1);
  assert.equal(user.text, '요약해줘');
  const sent = shellEvents(events, 'sent');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].seq < user.seq);
  // The fake agent answers with exactly what it was sent.
  const reply = replies(events);
  assert.match(reply, /<bash-input>node .*echo 0<\/bash-input>/);
  assert.match(reply, /<bash-stdout>hello 한글/);
  assert.match(reply, /요약해줘/);
  await session.send('그 다음');
  await until(() => session.state().status === 'idle');
  assert.equal(shellEvents(events, 'sent').length, 1);
  assert.doesNotMatch(replies(events).split('그 다음').at(-1), /bash-input/);
  // A slash command does not take it; the next real message does.
  await session.shell(node('echo', 0)).done;
  await session.send('/context');
  await until(() => session.state().status === 'idle');
  assert.equal(shellEvents(events, 'sent').length, 1);
  await session.send('이제');
  await until(() => session.state().status === 'idle');
  assert.equal(shellEvents(events, 'sent').length, 2);
});

test('chat session: a command left running by a stopped server is closed as interrupted on reopen', async t => {
  const ctx = await open(t), { session } = ctx;
  const { id, done } = session.shell(node('sleep'));
  await until(() => shellEvents(ctx.events, 'start').length === 1);
  session.stopShell(id);
  await done;
  // As after a crash: the start event is on disk but no end event follows.
  const log = path.join(ctx.directory, 'chat/chat/events.jsonl');
  const lines = (await readFile(log, 'utf8')).trim().split('\n').filter(line => !line.includes('"phase":"end"'));
  await session.close();
  await writeFile(log, `${lines.join('\n')}\n`);
  const reopened = await ctx.reopen();
  const ends = reopened.replay().events.filter(event => event.kind === 'shell' && event.phase === 'end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].status, 'interrupted');
});
