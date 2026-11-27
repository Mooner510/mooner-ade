import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
const resolveDir = fileURLToPath(new URL('../apps/web/src', import.meta.url));

// One bundle of the pure chat keyboard and hint modules plus the app's key matching (shortcuts.ts pulls in React, so it is bundled rather than imported).
async function load(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ade-chat-keys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'keys.cjs');
  await build({ stdin: { contents: `export * from './chat-keys'; export * from './chat-slash'; export * from './chat-hints'; export * from './chat-key-guide'; export * from './chat-find';
    export { matches, combosOverlap, appKeyDefs } from './shortcuts'; export { chatKey, chatKeyDefs, showCombo, validCombo } from './chat-model';`, resolveDir }, bundle: true, platform: 'node', format: 'cjs', outfile });
  return require(outfile);
}
const key = (k, mods = {}) => ({ key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

test('the new chat keys have their own combos: none taken by an app key, by another chat key, or by the zoom key', async t => {
  const { chatKeyDefs, appKeyDefs, combosOverlap, validCombo } = await load(t);
  assert.equal(new Set(chatKeyDefs.map(def => def.id)).size, chatKeyDefs.length);
  assert.ok(chatKeyDefs.length <= 16, 'the server keeps at most 16 chat key overrides (ui-state.js)');
  for (const def of chatKeyDefs) {
    assert.ok(/^[a-zA-Z][a-zA-Z0-9]{0,23}$/.test(def.id), def.id);
    assert.ok(validCombo(def.keys.replace('mod+', 'ctrl+')), def.keys);
    for (const app of appKeyDefs) assert.ok(!combosOverlap(def.keys, app.keys), `${def.id} ${def.keys} vs ${app.id} ${app.keys}`);
    for (const other of chatKeyDefs) if (other !== def) assert.ok(!combosOverlap(def.keys, other.keys), `${def.id} vs ${other.id}`);
  }
});

test('card keys: modifier+Enter answers, plain Enter never does, Esc refuses and Tab only steps in', async t => {
  const { cardKeyAction, chatKey, matches } = await load(t);
  const action = (event, overrides) => cardKeyAction(event, id => matches(chatKey(overrides, id), event));
  assert.equal(action(key('Enter', { ctrlKey: true })), 'allow');
  assert.equal(action(key('Enter', { metaKey: true })), 'allow');
  assert.equal(action(key('Enter', { ctrlKey: true, altKey: true })), 'allowMore');
  assert.equal(action(key('Enter', { altKey: true })), 'more');
  assert.equal(action(key('Enter')), null);
  assert.equal(action(key('Enter', { shiftKey: true })), null);
  assert.equal(action(key('Enter', { ctrlKey: true, shiftKey: true })), null, 'Ctrl+Shift+Enter stays the pane zoom');
  assert.equal(action(key('Escape')), 'deny');
  assert.equal(action(key('Escape', { shiftKey: true })), null);
  assert.equal(action(key('Tab')), 'enter');
  assert.equal(action(key('Tab', { shiftKey: true })), null);
  // A rebound key: the old default no longer answers.
  assert.equal(action(key('Y', { altKey: true }), { cardAllow: 'alt+y' }), 'allow');
  assert.equal(action(key('Enter', { ctrlKey: true }), { cardAllow: 'alt+y' }), null);
});

test('card keys are safe: no auto-repeat, no early press, nothing from text fields or other panes', async t => {
  const { cardKeyAllowed, CARD_GRACE_MS } = await load(t);
  const at = { now: 10_000, shownAt: 10_000 - CARD_GRACE_MS };
  assert.ok(cardKeyAllowed('allow', 'body', at));
  assert.ok(!cardKeyAllowed('allow', 'body', { ...at, shownAt: 9_900 }), 'within the grace period');
  assert.ok(!cardKeyAllowed('allow', 'body', { ...at, repeat: true }));
  assert.ok(!cardKeyAllowed('allowMore', 'field', at));
  assert.ok(!cardKeyAllowed('allow', 'outside', at));
  assert.ok(cardKeyAllowed('allow', 'modal', at), 'the plan dialog approves too');
  assert.ok(cardKeyAllowed('deny', 'body', { ...at, shownAt: at.now }), 'refusing needs no grace');
  assert.ok(!cardKeyAllowed('deny', 'modal', at), 'Esc closes the plan dialog instead');
  assert.ok(!cardKeyAllowed('deny', 'body', { ...at, repeat: true }));
  assert.ok(cardKeyAllowed('enter', 'body', at));
  assert.ok(!cardKeyAllowed('enter', 'pane', at), 'Tab on a control moves focus as usual');
});

test('conversation keys and when the message box keeps them for its own editing', async t => {
  const { threadKeyAction, threadKeyInComposer, chatKey, matches } = await load(t);
  const action = event => threadKeyAction(event, id => matches(chatKey({}, id), event));
  assert.equal(action(key('ArrowUp', { altKey: true })), 'turnPrev');
  assert.equal(action(key('ArrowDown', { altKey: true })), 'turnNext');
  assert.equal(action(key('ArrowUp')), null, 'plain ↑ stays the history');
  assert.equal(action(key('ArrowUp', { ctrlKey: true, altKey: true })), null, 'Ctrl+Alt+↑ stays Effort');
  assert.equal(action(key('Home', { ctrlKey: true })), 'top');
  assert.equal(action(key('End', { metaKey: true })), 'bottom');
  assert.equal(action(key('f', { ctrlKey: true })), 'find');
  assert.equal(action(key('c', { ctrlKey: true, shiftKey: true })), 'copyAnswer');
  assert.equal(action(key('c', { ctrlKey: true, altKey: true, shiftKey: true })), 'copyCode');
  assert.equal(action(key('c', { ctrlKey: true, altKey: true })), null, 'Ctrl+Alt+C is the app key that returns to the chat box');
  assert.equal(action(key('c', { ctrlKey: true })), null, 'Ctrl+C stays copy');
  assert.equal(action(key('PageUp')), 'pageUp');
  assert.equal(action(key('PageDown', { shiftKey: true })), null);
  const box = (empty, mac = false, overflow = false) => ({ empty, mac, overflow });
  assert.ok(threadKeyInComposer('top', box(true)) && !threadKeyInComposer('top', box(false)), 'Ctrl+Home moves the caret while there is text');
  assert.ok(threadKeyInComposer('turnPrev', box(false)) && !threadKeyInComposer('turnPrev', box(false, true)) && threadKeyInComposer('turnPrev', box(true, true)));
  assert.ok(threadKeyInComposer('pageDown', box(false)) && !threadKeyInComposer('pageDown', box(false, false, true)));
  assert.ok(threadKeyInComposer('find', box(false)) && threadKeyInComposer('copyCode', box(false)));
});

test('previous/next request from the reading position, one step per press while scrolling', async t => {
  const { turnJumpTarget } = await load(t);
  const tops = [-2000, -900, -300, 8, 600, 1400];
  assert.equal(turnJumpTarget(tops, -1), 2, 'the request above the edge');
  assert.equal(turnJumpTarget(tops, 1), 4, 'the request at the top (just jumped to) is not "next"');
  assert.equal(turnJumpTarget([-500, 700], -1), 0, 'inside a long turn ↑ goes to its own start');
  assert.equal(turnJumpTarget([20, 400], -1), null);
  assert.equal(turnJumpTarget([-400, -20], 1), null);
  assert.equal(turnJumpTarget(tops, -1, 3), 2, 'from the last jump');
  assert.equal(turnJumpTarget(tops, -1, 0), null);
  assert.equal(turnJumpTarget(tops, 1, 5), null);
  assert.equal(turnJumpTarget([], 1), null);
});

test('last answer and last code block', async t => {
  const { lastCodeBlock, lastCode, turnAnswer, lastAnswer } = await load(t);
  assert.equal(lastCodeBlock('a\n```js\none\n```\nb\n~~~\ntwo\n~~~\n'), 'two');
  assert.equal(lastCodeBlock('````md\n```js\ninner\n```\n````'), '```js\ninner\n```', 'a longer fence holds a shorter one');
  assert.equal(lastCodeBlock('```\nunclosed\nrest'), 'unclosed\nrest');
  assert.equal(lastCodeBlock('inline ``` not a fence ``` here'), '');
  assert.equal(lastCodeBlock('no code'), '');
  const user = text => ({ kind: 'user', key: `u${text}`, text, images: 0 });
  const said = (key, blocks, sub = false) => ({ kind: 'assistant', key, id: key, blocks, sub });
  const text = value => ({ type: 'text', text: value }), tool = id => ({ type: 'tool_use', id, name: 'Bash', input: {} });
  const turn = [user('q'), said('a1', [text('먼저 볼게요\n```sh\nls\n```'), tool('t1')]), said('a2', [text('결과입니다')])];
  assert.equal(turnAnswer(turn), '결과입니다', 'the answer is the text after the last tool');
  assert.equal(lastAnswer([turn, [user('later')]]), '결과입니다', 'a turn with nothing said yet is skipped');
  assert.equal(lastCode([turn, [user('later')]]), 'ls', 'code said before a tool still counts');
  assert.equal(lastCode([[user('x'), said('s', [text('```\nsub\n```')], true)]]), '', 'a subagent\'s code is not the agent\'s');
});

test('slash menu: handy ADE commands first, then recent ones, then the rest; a typed name is a plain prefix match', async t => {
  const { slashMenu, withRecentSlash, loadRecentSlash, recordSlashUse, RECENT_SLASH_SHOWN } = await load(t);
  const names = ['btw', 'clear', 'compact', 'cost', 'help', 'idlecompact', 'model', 'resume', 'retry', 'review', 'stats', 'usage', 'claude-api', 'plugin:deploy'];
  const available = names.sort().map(name => ({ name, description: `${name} 설명` }));
  const menu = slashMenu(available, '', { agent: 'claude', recent: ['review', 'btw', 'compact'], hidden: new Set(['claude-api']) });
  assert.deepEqual(menu.filter(item => item.group === 'featured').map(item => item.name), ['btw', 'resume', 'usage', 'stats', 'idlecompact', 'retry']);
  assert.equal(menu[0].description.includes('곁가지'), true, 'featured lines use their short text');
  assert.deepEqual(menu.filter(item => item.group === 'recent').map(item => item.name), ['review', 'compact'], 'recent ones already featured are not repeated');
  assert.ok(!menu.some(item => item.name === 'claude-api'));
  assert.equal(new Set(menu.map(item => item.name)).size, menu.length);
  assert.ok(menu.length <= 16);
  const codex = slashMenu(available, '', { agent: 'codex' });
  assert.ok(!codex.some(item => item.group === 'featured' && ['stats', 'idlecompact'].includes(item.name)), 'Claude-only commands are not featured elsewhere');
  assert.deepEqual(slashMenu(available, 'co', { agent: 'claude', recent: ['cost'] }).map(item => item.name), ['compact', 'cost'], 'typed: prefix order as before');
  assert.deepEqual(slashMenu(available, 'dep', { agent: 'claude' }).map(item => item.name), ['plugin:deploy']);
  assert.deepEqual(slashMenu(available, 'claude-api', { agent: 'claude', hidden: new Set(['claude-api']) }).map(item => item.name), ['claude-api']);
  assert.deepEqual(withRecentSlash(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
  assert.equal(withRecentSlash(Array.from({ length: 20 }, (_, i) => `n${i}`), 'x').length, 12);
  const many = slashMenu(available, '', { agent: 'cursor', recent: ['clear', 'compact', 'cost', 'help', 'model', 'review'] });
  assert.equal(many.filter(item => item.group === 'recent').length, RECENT_SLASH_SHOWN);
  const memory = new Map(), storage = { getItem: name => memory.get(name) ?? null, setItem: (name, value) => memory.set(name, value) };
  assert.deepEqual(loadRecentSlash(storage), []);
  recordSlashUse('btw', storage); recordSlashUse('cost', storage);
  assert.deepEqual(loadRecentSlash(storage), ['cost', 'btw']);
  memory.set('ade:slash-recent', '{bad'); assert.deepEqual(loadRecentSlash(storage), []);
  memory.set('ade:slash-recent', JSON.stringify(['ok', 3, '../x y'])); assert.deepEqual(loadRecentSlash(storage), ['ok']);
});

test('placeholder by situation, with the user\'s keys and nothing extra when tips are off', async t => {
  const { composerPlaceholder, IDLE_LINES } = await load(t);
  const keys = name => `<${name}>`, base = { oneLine: false, busy: false, stash: false, foldIn: true, agent: 'claude', modSend: false, tips: true, turns: 0 };
  assert.equal(composerPlaceholder(base, keys), '작업을 설명하거나 질문하세요, !명령으로 셸 실행');
  assert.equal(composerPlaceholder({ ...base, busy: true }, keys), 'Enter: 지금 끼워 넣기, Tab: 끝난 뒤 보내기, Esc: 중단');
  assert.equal(composerPlaceholder({ ...base, busy: true, modSend: true }, keys), 'Cmd/Ctrl+Enter: 지금 끼워 넣기, Tab: 끝난 뒤 보내기, Esc: 중단');
  assert.equal(composerPlaceholder({ ...base, busy: true, oneLine: true }, keys), '응답 중, 입력해 끼워 넣기');
  assert.equal(composerPlaceholder({ ...base, busy: true, foldIn: false, agent: 'cursor' }, keys), 'Enter: 응답을 끊고 바로 보내기, Tab: 끝난 뒤 보내기, Esc: 중단');
  assert.equal(composerPlaceholder({ ...base, stash: true, turns: 3 }, keys), '보관된 입력이 있습니다 (<stash>로 복원)');
  const lines = IDLE_LINES.length, idle = Array.from({ length: lines + 1 }, (_, index) => composerPlaceholder({ ...base, turns: index + 1 }, keys));
  assert.equal(new Set(idle.slice(0, lines)).size, lines, 'each finished turn shows the next line');
  assert.equal(idle[lines], idle[0]);
  assert.ok(idle.some(line => line.includes('<turnPrev>')) && idle.every(line => !line.includes('{')));
  assert.equal(composerPlaceholder({ ...base, tips: false, turns: 2 }, keys), '작업을 설명하거나 질문하세요, !명령으로 셸 실행');
  assert.ok(IDLE_LINES.length >= 3);
});

test('hint, start-screen and guide texts only name keys that exist', async t => {
  const { HINTS, DISCOVER, IDLE_LINES, guideParts, guideLine, discoverFor, chatKeyDefs, chatKeyGuide, CHAT_FIXED_KEYS, idleCompactOffer, showCombo } = await load(t);
  const ids = new Set(chatKeyDefs.map(def => def.id));
  const named = text => [...text.matchAll(/\{([\w+]+)\}/g)].map(match => match[1]);
  for (const text of [...Object.values(HINTS).map(hint => hint.text), ...DISCOVER.map(item => item.text), ...IDLE_LINES])
    for (const name of named(text)) assert.ok(ids.has(name) || name.includes('+'), `${name} in "${text}"`);
  assert.deepEqual(guideParts('a {stash} b', name => `K:${name}`), [{ text: 'a ' }, { key: 'K:stash' }, { text: ' b' }]);
  assert.equal(guideLine('{shift+tab} 순환', name => name.toUpperCase()), 'SHIFT+TAB 순환');
  assert.deepEqual(discoverFor('claude', []).map(item => item.id), ['btw', 'shell', 'send']);
  assert.deepEqual(discoverFor('claude', ['btw', 'resume']).map(item => item.id), ['shell', 'send', 'queue'], 'a command already used drops out');
  assert.ok(!discoverFor('codex', [], DISCOVER, 99).some(item => item.id === 'stats'));
  const guide = chatKeyGuide({ find: 'alt+f' });
  assert.equal(guide.find(entry => entry.id === 'find').keys, 'alt+f');
  assert.equal(guide.length, chatKeyDefs.length + CHAT_FIXED_KEYS.length);
  assert.ok(guide.every(entry => entry.group && entry.label && entry.keys));
  assert.ok(idleCompactOffer({ agent: 'claude', tips: true, idleCompactOn: false }));
  assert.ok(!idleCompactOffer({ agent: 'claude', tips: true, idleCompactOn: true }));
  assert.ok(!idleCompactOffer({ agent: 'claude', tips: false, idleCompactOn: false }));
  assert.ok(!idleCompactOffer({ agent: 'codex', tips: true, idleCompactOn: false }));
  assert.ok(!showCombo('mod+enter').toLowerCase().includes('mod'), 'a mod default shows as the platform key');
});

test('find: case-insensitive offsets, capped, stepping wraps', async t => {
  const { findOffsets, findStep } = await load(t);
  assert.deepEqual(findOffsets('Abc abc ABC', 'abc'), [0, 4, 8]);
  assert.deepEqual(findOffsets('aaaa', 'aa'), [0, 2], 'non-overlapping');
  assert.deepEqual(findOffsets('abc', ''), []);
  assert.equal(findOffsets('x'.repeat(50), 'x', 10).length, 10);
  assert.equal(findStep(0, 3, -1), 2);
  assert.equal(findStep(2, 3, 1), 0);
  assert.equal(findStep(0, 0, 1), 0);
});
