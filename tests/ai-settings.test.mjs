import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAppState } from '../apps/local-server/src/ui-state.js';

const state = settings => ({ openProjects: [], activeProjectId: '', settings });
const ok = settings => validateAppState(state(settings)).settings;

test('AI tool settings accept valid values', () => {
  const settings = { agentsOff: ['codex'], agentsMuted: ['cursor'], claudeArgs: '--model opus', codexArgs: '', cursorArgs: '--model auto', notifyLooking: true, cacheTimer: false, cacheWarn: 5, cacheSendWarn: false, cacheSendWarnMinutes: 60, followUpQueue: false, usageRefresh: 600 };
  assert.deepEqual(ok(settings), settings);
});

test('AI tool settings reject out-of-range or unsafe values', () => {
  for (const bad of [{ cacheWarn: 4 }, { cacheWarn: 51 }, { cacheWarn: 10.5 }, { cacheSendWarnMinutes: 0 }, { cacheSendWarnMinutes: 61 }, { cacheSendWarnMinutes: 1.5 }, { cacheSendWarnMinutes: '10' }, { cacheSendWarn: 'yes' }, { usageRefresh: 59 }, { usageRefresh: 601 }, { agentsOff: ['shell'] }, { agentsMuted: 'claude' },
    { claudeArgs: '--model opus\nrm -rf ~' }, { codexArgs: 'x'.repeat(513) }, { cursorArgs: 5 }, { cacheTimer: 'yes' }, { followUpQueue: 1 }, { notifyLooking: null }])
    assert.throws(() => ok(bad), /잘못된 앱 상태/, JSON.stringify(bad).slice(0, 40));
});
