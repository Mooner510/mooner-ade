import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { connectPtyHost, helloPtyHost, ptyHostControl } from '../apps/local-server/src/pty-client.js';
import { PTY_PROTOCOL } from '../apps/local-server/src/pty-protocol.js';
import { HOST_SOURCES, clearRendezvous, markHostCopy, newEndpoint, prepareHostCopy, processAlive, readRendezvous, sweepHostCopies, writeRendezvous } from '../apps/desktop/src/pty-host-files.js';

// The pty-host keeps terminals alive apart from the server and the app (an update restart). These run the real host with real PTYs.
const serverSrc = path.resolve('apps/local-server/src');
const nodePtyDir = path.dirname(createRequire(path.join(serverSrc, 'index.js')).resolve('node-pty/package.json'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// A terminal program that prints a counter every 100 ms and never ends by itself.
const ticker = ['-e', 'let n=0;setInterval(()=>process.stdout.write(`tick${n++} `),100)'];

function startHost(t, { entry = path.join(serverSrc, 'pty-host.js'), node = process.execPath, env = {} } = {}) {
  const endpoint = newEndpoint(), token = randomBytes(16).toString('hex');
  const child = spawn(node, [entry], { env: { ...process.env, ADE_PTY_ENDPOINT: endpoint, ADE_PTY_TOKEN: token, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = ''; child.stderr.on('data', chunk => { log += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) { child.kill(); await exited; } });
  const host = { endpoint, token, child, exited, log: () => log };
  host.ready = (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { const { socket } = await helloPtyHost({ endpoint, token, role: 'control', timeoutMs: 1000 }); socket.destroy(); return; } catch { await wait(100); }
    }
    throw new Error(`host did not start: ${log}`);
  })();
  return host;
}
const exitsWithin = (host, ms) => Promise.race([host.exited.then(() => true), wait(ms).then(() => false)]);
async function spawnTicker(owner) {
  const terminal = await owner.factory.spawn(process.execPath, ticker, { cols: 80, rows: 24, cwd: os.tmpdir(), env: process.env, meta: { projectId: 'p', id: 't1', cwd: os.tmpdir() } });
  let output = '';
  terminal.onData(data => { output += data; });
  return { terminal, output: () => output };
}

test('terminals keep running without an owner and come back with what they printed meanwhile', { timeout: 60_000 }, async t => {
  const host = startHost(t, { env: { ADE_PTY_LINGER_MS: '20000' } });
  await host.ready;
  const first = await connectPtyHost(host);
  assert.equal(first.hello.protocol, PTY_PROTOCOL);
  const { terminal, output } = await spawnTicker(first);
  for (let attempt = 0; attempt < 50 && !output().includes('tick3'); attempt++) await wait(100);
  assert.match(output(), /tick3/);
  terminal.resize(90, 30);
  first.close();
  await wait(800); // output goes on with nobody listening

  const second = await connectPtyHost(host);
  assert.equal(second.hello.terminals, 1);
  const [item] = await second.list();
  assert.deepEqual(item.meta, { projectId: 'p', id: 't1', cwd: os.tmpdir() });
  assert.equal(item.pid, terminal.pid);
  const adopted = await second.attach(item.key);
  assert.deepEqual(adopted.size, { cols: 90, rows: 30 }, 'the next server learns the size the terminal is drawn at');
  const last = Number(/tick(\d+) $/.exec(adopted.initial)?.[1]);
  assert.ok(last >= 8, `replay holds what was printed while detached: ${adopted.initial.slice(-80)}`);
  let more = '';
  adopted.onData(data => { more += data; });
  for (let attempt = 0; attempt < 30 && !more.includes(`tick${last + 2}`); attempt++) await wait(100);
  assert.match(more, new RegExp(`tick${last + 1} `), 'and it continues live without a gap');
  second.close();
});

test('a control link sets the linger time without taking the terminals, and the host ends them once it runs out', { timeout: 60_000 }, async t => {
  const host = startHost(t);
  await host.ready;
  const owner = await connectPtyHost(host);
  const { output } = await spawnTicker(owner);
  const control = await ptyHostControl(host, { op: 'linger', ms: 1500 });
  assert.equal(control.ok, true);
  assert.equal(control.hello.terminals, 1);
  const before = output().length;
  await wait(400);
  assert.ok(output().length > before, 'the owner still gets output after a control link came and went');
  owner.close();
  assert.equal(await exitsWithin(host, 800), false, 'kept for the linger time');
  assert.equal(await exitsWithin(host, 5000), true, 'then ended');
  assert.match(host.log(), /다시 연결되지 않음/);
});

// A chat agent stand-in: answers each stdin line with a JSON line and prints a tick line every 100 ms.
const echo = ['-e', "let n=0;setInterval(()=>console.log(JSON.stringify({tick:n++})),100);process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);console.log(JSON.stringify({echo:l}));if(l==='bye')process.exit(3)}})"];
function collect(proc) {
  const seen = []; let buffer = '';
  proc.stdout.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { seen.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); } });
  return seen;
}
const until = async (check, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end && !check();) await wait(50); assert.ok(check()); };

