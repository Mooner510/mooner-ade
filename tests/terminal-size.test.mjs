// One PTY, several viewers: the PTY size follows the viewer that typed last, and every viewer is told the real size.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTerminalSize, typedInput, validSize } from '../apps/local-server/src/terminal-size.js';

const WebSocket = createRequire(new URL('../apps/local-server/package.json', import.meta.url))('ws');

function fake(size = { cols: 100, rows: 28 }) {
  const calls = [], changes = [];
  const native = { resize: (cols, rows) => calls.push(['resize', cols, rows]), write: data => calls.push(['write', data]) };
  return { calls, changes, native, sizing: createTerminalSize(native, size, value => changes.push(value)) };
}

test('the first viewer to report a size takes it; another viewer\'s size is kept for later, not applied', () => {
  const { calls, changes, sizing } = fake();
  const desk = {}, phone = {};
  sizing.want(desk, 120, 40);
  assert.equal(sizing.owner, desk);
  sizing.want(phone, 50, 30);
  assert.deepEqual(calls, [['resize', 120, 40]]);
  assert.deepEqual(changes, [{ cols: 120, rows: 40 }]);
  assert.deepEqual(sizing.size, { cols: 120, rows: 40 });
  // The owner's own changes apply at once.
  sizing.want(desk, 110, 40);
  assert.deepEqual(sizing.size, { cols: 110, rows: 40 });
  assert.equal(sizing.owner, desk);
});

test('typing from another viewer switches the PTY to its size before the input is written', () => {
  const { calls, changes, native, sizing } = fake();
  const desk = {}, phone = {};
  sizing.want(desk, 120, 40); sizing.want(phone, 50, 30);
  const type = (client, data) => { sizing.input(client); native.write(data); };
  type(phone, 'ls\r');
  assert.equal(sizing.owner, phone);
  assert.deepEqual(calls.slice(-2), [['resize', 50, 30], ['write', 'ls\r']]);
  // More typing from the owner changes nothing; typing back on the desktop switches back.
  type(phone, 'x');
  type(desk, 'y');
  assert.deepEqual(calls.slice(-4), [['write', 'ls\r'], ['write', 'x'], ['resize', 120, 40], ['write', 'y']]);
  assert.deepEqual(changes, [{ cols: 120, rows: 40 }, { cols: 50, rows: 30 }, { cols: 120, rows: 40 }]);
});

test('a viewer without a reported size takes ownership by typing but leaves the size alone; the same size is never re-sent', () => {
  const { calls, changes, sizing } = fake();
  const desk = {}, plain = {}, same = {};
  sizing.want(desk, 120, 40);
  sizing.input(plain);
  assert.equal(sizing.owner, plain);
  assert.deepEqual(sizing.size, { cols: 120, rows: 40 });
  sizing.want(same, 120, 40); sizing.input(same);
  assert.equal(sizing.owner, same);
  assert.deepEqual(calls, [['resize', 120, 40]]);
  assert.equal(changes.length, 1);
});

test('the owner leaving frees the size (which stays); the next report applies. claim takes it outright', () => {
  const { changes, sizing } = fake();
  const desk = {}, phone = {};
  sizing.want(desk, 120, 40); sizing.want(phone, 50, 30); sizing.input(phone);
  sizing.release(phone);
  assert.equal(sizing.owner, null);
  assert.deepEqual(sizing.size, { cols: 50, rows: 30 });
  // A released viewer's stored wish is gone: typing again later takes ownership without a resize.
  sizing.input(phone);
  assert.deepEqual(sizing.size, { cols: 50, rows: 30 });
  sizing.want(desk, 121, 40);
  assert.deepEqual(sizing.size, { cols: 50, rows: 30 }, 'the phone owns it again');
  sizing.want(desk, 121, 40, true);
  assert.equal(sizing.owner, desk);
  assert.deepEqual(changes.at(-1), { cols: 121, rows: 40 });
});

