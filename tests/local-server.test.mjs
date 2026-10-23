import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WebSocket = createRequire(new URL('../apps/local-server/package.json', import.meta.url))('ws');
const git = (cwd, ...args) => new Promise((resolve, reject) => spawn('git', args, { cwd, stdio: 'ignore' }).on('exit', code => code ? reject(new Error(`git ${args}`)) : resolve()));

async function boot(t) {
  const data = await mkdtemp(join(tmpdir(), 'ade-data-')), repo = await realpath(await mkdtemp(join(tmpdir(), 'ade-repo-')));
  const child = spawn(process.execPath, ['apps/local-server/src/index.js'], { env: { ...process.env, ADE_PORT: '0', ADE_DATA_DIR: data, ADE_PTY_ENDPOINT: '', ADE_PTY_TOKEN: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); await exited;
    }
    await rm(data, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true });
  });
  const line = await new Promise((resolve, reject) => { child.stdout.once('data', chunk => resolve(String(chunk))); child.once('exit', () => reject(new Error('server exited'))); });
  const [, origin, token] = /(http:\/\/127\.0\.0\.1:\d+)\/#token=(\w+)/.exec(line);
  const auth = await fetch(`${origin}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const api = async (action, body = {}, expected = 200) => {
    const response = await fetch(`${origin}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  await git(repo, 'init', '-q', '-b', 'main');
  // A global core.autocrlf (Windows default) would check files out with CRLF and make content assertions machine-dependent.
  await git(repo, 'config', 'core.autocrlf', 'false');
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  await writeFile(join(repo, 'a.txt'), 'hello world\nHello again\n');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'b.ts'), 'export const x = 1;\n');
  await git(repo, 'add', '.');
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'files');
  const project = await api('project/open', { path: repo });
  return { origin, cookie, api, repo, data, projectId: project.id, call: (action, body, expected) => api(action, { projectId: project.id, ...body }, expected) };
}

test('terminal restore keeps concurrent provider sessions separate and sends legacy terminals to the picker', async t => {
  const { call, data, projectId } = await boot(t);
  if (!(await call('readiness')).pty.installed) return t.skip('node-pty unavailable');
  const sessions = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  for (const agent of ['claude', 'codex']) {
    for (const sessionId of sessions) {
      const original = await call('terminal/open', { agent });
      const directory = join(data, projectId, 'terminal-sessions', original.id);
      if (agent === 'claude') await writeFile(join(directory, 'session.json'), JSON.stringify({ agent, sessionId }));
      else await writeFile(join(directory, 'codex-tui.log'), `2026-10-20T00:00:00Z  INFO session_loop{thread_id=${sessionId}}: codex_core::session: new\n`);
      await call('terminal/close', { id: original.id });
      const restored = await call('terminal/open', { agent, restoreId: original.id });
      assert.match(restored.command, new RegExp(agent === 'claude' ? `^claude --resume ${sessionId}(?: |$)` : `^codex resume ${sessionId}(?: |$)`));
      await call('terminal/close', { id: restored.id });
    }
    const legacy = await call('terminal/open', { agent, restoreId: 'old-terminal' });
    assert.match(legacy.command, agent === 'claude' ? /^claude --resume(?: |$)/ : /^codex resume(?: |$)/);
    assert.doesNotMatch(legacy.command, /--continue|--last/);
    await call('terminal/close', { id: legacy.id });
  }
  await call('terminal/open', { agent: 'other' }, 400);
  await call('terminal/open', { agent: 'claude', restoreId: '../escape' }, 400);
  await call('terminal/open', { restoreId: 'old-terminal' }, 400);
});

