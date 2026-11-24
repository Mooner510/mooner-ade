// The cache-timer chip after a compaction: 보관 (archive icon, no countdown, no drain bar) even with cache time left, in a terminal tab and in a chat tab,
// and back to a normal timer once the next request is in the transcript. No model is called: the terminal's "Claude" is `exec -a claude sleep` plus a
// sessions/<pid>.json and transcript this script writes into the session's HOME; the chat is the fake claude, whose ctl.json switches (sessionUuid, transcript,
// ttl, transcriptAgeSec, compacted) write the transcript lines per message.
// Run: VERIFY_OUT=<session> (or VERIFY_TAB=… on tmp/main) node scripts/verify/t-cache-compacted.mjs
// It opens one terminal tab and one Claude chat tab and closes both again (a project holds 16 chats at most); ctl.json is reset at the end.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, env } from './cdp.mjs';

const c = await connect(page => page.url.includes('127.0.0.1')), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const temp = env().temp, ctlFile = join(temp, 'ctl.json'), setCtl = value => writeFileSync(ctlFile, JSON.stringify(value));
// Other tabs stay mounted (hidden, inert), so only what is on screen counts.
const all = sel => `[...document.querySelectorAll('${sel}')].filter(e => !e.closest('[inert]') && e.getClientRects().length)`;
const has = expr => c.ev(`return !!(${expr})`);
const chip = scope => c.ev(`const e = ${all(`${scope} .cache-timer`)}[0]; return e && { cls: e.className.replace('cache-timer ', ''), text: e.querySelector('b')?.textContent.trim() ?? '', icon: e.querySelector('.icon')?.textContent.trim() ?? null, bar: !!e.querySelector('i'), title: e.title }`);
const chipIs = async (scope, state, ms = 20000) => { const end = Date.now() + ms; let seen; while (Date.now() < end) { seen = await chip(scope); if (seen?.cls === state) return seen; await sleep(300); } throw new Error(`${scope} chip: want ${state}, got ${JSON.stringify(seen)}`); };
// Tip cards blur the page behind them; dismiss them before a screenshot.
const shot = async name => { for (let i = 0; i < 3 && await has(`${all('button')}.some(b => b.textContent.trim() === '알겠어요')`); i++) { await c.ev(`${all('button')}.find(b => b.textContent.trim() === '알겠어요').click()`); await sleep(500); } return c.shot(name); };
const iso = at => new Date(at).toISOString();
// Claude Code's transcript lines for one main-thread request (same shapes the fake claude writes).
const request = (ref, at, ttl = 3600) => [{ type: 'api-request', id: ref, timestamp: iso(at) }, { type: 'assistant', timestamp: iso(at + 800), requestRef: ref, promptCacheRequested: ttl === 3600 ? '1h' : '5m',
  message: { model: 'claude-opus-5-5', usage: { input_tokens: 12, output_tokens: 340, cache_creation_input_tokens: 4200, cache_read_input_tokens: 18400, ...(ttl === 3600 && { cache_creation: { ephemeral_1h_input_tokens: 4200 } }) }, content: [{ type: 'text', text: 'ok' }] } }];
