// The server side of plugin workspace sessions: what the app relays over IPC for a plugin that declared `workspace`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function boot(t) {
  const data = await mkdtemp(join(tmpdir(), 'ade-data-')), folder = await realpath(await mkdtemp(join(tmpdir(), 'ade-project-')));
  const child = spawn(process.execPath, ['apps/local-server/src/index.js'], { env: { ...process.env, ADE_PORT: '0', ADE_DATA_DIR: data, ADE_PTY_ENDPOINT: '', ADE_PTY_TOKEN: '' }, stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  const messages = [];
  child.on('message', message => messages.push(message));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); await exited;
    }
    const removal = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
    await rm(data, removal); await rm(folder, removal);
  });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', () => reject(new Error('server exited'))); });
  const send = (op, extra = {}) => child.send({ type: 'plugin/workspace', plugin: 'example', op, ...extra });
  const until = async (predicate, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const index = messages.findIndex(predicate); if (index >= 0) return messages.splice(index, 1)[0]; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('timeout');
  };
  let ids = 0;
  const api = async (session, action, input = {}) => {
    const id = ++ids;
    send('api', { session, id, action, input });
    const reply = await until(message => message.type === 'plugin/workspace' && message.op === 'api-result' && message.id === id);
    assert.equal(reply.plugin, 'example'); assert.equal(reply.session, session);
    return reply;
  };
  const received = (session, predicate) => until(message => message.type === 'plugin/workspace' && message.op === 'message' && message.session === session && predicate(JSON.parse(message.text)));
  const busy = async () => { child.send({ type: 'busy?', id: 1 }); return until(message => message.type === 'busy'); };
  return { child, folder, messages, send, until, api, received, busy };
}

test('a plugin session lists projects, opens a terminal, types into it and reads its output', async t => {
  const { folder, send, until, api, received, busy } = await boot(t);
  assert.equal((await api('s1', 'recent')).error.code, 'NOT_FOUND'); // no session yet
  send('open', { session: 's1' });
  const opened = await api('s1', 'project/open', { path: folder });
  assert.equal(opened.ok, true, JSON.stringify(opened.error));
  const projectId = opened.value.id;
  assert.ok((await api('s1', 'recent')).value.some(item => item.root === folder));
  assert.ok((await api('s1', 'app/state')).ok);
  assert.equal((await api('s1', 'no/such-action', {})).ok, false);
  send('send', { session: 's1', message: { type: 'subscribe', projectId } });
  await received('s1', message => message.type === 'snapshot' && message.projectId === projectId);
  // The open session counts as work an app restart would cut off.
  assert.ok((await busy()).reasons.some(reason => reason.kind === 'plugin' && reason.terminal === 'example'));

  const readiness = await api('s1', 'readiness', { projectId });
  if (readiness.value?.pty?.installed) {
    const terminal = await api('s1', 'terminal/open', { projectId });
    assert.equal(terminal.ok, true, JSON.stringify(terminal.error));
    send('send', { session: 's1', message: { type: 'terminal/input', projectId, id: terminal.value.id, data: process.platform === 'win32' ? 'echo ade-$(20+22)\r' : 'echo ade-$((20+22))\n' } });
    await received('s1', message => message.type === 'terminal' && message.id === terminal.value.id && message.data.includes('ade-42'));
    await api('s1', 'terminal/close', { projectId, id: terminal.value.id });
  } else t.diagnostic('node-pty unavailable; terminal checks skipped');

  send('close', { session: 's1' });
  await until(message => message.op === 'closed' && message.session === 's1');
  assert.equal((await busy()).reasons.filter(reason => reason.kind === 'plugin').length, 0);
});

test('sessions are limited per plugin and close-all ends every session of that plugin', async t => {
  const { send, until, api, messages } = await boot(t);
  for (let index = 0; index < 17; index++) send('open', { session: `s${index}` });
  await until(message => message.op === 'closed' && message.session === 's16');
  assert.equal((await api('s0', 'app/state')).ok, true);
  // Opening an open session again changes nothing.
  send('open', { session: 's0' });
  assert.equal((await api('s0', 'app/state')).ok, true);
  assert.ok(!messages.some(message => message.op === 'closed' && message.session === 's0'));
  // Malformed requests are dropped.
  send('open', { session: '../x' });
  send('open', { session: 's-bad', plugin: 'Bad Id' });
  send('close-all');
  for (let index = 0; index < 16; index++) await until(message => message.op === 'closed' && message.session === `s${index}`);
  assert.equal((await api('s0', 'app/state')).error.code, 'NOT_FOUND');
});

test('a plugin can open at most 8 terminals', async t => {
  const { folder, send, api } = await boot(t);
  send('open', { session: 'main' });
  const { value: project } = await api('main', 'project/open', { path: folder });
  const readiness = await api('main', 'readiness', { projectId: project.id });
  if (!readiness.value?.pty?.installed) { t.skip('node-pty unavailable'); return; }
  const opened = [];
  for (let index = 0; index < 8; index++) {
    const result = await api('main', 'terminal/open', { projectId: project.id });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    opened.push(result.value.id);
  }
  assert.equal((await api('main', 'terminal/open', { projectId: project.id })).error.code, 'TERMINAL_LIMIT');
  await api('main', 'terminal/close', { projectId: project.id, id: opened[0] });
  const again = await api('main', 'terminal/open', { projectId: project.id });
  assert.equal(again.ok, true, JSON.stringify(again.error));
  for (const id of [...opened.slice(1), again.value.id]) await api('main', 'terminal/close', { projectId: project.id, id });
});