test('a piped process outlives its server and the next one reads on from the exact line the last one stopped at', { timeout: 60_000 }, async t => {
  const host = startHost(t, { env: { ADE_PTY_LINGER_MS: '20000' } });
  await host.ready;
  const first = await connectPtyHost(host);
  assert.equal(first.procs, true);
  const proc = first.spawnProc(process.execPath, echo, { cwd: os.tmpdir(), env: process.env, meta: { chatId: 'c1', projectId: 'p' } });
  await new Promise((resolve, reject) => { proc.once('spawn', resolve); proc.once('error', reject); });
  const seen = collect(proc);
  proc.stdin.write('hello\n');
  await until(() => seen.some(item => item.echo === 'hello') && seen.filter(item => 'tick' in item).length >= 3);
  const stopped = proc.lastLine;
  proc.detach(); first.close();
  await wait(600); // ticks go on with nobody reading

  const second = await connectPtyHost(host);
  assert.equal(second.hello.procs, 1);
  const [item] = await second.listProcs();
  assert.deepEqual(item.meta, { chatId: 'c1', projectId: 'p' });
  const again = await second.attachProc(item.key, stopped);
  assert.equal(again.missing, false);
  const more = collect(again);
  again.stdin.write('bye\n');
  const closed = new Promise(resolve => again.once('close', (code, signal) => resolve({ code, signal })));
  assert.deepEqual(await closed, { code: 3, signal: null });
  const ticks = [...seen, ...more].filter(entry => 'tick' in entry).map(entry => entry.tick);
  assert.deepEqual(ticks, ticks.map((_, index) => index), 'every tick exactly once, none lost while nobody read');
  assert.ok(more.some(entry => entry.echo === 'bye'), 'stdin reaches it after the takeover');
  assert.ok(more.length >= 5, 'what it printed meanwhile was kept');
  await assert.rejects(second.attachProc('nope'), /failed/);
  second.close();
});

test('lines the previous server acknowledged are gone, and a takeover from before them says so', { timeout: 60_000 }, async t => {
  const host = startHost(t, { env: { ADE_PTY_LINGER_MS: '20000' } });
  await host.ready;
  const owner = await connectPtyHost(host);
  const proc = owner.spawnProc(process.execPath, echo, { cwd: os.tmpdir(), env: process.env, meta: {} });
  const seen = collect(proc);
  await until(() => seen.length >= 3);
  proc.detach(); owner.close();
  const next = await connectPtyHost(host);
  const [item] = await next.listProcs();
  const again = await next.attachProc(item.key, 0);
  assert.equal(again.missing, true);
  again.kill();
  await new Promise(resolve => again.once('close', resolve));
  next.close();
});