test('manually typed CLIs record separate sessions through the real PTY startup functions', { skip: process.platform === 'win32' }, async t => {
  const { call, repo, origin, cookie, projectId } = await boot(t);
  if (!(await call('readiness')).pty.installed) return t.skip('node-pty unavailable');
  const bin = join(repo, 'bin'), fixture = join(repo, 'session-cli.mjs');
  await mkdir(bin);
  await writeFile(fixture, `import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const [agent, sessionId, ...args] = process.argv.slice(2);
if (agent === 'claude') {
  const settings = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
  const result = spawnSync(settings.hooks.SessionStart[0].hooks[0].command, {shell:true,input:JSON.stringify({hook_event_name:'SessionStart',session_id:sessionId})});
  if(result.status) throw new Error(String(result.stderr));
} else {
  const root = args[args.indexOf('-c') + 1].slice('log_dir='.length);
  writeFileSync(path.join(root, 'codex-tui.log'), '2026-10-20T00:00:00Z  INFO session_loop{thread_id='+sessionId+'}: codex_core::session: new\\n');
}
console.log('session-ready-'+sessionId);
setInterval(()=>{}, 1000);
`);
  const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
  for (const agent of ['claude', 'codex']) await writeFile(join(bin, agent), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ${agent} "$ADE_TEST_SESSION" "$@"\n`, { mode: 0o700 });
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { Origin: origin, Cookie: cookie } }), messages = [];
  t.after(() => ws.close());
  ws.on('message', raw => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'subscribe', projectId }));
  const until = async predicate => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (messages.some(predicate)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('manual CLI session timeout');
  };
  for (const agent of ['claude', 'codex']) for (const sessionId of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
    const terminal = await call('terminal/open');
    await until(message => message.type === 'terminal' && message.id === terminal.id);
    ws.send(JSON.stringify({ type: 'terminal/input', projectId, id: terminal.id, data: `export PATH=${quote(bin)}:"$PATH" ADE_TEST_SESSION=${sessionId}; ${agent}\r` }));
    await until(message => message.type === 'terminal' && message.id === terminal.id && message.data.includes(`session-ready-${sessionId}`));
    await call('terminal/close', { id: terminal.id });
    const restored = await call('terminal/open', { agent, restoreId: terminal.id });
    assert.match(restored.command, new RegExp(`${agent === 'claude' ? '--resume' : 'resume'} ${sessionId}(?: |$)`));
    await call('terminal/close', { id: restored.id });
  }
});

test('server requires auth and rejects foreign origins', async t => {
  const { origin } = await boot(t);
  const noAuth = await fetch(`${origin}/api/recent`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
  assert.equal(noAuth.status, 401);
  const foreign = await fetch(`${origin}/api/recent`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
});

test('recent: removal persists without deleting files or closing projects', async t => {
  const { api, call, repo, projectId } = await boot(t);
  const other = await api('project/open', { path: join(repo, 'src') });
  const state = { openProjects: [{ id: projectId, root: repo }], activeProjectId: projectId, settings: null };
  await api('app/state', { state });
  await api('recent/pin', { root: repo, pinned: true });
  const before = await api('recent');
  for (const root of [undefined, '', 42]) await api('recent/remove', { root }, 400);
  assert.deepEqual(await api('recent'), before);
  const remaining = before.filter(item => item.root !== repo);
  assert.deepEqual(await api('recent/remove', { root: repo }), remaining);
  assert.deepEqual(await api('recent'), remaining);
  assert.ok(remaining.some(item => item.id === other.id));
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'hello world\nHello again\n');
  assert.deepEqual(await api('app/state'), { version: 1, ...state });
  assert.deepEqual(await api('recent/remove', { root: repo }), remaining);
  await api('project/close', { projectId });
  await api('project/open', { path: repo });
  assert.ok((await api('recent')).some(item => item.root === repo));
});

test('endpoints of removed features stay gone', async t => {
  const { call } = await boot(t);
  for (const action of ['files/read', 'files/save', 'files/search', 'git/discard', 'git/stage', 'git/commit', 'run/start', 'conversation/create', 'approval', 'agents/catalog']) await call(action, {}, 404);
});

test('git: a repository-configured core.fsmonitor command never runs during status', async t => {
  const { call, repo } = await boot(t);
  const marker = join(repo, '..', `fsmonitor-ran-${process.pid}`);
  await git(repo, 'config', 'core.fsmonitor', `touch ${marker}`);
  await call('git/status');
  await assert.rejects(stat(marker));
});

test('git: a repository hook never runs during ADE checkout', async t => {
  const { call, repo } = await boot(t);
  const marker = join(repo, '..', `hook-ran-${process.pid}`);
  await git(repo, 'branch', 'other');
  await writeFile(join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  await call('git/checkout', { branch: 'other' });
  await assert.rejects(stat(marker));
});

test('git: repository-configured filter and diff commands never run during status, show or checkout', async t => {
  const { call, repo } = await boot(t);
  const marker = join(repo, '..', `filter-ran-${process.pid}`);
  for (const key of ['filter.y.clean', 'filter.y.smudge', 'filter.y.process', 'diff.y.textconv', 'diff.y.command']) await git(repo, 'config', key, `touch ${marker}`);
  await writeFile(join(repo, '.gitattributes'), '* filter=y diff=y\n');
  await git(repo, 'branch', 'other');
  await writeFile(join(repo, 'a.txt'), 'changed\n');
  await call('git/status');
  await call('git/show', { path: 'a.txt' });
  await writeFile(join(repo, 'a.txt'), 'hello world\nHello again\n');
  await call('git/checkout', { branch: 'other' });
  await assert.rejects(stat(marker));
});

test('git: status, show, branches, checkout', async t => {
  const { call, repo } = await boot(t);
  await writeFile(join(repo, 'a.txt'), 'changed\n');
  await writeFile(join(repo, 'new.txt'), 'brand new\n');
  const status = await call('git/status');
  assert.deepEqual(status.changes.map(change => change.status).sort(), [' M', '??']);
  assert.equal(status.additions, 2);
  assert.equal((await call('git/show', { path: 'a.txt' })).content, 'hello world\nHello again\n');
  assert.equal((await call('git/show', { path: 'a.txt', working: true })).content, 'changed\n');
  await git(repo, 'add', 'a.txt');
  assert.equal((await call('git/show', { path: 'a.txt', staged: true })).content, 'changed\n');
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'change');
  await git(repo, 'branch', 'feature');
  assert.deepEqual((await call('git/branches')).branches.sort(), ['feature', 'main']);
  await call('git/checkout', { branch: 'feature' });
  assert.equal((await call('git/status')).branch, 'feature');
  await call('git/checkout', { branch: '--orphan' }, 400);
});

test('websocket: terminal echo and resize validation', async t => {
  const { origin, cookie, call, projectId } = await boot(t);
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { Origin: origin, Cookie: cookie } });
  t.after(() => ws.close());
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'subscribe', projectId }));
  const until = async (predicate, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const found = messages.find(predicate); if (found) return found; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('timeout'); };
  await until(message => message.type === 'snapshot');

  const readiness = await call('readiness');
  if (readiness.pty.installed) {
    const { id } = await call('terminal/open');
    ws.send(JSON.stringify({ type: 'terminal/resize', projectId, id, cols: 0, rows: 5 }));
    assert.equal((await until(message => message.type === 'error')).error.code, 'INVALID_INPUT');
    ws.send(JSON.stringify({ type: 'terminal/resize', projectId, id, cols: 100, rows: 30 }));
    ws.send(JSON.stringify({ type: 'terminal/input', projectId, id, data: process.platform === 'win32' ? 'echo ade-$(20+22)\r' : 'echo ade-$((20+22))\n' }));
    await until(message => message.type === 'terminal' && message.data.includes('ade-42'));
    ws.send(JSON.stringify({ type: 'terminal/input', projectId, id, data: 'exit\r' }));
    await until(message => message.type === 'terminal/exit' && message.id === id);
    assert.ok(!(await call('snapshot')).terminals.some(terminal => terminal.id === id));
    await call('terminal/close', { id });
    const closed = await call('terminal/open');
    await call('terminal/close', { id: closed.id });
    await until(message => message.type === 'terminal/exit' && message.id === closed.id);
    for (const terminalId of [id, closed.id]) {
      ws.send(JSON.stringify({ type: 'terminal/input', projectId, id: terminalId, data: 'late input' }));
      ws.send(JSON.stringify({ type: 'terminal/resize', projectId, id: terminalId, cols: 100, rows: 30 }));
    }
  } else t.diagnostic('node-pty unavailable; terminal checks skipped');

  assert.deepEqual(messages.filter(message => message.type === 'error').map(message => message.error.code), readiness.pty.installed ? ['INVALID_INPUT'] : []);
});

test('websocket: terminal agent processes survive replay, switch providers and clear on exit', async t => {
  const { origin, cookie, call, projectId, repo } = await boot(t);
  if (!(await call('readiness')).pty.installed) return t.skip('node-pty unavailable');
  const connect = async () => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { Origin: origin, Cookie: cookie } }), messages = [];
    t.after(() => ws.close());
    ws.on('message', raw => messages.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'subscribe', projectId }));
    const until = async predicate => {
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        const found = messages.find(predicate); if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('terminal agent event timeout');
    };
    return { ws, messages, until };
  };
  const { ws, messages, until } = await connect();
  const { id } = await call('terminal/open');
  await until(message => message.type === 'terminal' && message.id === id);
  const run = async (folder, name) => {
    const directory = join(repo, 'node_modules', folder);
    await mkdir(directory, { recursive: true });
    const script = join(directory, name);
    const app = folder.includes('claude-code') ? 'claude-code' : 'codex';
    await writeFile(script, `process.stdin.setRawMode(true); process.stdin.resume();
      process.stdout.write('\\x1b]7501;?\\x1b\\\\');
      let started = false, input = '';
      process.stdin.on('data', data => {
        input += data;
        if (input.includes('\\x03')) process.exit();
        if (!started && input.includes('\\x1b]7501;?\\x1b\\\\')) {
          started = true;
          process.stdout.write('\\x1b]7501;state=working:app=${app}\\x1b\\\\');
          process.stdout.write('redraw\\n'.repeat(40000));
        }
      });`);
    messages.length = 0;
    ws.send(JSON.stringify({ type: 'terminal/input', projectId, id, data: `"${process.execPath}" "${script}"\r` }));
  };
  await run('@anthropic-ai/claude-code', 'cli.js');
  await until(message => message.type === 'terminal/agent' && message.id === id && message.agent === 'claude');
  await until(message => message.type === 'terminal' && message.id === id && message.status?.state === 'working');
  const replay = await connect();
  await replay.until(message => message.type === 'terminal/agent' && message.id === id && message.agent === 'claude');
  const restored = await replay.until(message => message.type === 'terminal/replay' && message.id === id);
  assert.deepEqual(restored.status, { agent: 'claude', state: 'working' });
  assert.ok(!restored.data.includes('7501;state=working'), 'state survives even when its report has scrolled out of the replay buffer');
  messages.length = 0;
  ws.send(JSON.stringify({ type: 'terminal/input', projectId, id, data: '\x03' }));
  await until(message => message.type === 'terminal/agent' && message.id === id && message.agent === null);
  await until(message => message.type === 'terminal/status' && message.id === id && message.status === null);
  await run('@openai/codex/bin', 'codex.js');
  await until(message => message.type === 'terminal/agent' && message.id === id && message.agent === 'codex');
  await until(message => message.type === 'terminal' && message.id === id && message.status?.agent === 'codex' && message.status.state === 'working');
  await call('terminal/close', { id });
});

test('terminal follow-up validates the live Claude process and output sequence, and acknowledges retries once', async t => {
  const { origin, cookie, call, projectId, repo } = await boot(t);
  if (!(await call('readiness')).pty.installed) return t.skip('node-pty unavailable');
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { Origin: origin, Cookie: cookie } }), messages = [];
  t.after(() => ws.close());
  ws.on('message', raw => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'subscribe', projectId }));
  const until = async predicate => {
    const end = Date.now() + 10000;
    while (Date.now() < end) { if (messages.some(predicate)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('follow-up timeout');
  };
  const { id } = await call('terminal/open');
  await until(message => message.type === 'terminal' && message.id === id);
  const sequence = () => messages.filter(message => message.type === 'terminal' && message.id === id).at(-1).sequence;
  const request = { id, prompt: '후속 요청\nsecond line', requestId: 'follow-up-test', sequence: sequence() };
  assert.deepEqual(await call('terminal/follow-up', request), { accepted: false }); // Never type a queued command into the shell.
  await call('terminal/follow-up', { ...request, prompt: '\x1b[201~\rcommand' }, 400);
  const directory = join(repo, 'node_modules', '@anthropic-ai', 'claude-code');
  await mkdir(directory, { recursive: true });
  const script = join(directory, 'cli.js');
  await writeFile(script, `process.stdin.setRawMode(true);
    process.stdin.on('data', data => process.stdout.write('received:' + JSON.stringify(data.toString()) + '\\n'));
    console.log('fake-claude-ready');`);
  ws.send(JSON.stringify({ type: 'terminal/input', projectId, id, data: `"${process.execPath}" "${script}"\r` }));
  await until(message => message.type === 'terminal' && message.data.includes('fake-claude-ready'));
  assert.deepEqual(await call('terminal/follow-up', request), { accepted: false }); // Stale screen.
  request.sequence = sequence();
  assert.deepEqual(await call('terminal/follow-up', request), { accepted: true });
  await until(message => message.type === 'terminal' && message.data.includes('received:'));
  assert.deepEqual(await call('terminal/follow-up', request), { accepted: true }); // A lost HTTP reply must not submit twice.
  const output = messages.filter(message => message.type === 'terminal').map(message => message.data).join('');
  assert.equal(output.split('후속 요청').length - 1, 1);
  assert.ok(output.includes('\\u001b[200~후속 요청\\nsecond line\\u001b[201~\\r'));
  await call('terminal/close', { id });
});

test('multi-project: tagged fan-out, unsubscribe, close, app state', async t => {
  const { origin, cookie, api, call, projectId, repo } = await boot(t);
  const second = await realpath(await mkdtemp(join(tmpdir(), 'ade-repo2-')));
  // The server's directory watcher can still hold the folder on Windows; a leftover temp dir is harmless.
  t.after(() => rm(second, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {}));
  await git(second, 'init', '-q', '-b', 'main');
  await git(second, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const other = await api('project/open', { path: second });
  assert.notEqual(other.id, projectId);
  assert.equal((await api('project/open', { path: repo })).id, projectId);

  const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { Origin: origin, Cookie: cookie } });
  t.after(() => ws.close());
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const until = async (predicate, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const found = messages.find(predicate); if (found) return found; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('timeout'); };
  for (const id of [projectId, other.id]) ws.send(JSON.stringify({ type: 'subscribe', projectId: id }));
  await until(m => m.type === 'snapshot' && m.projectId === projectId);
  await until(m => m.type === 'snapshot' && m.projectId === other.id);

  // Messages are tagged with their own project and never leak across projects.
  await writeFile(join(repo, 'n.txt'), 'x');
  await until(m => m.type === 'fs' && m.projectId === projectId && m.paths.includes('n.txt'));
  assert.ok(!messages.some(m => m.type === 'fs' && m.projectId === other.id));

  ws.send(JSON.stringify({ type: 'unsubscribe', projectId }));
  await new Promise(resolve => setTimeout(resolve, 200));
  messages.length = 0;
  await writeFile(join(repo, 'm.txt'), 'y');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(!messages.some(m => m.type === 'fs'));

  const readiness = await api('readiness', { projectId: other.id });
  if (readiness.pty.installed) {
    await api('terminal/open', { projectId: other.id });
    assert.equal((await api('project/close', { projectId: other.id }, 409)).error.code, 'PROJECT_BUSY');
  }
  await api('project/close', { projectId: other.id, force: true });
  await api('snapshot', { projectId: other.id }, 404);
  await call('snapshot'); // the other project is unaffected
  assert.equal((await api('project/open', { path: second })).id, other.id); // lock was released, so it reopens

  const state = { openProjects: [{ id: projectId, root: repo }, { id: other.id, root: second }], activeProjectId: other.id, settings: { theme: 'light' } };
  await api('app/state', { state });
  assert.deepEqual(await api('app/state'), { version: 1, ...state });
  await api('app/state', { state: { ...state, activeProjectId: 'missing' } }, 400);

  // The status bar reads host load; it needs no open project.
  const system = await api('system/info');
  assert.ok(system.cpu >= 0 && system.cpu <= 100 && system.cores > 0);
  assert.ok(system.memory.total > 0 && system.memory.used > 0 && system.memory.used <= system.memory.total);
});

test('access token is per process, never stored, and can be exchanged again', async t => {
  const data = await mkdtemp(join(tmpdir(), 'ade-token-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  await writeFile(join(data, 'token'), 'a'.repeat(64)); // left by an older version
  const start = async () => {
    const child = spawn(process.execPath, ['apps/local-server/src/index.js'], { env: { ...process.env, ADE_PORT: '0', ADE_DATA_DIR: data, ADE_PTY_ENDPOINT: '', ADE_PTY_TOKEN: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
    const line = await new Promise((resolve, reject) => { child.stdout.once('data', chunk => resolve(String(chunk))); child.once('exit', () => reject(new Error('server exited'))); });
    const [, origin, token] = /(http:\/\/127\.0\.0\.1:\d+)\/#token=(\w+)/.exec(line);
    const exchange = (value = token) => fetch(`${origin}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token: value }) });
    return { token, exchange, stop: async () => { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } };
  };
  const first = await start();
  assert.equal((await first.exchange()).status, 200);
  assert.equal((await first.exchange()).status, 200); // a window reload exchanges it again
  await first.stop();
  const second = await start();
  t.after(second.stop);
  assert.notEqual(second.token, first.token);
  assert.equal((await second.exchange(first.token)).status, 401);
  assert.equal((await second.exchange()).status, 200);
  await assert.rejects(stat(join(data, 'token')));
});
