import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateAppState, validateUi } from '../apps/local-server/src/ui-state.js';
import { createPluginStore } from '../apps/desktop/src/plugin-core.js';

// What a v0.5.12 install saved (taken from a real v0.5.12 session of the update e2e, hand-changed: light theme, accent, shortcut, hidden status items). The 0.6.0 validators and
// stores must read it as it is: a rejected save would stop every later settings change from being kept.
const settings0512 = {
  theme: 'light', fontSize: 13, terminalFontSize: 15, wordWrap: true, dimInactivePanes: true, terminalFont: 'Cascadia Mono', lineHeight: 1.2, scrollback: 10000, cursorStyle: 'block', cursorBlink: true, copyOnSelect: false, sidebarWidth: 252,
  statusItems: ['connection', 'path', 'branch', 'cpu', 'memory', 'claudeusage', 'codexusage', 'clock', 'openproject'], statusLeft: ['connection', 'path', 'branch'],
  statusRight: ['cpu', 'memory', 'claudeusage', 'codexusage', 'cursorusage', 'wakatime', 'clock', 'readiness', 'openproject'],
  usageColors: true, notifyDone: true, notifyApproval: true, notifySound: true, soundDone: 'marimba', soundAttention: 'alert', soundVolume: 60, soundVolumeExtended: false, diffRefresh: 3, wakatime: false, wakatimeBackground: true,
  terminalShell: '', claudeSession: true, agentsOff: [], agentsMuted: [], claudeArgs: '', codexArgs: '', cursorArgs: '', notifyLooking: false, cacheTimer: true, cacheWarn: 20, cacheSendWarn: true, cacheSendWarnMinutes: 10,
  followUpQueue: true, interactiveUi: true, artifactAlways: false, usageRefresh: 120, chatKeys: {}, appKeys: { review: 'ctrl+alt+d' }, defaultMode: 'chat', chatTipPending: false, tips: true, contextTipK: 400, hintsSeen: ['tocli', 'stats'],
  tmuxGuide: 'auto', tmuxPrefix: 'b', accentColor: '#a78bfa', terminalFontWeight: 400, rightClickPaste: false, optionAsMeta: false, confirmClose: true, letterSpacing: 0, scrollSensitivity: 1, minimumContrast: 1,
  wordSeparator: ' ()[]{}\',"`─‘’“”|', boldBright: true, terminalGpu: true, diffLayout: 'split', diffIgnoreWhitespace: false, diffFoldUnchanged: true, diffContextLines: 3, clock12h: false, clockSeconds: false, systemRefresh: 5, reviewWidth: 480,
  onboarded: true, tourVersion: 2, chatStatusItems: ['tokens', 'cost', 'share'], chatStatusLeft: ['status', 'tokens', 'turns'], chatStatusRight: ['cost', 'share', 'duration', 'session', 'model', 'mode', 'context'], chatStatusSeparator: '',
  chatSendKey: 'mod-enter', chatToolsOpen: false, chatToolDisplay: 'detail', chatThinkingOpen: 'live', chatAutoScroll: true, chatSmoothStream: true, chatFontSize: 13, chatWidth: 'wide', chatComposerMax: 220, chatModelPins: {},
  chatDefaultPermission: 'plan', chatPermissionAutoSet: true, chatDefaultEffort: 'auto', uiZoom: 100, diffFont: '', sidebarCompact: false, animateInBackground: false, terminalBell: 'off', diffComputeMs: 2000, confirmCloseChat: true,
  confirmCloseProject: true, feedbackAgentTool: true, feedbackAiContext: true, feedbackAiModel: 'claude-haiku-5-5', feedbackAiEffort: 'low'
};

test('app state saved by 0.5.12 is accepted as it is, and the settings the page adds on top of it (0.6.0 keys) are accepted too', () => {
  const state = { openProjects: [{ id: 'p1', root: 'C:\\work\\repo' }, { id: 'p2', root: 'C:\\work\\notes' }], activeProjectId: 'p2', settings: settings0512 };
  assert.deepEqual(validateAppState(state).settings, settings0512, 'nothing of the old settings is dropped or rewritten');
  // What the 0.6.0 page saves back after migrateSettings: the old keys, the shortcut moved from `review` to `gitLog`, and the new keys with their defaults.
  const migrated = { ...settings0512, appKeys: { gitLog: 'ctrl+alt+d' }, theme: 'light', gitTipPending: true, termKeys: {}, usageStyle: 'bar', usageShown: { claude: ['session', 'weekly', 'fable', 'credit'], codex: ['session', 'weekly', 'credit'], cursor: ['auto', 'api', 'total'] },
    chatFileChipLabel: 'path', gitLogHeight: 380, gitLogDock: false, gitLogLimit: 5000, gitSort: 'date', gitColumns: ['author', 'date'], gitFavorites: ['main', 'master', 'origin/main', 'origin/master'], gitProtected: 'main, master', gitBranchClick: 'none', gitUpdateMethod: 'merge' };
  assert.deepEqual(validateAppState({ ...state, settings: migrated }).settings, migrated);
  // A theme id that no longer exists would still be accepted by the server (the page maps it to dark), and 0.5.12's two ids are plain ids.
  for (const theme of ['dark', 'light']) validateAppState({ ...state, settings: { ...settings0512, theme } });
});