test('a spawn that fails reports the error, and linger 0 keeps processes until an owner comes back', { timeout: 60_000 }, async t => {
  const host = startHost(t, { env: { ADE_PTY_LINGER_MS: '500' } });
  await host.ready;
  const owner = await connectPtyHost(host);
  const bad = owner.spawnProc(path.join(os.tmpdir(), 'no-such-agent-binary'), [], { cwd: os.tmpdir(), env: process.env });
  const error = await new Promise(resolve => { bad.once('error', resolve); bad.once('spawn', () => resolve(null)); });
  assert.equal(error?.code, 'ENOENT');
  const proc = owner.spawnProc(process.execPath, echo, { cwd: os.tmpdir(), env: process.env, meta: {} });
  await new Promise(resolve => proc.once('spawn', resolve));
  assert.equal((await ptyHostControl(host, { op: 'linger', ms: 0 })).ok, true);
  proc.detach(); owner.close();
  assert.equal(await exitsWithin(host, 1500), false, 'no time limit');
  assert.equal(processAlive(proc.pid), true);
  assert.equal((await ptyHostControl(host, { op: 'shutdown' })).ok, true);
  assert.equal(await exitsWithin(host, 5000), true);
  for (let attempt = 0; attempt < 30 && processAlive(proc.pid); attempt++) await wait(100);
  assert.equal(processAlive(proc.pid), false, 'shutdown ends it');
});

test('shutdown ends the terminals at once, and a host without terminals or owner exits', { timeout: 60_000 }, async t => {
  const host = startHost(t);
  await host.ready;
  const owner = await connectPtyHost(host);
  const { terminal } = await spawnTicker(owner);
  assert.equal(processAlive(terminal.pid), true);
  const result = await ptyHostControl(host, { op: 'shutdown', reason: 'test' });
  assert.equal(result.ok, true);
  assert.equal(await exitsWithin(host, 5000), true);
  for (let attempt = 0; attempt < 30 && processAlive(terminal.pid); attempt++) await wait(100);
  assert.equal(processAlive(terminal.pid), false, 'the terminal program ended with the host');

  const empty = startHost(t);
  await empty.ready;
  (await connectPtyHost(empty)).close();
  assert.equal(await exitsWithin(empty, 5000), true, 'nothing to keep');

  const unused = startHost(t, { env: { ADE_PTY_FIRST_OWNER_MS: '500' } });
  await unused.ready;
  assert.equal(await exitsWithin(unused, 5000), true, 'nobody ever came');
});

test('a new owner replaces the old one; a wrong token or an old host is refused', { timeout: 60_000 }, async t => {
  const host = startHost(t);
  await host.ready;
  const first = await connectPtyHost(host);
  let closed = false; first.onClose(() => { closed = true; });
  const second = await connectPtyHost(host);
  for (let attempt = 0; attempt < 20 && !closed; attempt++) await wait(50);
  assert.equal(closed, true);
  await assert.rejects(first.list(), /disconnected/);
  await assert.rejects(helloPtyHost({ endpoint: host.endpoint, token: 'nope', timeoutMs: 2000 }), error => error.code === 'PTY_INCOMPATIBLE');
  second.close();

  // A protocol 1 host never answered the hello; another version answers with its number.
  for (const answer of [null, { ev: 'hello', protocol: 1 }]) {
    const endpoint = newEndpoint();
    const fake = net.createServer(socket => { socket.on('error', () => {}); if (answer) socket.write(`${JSON.stringify(answer)}\n`); });
    await new Promise(resolve => fake.listen(endpoint, resolve));
    t.after(() => fake.close());
    await assert.rejects(helloPtyHost({ endpoint, token: 'x', timeoutMs: 1000 }), error => error.code === 'PTY_INCOMPATIBLE');
  }
});

