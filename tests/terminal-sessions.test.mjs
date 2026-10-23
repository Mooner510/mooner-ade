import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { terminalAgentCommand, terminalSessionShell, readTerminalSession, recordClaudeSession, codexSession, syncClaudeSession } from '../apps/local-server/src/terminal-sessions.js';

const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
const start = id => `2026-10-20T06:39:17.163436Z  INFO session_loop{thread_id=${id}}: codex_core::session: new\n`;
const directory = async t => {
  const root = await mkdtemp(path.join(tmpdir(), "ade sessions '$-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test('Claude records independent terminal sessions, updates on clear/resume, and ignores subagents', async t => {
  const root = await directory(t), file = id => path.join(root, 'terminal-sessions', id, 'session.json');
  for (const [id, session_id] of [['one', first], ['two', second]]) {
    const command = await terminalAgentCommand(root, id, 'claude');
    assert.match(command, /^claude --settings /);
    await recordClaudeSession(file(id), { hook_event_name: 'SessionStart', session_id });
  }
  assert.match(await terminalAgentCommand(root, 'restored-one', 'claude', 'one'), new RegExp(`--resume ${first} `));
  assert.match(await terminalAgentCommand(root, 'restored-two', 'claude', 'two'), new RegExp(`--resume ${second} `));
  await recordClaudeSession(file('one'), { hook_event_name: 'SessionStart', session_id: second, agent_id: 'child' });
  assert.equal(await readTerminalSession(root, 'one', 'claude'), first);
  await recordClaudeSession(file('one'), { hook_event_name: 'SessionStart', source: 'clear', session_id: second });
  assert.equal(await readTerminalSession(root, 'one', 'claude'), second);
  assert.equal(await readTerminalSession(root, 'one', 'codex'), undefined);
});

test('Codex restores only the latest root session from each terminal log, across large chunk boundaries', async t => {
  const root = await directory(t), log = id => path.join(root, 'terminal-sessions', id, 'codex-tui.log');
  for (const [id, session] of [['one', first], ['two', second]]) {
    assert.match(await terminalAgentCommand(root, id, 'codex'), /--no-daemon -c /);
    await writeFile(log(id), start(session));
  }
  assert.match(await terminalAgentCommand(root, 'restored-one', 'codex', 'one'), new RegExp(`^codex resume ${first} `));
  assert.match(await terminalAgentCommand(root, 'restored-two', 'codex', 'two'), new RegExp(`^codex resume ${second} `));
  assert.equal(await readTerminalSession(root, 'restored-one', 'codex'), first);
  const child = `2026-10-20T00:00:00Z INFO session_loop{thread_id=${first}}:nested{thread_id=${second}}: new\n`;
  assert.equal(codexSession(start(first) + child), first);
  for (const padding of [0, 65400, 65450, 65535, 65536, 131072]) {
    await writeFile(log('one'), start(first) + start(second) + child + 'x'.repeat(padding) + '\n');
    assert.equal(await readTerminalSession(root, 'one', 'codex'), second, `padding ${padding}`);
  }
});

test('unknown, corrupt and legacy records use the provider picker; identifiers cannot become shell code or paths', async t => {
  const root = await directory(t);
  for (const agent of ['claude', 'codex']) {
    const command = await terminalAgentCommand(root, 'new', agent, 'legacy');
    assert.match(command, agent === 'claude' ? /^claude --resume --settings / : /^codex resume --no-daemon /);
    assert.doesNotMatch(command, /--continue|--last/);
  }
  for (const id of ['../escape', '', null, 'id;echo bad']) await assert.rejects(terminalAgentCommand(root, 'new', 'claude', id), { code: 'INVALID_INPUT' });
  await assert.rejects(terminalAgentCommand(root, 'new', 'other'), { code: 'INVALID_INPUT' });
  const file = path.join(root, 'terminal-sessions', 'new', 'session.json');
  await writeFile(file, '{partial');
  assert.equal(await readTerminalSession(root, 'new', 'claude'), undefined);
  await writeFile(file, JSON.stringify({ agent: 'claude', sessionId: '$(echo unsafe)' }));
  assert.equal(await readTerminalSession(root, 'new', 'claude'), undefined);
});

test('generated Claude command survives shell quoting and its actual hook writes the session without stdout', { skip: process.platform === 'win32' }, async t => {
  const root = await directory(t), command = await terminalAgentCommand(root, 'one', 'claude');
  // Substitute just the executable with printf, retaining the exact generated shell arguments.
  const settings = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command.replace(/^claude /, "printf '%s\\n' ")]);
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.on('error', reject);
    child.on('exit', async code => {
      if (code) return reject(new Error(`shell exit ${code}`));
      try { resolve(JSON.parse(await readFile(output.trim().split('\n')[1], 'utf8'))); } catch (error) { reject(error); }
    });
  });
  const hook = settings.hooks.SessionStart[0].hooks[0].command;
  await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', hook]);
    let output = '', errors = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => errors += chunk);
    child.on('error', reject);
    child.on('exit', code => { assert.equal(output, ''); code ? reject(new Error(errors)) : resolve(); });
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: first }));
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'terminal-sessions', 'one', 'session.json'), 'utf8')), { agent: 'claude', sessionId: first });
});