test('a project layout saved by 0.5.12 (split panes, the open changes panel, a diff tab) still validates', () => {
  const layout = {
    gitRepositoryId: 'repo-id', focus: 'term-1', activeTab: 'tab-1', rightVisible: true,
    paneTabs: [
      { id: 'tab-1', focus: 'term-1', pane: { direction: 'row', children: [{ id: 'chat-1', kind: 'chat', agent: 'claude' }, { id: 'term-1', kind: 'terminal', cwd: 'C:\\work\\repo' }], sizes: [1, 1] } },
      { id: 'tab-2', pane: null },
      { id: 'tab-3', focus: 'ed-1', pane: { id: 'ed-1', kind: 'editor', tabs: ['diff:src/a.ts'], active: 'diff:src/a.ts' } }
    ]
  };
  const saved = validateUi(layout);
  assert.deepEqual(saved.paneTabs.map(tab => tab.id), ['tab-1', 'tab-2', 'tab-3']);
  assert.equal(saved.rightVisible, true);
  assert.equal(saved.paneTabs[0].pane.children[0].kind, 'chat');
});

// The plugin storage v0.5.12 wrote: plugins.json (what is not secret) and plugins.bin (everything, sealed; here the "seal" is a marker so the test needs no OS keychain).
const crypto = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(`sealed:${text}`), decryptString: blob => { const text = blob.toString(); if (!text.startsWith('sealed:')) throw new Error('not sealed'); return text.slice(7); } };
const hash = 'a'.repeat(64);
const sealed0512 = { version: 1, enabled: true, approved: { 'demo-plugin': { hash, folder: 'demo-plugin', version: '1.2.0', approvedAt: 1700000000000 } }, data: { 'demo-plugin': '{"token":"secret-value","n":3}' },
  mcp: { 'demo-plugin': { off: false, disabled: ['tool_a'] } }, builtin: { 'agent-bus': { enabled: false } }, updates: { 'demo-plugin': { mode: 'auto', notified: '1.3.0' } },
  github: { token: `ghp_${'x'.repeat(30)}`, login: 'octo', via: 'pat', at: 5 }, ghAccount: 'octo' };
const plain0512 = { ...sealed0512, approved: {}, data: {}, github: { login: 'octo', via: 'pat', at: 5 } };

test('plugin settings, approvals, stored data and the GitHub sign-in written by 0.5.12 are all still there in 0.6.0 (which adds an empty Hub sign-in)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ade-update-plugins-'));
  try {
    const file = path.join(dir, 'plugins.bin');
    await writeFile(file, crypto.encryptString(JSON.stringify(sealed0512)));
    await writeFile(path.join(dir, 'plugins.json'), JSON.stringify(plain0512));
    const store = createPluginStore({ file, crypto });
    const state = store.load();
    assert.equal(store.problem, null);
    assert.equal(state.enabled, true);
    assert.deepEqual({ ...state.approved }, sealed0512.approved, 'the approved plugin keeps its approval (the content hash is unchanged)');
    assert.deepEqual({ ...state.data }, sealed0512.data);
    assert.deepEqual(state.mcp, sealed0512.mcp); assert.deepEqual(state.builtin, sealed0512.builtin); assert.deepEqual(state.updates, sealed0512.updates);
    assert.equal(state.github.login, 'octo'); assert.equal(state.github.token, sealed0512.github.token); assert.equal(state.ghAccount, 'octo');
    assert.equal(state.hub, null, 'no Hub sign-in yet');
    // A change made by 0.6.0 keeps everything that was sealed, and the file stays readable by a fresh store.
    store.update(current => ({ ...current, updates: { ...current.updates, 'demo-plugin': { mode: 'notify', notified: '1.3.0' } } }));
    const again = createPluginStore({ file, crypto }).load();
    assert.deepEqual({ ...again.approved }, sealed0512.approved); assert.deepEqual({ ...again.data }, sealed0512.data); assert.equal(again.github.token, sealed0512.github.token);
    assert.equal(again.updates['demo-plugin'].mode, 'notify');
    assert.equal(JSON.parse(await readFile(path.join(dir, 'plugins.json'), 'utf8')).github.token, undefined, 'the token never lands in the plain file');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the first launch after the update shows one thing at a time: update notes, the Git card, then the tips; and nothing again once each was dismissed', async () => {
  const { createNotices } = await import('../apps/web/src/notices.ts');
  const notices = createNotices(), shown = [];
  notices.subscribe(() => shown.push(notices.current()));
  // Everything a 0.5.12 user's first start asks for at about the same time (settings from 0.5.12, an update with an unread note, a newer Claude Code, the window losing focus, a chat pointer).
  for (const id of ['hint:chat-1', 'bg-anim', 'chat-mode', 'git', 'changelog']) notices.want(id, true);
  assert.equal(notices.current(), 'changelog', 'the update notes first');
  notices.want('changelog', false); assert.equal(notices.current(), 'git', 'closing them brings the Git card');
  notices.want('git', false); assert.equal(notices.current(), 'chat-mode');
  notices.want('chat-mode', false); assert.equal(notices.current(), 'bg-anim');
  notices.want('bg-anim', false); assert.equal(notices.current(), 'hint:chat-1');
  notices.want('hint:chat-1', false);
  assert.equal(notices.current(), null);
  // A launch where none of them is due (their own once-only memory is spent) asks for nothing, so nothing shows.
  assert.deepEqual(shown, ['hint:chat-1', 'bg-anim', 'chat-mode', 'git', 'changelog', 'git', 'chat-mode', 'bg-anim', 'hint:chat-1', null]);
});
