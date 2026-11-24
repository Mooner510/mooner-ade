import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChatSession } from '../apps/local-server/src/chat.js';
import { fromReplay } from '../apps/web/src/chat-model.ts';

// The fake claude (fixtures/fake-claude-idle.mjs) leaves a 1h-cache transcript. The lead is shortened to LEAD x 3600 s = 1.44 s, so a compact is due 1.44 s after the request.
const LEAD = 0.0004, DUE_MS = 3600 * 1000 * LEAD;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, ms = 8000) => { for (let i = 0; i < ms / 20; i++) { if (predicate()) return; await sleep(20); } assert.fail('chat did not settle'); };
const script = fileURLToPath(new URL('./fixtures/fake-claude-idle.mjs', import.meta.url));
const compacts = events => events.filter(event => event.kind === 'user' && event.text === '/compact');

async function open(t, { env = {}, global = { enabled: true, minK: 200 }, settings } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ade-idle-compact-')), config = path.join(directory, 'claude-config');
  if (settings) { await mkdir(config, { recursive: true }); await writeFile(path.join(config, 'settings.json'), JSON.stringify(settings)); }
  const events = [], setting = { ...global }, options = { directory, id: 'idle', cwd: directory, executable: process.execPath, executableArgs: [script], env: { CLAUDE_CONFIG_DIR: config, ...env },
    idleCompact: () => setting, idleLead: LEAD, onEvent: event => events.push(event) };
  let session = await openChatSession(options);
  t.after(async () => { await session.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { directory, events, setting, get session() { return session; }, async reopen() { await session.close(); session = await openChatSession(options); return session; } };
}
const armed = chat => chat.session.state().cache?.compactAt;

test('a long 1h-cache chat is compacted once, just before the cache goes cold, and says so', async t => {
  const chat = await open(t), { events, session } = chat;
  await session.send('hello');
  await until(() => armed(chat));
  const cache = session.state().cache;
  assert.equal(cache.compactAt, cache.at + DUE_MS, 'the chip gets the compact time');
  assert.equal(compacts(events).length, 0);
  await until(() => events.some(event => event.kind === 'compact') && session.state().status === 'idle');
  assert.equal(compacts(events).length, 1, 'ADE sent /compact through the normal path');
  assert.ok(Date.now() >= cache.at + DUE_MS - 50 && Date.now() < cache.at + 3_600_000, 'not before the due time, and before the cache expires');
  assert.equal(events.find(event => event.kind === 'compact').trigger, 'idle');
  await until(() => session.state().cache?.compacted);
  assert.equal(session.state().cache.compactAt, undefined);
  assert.equal(session.state().cache.compacted.trigger, 'auto', 'the chip calls it automatic, not manual');
  await sleep(DUE_MS + 600);
  assert.equal(compacts(events).length, 1, 'never twice for the same cache window');
  assert.deepEqual(fromReplay(session.replay(), 0).items.filter(item => item.kind === 'compact').map(item => item.trigger), ['idle'], 'the divider keeps the idle trigger on replay');
  assert.deepEqual(fromReplay((await chat.reopen()).replay(), 0).items.filter(item => item.kind === 'compact').map(item => item.trigger), ['idle'], 'and after a reopen');
});

test('a new request moves the timer to the new window: one compact, after the last request', async t => {
  const chat = await open(t), { events, session } = chat;
  await session.send('hello'); await until(() => armed(chat));
  const first = session.state().cache;
  await until(() => session.state().status === 'idle'); await sleep(700);
  await session.send('again'); // a turn start cancels the timer; the next reading arms it again from the new request
  await until(() => armed(chat) > first.compactAt);
  const second = session.state().cache;
  assert.ok(second.at >= first.at + 600);
  assert.equal(second.compactAt, second.at + DUE_MS);
  await until(() => events.some(event => event.kind === 'compact'));
  assert.ok(Date.now() >= second.at + DUE_MS - 50, 'it waited for the second window');
  await sleep(DUE_MS + 600);
  assert.equal(compacts(events).length, 1);
});

test('the per-chat choice overrides the global setting, is kept, and follows a change of the global one', async t => {
  const chat = await open(t, { global: { enabled: false, minK: 200 } }), { events, setting } = chat;
  assert.deepEqual(chat.session.state().idleCompact, { chat: null, on: false });
  await chat.session.send('hello'); await until(() => chat.session.state().cache && chat.session.state().status === 'idle');
  assert.equal(armed(chat), undefined, 'off by default');
  assert.deepEqual(await chat.session.setIdleCompact(true), { chat: true, on: true });
  assert.ok(armed(chat), 'turning it on arms the window at hand');
  assert.deepEqual(await chat.session.setIdleCompact(null), { chat: null, on: false });
  assert.equal(armed(chat), undefined);
  setting.enabled = true; chat.session.resyncIdleCompact();
  await until(() => armed(chat));
  assert.deepEqual(await chat.session.setIdleCompact(false), { chat: false, on: false }, 'off for this chat beats a global on');
  assert.equal(armed(chat), undefined);
  assert.equal((await chat.reopen()).state().idleCompact.chat, false, 'stored in the chat');
  await assert.rejects(chat.session.setIdleCompact('yes'), error => error.code === 'INVALID_INPUT');
  await sleep(DUE_MS + 600);
  assert.equal(compacts(events).length, 0);
});

// Each case: the setup that makes the compact wrong at the moment it is due, and the wait long enough to see it did not run.
const skips = {
  'off (the default)': { global: { enabled: false } },
  'a 5-minute cache': { env: { FAKE_TTL: '300' } },
  'a context below the threshold': { env: { FAKE_TOKENS: '150000' } },
  'a cache that already expired': { env: { FAKE_AGE_SEC: '3700' } },
  'a conversation already compacted after its last request': { env: { FAKE_COMPACTED: '1' } },
  'the CLI auto compact switched off': { settings: { autoCompactEnabled: false } },
  'a turn still running when it is due': { text: 'slow', env: { FAKE_SLOW_MS: '3500' }, wait: 3000 },
  'an approval waiting for the user': { text: 'ask' },
  'a chat stopped by its limit': { limit: { cost: 0.01 }, env: { FAKE_COST: '0.02' } },
};
test('nothing is sent when a skip rule holds at the due time, and it is not retried', async t => {
  await Promise.all(Object.entries(skips).map(async ([name, { text = 'hello', wait = 0, limit, ...options }]) => {
    const chat = await open(t, options);
    if (limit) await chat.session.setLimit(limit);
    await chat.session.send(text);
    await until(() => chat.session.state().cache);
    await sleep(DUE_MS + 900 + wait);
    assert.equal(compacts(chat.events).length, 0, name);
    assert.equal(chat.events.some(event => event.kind === 'compact'), false, name);
    if (limit) assert.ok(chat.session.state().limit.stop, name);
  }));
});

test('a closed chat sends nothing', async t => {
  const chat = await open(t);
  await chat.session.send('hello'); await until(() => armed(chat));
  await chat.session.close();
  await sleep(DUE_MS + 600);
  assert.equal(compacts(chat.events).length, 0);
});
