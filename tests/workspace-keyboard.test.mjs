import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attentionTargets, attentionTitle, nextAttention, pickChat } from '../apps/web/src/attention-nav.ts';
import { swapLeaves, tabStep, treeKey } from '../apps/web/src/tree-nav.ts';
import { fuzzy, parsePaletteQuery, rankPalette, rememberUse, MRU_LIMIT } from '../apps/web/src/palette-model.ts';
import { attentionCount, dotBitmap, setupAttention } from '../apps/desktop/src/attention.js';
import { validateAppState } from '../apps/local-server/src/ui-state.js';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
const resolveDir = fileURLToPath(new URL('../apps/web/src', import.meta.url));
const bundle = async (t, contents) => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-wkeys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, 'bundle.cjs');
  await build({ stdin: { contents, resolveDir }, bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
  return require(outfile);
};

test('palette prefixes follow VS Code: > commands, # tabs, @ files, , settings, ? help, nothing = mixed', () => {
  assert.deepEqual(parsePaletteQuery('ab'), { mode: 'all', query: 'ab' });
  assert.deepEqual(parsePaletteQuery('>  split '), { mode: 'command', query: 'split' });
  assert.deepEqual(parsePaletteQuery('#claude'), { mode: 'tab', query: 'claude' });
  assert.deepEqual(parsePaletteQuery('@src/app'), { mode: 'file', query: 'src/app' });
  assert.deepEqual(parsePaletteQuery(',단축'), { mode: 'setting', query: '단축' });
  assert.deepEqual(parsePaletteQuery('?'), { mode: 'help', query: '' });
  assert.deepEqual(parsePaletteQuery('  >x'), { mode: 'command', query: 'x' }, 'leading spaces do not hide the prefix');
  assert.equal(fuzzy('nt', 'new tab') > fuzzy('nt', 'continue'), true, 'word starts score higher');
  assert.equal(fuzzy('zz', 'new tab'), -1);
});

test('recently used entries come first, and break near ties while searching', () => {
  const items = [{ id: 'a', label: '새 탭', kind: 'command' }, { id: 'b', label: '탭 닫기', kind: 'command' }, { id: 'c', label: '설정 열기', kind: 'command' }];
  assert.deepEqual(rankPalette(items, '', []).map(item => item.id), ['a', 'b', 'c'], 'given order without history');
  assert.deepEqual(rankPalette(items, '', ['c', 'b']).map(item => item.id), ['c', 'b', 'a'], 'newest use first');
  assert.deepEqual(new Set(rankPalette(items, '탭', []).map(item => item.id)), new Set(['a', 'b']));
  assert.equal(rankPalette(items, '탭', ['a'])[0].id, 'a', 'a used entry wins over an equally good match');
  assert.ok(!rankPalette(items, '탭', []).some(item => item.id === 'c'), 'no match, no row');
  // The extra search text (a tab's project name) matches too, below a label match.
  const tabs = [{ id: 't1', label: 'Claude 채팅', kind: 'tab', search: 'mooner-ade' }, { id: 't2', label: 'mooner 메모', kind: 'tab' }];
  assert.deepEqual(rankPalette(tabs, 'mooner', []).map(item => item.id), ['t2', 't1']);
  assert.deepEqual(rememberUse(['x', 'y', 'z'], 'y'), ['y', 'x', 'z']);
  assert.equal(rememberUse(Array.from({ length: 80 }, (_, i) => `id${i}`), 'new').length, MRU_LIMIT);
});

test('next attention: questions and approvals first, then finished answers, across projects and split panes', () => {
  const pane = (id, state = '') => ({ id, asking: state === 'ask', attention: state !== '' });
  const projects = [
    { root: 'A', tabs: [{ ...pane('a1', 'done'), panes: [] }, { ...pane('a2'), panes: [pane('p1'), pane('p2', 'ask')] }] },
    { root: 'B', tabs: [{ ...pane('b1', 'ask'), panes: [] }, { ...pane('b2'), panes: [] }] },
  ];
  const targets = attentionTargets(projects);
  assert.deepEqual(targets.map(target => target.paneId ?? target.tabId), ['p2', 'b1', 'a1']);
  assert.equal(nextAttention(targets, { root: 'B', tabId: 'b2' }, 1).tabId, 'a2', 'not on a target: the first (a question)');
  assert.equal(nextAttention(targets, { root: 'B', tabId: 'b2' }, -1).tabId, 'a1', 'going back: the last');
  assert.equal(nextAttention(targets, { root: 'A', tabId: 'a2', paneId: 'p2' }, 1).tabId, 'b1');
  assert.equal(nextAttention(targets, { root: 'A', tabId: 'a1' }, 1).paneId, 'p2', 'wraps around');
  assert.equal(nextAttention(targets, { root: 'A', tabId: 'a2', paneId: 'p1' }, 1).paneId, 'p2', 'another pane of the same tab is not the target');
  assert.equal(nextAttention([], undefined, 1), undefined);
  assert.equal(attentionTitle('무너에이드', 0), '무너에이드');
  assert.equal(attentionTitle('무너에이드', 2), '(2) 무너에이드');
  assert.equal(attentionTitle('무너에이드', 120), '(99+) 무너에이드');
});

test('back to the chat: the last used in this tab, else in the project, else the first', () => {
  const tabs = [{ id: 't1', chats: ['c1', 'c2'] }, { id: 't2', chats: [] }, { id: 't3', chats: ['c3'] }];
  assert.deepEqual(pickChat(tabs, 't1', new Map([['c2', 5], ['c3', 9]])), { tabId: 't1', chatId: 'c2' }, 'this tab wins over a newer chat elsewhere');
  assert.deepEqual(pickChat(tabs, 't2', new Map([['c1', 5], ['c3', 9]])), { tabId: 't3', chatId: 'c3' });
  assert.deepEqual(pickChat(tabs, 't2', new Map()), { tabId: 't1', chatId: 'c1' }, 'never used: sidebar order');
  assert.equal(pickChat([{ id: 't', chats: [] }], 't', new Map()), undefined);
});

test('sidebar tree keys: up/down, home/end, right opens or steps in, left closes or goes to the parent', () => {
  const rows = [
    { level: 1, expanded: true }, // 0 project A
    { level: 2 }, // 1 tab
    { level: 2, expanded: true, fixed: true }, // 2 split tab
    { level: 3 }, // 3 pane
    { level: 1, expanded: false }, // 4 project B (folded)
    { level: 1 }, // 5 compact rail row
  ];
  assert.deepEqual(treeKey(rows, 1, 'ArrowDown'), { focus: 2 });
  assert.deepEqual(treeKey(rows, 1, 'ArrowUp'), { focus: 0 });
  assert.equal(treeKey(rows, 0, 'ArrowUp'), null);
  assert.equal(treeKey(rows, 5, 'ArrowDown'), null);
  assert.deepEqual(treeKey(rows, 3, 'Home'), { focus: 0 });
  assert.deepEqual(treeKey(rows, 3, 'End'), { focus: 5 });
  assert.deepEqual(treeKey(rows, 4, 'ArrowRight'), { toggle: 4, expand: true });
  assert.deepEqual(treeKey(rows, 0, 'ArrowRight'), { focus: 1 });
  assert.deepEqual(treeKey(rows, 0, 'ArrowLeft'), { toggle: 0, expand: false });
  assert.deepEqual(treeKey(rows, 3, 'ArrowLeft'), { focus: 2 }, 'a pane goes up to its split tab');
  assert.deepEqual(treeKey(rows, 2, 'ArrowLeft'), { focus: 0 }, 'a split tab cannot fold, it goes up');
  assert.deepEqual(treeKey(rows, 2, 'ArrowRight'), { focus: 3 });
  assert.equal(treeKey(rows, 1, 'ArrowRight'), null);
  assert.equal(treeKey(rows, 1, 'Enter'), null, 'Enter stays with the row');
  assert.equal(treeKey([], 0, 'ArrowDown'), null);
  assert.deepEqual([tabStep(3, 2, 'ArrowRight'), tabStep(3, 0, 'ArrowLeft'), tabStep(3, 1, 'Home'), tabStep(3, 1, 'End'), tabStep(3, 1, 'x'), tabStep(0, 0, 'ArrowRight')], [0, 2, 0, 2, null, null]);
});

test('two panes trade places and keep the sizes of their slots', () => {
  const tree = { direction: 'row', sizes: [1, 2], children: [{ id: 'a', kind: 'terminal' }, { direction: 'column', sizes: [1, 1], children: [{ id: 'b', kind: 'chat' }, { id: 'c' }] }] };
  const swapped = swapLeaves(tree, 'a', 'c');
  assert.deepEqual(swapped.children[0], { id: 'c' });
  assert.deepEqual(swapped.children[1].children[1], { id: 'a', kind: 'terminal' });
  assert.deepEqual(swapped.sizes, [1, 2]);
  assert.equal(swapLeaves(tree, 'a', 'missing'), tree);
  assert.deepEqual(tree.children[0], { id: 'a', kind: 'terminal' }, 'the original is untouched');
});

test('new keys: defaults avoid the reserved combos and every palette command can take a key', async t => {
  const { appKeyDefs, appKey, appKeyInTerminal, showAppKey, combosOverlap } = await bundle(t, `export * from './shortcuts';`);
  const keyOf = id => appKey({}, id);
  assert.equal(keyOf('focusChat'), 'mod+alt+c');
  assert.equal(keyOf('focusSidebar'), 'alt+0');
  assert.equal(keyOf('nextAttention'), 'mod+alt+.');
  assert.equal(keyOf('keyGuide'), 'mod+/');
  assert.equal(keyOf('pane9'), 'alt+shift+9');
  // Kept free for the chat and send-to-chat teams.
  for (const reserved of ['mod+enter', 'mod+shift+enter', 'alt+arrowup', 'alt+arrowdown', 'mod+f', 'mod+home', 'mod+end', 'mod+shift+l', 'mod+l', 'mod+alt+l'])
    for (const def of appKeyDefs) if (def.keys && def.id !== 'zoom') assert.ok(!combosOverlap(def.keys, reserved), `${def.id} takes ${reserved}`);
  // Commands with no default have '' (shown as nothing) and can be bound; the server accepts the ids.
  for (const id of ['renameTab', 'moveTabUp', 'moveTabDown', 'detachPane', 'preset', 'equalize', 'branch', 'theme', 'tutorial', 'toggleTree', 'errors', 'usage', 'changelog', 'plugins', 'openFile', 'movePaneTo', 'mergeTab', 'swapPane', 'newclaude', 'splitcursor']) {
    const def = appKeyDefs.find(item => item.id === id);
    assert.ok(def, id); assert.equal(def.keys, '', id); assert.equal(showAppKey({}, id), '');
    assert.equal(showAppKey({ [id]: 'ctrl+alt+k' }, id), 'Ctrl+Alt+K');
  }
  const overrides = Object.fromEntries(appKeyDefs.filter(def => !def.keys).map((def, index) => [def.id, `ctrl+alt+f${(index % 12) + 1}`]));
  assert.doesNotThrow(() => validateAppState({ openProjects: [], activeProjectId: '', settings: { appKeys: overrides, attentionBadge: false } }));
  assert.throws(() => validateAppState({ openProjects: [], activeProjectId: '', settings: { attentionBadge: 'yes' } }));
  // Alt keys reach the app from a terminal; plain Ctrl+Tab stays with the shell there (the command also only acts in an editor).
  const event = (modifiers) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });
  assert.ok(appKeyInTerminal({}, 'focusSidebar', event({ altKey: true })));
  assert.ok(appKeyInTerminal({}, 'focusChat', event({ ctrlKey: true, altKey: true })));
  assert.ok(!appKeyInTerminal({}, 'nextEditorTab', event({ ctrlKey: true })));
});

