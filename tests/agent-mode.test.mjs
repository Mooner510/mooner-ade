import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { launchersFor } from '../apps/web/src/launchers.ts';
import { chatModeTipDue, nextHint } from '../apps/web/src/tips.ts';
import { validateAppState } from '../apps/local-server/src/ui-state.js';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
const bundle = await build({ stdin: { contents: "export { defaultSettings, migrateSettings, TOUR_VERSION } from './apps/web/src/Editor'; export { shellLabel } from './apps/web/src/shells';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['monaco-editor', 'monaco-editor/*'] });
const { defaultSettings, migrateSettings, TOUR_VERSION, shellLabel } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const app = settings => ({ openProjects: [], activeProjectId: '', settings });

test('each mode has one launcher per provider and keeps the shell', () => {
  for (const mode of ['chat', 'cli']) {
    const items = launchersFor(mode);
    assert.deepEqual(items.map(item => item.label), ['터미널', 'Claude', 'Codex', 'Cursor']);
    assert.equal(new Set(items.map(item => item.id)).size, 4);
    assert.deepEqual(items.map(item => item.command), mode === 'chat'
      ? ['', 'ade:chat:claude', 'ade:chat:codex', 'ade:chat:cursor'] : ['', 'claude', 'codex', 'cursor-agent']);
  }
});

test('new users start in Chat and are invited until they open it; old users retain CLI on their first upgrade', () => {
  assert.equal(defaultSettings.defaultMode, 'chat');
  assert.equal(defaultSettings.chatTipPending, true, 'a new user who picks CLI has still never seen Chat');
  const old = migrateSettings({ theme: 'light' });
  assert.equal(old.defaultMode, 'cli');
  assert.equal(old.chatTipPending, true);
  assert.equal(old.theme, 'light');
  assert.equal(migrateSettings({ onboarded: false }).chatTipPending, false);
  assert.deepEqual(migrateSettings(old), old);
});

test('new chats default to auto mode; the old saved "cli" default moves once, a later explicit choice stays', () => {
  assert.equal(defaultSettings.chatDefaultPermission, 'auto');
  assert.equal(migrateSettings({ chatDefaultPermission: 'cli' }).chatDefaultPermission, 'auto', 'the old default, not a choice');
  assert.equal(migrateSettings({}).chatDefaultPermission, 'auto');
  assert.equal(migrateSettings({ chatDefaultPermission: 'plan' }).chatDefaultPermission, 'plan', 'an explicit pick is kept');
  const migrated = migrateSettings({ chatDefaultPermission: 'cli' });
  assert.equal(migrateSettings({ ...migrated, chatDefaultPermission: 'cli' }).chatDefaultPermission, 'cli', 'chosen after the migration');
});

test('a newer tutorial is due once more for everyone who finished an older one, then stays done', () => {
  assert.equal(migrateSettings({ onboarded: true, defaultMode: 'chat' }).onboarded, false, 'finished before tourVersion existed');
  assert.equal(migrateSettings({ onboarded: true, tourVersion: TOUR_VERSION - 1 }).onboarded, false);
  const finished = { ...migrateSettings({ onboarded: true }), onboarded: true, tourVersion: TOUR_VERSION };
  assert.deepEqual(migrateSettings(JSON.parse(JSON.stringify(finished))), finished, 'finishing it is kept');
  assert.equal(migrateSettings({ onboarded: true }).chatTipPending, true, 'still an old user for the Chat invitation');
});

test('the upgrade tip is limited to CLI providers, and dismissal survives saves and later migrations', () => {
  const old = migrateSettings({ onboarded: true });
  for (const agent of ['claude', 'codex', 'cursor']) {
    assert.equal(chatModeTipDue(old, 'terminal', agent), true);
    assert.equal(chatModeTipDue(old, undefined, agent), true, 'legacy terminal leaves have no kind');
    assert.equal(chatModeTipDue(old, 'chat', agent), false);
    assert.equal(chatModeTipDue(old, 'editor', agent), false);
  }
  assert.equal(chatModeTipDue(old, 'terminal', undefined), false);
  assert.equal(chatModeTipDue({ ...old, defaultMode: 'chat' }, 'terminal', 'claude'), true, 'a Chat default does not mean Chat was tried');
  assert.equal(chatModeTipDue({ ...old, tips: false }, 'terminal', 'claude'), false);
  const dismissed = validateAppState(app({ ...old, chatTipPending: false })).settings;
  assert.equal(chatModeTipDue(migrateSettings(JSON.parse(JSON.stringify(dismissed))), 'terminal', 'claude'), false);
  assert.equal(chatModeTipDue(defaultSettings, 'terminal', 'claude'), true);
});

test('button hints: one at a time, in order, never during the tour, and remembered once acknowledged', () => {
  const settings = { ...defaultSettings, onboarded: true };
  assert.equal(nextHint(settings, [['tocli', true], ['stats', true]]), 'tocli');
  assert.equal(nextHint(settings, [['tocli', false], ['stats', 'sid']]), 'stats', 'any truthy condition counts');
  assert.equal(nextHint({ ...settings, hintsSeen: ['tocli'] }, [['tocli', true], ['stats', true]]), 'stats');
  assert.equal(nextHint({ ...settings, hintsSeen: ['tocli', 'stats'] }, [['tocli', true], ['stats', true]]), undefined);
  assert.equal(nextHint({ ...settings, onboarded: false }, [['tocli', true]]), undefined, 'not over the tour');
  assert.equal(nextHint({ ...settings, tips: false }, [['tocli', true]]), undefined);
  assert.deepEqual(validateAppState(app({ hintsSeen: ['tocli', 'stats', 'tochat'] })).settings.hintsSeen, ['tocli', 'stats', 'tochat']);
  const keys = ['keymodel', 'keyeffort', 'keymode', 'keystash']; // the composer's shortcut pointers (ChatPane)
  assert.deepEqual(validateAppState(app({ hintsSeen: keys })).settings.hintsSeen, keys);
  for (const hintsSeen of ['tocli', [1], ['<script>']]) assert.throws(() => validateAppState(app({ hintsSeen })), { code: 'INVALID_INPUT' });
});

test('mode and upgrade eligibility are validated at the persistence boundary', () => {
  for (const defaultMode of ['cli', 'chat']) assert.equal(validateAppState(app({ defaultMode, chatTipPending: true })).settings.defaultMode, defaultMode);
  for (const settings of [{ defaultMode: 'terminal' }, { defaultMode: null }, { chatTipPending: 'false' }]) assert.throws(() => validateAppState(app(settings)), { code: 'INVALID_INPUT' });
});


test('the launcher names the selected shell or the actual automatic fallback', () => {
  const list = { shells: [{ id: 'pwsh', label: 'PowerShell 7' }, { id: 'cmd', label: '명령 프롬프트 (cmd)' }], default: 'pwsh' };
  assert.equal(shellLabel(list, ''), 'PowerShell 7');
  assert.equal(shellLabel(list, 'cmd'), '명령 프롬프트 (cmd)');
  assert.equal(shellLabel(list, 'removed-shell'), 'PowerShell 7');
  assert.equal(shellLabel(null, ''), '');
  assert.equal(launchersFor('cli', shellLabel(list, 'cmd'))[0].detail, '명령 프롬프트 (cmd)');
});
