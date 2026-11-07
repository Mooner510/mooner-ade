import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteClaude, parseRemote, pickSession, remoteScript, stateOf } from '../apps/local-server/src/remote-claude.js';
import { sshRunCommand, sshUploadCommand } from '../apps/local-server/src/ssh-upload.js';
import { createTerminalStatus } from '../apps/local-server/src/terminal-status.js';

const one = '5450d9b4-ef97-4365-80a9-40e9e92cc1a0', two = '6a50d9b4-ef97-4365-80a9-40e9e92cc1a1', cwd = '/home/me/my_project';
const request = (id, timestamp) => JSON.stringify({ type: 'api-request', id, timestamp });
const reply = (ref, ttl = '1h') => JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: '2026-11-06T10:00:30.000Z', requestRef: ref, promptCacheRequested: ttl,
  message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 } } });
const session = (pid, sessionId, extra = {}) => ({ pid, sessionId, cwd, kind: 'interactive', status: 'idle', dir: '/home/me/.claude', ...extra });

test('busy is a turn in progress, anything else is not, and no status says nothing', () => {
  assert.equal(stateOf({ status: 'busy' }), 'working');
  assert.equal(stateOf({ status: 'idle' }), 'idle');
  assert.equal(stateOf({ status: 'waiting' }), 'idle');
  assert.equal(stateOf({}), null);
});

test('only the terminal\'s own Claude is followed: the sticky one, the only one, or the one named on screen', () => {
  const a = session(10, one, { cwd: '/srv/alpha-app' }), b = session(11, two, { cwd: '/srv/beta-app' });
  assert.equal(pickSession([a], '', null), a);
  assert.equal(pickSession([a, b], 'user@host:~/alpha-app$', null), a);
  assert.equal(pickSession([a, b], 'nothing useful', null), null, 'ambiguous: read nothing rather than another terminal\'s Claude');
  assert.equal(pickSession([a, b], 'alpha-app beta-app', null), null);
  assert.equal(pickSession([a, b], 'nothing useful', 11), b, 'a followed session stays while it lives');
  assert.equal(pickSession([a, session(12, one, { kind: 'sdk' })], '', null), a, 'only interactive sessions count');
  assert.equal(pickSession([{ pid: 1, sessionId: 'nope' }], '', null), null);
});

test('the listing is parsed, and a transcript tail is kept as bytes', () => {
  const output = Buffer.from(`@@SESSION /home/me/.claude\n${JSON.stringify({ pid: 7, sessionId: one, status: 'busy' })}\n@@TRANSCRIPT 5 12\nhello\nbye\n`);
  const { sessions, transcript } = parseRemote(output);
  assert.deepEqual(sessions, [{ dir: '/home/me/.claude', pid: 7, sessionId: one, status: 'busy' }]);
  assert.equal(transcript.offset, 5); assert.equal(transcript.size, 12); assert.equal(transcript.bytes.toString(), 'hello\nbye\n');
  assert.deepEqual(parseRemote(Buffer.from('')), { sessions: [], transcript: null });
  assert.equal(parseRemote(Buffer.from('@@SESSION /d\n{broken\n')).sessions.length, 0, 'a file being rewritten is skipped');
});

test('state and cache follow the remote transcript incrementally, whole lines only', () => {
  const remote = createRemoteClaude();
  const first = `${request('r1', '2026-11-06T10:00:00.000Z')}\n${reply('r1')}\n`, bytes = Buffer.from(first);
  // A tail that starts mid-line drops the cut-off first line; a half-written last line waits for the next poll.
  const cut = Buffer.concat([Buffer.from('tial-of-an-older-line\n'), bytes, Buffer.from('{"type":"api-req')]);
  let result = remote.update({ sessions: [session(7, one, { status: 'busy' })], transcript: { offset: 900, size: 900 + cut.length, bytes: cut } });
  assert.equal(result.state, 'working');
  assert.deepEqual(result.cache, { at: Date.parse('2026-11-06T10:00:00.000Z'), ttl: 3600, tokens: 1002, model: 'claude-opus-5-5' });
  const asked = remote.request;
  assert.equal(asked.offset, 900 + Buffer.from('tial-of-an-older-line\n').length + bytes.length, 'continues after the last whole line');
  assert.equal(asked.sessionId, one);
  // The next poll resumes there with the line completed.
  const more = Buffer.from(`${request('r2', '2026-11-06T10:20:00.000Z')}\n${reply('r2', '5m')}\n`);
  result = remote.update({ sessions: [session(7, one, { status: 'idle' })], transcript: { offset: asked.offset, size: asked.offset + more.length, bytes: more } });
  assert.equal(result.state, 'idle'); assert.equal(result.cache.at, Date.parse('2026-11-06T10:20:00.000Z')); assert.equal(result.cache.ttl, 300);
  // The session going away clears everything; a new session id starts a fresh cache.
  assert.deepEqual(remote.update({ sessions: [], transcript: null }), { state: null, cache: null });
  assert.equal(remote.request.offset, -1);
});

