import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrameParser, frame } from '../apps/local-server/src/lsp.js';

const WebSocket = createRequire(new URL('../apps/local-server/package.json', import.meta.url))('ws');
const git = (cwd, ...args) => new Promise((resolve, reject) => spawn('git', args, { cwd, stdio: 'ignore' }).on('exit', code => code ? reject(new Error(`git ${args}`)) : resolve()));

async function boot(t) {
  const data = await mkdtemp(join(tmpdir(), 'ade-data-')), repo = await realpath(await mkdtemp(join(tmpdir(), 'ade-repo-')));
  const child = spawn(process.execPath, ['apps/local-server/src/index.js'], { env: { ...process.env, ADE_PORT: '0', ADE_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(async () => { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); await rm(data, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); });
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
  return { origin, cookie, api, repo, projectId: project.id, call: (action, body, expected) => api(action, { projectId: project.id, ...body }, expected) };
}

test('server requires auth and rejects foreign origins', async t => {
  const { origin } = await boot(t);
  const noAuth = await fetch(`${origin}/api/recent`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
  assert.equal(noAuth.status, 401);
  const foreign = await fetch(`${origin}/api/recent`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
});

test('files: search options, replace, folder rename/delete, index', async t => {
  const { call, repo } = await boot(t);
  const { files } = await call('files/index');
  assert.deepEqual(files.sort(), ['a.txt', 'src/b.ts']);
  assert.equal((await call('files/search', { query: 'hello' })).hits.length, 2);
  assert.equal((await call('files/search', { query: 'hello', caseSensitive: true })).hits.length, 1);
  assert.equal((await call('files/search', { query: 'hell', wholeWord: true })).hits.length, 0);
  assert.equal((await call('files/search', { query: 'x\\s=', regex: true })).hits[0].path, 'src/b.ts');
  assert.equal((await call('files/search', { query: 'hello', include: 'src/**' })).hits.length, 0);
  assert.equal((await call('files/search', { query: 'hello', exclude: '*.txt' })).hits.length, 0);
  await call('files/search', { query: '(', regex: true }, 400);
  const read = await call('files/read', { path: 'a.txt' });
  await call('files/replace', { path: 'a.txt', revision: 'stale', query: 'hello', replacement: 'bye' }, 409);
  const replaced = await call('files/replace', { path: 'a.txt', revision: read.revision, query: 'hello', replacement: 'bye' });
  assert.equal(replaced.count, 2);
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'bye world\nbye again\n');
  await call('files/rename', { path: 'src', to: 'lib/deep' });
  assert.ok((await stat(join(repo, 'lib/deep/b.ts'))).isFile());
  await call('files/save', { path: 'other.txt', content: 'x', revision: null });
  await call('files/rename', { path: 'other.txt', to: 'a.txt' }, 409);
  await call('files/delete', { path: 'lib' });
  await assert.rejects(stat(join(repo, 'lib')));
  await call('files/delete', { path: '.' }, 400);
  await call('files/read', { path: '../escape' }, 400);
});

test('git: show, stage, discard, branches', async t => {
  const { call, repo } = await boot(t);
  await writeFile(join(repo, 'a.txt'), 'changed\n');
  await writeFile(join(repo, 'new.txt'), 'brand new\n');
  const status = await call('git/status');
  assert.deepEqual(status.changes.map(change => change.status).sort(), [' M', '??']);
  assert.equal((await call('git/show', { path: 'a.txt' })).content, 'hello world\nHello again\n');
  assert.equal((await call('git/show', { path: 'a.txt', working: true })).content, 'changed\n');
  await call('git/stage', { files: ['a.txt'] });
  assert.equal((await call('git/show', { path: 'a.txt', staged: true })).content, 'changed\n');
  await call('git/discard', { files: ['a.txt', 'new.txt'] });
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'hello world\nHello again\n');
  await assert.rejects(stat(join(repo, 'new.txt')));
  assert.equal((await call('git/status')).changes.length, 0);
  await git(repo, 'branch', 'feature');
  assert.deepEqual((await call('git/branches')).branches.sort(), ['feature', 'main']);
  await call('git/checkout', { branch: 'feature' });
  assert.equal((await call('git/status')).branch, 'feature');
  await call('git/checkout', { branch: '--orphan' }, 400);
});

test('websocket: terminal echo, resize validation, typescript language server', async t => {
  const { origin, cookie, call, projectId } = await boot(t);
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { Origin: origin, Cookie: cookie } });
  t.after(() => ws.close());
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'subscribe', projectId, cursors: {} }));
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
  } else t.diagnostic('node-pty unavailable; terminal checks skipped');

  ws.send(JSON.stringify({ type: 'lsp', projectId, message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } } }));
  const reply = await until(message => message.type === 'lsp' && message.message.id === 1);
  assert.ok(reply.message.result.capabilities.completionProvider);
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
  for (const id of [projectId, other.id]) ws.send(JSON.stringify({ type: 'subscribe', projectId: id, cursors: {} }));
  await until(m => m.type === 'snapshot' && m.projectId === projectId);
  await until(m => m.type === 'snapshot' && m.projectId === other.id);

  // Messages are tagged with their own project and never leak across projects.
  await api('conversation/create', { projectId: other.id, agentId: 'codex', workspaceMode: 'shared', title: 'x' });
  await call('files/save', { path: 'n.txt', content: 'x', revision: null });
  await until(m => m.type === 'file' && m.projectId === projectId && m.path === 'n.txt');
  assert.ok(!messages.some(m => m.type === 'file' && m.projectId === other.id));

  ws.send(JSON.stringify({ type: 'unsubscribe', projectId }));
  await new Promise(resolve => setTimeout(resolve, 200));
  messages.length = 0;
  await call('files/save', { path: 'm.txt', content: 'y', revision: null });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(!messages.some(m => m.type === 'file'));

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

test('LSP frame parser handles split chunks and several messages per chunk', () => {
  const seen = [], push = createFrameParser(message => seen.push(message));
  const bytes = Buffer.concat([frame({ id: 1, text: '한글' }), frame({ id: 2 })]);
  for (let i = 0; i < bytes.length; i += 7) push(bytes.subarray(i, i + 7));
  assert.deepEqual(seen, [{ id: 1, text: '한글' }, { id: 2 }]);
  push(Buffer.from('Content-Length: 99999999999\r\n\r\n')); // oversize header resets instead of buffering forever
  push(frame({ id: 3 }));
  assert.equal(seen.at(-1).id, 3);
});