test('the shortcut guide lists changeable keys with the user\'s choice, then the fixed ones, and searches both', async t => {
  const { keyGuideGroups, fixedKeys, showGuideKey } = await bundle(t, `export * from './key-guide';`);
  const groups = keyGuideGroups({ appKeys: { newTab: 'alt+k' } }, '', false);
  const rows = groups.flatMap(group => group.rows);
  assert.deepEqual(rows.find(row => row.label === '새 탭').keys, ['Alt+K']);
  assert.ok(!rows.some(row => row.label === '탭 이름 바꾸기…'), 'a command without a key is left out');
  assert.ok(groups.findIndex(group => !group.changeable) > groups.findLastIndex(group => group.changeable), 'fixed keys come last');
  assert.deepEqual(rows.find(row => row.label === '저장').keys, ['Ctrl+S']);
  assert.deepEqual(rows.find(row => row.label === '위아래 줄로 이동').keys, ['↑', '↓']);
  assert.equal(showGuideKey('#'), '#');
  assert.equal(showGuideKey('화살표'), '화살표');
  const found = keyGuideGroups({}, '채팅 입력창으로', false);
  assert.deepEqual(found.flatMap(group => group.rows).map(row => row.label), ['채팅 입력창으로 돌아가기']);
  for (const item of fixedKeys) assert.ok(item.group && item.keys && item.label, JSON.stringify(item));
});

