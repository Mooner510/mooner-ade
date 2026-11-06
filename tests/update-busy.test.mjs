import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The auto-updater asks the server over IPC what a restart would cut off. This runs the real server with a real terminal.
const runNode = `${process.platform === 'win32' ? '& ' : ''}"${process.execPath}"`;
const WebSocket = createRequire(new URL('../apps/local-server/package.json', import.meta.url))('ws');
const git = (cwd, ...args) => new Promise((resolve, reject) => spawn('git', args, { cwd, stdio: 'ignore' }).on('exit', code => code ? reject(new Error(`git ${args}`)) : resolve()));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function boot(t) {
  const data = await mkdtemp(join(tmpdir(), 'ade-data-')), repo = await realpath(await mkdtemp(join(tmpdir(), 'ade-repo-')));
  const child = spawn(process.execPath, ['apps/local-server/src/index.js'], { env: { ...process.env, ADE_PORT: '0', ADE_DATA_DIR: data, ADE_PTY_ENDPOINT: '', ADE_PTY_TOKEN: '' }, stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.send({ type: 'shutdown' }); await exited;
    }
    const removal = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
    await rm(data, removal); await rm(repo, removal);
  });
  const line = await new Promise((resolve, reject) => { child.stdout.once('data', chunk => resolve(String(chunk))); child.once('exit', () => reject(new Error('server exited'))); });
  const [, origin, token] = /(http:\/\/127\.0\.0\.1:\d+)\/#token=(\w+)/.exec(line);
  const auth = await fetch(`${origin}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const api = async (action, body = {}) => {
    const response = await fetch(`${origin}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  let requests = 0;
  const busy = () => new Promise((resolve, reject) => {
    const id = ++requests, timer = setTimeout(() => reject(new Error('no answer to busy?')), 20_000);
    const onMessage = message => { if (message?.type === 'busy' && message.id === id) { clearTimeout(timer); child.off('message', onMessage); resolve(message); } };
    child.on('message', onMessage); child.send({ type: 'busy?', id });
  });
  await git(repo, 'init', '-q', '-b', 'main');
  return { origin, cookie, api, repo, busy, projectId: (await api('project/open', { path: repo })).id };
}

// Shells start helpers and prompts for a moment, so a state is waited for rather than read once.
async function until(read, expected, what) {
  let last;
  for (let attempt = 0; attempt < 60; attempt++) { last = await read(); if (last.busy === expected) return last; await wait(500); }
  assert.fail(`${what}: last answer ${JSON.stringify(last)}`);
}

test('the server tells the updater whether a restart would cut something off', { timeout: 120_000 }, async t => {
  const { origin, cookie, api, busy, projectId } = await boot(t);
  assert.deepEqual(await busy(), { type: 'busy', id: 1, busy: false, reasons: [] }, 'no terminals, nothing to cut off');

  const terminal = await api('terminal/open', { projectId });
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { Origin: origin, Cookie: cookie } });
  t.after(() => ws.close());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'subscribe', projectId }));
  await until(busy, false, 'an idle shell is not busy');

  ws.send(JSON.stringify({ type: 'terminal/input', projectId, id: terminal.id, data: `${runNode} -e "setTimeout(function(){},120000)"\r` }));
  const running = await until(busy, true, 'a command running in the shell is busy');
  assert.equal(running.reasons.length, 1);
  assert.equal(running.reasons[0].kind, 'command');
  assert.match(running.reasons[0].detail, /^node/i);

  ws.send(JSON.stringify({ type: 'terminal/input', projectId, id: terminal.id, data: '\x03' }));
  await until(busy, false, 'the shell is idle again once the command is interrupted');
});
