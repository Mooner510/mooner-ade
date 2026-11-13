import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { newEndpoint } from '../apps/desktop/src/pty-host-files.js';
import { helloPtyHost, ptyHostControl } from '../apps/local-server/src/pty-client.js';

// The auto-updater asks the server over IPC what a restart would cut off. This runs the real server with a real terminal.
const runNode = `${process.platform === 'win32' ? '& ' : ''}"${process.execPath}"`;
const WebSocket = createRequire(new URL('../apps/local-server/package.json', import.meta.url))('ws');
const git = (cwd, ...args) => new Promise((resolve, reject) => spawn('git', args, { cwd, stdio: 'ignore' }).on('exit', code => code ? reject(new Error(`git ${args}`)) : resolve()));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function boot(t, { pty = { endpoint: '', token: '' }, data: shared, repo: sharedRepo } = {}) {
  const data = shared ?? await mkdtemp(join(tmpdir(), 'ade-data-')), repo = sharedRepo ?? await realpath(await mkdtemp(join(tmpdir(), 'ade-repo-')));
  const child = spawn(process.execPath, ['apps/local-server/src/index.js'], { env: { ...process.env, ADE_PORT: '0', ADE_DATA_DIR: data, ADE_PTY_ENDPOINT: pty.endpoint, ADE_PTY_TOKEN: pty.token }, stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.send({ type: 'shutdown' }); await exited;
    }
  };
  t.after(async () => {
    await stop();
    if (shared) return;
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
  if (!sharedRepo) await git(repo, 'init', '-q', '-b', 'main');
  return { origin, cookie, api, repo, data, busy, stop, projectId: (await api('project/open', { path: repo })).id };
}

// Shells start helpers and prompts for a moment, so a state is waited for rather than read once.
async function until(read, expected, what, accept = () => true) {
  let last;
  for (let attempt = 0; attempt < 60; attempt++) { last = await read(); if (last.busy === expected && accept(last)) return last; await wait(500); }
  assert.fail(`${what}: last answer ${JSON.stringify(last)}`);
}

test('the server tells the updater whether a restart would cut something off', { timeout: 120_000 }, async t => {
  const { origin, cookie, api, busy, projectId } = await boot(t);
  assert.deepEqual(await busy(), { type: 'busy', id: 1, busy: false, keepsTerminals: false, keepsChats: false, live: { terminals: 0, chats: 0, answering: 0 }, reasons: [] }, 'no terminals, nothing to cut off');

  const terminal = await api('terminal/open', { projectId });
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { Origin: origin, Cookie: cookie } });
  t.after(() => ws.close());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'subscribe', projectId }));
  await until(busy, false, 'an idle shell is not busy');

  ws.send(JSON.stringify({ type: 'terminal/input', projectId, id: terminal.id, data: `${runNode} -e "setTimeout(function(){},120000)"\r` }));
  // The user's own shell startup may keep a helper (zsh) under the prompt for a while; the reason that matters is the node command itself.
  const running = await until(busy, true, 'a command running in the shell is busy', answer => answer.reasons.length === 1 && /^node/i.test(answer.reasons[0].detail ?? ''));
  assert.equal(running.reasons.length, 1);
  assert.equal(running.reasons[0].kind, 'command');
  assert.match(running.reasons[0].detail, /^node/i);

  ws.send(JSON.stringify({ type: 'terminal/input', projectId, id: terminal.id, data: '\x03' }));
  await until(busy, false, 'the shell is idle again once the command is interrupted');
});

// What an update restart does with the pty-host: the server goes, the host keeps the terminal, a new server takes it over.
test('a terminal in the pty-host outlives the server, and the next server takes it over under the same id', { timeout: 180_000 }, async t => {
  const endpoint = newEndpoint(), token = randomBytes(16).toString('hex');
  const host = spawn(process.execPath, [resolve('apps/local-server/src/pty-host.js')], { env: { ...process.env, ADE_PTY_ENDPOINT: endpoint, ADE_PTY_TOKEN: token }, stdio: 'ignore' });
  const hostExit = new Promise(done => host.once('exit', done));
  t.after(async () => { if (host.exitCode === null) { await ptyHostControl({ endpoint, token }, { op: 'shutdown' }).catch(() => host.kill()); await hostExit; } });
  for (let attempt = 0; ; attempt++) {
    try { const { socket } = await helloPtyHost({ endpoint, token, role: 'control', timeoutMs: 1000 }); socket.destroy(); break; }
    catch (error) { if (attempt > 100) throw error; await wait(100); }
  }

  const first = await boot(t, { pty: { endpoint, token } });
  const terminal = await first.api('terminal/open', { projectId: first.projectId });
  const ws = new WebSocket(`${first.origin.replace('http', 'ws')}/ws`, { headers: { Origin: first.origin, Cookie: first.cookie } });
  await new Promise((done, fail) => { ws.once('open', done); ws.once('error', fail); });
  let printed = '';
  ws.on('message', raw => { const message = JSON.parse(String(raw)); if (message.id === terminal.id && typeof message.data === 'string') printed += message.data; });
  ws.send(JSON.stringify({ type: 'subscribe', projectId: first.projectId }));
  // The prompt, not an idle report: a shell profile may keep its own helpers running for a while on a loaded machine.
  for (let attempt = 0; attempt < 120 && !/>\s*$/m.test(printed); attempt++) await wait(500);
  ws.send(JSON.stringify({ type: 'terminal/input', projectId: first.projectId, id: terminal.id, data: `${runNode} -e "let n=0;setInterval(function(){console.log('still-'+(n++))},300)"\r` }));
  // A running command no longer holds the update back: it is reported, marked as kept.
  let report;
  const isNode = item => item.kind === 'command' && /^node/i.test(item.detail);
  for (let attempt = 0; attempt < 120; attempt++) { report = await first.busy(); if (report.reasons.some(isNode)) break; await wait(500); }
  assert.equal(report.keepsTerminals, true);
  assert.equal(report.reasons.find(isNode)?.keeps, true, JSON.stringify(report));
  ws.close();

  await ptyHostControl({ endpoint, token }, { op: 'linger', ms: 60_000 });
  await first.stop();
  await wait(1500); // the update's restart gap

  const second = await boot(t, { pty: { endpoint, token }, data: first.data, repo: first.repo });
  const opened = await second.api('project/open', { path: first.repo });
  const kept = opened.terminals.find(item => item.id === terminal.id);
  assert.ok(kept && !kept.exited, `the terminal is back under its id: ${JSON.stringify(opened.terminals)}`);
  const ws2 = new WebSocket(`${second.origin.replace('http', 'ws')}/ws`, { headers: { Origin: second.origin, Cookie: second.cookie } });
  t.after(() => ws2.close());
  await new Promise((done, fail) => { ws2.once('open', done); ws2.once('error', fail); });
  const seen = [];
  ws2.on('message', raw => { const message = JSON.parse(String(raw)); if (message.type === 'terminal' && message.id === terminal.id) seen.push(message.data); else if (message.type === 'terminal/replay' || message.type === 'subscribed') seen.push(JSON.stringify(message)); });
  ws2.send(JSON.stringify({ type: 'subscribe', projectId: opened.id }));
  for (let attempt = 0; attempt < 40 && !/still-\d+/.test(seen.join('')); attempt++) await wait(250);
  assert.match(seen.join(''), /still-\d+/, 'output from the command that kept running');
});