test('an unknown size (a terminal from an older keeper) becomes known with the first applied report', () => {
  const { calls, sizing } = fake(null);
  assert.equal(sizing.size, null);
  sizing.want({}, 80, 24);
  assert.deepEqual(calls, [['resize', 80, 24]]);
  assert.deepEqual(sizing.size, { cols: 80, rows: 24 });
  assert.equal(validSize({ cols: 0, rows: 5 }), null);
  assert.equal(validSize({ cols: 80.5, rows: 5 }), null);
  assert.equal(validSize(undefined), null);
  assert.deepEqual(validSize({ cols: 1000, rows: 1, extra: 1 }), { cols: 1000, rows: 1 });
});

test('answers a view sends on its own (query replies, focus, bare mouse movement) do not count as typing', () => {
  for (const data of ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[12;40R', '\x1b[0n', '\x1b[?2004;1$y', '\x1b[?0u', '\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1b]10;rgb:ffff/ffff/ffff\x07', '\x1bP1$r0m\x1b\\', '\x1b[I', '\x1b[O', '\x1b[<35;10;5M', '\x1b[I\x1b[12;40R'])
    assert.equal(typedInput(data), false, JSON.stringify(data));
  for (const data of ['a', 'ls\r', '\r', '\x03', '\x1b[A', '\x1b\r', '\x1b[200~text\x1b[201~', '\x1b[<0;10;5M', '\x1b[<64;10;5M', '\x1b[I' + 'x'])
    assert.equal(typedInput(data), true, JSON.stringify(data));
});

// Through the real server: the window's socket, a second socket, and a plugin workspace session are separate viewers.
async function boot(t) {
  const data = await mkdtemp(join(tmpdir(), 'ade-data-')), folder = await realpath(await mkdtemp(join(tmpdir(), 'ade-project-')));
  const child = spawn(process.execPath, ['apps/local-server/src/index.js'], { env: { ...process.env, ADE_PORT: '0', ADE_DATA_DIR: data, ADE_PTY_ENDPOINT: '', ADE_PTY_TOKEN: '' }, stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  const ipc = [];
  child.on('message', message => ipc.push(message));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); await exited;
    }
    const removal = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };
    await rm(data, removal); await rm(folder, removal);
  });
  const line = await new Promise((resolve, reject) => { child.stdout.once('data', chunk => resolve(String(chunk))); child.once('exit', () => reject(new Error('server exited'))); });
  const [, origin, token] = /(http:\/\/127\.0\.0\.1:\d+)\/#token=(\w+)/.exec(line);
  const auth = await fetch(`${origin}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const api = async (action, body = {}) => (await fetch(`${origin}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) })).json();
  const project = await api('project/open', { path: folder });
  const wait = async (list, predicate, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const found = list.find(predicate); if (found) return found; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('timeout');
  };
  const connect = async () => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { Origin: origin, Cookie: cookie } }), messages = [];
    t.after(() => ws.close());
    ws.on('message', raw => messages.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const send = value => ws.send(JSON.stringify({ projectId: project.id, ...value }));
    send({ type: 'subscribe' });
    await wait(messages, message => message.type === 'snapshot');
    return { ws, messages, send, until: (predicate, ms) => wait(messages, predicate, ms) };
  };
  // A plugin workspace session, as the app relays it for a phone.
  const session = async name => {
    const messages = [];
    child.send({ type: 'plugin/workspace', plugin: 'example', op: 'open', session: name });
    const send = value => child.send({ type: 'plugin/workspace', plugin: 'example', op: 'send', session: name, message: { projectId: project.id, ...value } });
    const pump = setInterval(() => {
      for (let index = ipc.length - 1; index >= 0; index--) if (ipc[index].op === 'message' && ipc[index].session === name) messages.push(JSON.parse(ipc.splice(index, 1)[0].text));
    }, 10);
    t.after(() => clearInterval(pump));
    send({ type: 'subscribe' });
    await wait(messages, message => message.type === 'snapshot');
    return { messages, send, close: () => child.send({ type: 'plugin/workspace', plugin: 'example', op: 'close', session: name }), until: (predicate, ms) => wait(messages, predicate, ms) };
  };
  return { api, projectId: project.id, connect, session };
}

test('server: sizes are shared with every viewer, follow the last typist, and reach late subscribers', { timeout: 120_000 }, async t => {
  const { api, projectId, connect, session } = await boot(t);
  if (!(await api('readiness', { projectId })).pty?.installed) return t.skip('node-pty unavailable');
  const desk = await connect(), phone = await session('phone-1');
  const { id } = await api('terminal/open', { projectId });
  const sizes = list => list.filter(message => message.type === 'terminal/size' && message.id === id).map(({ cols, rows }) => `${cols}x${rows}`);
  const settle = () => new Promise(resolve => setTimeout(resolve, 300));
  // A new terminal announces the size it starts at, so a first report of that same size still leaves everyone knowing it.
  await phone.until(message => message.type === 'terminal/size' && message.id === id && message.cols === 100 && message.rows === 28);

  // The window reports first and owns the size; both viewers hear it.
  desk.send({ type: 'terminal/resize', id, cols: 120, rows: 40 });
  await desk.until(message => message.type === 'terminal/size' && message.id === id && message.cols === 120);
  await phone.until(message => message.type === 'terminal/size' && message.id === id && message.cols === 120);
  // The phone's own size is kept, not applied.
  phone.send({ type: 'terminal/resize', id, cols: 50, rows: 30 });
  await settle();
  assert.deepEqual(sizes(desk.messages), ['100x28', '120x40']);
  const listed = (await api('snapshot', { projectId })).terminals.find(item => item.id === id);
  assert.deepEqual([listed.cols, listed.rows], [120, 40]);

  // Typing on the phone switches the PTY to the phone's size first; the shell then sees it.
  const probe = process.platform === 'win32' ? 'Write-Output "size-$([Console]::WindowWidth)x$([Console]::WindowHeight)"\r' : 'echo "size-$(tput cols)x$(tput lines)"\n';
  phone.send({ type: 'terminal/input', id, data: probe });
  await desk.until(message => message.type === 'terminal/size' && message.id === id && message.cols === 50);
  await phone.until(message => message.type === 'terminal' && message.id === id && message.data.includes('size-50x30'), 20000);
  // A resize from the window while the phone owns the size is stored only, and nothing is broadcast.
  desk.send({ type: 'terminal/resize', id, cols: 130, rows: 40 });
  await settle();
  assert.deepEqual(sizes(desk.messages), ['100x28', '120x40', '50x30']);

  // A viewer that connects later learns the current size before the replay.
  const late = await connect();
  const lateSize = late.messages.findIndex(message => message.type === 'terminal/size' && message.id === id);
  assert.ok(lateSize >= 0, 'late subscriber gets the size');
  assert.deepEqual([late.messages[lateSize].cols, late.messages[lateSize].rows], [50, 30]);
  assert.ok(lateSize < late.messages.findIndex(message => message.type === 'terminal/replay' && message.id === id), 'size comes before the replay');
  assert.deepEqual(late.messages.find(message => message.type === 'snapshot').snapshot.terminals.find(item => item.id === id).cols, 50);

  // The phone leaves: the size stays, and the next report (the window's) applies without typing.
  phone.close();
  await settle();
  assert.deepEqual(sizes(desk.messages), ['100x28', '120x40', '50x30']);
  desk.send({ type: 'terminal/resize', id, cols: 130, rows: 41 });
  await desk.until(message => message.type === 'terminal/size' && message.id === id && message.cols === 130);

  // claim: the window takes the size back explicitly, even from an owner that is still there.
  const other = await connect();
  other.send({ type: 'terminal/resize', id, cols: 70, rows: 20 });
  other.send({ type: 'terminal/input', id, data: ' ' });
  await desk.until(message => message.type === 'terminal/size' && message.id === id && message.cols === 70);
  desk.send({ type: 'terminal/resize', id, cols: 130, rows: 41, claim: true });
  await other.until(message => message.type === 'terminal/size' && message.id === id && message.cols === 130);
  // A closed window socket frees ownership too.
  other.send({ type: 'terminal/input', id, data: ' ' });
  await desk.until(message => sizes(desk.messages).at(-1) === '70x20');
  other.ws.close();
  await settle();
  desk.send({ type: 'terminal/resize', id, cols: 131, rows: 41 });
  await desk.until(message => message.type === 'terminal/size' && message.id === id && message.cols === 131);
  assert.deepEqual(sizes(desk.messages), ['100x28', '120x40', '50x30', '130x41', '70x20', '130x41', '70x20', '131x41']);
  await api('terminal/close', { projectId, id });
});