test('the desktop shell badges the window: dot overlay on Windows, Dock badge elsewhere, flash only in the background', () => {
  assert.equal(attentionCount(3), 3); assert.equal(attentionCount(-1), 0); assert.equal(attentionCount('2'), 0); assert.equal(attentionCount(500), 99);
  const dot = dotBitmap(16);
  assert.equal(dot.length, 16 * 16 * 4);
  assert.equal(dot[(8 * 16 + 8) * 4 + 3], 255, 'opaque centre'); assert.equal(dot[3], 0, 'clear corner');
  const run = platform => {
    const calls = [], listeners = {}, window = { isDestroyed: () => false, isFocused: () => false, setOverlayIcon: (icon, text) => calls.push(['overlay', Boolean(icon), text]), flashFrame: on => calls.push(['flash', on]), on: (name, fn) => { listeners[name] = fn; } };
    let handler;
    const app = { setBadgeCount: count => calls.push(['badge', count]), dock: { bounce: kind => calls.push(['bounce', kind]) } };
    const attention = setupAttention({ ipcMain: { on: (_name, fn) => { handler = fn; } }, app, nativeImage: { createFromBitmap: () => ({}) }, getWindow: () => window, trusted: event => event.ok, platform });
    attention.attach(window);
    return { calls, send: (count, flash, ok = true) => handler({ ok }, count, flash), focus: () => listeners.focus(), window };
  };
  const win = run('win32');
  win.send(2, true);
  assert.deepEqual(win.calls, [['overlay', true, '확인 필요 2개'], ['flash', true]]);
  win.calls.length = 0; win.send(2, false); assert.deepEqual(win.calls, [], 'same count, no flash: nothing to do');
  win.send(0, false); assert.deepEqual(win.calls, [['overlay', false, ''], ['flash', false]]);
  win.calls.length = 0; win.send(5, true, false); assert.deepEqual(win.calls, [], 'another page may not ask');
  win.focus(); assert.deepEqual(win.calls, [['flash', false]], 'coming back ends the flash');
  const mac = run('darwin');
  mac.window.isFocused = () => true;
  mac.send(1, true);
  assert.deepEqual(mac.calls, [['badge', 1]], 'a focused window is not flashed');
});