test('the host imports only the sources that are copied for it', () => {
  const seen = new Set(), visit = name => {
    if (seen.has(name)) return; seen.add(name);
    for (const [, spec] of fs.readFileSync(path.join(serverSrc, name), 'utf8').matchAll(/^import [^'"]*['"]([^'"]+)['"]/gm)) {
      if (spec.startsWith('./')) visit(spec.slice(2));
      else assert.match(spec, /^(node:|node-pty$)/, `${name} imports ${spec}, which the host copy does not have`);
    }
  };
  visit('pty-host.js');
  assert.deepEqual([...seen].sort(), [...HOST_SOURCES].sort());
});

test('the host runs from its own copy outside the install folder, made once per content', { timeout: 120_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-pty-copy-'));
  // The host goes first (hooks run in order), or the removal would get halfway through the copy it runs from.
  let host;
  t.after(async () => {
    if (host && host.child.exitCode === null) { host.child.kill(); await host.exited; }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  const copy = prepareHostCopy({ root, serverSrc, nodePtyDir, nodeBinary: process.execPath });
  assert.ok(copy.dir.startsWith(root));
  assert.ok(fs.existsSync(copy.node) && fs.existsSync(copy.entry));
  assert.ok(!fs.existsSync(path.join(copy.dir, 'node_modules/node-pty/src')), 'node-pty sources are left out');
  const marker = path.join(copy.dir, 'marker');
  fs.writeFileSync(marker, '');
  assert.equal(prepareHostCopy({ root, serverSrc, nodePtyDir, nodeBinary: process.execPath }).dir, copy.dir);
  assert.ok(fs.existsSync(marker), 'the same content reuses the copy');

  // The copy works on its own: its Node, its sources and its node-pty start a real terminal.
  host = startHost(t, { entry: copy.entry, node: copy.node });
  markHostCopy(copy.dir, host.child.pid);
  await host.ready;
  const owner = await connectPtyHost(host);
  const { output } = await spawnTicker(owner);
  for (let attempt = 0; attempt < 50 && !output().includes('tick2'); attempt++) await wait(100);
  assert.match(output(), /tick2/, host.log());
  sweepHostCopies(root, []);
  assert.ok(fs.existsSync(copy.entry) && fs.existsSync(copy.node), 'a copy a host still runs from is left whole');
  await ptyHostControl(host, { op: 'shutdown' });
  await host.exited;

  fs.mkdirSync(path.join(root, 'old-copy'));
  sweepHostCopies(root, [copy.key]);
  assert.ok(!fs.existsSync(path.join(root, 'old-copy')));
  assert.ok(fs.existsSync(copy.dir));
  sweepHostCopies(root, []);
  assert.ok(!fs.existsSync(copy.dir), 'and once its host is gone, it goes too');
});

test('the rendezvous file is read back, ignored when broken, and cleared only for its own host', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-pty-rv-'));
  try {
    assert.equal(readRendezvous(root), null);
    writeRendezvous(root, { protocol: 2, endpoint: 'e', token: 't', pid: 42, key: 'k' });
    assert.equal(readRendezvous(root).pid, 42);
    if (process.platform === 'win32') {
      // icacls prints "<file> <holder>:<rights>" lines; an inherited entry is marked (I).
      const acl = execFileSync('icacls', [path.join(root, 'pty-host.json')], { encoding: 'utf8' });
      const holders = [...acl.matchAll(/([^\s\\]+):\(/g)].map(match => match[1]);
      assert.deepEqual(holders, [os.userInfo().username], acl);
      assert.doesNotMatch(acl, /\(I\)/, 'nothing inherited from the folder');
    }
    clearRendezvous(root, 7);
    assert.equal(readRendezvous(root).pid, 42, 'another host left it alone');
    clearRendezvous(root, 42);
    assert.equal(readRendezvous(root), null);
    fs.writeFileSync(path.join(root, 'pty-host.json'), '{"endpoint":1}');
    assert.equal(readRendezvous(root), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