test('a new conversation in the same Claude does not inherit the old cache', () => {
  const remote = createRemoteClaude();
  const bytes = Buffer.from(`${request('r1', '2026-11-06T10:00:00.000Z')}\n${reply('r1')}\n`);
  remote.update({ sessions: [session(7, one)], transcript: { offset: 0, size: bytes.length, bytes } });
  const result = remote.update({ sessions: [session(7, two)], transcript: null });
  assert.equal(result.cache, null);
  assert.equal(remote.request.sessionId, two); assert.equal(remote.request.offset, -1);
});

test('remote session state stands in only when nothing else reports, and a finished turn reads as done', () => {
  let agent = 'claude';
  const status = createTerminalStatus(() => {}, () => agent);
  assert.equal(status.status, null);
  status.setRemote('idle');
  assert.deepEqual(status.status, { agent: 'claude', state: 'idle', source: 'session' });
  status.setRemote('working');
  assert.equal(status.status.state, 'working');
  status.setRemote('idle');
  assert.equal(status.status.state, 'done');
  status.setRemote('idle');
  assert.equal(status.status.state, 'done', 'stays done until the next turn');
  status.setRemote('working'); assert.equal(status.status.state, 'working');
  agent = null; assert.equal(status.status, null, 'needs an identified agent');
  agent = 'claude';
  // A CLI that speaks 7501, or sends progress, wins.
  status.feed('\x1b]9;4;3;\x07');
  assert.deepEqual(status.status, { agent: 'claude', state: 'working', source: 'progress' });
  status.feed('\x1b]9;4;0;\x07');
  assert.equal(status.status.state, 'done');
  status.feed('\x1b]7501;state=idle:app=claude-code\x07');
  assert.deepEqual(status.status, { agent: 'claude', state: 'idle' });
  status.clear(); status.setRemote(null);
  assert.equal(status.status, null);
});

test('the ssh client line becomes a non-interactive ssh run with the same host settings', () => {
  const run = sshRunCommand(String.raw`"C:\Windows\System32\OpenSSH\ssh.exe" -tt -L 8080:localhost:80 -i "C:\Users\me\.ssh\my key" -p2222 -l me -J jump -o ServerAliveInterval=30 host tmux attach`);
  assert.equal(run.binary, String.raw`C:\Windows\System32\OpenSSH\ssh.exe`);
  const args = run.args.join(' ');
  assert.match(args, /-o BatchMode=yes/); assert.match(args, /-o RequestTTY=no/); assert.match(args, /-o ClearAllForwardings=yes/);
  assert.ok(run.args.includes('-p') && run.args.includes('2222'), 'the port stays an ssh port');
  assert.ok(run.args.includes('-J') && run.args.includes('jump'));
  assert.ok(!run.args.includes('-L') && !run.args.includes('-t') && !run.args.includes('-tt'), 'no forwards or tty');
  assert.equal(run.args.at(-1), 'host', 'the remote command typed in the terminal is not repeated');
  assert.equal(sshRunCommand('ssh'), null);
  assert.equal(sshUploadCommand('ssh -p 2222 host').args.includes('-P'), true, 'sftp still names its port -P');
});

// Windows' sh (msys) does not know native process ids, so the liveness check cannot be exercised there.
const hasSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'true']).status === 0;
test('the script itself runs under sh: lists live sessions and resends the transcript from an offset', { skip: !hasSh && 'no sh on this machine' }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-remote-')), dir = path.join(home, '.claude');
  try {
    const projects = path.join(dir, 'projects', '-home-me-my-project');
    await fs.mkdir(path.join(dir, 'sessions'), { recursive: true }); await fs.mkdir(projects, { recursive: true });
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      await fs.writeFile(path.join(dir, 'sessions', `${sleeper.pid}.json`), JSON.stringify({ pid: sleeper.pid, sessionId: one, cwd, status: 'busy', kind: 'interactive' }));
      await fs.writeFile(path.join(dir, 'sessions', '99999999.json'), JSON.stringify({ pid: 99999999, sessionId: two, cwd }));
      const body = 'x'.repeat(40) + '\n' + 'y'.repeat(20) + '\n';
      await fs.writeFile(path.join(projects, `${one}.jsonl`), body);
      const run = (options) => spawnSync('sh', ['-s'], { input: remoteScript(options), env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' } }).stdout;
      let parsed = parseRemote(run({}));
      assert.equal(parsed.sessions.length, 1, 'a dead pid is skipped');
      assert.equal(parsed.sessions[0].sessionId, one); assert.equal(parsed.sessions[0].dir, dir.replaceAll('\\', '/'));
      assert.equal(parsed.transcript, null, 'no transcript until a session is followed');
      parsed = parseRemote(run({ dir: parsed.sessions[0].dir, sessionId: one, cwd }));
      assert.equal(parsed.transcript.offset, 0); assert.equal(parsed.transcript.size, body.length); assert.equal(parsed.transcript.bytes.toString(), body);
      parsed = parseRemote(run({ dir: parsed.sessions[0].dir, sessionId: one, cwd, offset: 41 }));
      assert.equal(parsed.transcript.offset, 41); assert.equal(parsed.transcript.bytes.toString(), 'y'.repeat(20) + '\n');
      parsed = parseRemote(run({ dir: parsed.sessions[0].dir, sessionId: one, cwd: "it's/odd", offset: body.length + 5 }));
      assert.equal(parsed.transcript.offset, 0, 'a file that shrank is read from the start (the folder is also found by session id)');
    } finally { sleeper.kill(); }
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
