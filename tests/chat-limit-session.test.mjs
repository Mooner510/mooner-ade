import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChatSession } from '../apps/local-server/src/chat.js';
import { fromReplay } from '../apps/web/src/chat-model.ts';

const until = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('chat did not settle'); };
const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
async function open(t, script, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-chat-limit-'));
  const events = [], options = { directory, id: 'limit', cwd: directory, executable: process.execPath, executableArgs: [fixture(script)], onEvent: event => events.push(event), ...extra };
  let session = await openChatSession(options);
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { directory, events, get session() { return session; }, async reopen() { await session.close(); session = await openChatSession(options); return session; } };
}
const refused = (promise, code = 'CHAT_LIMIT') => assert.rejects(promise, error => error.code === code);

test('a cost limit stops the chat when the turn brings the cost over it, compacts once, and refuses sends until it is raised', async t => {
  const chat = await open(t, 'fake-claude-compact-stream.mjs'), { events } = chat;
  await chat.session.setLimit({ cost: 0.01, compact: true });
  await chat.session.send('hello'); // the turn costs 0.02, the compact leaves the total at 0.01
  await until(() => events.some(event => event.kind === 'compact') && chat.session.state().status === 'idle');
  const stops = events.filter(event => event.kind === 'limit_stop');
  assert.deepEqual(stops.map(event => event.rule), ['비용 $0.01']);
  assert.equal(chat.session.state().limit.stop, '비용 $0.01');
  assert.equal(events.filter(event => event.kind === 'compact').length, 1, 'compacted once, and not stopped again by its own cost');
  assert.ok(events.some(event => event.kind === 'compact') && stops[0].seq < events.find(event => event.kind === 'compact').seq);
  await refused(chat.session.send('again'));
  assert.equal(events.filter(event => event.kind === 'user').length, 2, 'only hello and the automatic /compact');
  assert.equal(events.filter(event => event.kind === 'compact').length, 1, 'a refused send does not compact again');
  // The stop and the rule are part of the chat: they survive a reopen, and the thread shows the line again from the stored events.
  const again = await chat.reopen();
  assert.equal(again.state().limit.stop, '비용 $0.01');
  assert.deepEqual(fromReplay(again.replay(), 0).items.filter(item => item.kind === 'note' && item.text.includes('제한 규칙')).map(item => item.text), ['제한 규칙(비용 $0.01)에 따라 중지되었습니다']);
  await again.setLimit({ cost: 5 });
  assert.equal(again.state().limit.stop, null);
  await again.send('go on'); await until(() => again.state().status === 'idle');
  assert.ok(events.some(event => event.kind === 'user' && event.text === 'go on'));
  await again.setLimit(null);
  assert.equal(again.state().limit, null);
});

test('a usage limit is read while the turn runs: it interrupts the turn like the stop button; a reset window lets sends through', async t => {
  let percent = 50, reads = 0, forced = [];
  const readUsage = async (provider, options) => { reads += 1; forced.push(options.force); if (reads === 3) percent = 85; return { windows: [{ key: 'session', percent, resetsAt: 9e12 }, { key: 'weekly', percent: 10, resetsAt: 9e12 }] }; };
  const chat = await open(t, 'fake-claude-control.mjs', { readUsage, limitPollMs: 250 }), { events, session } = chat;
  await session.setLimit({ usage: { window: 'session', percent: 80 }, compact: true }); // read 1
  assert.equal(session.state().limit.stop, null);
  await session.send('slow'); // read 2 (before the turn), then a poll every 250 ms (30 s in the app) while it runs: read 3 sees 85%
  const compacts = () => events.filter(event => event.kind === 'user' && event.text === '/compact').length;
  await until(() => compacts() === 1 && events.filter(event => event.kind === 'result').length === 2 && session.state().status === 'idle');
  assert.equal(events.find(event => event.kind === 'limit_stop').rule, '5시간 사용량 80%');
  assert.ok(events.some(event => event.kind === 'result' && event.status === 'interrupted'), 'the running turn was interrupted');
  assert.ok(forced.every(value => value === true), 'every read asks for a fresh one (usage.js still serves its cache inside its own gap)');
  assert.equal(compacts(), 1, 'the automatic compact (the fake CLI just answers it) ran once, after the interrupted turn');
  const sends = reads;
  await refused(session.send('again'));
  assert.equal(compacts(), 1);
  assert.equal(reads, sends + 1, 'a send reads the window once');
  percent = 40; // the window reset
  await session.send('after reset'); await until(() => session.state().status === 'idle');
  assert.equal(session.state().limit.stop, null);
  assert.ok(events.some(event => event.kind === 'user' && event.text === 'after reset'));
});

test('a share limit measures the rise since it was set, and starts over when the window resets', async t => {
  let reading = { percent: 40, resetsAt: 9e12 };
  const chat = await open(t, 'fake-claude-control.mjs', { readUsage: async () => ({ windows: [{ key: 'weekly', ...reading }] }) }), { directory, session } = chat;
  await session.setLimit({ share: { window: 'weekly', percent: 5 } });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'chat', 'limit', 'meta.json'), 'utf8')).limit.base, { window: 'weekly', percent: 40, resetsAt: 9e12 });
  reading = { percent: 44, resetsAt: 9e12 };
  await session.send('fine'); await until(() => session.state().status === 'idle');
  assert.equal(session.state().limit.now.share, 4);
  reading = { percent: 45, resetsAt: 9e12 };
  await refused(session.send('over'));
  assert.equal(session.state().limit.stop, '주간 할당 5%');
  reading = { percent: 7, resetsAt: 9e12 + 7 * 86_400_000 }; // reset: the next reading is the new baseline
  await session.send('new window'); await until(() => session.state().status === 'idle');
  assert.equal(session.state().limit.stop, null);
  assert.equal(session.state().limit.now.share, 0);
});

test('a limit the chat cannot measure is refused: plan windows on an API key', async t => {
  const key = await open(t, 'fake-claude-control.mjs', { env: { ANTHROPIC_API_KEY: 'sk-test' } });
  assert.deepEqual(key.session.state().limitOptions, { cost: true, windows: [] });
  await assert.rejects(key.session.setLimit({ usage: { window: 'session', percent: 50 } }), error => error.code === 'INVALID_INPUT');
  await key.session.setLimit({ cost: 1 });
  assert.equal(key.session.state().limit.cost, 1);
});
