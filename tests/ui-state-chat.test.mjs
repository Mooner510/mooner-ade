import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAppState, validateUi } from '../apps/local-server/src/ui-state.js';

const app = settings => ({ openProjects: [], activeProjectId: '', settings });
const ui = pane => ({ gitRepositoryId: '', focus: '', activeTab: 't', rightVisible: false, paneTabs: [{ id: 't', pane }] });

test('a chat leaf survives validation', () => {
  for (const agent of ['claude', 'codex', 'cursor']) assert.equal(validateUi(ui({ id: 'c1', kind: 'chat', agent })).paneTabs[0].pane.agent, agent);
  assert.throws(() => validateUi(ui({ id: 'c1', kind: 'nope' })));
});

test('chat status settings accept a well-formed layout and reject a bad one', () => {
  validateAppState(app({ chatStatusItems: ['model'], chatStatusSeparator: '·' }));
  assert.throws(() => validateAppState(app({ chatStatusItems: ['Bad Id'] })));
  assert.throws(() => validateAppState(app({ chatStatusSeparator: '123456789' })));
});

test('chat, zoom and bell settings accept valid values and reject the rest', () => {
  const good = { chatSendKey: 'mod-enter', chatToolsOpen: true, chatThinkingOpen: 'always', chatAutoScroll: false, chatSmoothStream: false, chatFontSize: 15, chatWidth: 'wide', chatComposerMax: 400,
    chatDefaultPermission: 'plan', chatDefaultEffort: 'high', uiZoom: 110, diffFont: 'Fira Code', sidebarCompact: true, terminalBell: 'visual', diffComputeMs: 5000, confirmCloseChat: false, confirmCloseProject: false };
  assert.deepEqual(validateAppState(app(good)).settings, good);
  for (const bad of [{ chatSendKey: 'space' }, { chatThinkingOpen: 'yes' }, { chatWidth: 'huge' }, { chatDefaultPermission: 'bypassPermissions' }, { chatDefaultEffort: 'ultra' }, { terminalBell: 'loud' },
    { chatFontSize: 10 }, { chatFontSize: 21 }, { chatComposerMax: 119 }, { chatComposerMax: 601 }, { uiZoom: 79 }, { uiZoom: 151 }, { uiZoom: 100.5 }, { diffComputeMs: 999 }, { diffComputeMs: 20001 },
    { diffFont: 3 }, { diffFont: 'x'.repeat(201) }, { chatToolsOpen: 'yes' }, { sidebarCompact: 1 }, { confirmCloseChat: 'no' }])
    assert.throws(() => validateAppState(app(bad)), { code: 'INVALID_INPUT' }, JSON.stringify(bad));
});