const boundary = at => ({ type: 'system', subtype: 'compact_boundary', timestamp: iso(at), compactMetadata: { trigger: 'manual', preTokens: 180000, postTokens: 14000 } });
const lines = list => list.map(line => JSON.stringify(line) + '\n').join('');
// A new tab is a launcher page; its card turns it into a terminal or a chat. JS .click(), as pointer moves close menus.
const launcherCard = async match => {
  await c.ev(`document.querySelector('button[aria-label="새 터미널 탭"]').click()`);
  await c.waitFor(`${all('button')}.some(b => ${match})`, 8000);
  await c.ev(`${all('button')}.find(b => ${match}).click()`);
};
// Our own tabs are tagged right after they open and closed by that tag (other tabs may look alike); a running process or turn asks for a 확인.
const markTab = name => c.ev(`document.querySelector('.folder-tab.active').setAttribute('data-probe', '${name}'); return '${name}'`);
const closeTab = name => async () => {
  await c.ev(`document.querySelector('[data-probe="${name}"] .ptab-close')?.click()`); await sleep(600);
  if (await has(`${all('[role=option]')}.some(o => o.textContent.trim() === '확인')`)) { await c.key('Enter', 'Enter', 0, '\r'); await sleep(900); } // the confirm menu's 확인 is selected
};
const closing = [];
try {
  await c.waitFor(`!!document.querySelector('[aria-label="새 탭 종류 선택"]')`, 20000);
  await c.ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '알겠어요')?.click()`);

  // ---- terminal tab: a process named `claude` with the session file and transcript Claude Code would leave
  await launcherCard(`b.textContent.includes('터미널') && b.textContent.includes('zsh')`);
  await c.waitFor(`${all('.terminal-pane .xterm-helper-textarea')}.length`, 15000);
  closing.push(closeTab(await markTab('cache-term')));
  await sleep(1500);
  const sleepFor = 900 + Math.floor(Math.random() * 90); // makes the process's command line unique to this run
  await c.ev(`(${all('.terminal-pane .xterm-helper-textarea')}[0] ?? ${all('.terminal-pane')}[0]).focus()`);
  await c.type(`exec -a claude sleep ${sleepFor}`); await c.key('Enter', 'Enter', 0, '\r');
  const pid = await (async () => { for (let i = 0; i < 40; i++) { const hit = execFileSync('ps', ['-axo', 'pid=,command=']).toString().split('\n').map(l => /^\s*(\d+)\s+claude (\d+)\s*$/.exec(l)).find(m => m && Number(m[2]) === sleepFor); if (hit) return Number(hit[1]); await sleep(250); } throw new Error('the fake claude process did not start'); })();
  const cwd = join(temp, 'repo'), home = join(temp, 'home', '.claude'), session = crypto.randomUUID();
  const dir = join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')), file = join(dir, `${session}.jsonl`);
  mkdirSync(join(home, 'sessions'), { recursive: true }); mkdirSync(dir, { recursive: true });
  closing.push(() => rmSync(join(home, 'sessions', `${pid}.json`), { force: true }), () => rmSync(file, { force: true }));
  writeFileSync(join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: session, cwd, status: 'idle', kind: 'interactive' }));
  const term = '.terminal-pane';

  // A 1h cache whose request started 10 minutes ago: a running countdown (hot, ~50:00).
  const started = Date.now() - 10 * 60_000;
  // The server rechecks a silent terminal only every 30 s; a keypress (echoed by the tty) makes it look at the next 3 s poll, as real Claude output does.
  const poke = async () => { await c.ev(`${all('.terminal-pane .xterm-helper-textarea')}[0].focus()`); await c.key('Enter', 'Enter', 0, '\r'); };
  writeFileSync(file, lines(request('req_1', started))); await poke();
  let seen = await chipIs(term, 'hot');
  assert.match(seen.text, /^\d+:\d\d$/, 'a countdown while the cache has time left'); assert.ok(seen.bar, 'with the drain bar');
  await shot('cache-terminal-hot');

  // /compact 10 minutes into the cache: 보관 right away, with no countdown and no bar, although ~50 minutes of cache are left.
  appendFileSync(file, lines([boundary(Date.now())])); await poke();
  seen = await chipIs(term, 'compacted');
  assert.equal(seen.icon, 'inventory_2', 'the archive icon'); assert.equal(seen.text, '', 'no countdown number'); assert.equal(seen.bar, false, 'no drain bar');
  assert.match(seen.title, /수동 Compact/); assert.doesNotMatch(seen.title, /만료 예정|Compact 예정/, 'the tooltip does not promise an expiry');
  assert.ok(!await has(`${all(`${term} .cache-timer`)}[0].style.getPropertyValue('--left')`), 'no --left left over from the countdown');
  const before = seen.text; await sleep(2500); assert.equal((await chip(term)).text, before, 'it stays still');
  await shot('cache-terminal-compacted');

  // The next main-thread request: a normal timer again.
  appendFileSync(file, lines(request('req_2', Date.now()))); await poke();
  seen = await chipIs(term, 'hot');
  assert.match(seen.text, /^\d+:\d\d$/); assert.ok(seen.bar); assert.doesNotMatch(seen.title, /Compact/);
  await shot('cache-terminal-hot-again');

  // The terminal's compaction is still on screen in the sidebar while the chat tab is in front: the same chip, in the tab row.
  appendFileSync(file, lines([boundary(Date.now())])); await poke(); await chipIs(term, 'compacted');
  // ---- chat tab: the fake claude writes the transcript for each message; `compacted` adds the boundary right behind the request
  await launcherCard(`/^Claude(arrow_forward)?$/.test(b.textContent.trim())`); // the launcher opens in Chat 모드
  closing.push(closeTab(await markTab('cache-chat')));
  await c.waitFor(`${all('textarea[aria-label="메시지 입력"]')}.length`, 15000); await sleep(1000);
  const row = await chip('[data-probe="cache-term"]');
  assert.equal(row?.cls, 'compacted', `sidebar chip of the terminal tab: ${JSON.stringify(row)}`); assert.equal(row.text, ''); assert.equal(row.bar, false);
  await shot('cache-sidebar-compacted');
  const chatPane ='.pane-tools[aria-label="채팅 pane"]';
  const idle = () => c.waitFor(`${all('.chat-send.stop')}.length === 0`, 20000);
  const send = async text => { await c.ev(`${all('textarea[aria-label="메시지 입력"]')}[0].focus()`); await c.type(text); await c.key('Enter', 'Enter', 0, '\r'); await sleep(400); await idle(); };
  setCtl({ sessionUuid: true, transcript: true, ttl: 3600, transcriptAgeSec: 600 });
  await send('안녕'); // a request that started 10 minutes ago: a timer with ~50 minutes left
  seen = await chipIs(chatPane, 'hot'); assert.match(seen.text, /^\d+:\d\d$/);
  setCtl({ sessionUuid: true, transcript: true, ttl: 3600, transcriptAgeSec: 600, compacted: true });
  await send('/compact'); // the request plus its compact_boundary arrive together; the chat re-reads after the compact
  seen = await chipIs(chatPane, 'compacted');
  assert.equal(seen.icon, 'inventory_2', 'the archive icon'); assert.equal(seen.text, ''); assert.equal(seen.bar, false);
  await shot('cache-chat-compacted');
  setCtl({ sessionUuid: true, transcript: true, ttl: 3600, transcriptAgeSec: 0 });
  await send('다음 질문'); // the next request: back to a timer
  seen = await chipIs(chatPane, 'hot'); assert.match(seen.text, /^\d+:\d\d$/);
  await shot('cache-chat-hot-again');
  console.log('ok');
} finally {
  setCtl({});
  for (const undo of closing.reverse()) await Promise.resolve(undo()).catch(() => {});
  c.close();
}