test('direct shell commands keep user arguments and track separate terminals after normal zsh startup', { skip: process.platform !== 'darwin' }, async t => {
  const root = await directory(t), original = path.join(root, 'original'), bin = path.join(root, 'bin');
  await mkdir(original); await mkdir(bin);
  await writeFile(path.join(original, '.zshenv'), 'export ADE_TEST_ENV=loaded\n');
  await writeFile(path.join(original, '.zshrc'), "export ADE_TEST_RC=loaded\nalias claude='claude --user-flag'\n");
  for (const agent of ['claude', 'codex']) await writeFile(path.join(bin, agent), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  const previous = process.env.ZDOTDIR;
  process.env.ZDOTDIR = original;
  let one, two;
  try {
    one = await terminalSessionShell(root, 'one', '/bin/zsh');
    two = await terminalSessionShell(root, 'two', '/bin/zsh');
  } finally { if (previous === undefined) delete process.env.ZDOTDIR; else process.env.ZDOTDIR = previous; }
  // macOS login shells run path_helper, which reorders the test's PATH, so the login flag is dropped here.
  const run = prepared => new Promise((resolve, reject) => {
    const child = spawn('/bin/zsh', [...prepared.args.filter(arg => arg !== '-l'), '-ic', `claude 'a b'; codex resume ${first}; print -r -- "$ADE_TEST_ENV:$ADE_TEST_RC:$ZDOTDIR"`], { env: { ...process.env, ...prepared.env, PATH: `${bin}:${process.env.PATH}` } });
    let output = '', errors = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => errors += chunk);
    child.on('error', reject);
    child.on('exit', code => code ? reject(new Error(errors)) : resolve(output));
  });
  for (const [id, prepared] of [['one', one], ['two', two]]) {
    const output = await run(prepared);
    assert.ok(output.includes(path.join(root, 'terminal-sessions', id, 'claude-settings.json')));
    assert.ok(output.includes(`log_dir=${path.join(root, 'terminal-sessions', id)}`));
    assert.ok(output.includes('--user-flag\na b\n'));
    assert.ok(output.includes(`resume\n${first}\n`));
    assert.ok(output.includes(`loaded:loaded:${original}`));
  }
  assert.deepEqual(await terminalSessionShell(root, 'unknown', '/bin/custom-shell'), { args: [], env: {}, tracked: false });
});

test('a running Claude process ID is synced without relying on the hook', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ade-sync-')), config = path.join(root, 'cfg');
  await mkdir(path.join(config, 'sessions'), { recursive: true });
  const sessionId = '11111111-2222-4333-8444-555555555555';
  await writeFile(path.join(config, 'sessions', '42.json'), JSON.stringify({ pid: 42, sessionId }));
  assert.equal(await syncClaudeSession(root, 'term-a', 42, config), true);
  assert.equal(await readTerminalSession(root, 'term-a', 'claude'), sessionId);
  assert.equal(await syncClaudeSession(root, 'term-a', 42, config), false);
  assert.equal(await syncClaudeSession(root, 'term-b', 43, config), false);
});

test('Cursor CLI starts plainly and restores through its session picker', async t => {
  const root = await directory(t);
  assert.equal(await terminalAgentCommand(root, 'one', 'cursor'), 'cursor-agent');
  assert.equal(await terminalAgentCommand(root, 'restored', 'cursor', 'one'), 'cursor-agent --resume');
  await assert.rejects(terminalAgentCommand(root, 'bad', 'gemini'), /잘못된 에이전트/);
});
