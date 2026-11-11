import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const BUS_DIR = path.resolve(import.meta.dirname, '../apps/desktop/builtin-plugins/agent-bus');

// An MCP client for mcp.mjs: what an agent's CLI does.
function mcpClient(args, env) {
  const child = spawn(process.execPath, [path.join(BUS_DIR, 'mcp.mjs'), '--stdio', ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  let next = 0;
  return {
    call: (method, params) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }),
    close: () => { child.stdin.end(); child.kill(); }
  };
}
const chatText = result => JSON.parse(result.result.content[0].text);

// The plugin process the way the app runs it: a Node child with an IPC channel. This test plays the app and the local server.
function spawnHost(t) {
  const child = fork(path.join(BUS_DIR, 'host.mjs'), [], { cwd: BUS_DIR, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }), log = [], waiters = [];
  child.on('message', message => {
    log.push(message);
    if (message.type === 'workspace' && message.op === 'api') {
      const reply = value => child.send({ type: 'workspace', op: 'api-result', session: 'bus', id: message.id, ok: true, value });
      if (message.action === 'chat/peers') reply([
        { id: 'claude-1', projectId: 'p1', project: 'proj', agent: 'claude', title: 'Backend', status: 'idle', cwd: 'C:\\w' },
        { id: 'codex-1', projectId: 'p1', project: 'proj', agent: 'codex', title: '', status: 'idle', cwd: 'C:\\w' }]);
      else if (message.action === 'chat/send') reply({});
    }
    for (const waiter of [...waiters]) if (waiter.test(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
  });
  const next = test => log.find(test) ?? new Promise(resolve => waiters.push({ test, resolve }));
  const act = (action, values) => new Promise(resolve => {
    const id = `a${Math.random()}`, listener = message => { if (message.type === 'action-result' && message.id === id) { child.off('message', listener); resolve(message); } };
    child.on('message', listener); child.send({ type: 'action', id, action, values });
  });
  t.after(() => child.kill());
  return { child, log, next, act, init: storage => child.send({ type: 'init', apiVersion: 1, id: 'agent-bus', appVersion: '0', dataDir: os.tmpdir(), storage }) };
}

test('the host serves the MCP server over loopback, reaches the chats through its workspace session and applies its settings', async t => {
  const host = spawnHost(t);
  host.init({ settings: { maxLength: 300 } });
  const offered = await host.next(message => message.type === 'terminal');
  await host.next(message => message.type === 'ready');
  assert.deepEqual([offered.autoApprove, offered.mcpArgs[0], offered.mcpArgs[2]], [true, '--port', '--token']);
  assert.equal(host.log.some(message => message.type === 'workspace'), false, 'no workspace session is held while nothing happens (an open one blocks app updates)');
  const saved = host.log.find(message => message.type === 'storage').value;
  assert.deepEqual([saved.settings.maxLength, saved.link.port, saved.link.token], [300, Number(offered.mcpArgs[1]), offered.mcpArgs[3]]);
  const view = (await host.next(message => message.type === 'view')).view;
  assert.equal(view.fields.find(field => field.key === 'maxLength').value, '300');
  assert.deepEqual(view.actions.map(action => action.id), ['save', 'reset', 'clear-log']);

  const client = mcpClient(offered.mcpArgs, { ADE_CHAT_ID: 'claude-1', ADE_PROJECT_ID: 'p1', ADE_CHAT_AGENT: 'claude' });
  t.after(() => client.close());
  await client.call('initialize', { protocolVersion: '2025-06-18' });
  const peers = chatText(await client.call('tools/call', { name: 'list_peers', arguments: {} }));
  assert.deepEqual([peers.you.title, peers.peers.map(peer => peer.id)], ['Backend', ['codex-1']]);
  assert.equal(host.log.filter(message => message.type === 'workspace' && message.op === 'open' && message.session === 'bus').length, 1, 'opened on the first call');
  const sent = chatText(await client.call('tools/call', { name: 'send_message', arguments: { to: 'codex', message: 'please review' } }));
  assert.equal(sent.results[0].status, 'delivered');
  const call = host.log.find(message => message.type === 'workspace' && message.action === 'chat/send');
  assert.deepEqual([call.input.projectId, call.input.id], ['p1', 'codex-1']);
  assert.match(call.input.text, /please review$/);
  assert.match((await client.call('tools/call', { name: 'send_message', arguments: { to: 'codex', message: 'x'.repeat(301) } })).result.content[0].text, /limit is 300/, 'the saved settings apply');

  // The settings page: a bad value is refused with its reason; a good one applies at once and is saved.
  const values = Object.fromEntries(view.fields.map(field => [field.key, field.value]));
  assert.match((await host.act('save', { ...values, maxHops: '99' })).error, /정수/);
  assert.equal((await host.act('save', { ...values, maxLength: '1000', autoApprove: 'false' })).ok, true);
  assert.equal(host.log.filter(message => message.type === 'terminal').at(-1).autoApprove, false, 'a changed auto-approval is offered to the chats again');
  assert.equal(host.log.filter(message => message.type === 'storage').at(-1).value.settings.maxLength, 1000);
  assert.equal(chatText(await client.call('tools/call', { name: 'send_message', arguments: { to: 'codex', message: 'x'.repeat(301) } })).results[0].status, 'delivered');
  assert.equal((await host.act('reset')).ok, true);
  assert.equal(host.log.filter(message => message.type === 'storage').at(-1).value.settings.maxLength, 8000);
  assert.equal((await host.act('nothing')).ok, false);
});

test('a restarted host listens on the same port with the same token, and a wrong token is refused', async t => {
  const first = spawnHost(t);
  first.init(null);
  const offered = await first.next(message => message.type === 'terminal');
  await first.next(message => message.type === 'ready');
  const storage = first.log.find(message => message.type === 'storage').value;
  first.child.send({ type: 'shutdown' });
  await new Promise(resolve => first.child.once('exit', resolve));

  const second = spawnHost(t);
  second.init(storage);
  const again = await second.next(message => message.type === 'terminal');
  assert.deepEqual(again.mcpArgs.slice(0, 4), offered.mcpArgs.slice(0, 4), 'chats started before the restart keep reaching the bus');
  const env = { ADE_CHAT_ID: 'claude-1', ADE_PROJECT_ID: 'p1', ADE_CHAT_AGENT: 'claude' };
  const known = mcpClient(again.mcpArgs, env), intruder = mcpClient(['--port', again.mcpArgs[1], '--token', 'f'.repeat(48)], env);
  t.after(() => { known.close(); intruder.close(); });
  assert.notEqual((await known.call('tools/call', { name: 'list_peers', arguments: {} })).result.isError, true);
  const refused = await intruder.call('tools/call', { name: 'list_peers', arguments: {} });
  assert.deepEqual([refused.result.isError, refused.result.content[0].text], [true, 'Not allowed.']);
});

test('the host opens its workspace session again after the server restarted', async t => {
  const host = spawnHost(t);
  host.init(null);
  const offered = await host.next(message => message.type === 'terminal');
  await host.next(message => message.type === 'ready');
  const opens = () => host.log.filter(message => message.type === 'workspace' && message.op === 'open').length;
  const client = mcpClient(offered.mcpArgs, { ADE_CHAT_ID: 'claude-1', ADE_PROJECT_ID: 'p1', ADE_CHAT_AGENT: 'claude' });
  t.after(() => client.close());
  assert.equal(chatText(await client.call('tools/call', { name: 'list_peers', arguments: {} })).peers.length, 1);
  assert.equal(opens(), 1);
  assert.equal(chatText(await client.call('tools/call', { name: 'list_peers', arguments: {} })).peers.length, 1);
  assert.equal(opens(), 1, 'the open session is reused');
  host.child.send({ type: 'workspace', op: 'reset' });
  assert.equal(chatText(await client.call('tools/call', { name: 'list_peers', arguments: {} })).peers.length, 1, 'works after the server restarted');
  assert.equal(opens(), 2, 'a new session was opened for it');
});
