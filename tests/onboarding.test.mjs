import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// onboarding-steps.ts imports ./api without an extension, so bundle it with the esbuild that ships with vite.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
const bundle = await build({ entryPoints: ['apps/web/src/onboarding-steps.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { initialTour, reduce, stepDone, steps, activeTab, project, latin } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const list = steps(keys => keys), step = id => list.find(item => item.id === id);
// The step id only labels which lesson the actions belong to; goals count in any step.
const play = (_lesson, actions, tour = initialTour()) => actions.reduce((state, action) => reduce(state, action, 1000), tour);

test('a step unlocks only after its own gestures', () => {
  assert.equal(stepDone(step('welcome'), initialTour()), true);
  assert.equal(stepDone(step('tabs'), play('tabs', [{ type: 'tab', id: 'build' }])), false);
  assert.equal(stepDone(step('tabs'), play('tabs', [{ type: 'tab', id: 'server' }, { type: 'jump', index: 0 }, { type: 'cycle', step: 1 }])), true);
  assert.equal(stepDone(step('newTab'), play('projects', [{ type: 'newTab' }, { type: 'launch', target: '', agent: 'codex' }])), true, 'done ahead of its step still counts');
});

test('a goal counts however it is reached: click, key or palette', () => {
  const byKey = play('projects', [{ type: 'project', id: 'api-server' }, { type: 'projectJump', index: 0 }]);
  assert.equal(byKey.current, 'my-app');
  assert.equal(stepDone(step('projects'), byKey), true);
  assert.equal(stepDone(step('projects'), play('projects', [{ type: 'projectJump', index: 1 }, { type: 'project', id: 'my-app' }])), true, 'back to my-app by click');
  assert.equal(stepDone(step('projects'), play('projects', [{ type: 'project', id: 'my-app' }])), false, 'staying put is not going back');
  assert.equal(stepDone(step('tabs'), play('tabs', [{ type: 'tab', id: 'server' }, { type: 'tab', id: 'web' }])), true, 'clicks reach the first and the next tab too');
  assert.equal(stepDone(step('newTab'), play('newTab', [{ type: 'launch', target: '', agent: 'claude' }])), true, '▾ menu opens the tab and launches');
});

test('new tab, launcher, Claude and the follow-up queue', () => {
  let tour = play('newTab', [{ type: 'newTab' }]);
  assert.equal(activeTab(tour).pane, null, 'a new tab starts on the launcher page');
  tour = play('newTab', [{ type: 'launch', target: activeTab(tour).id, agent: 'claude' }], tour);
  assert.equal(stepDone(step('newTab'), tour), true);
  const leaf = tour.claude.leaf;
  tour = play('followUp', [{ type: 'queue', text: 'too early' }, { type: 'submit', leaf, text: 'use PORT' }, { type: 'queue', text: 'add a test' }], tour);
  assert.deepEqual(tour.claude.queue, ['add a test']);
  assert.equal(stepDone(step('followUp'), tour), true);
  tour = reduce(tour, { type: 'workDone' }, 2000);
  assert.equal(tour.claude.state, 'working', 'the queued follow-up is sent right away');
  assert.deepEqual(tour.claude.queue, []);
  tour = reduce(tour, { type: 'workDone' }, 3000);
  assert.equal(tour.claude.state, 'idle', 'finished while watching');
});

test('Claude asks only while you look elsewhere; ⚠ tab, answer, diff', () => {
  let tour = play('newTab', [{ type: 'launch', target: '', agent: 'claude' }]);
  const leaf = tour.claude.leaf;
  assert.equal(reduce(tour, { type: 'ask' }).claude.state, 'idle', 'no question while watching');
  tour = play('alert', [{ type: 'tab', id: 'web' }, { type: 'ask' }], tour);
  assert.equal(tour.claude.state, 'asking');
  const claudeTabId = project(tour).tabs.at(-1).id;
  tour = play('alert', [{ type: 'tab', id: claudeTabId }, { type: 'submit', leaf, text: 'ㅇㅇ' }], tour);
  assert.equal(stepDone(step('alert'), tour), true);
  assert.equal(tour.changes, 1);
  assert.equal(stepDone(step('diff'), play('diff', [{ type: 'diff' }], tour)), false, 'opened but not closed yet');
  tour = play('diff', [{ type: 'diff' }, { type: 'diff' }], tour);
  assert.equal(stepDone(step('diff'), tour), true);
});

test('split into a launcher pane, fill it, move focus and zoom', () => {
  let tour = play('split', [{ type: 'split', dir: 'row' }]);
  const launcher = tour.focus;
  assert.equal(activeTab(tour).pane.children[1].kind, 'launcher');
  tour = play('split', [{ type: 'launch', target: launcher, agent: '' }, { type: 'split', dir: 'column' }], tour);
  assert.equal(stepDone(step('split'), tour), true);
  assert.equal(stepDone(step('pane'), play('pane', [{ type: 'pick', id: 'l-web' }, { type: 'zoom' }], tour)), true, 'clicking another pane moves focus too');
  tour = play('pane', [{ type: 'focusBy', step: 1 }, { type: 'zoom' }], tour);
  assert.equal(tour.zoom, tour.focus);
  assert.equal(stepDone(step('pane'), tour), true);
});

test('any tab move counts as reordering; required tabs cannot be closed or merged', () => {
  assert.equal(stepDone(step('reorder'), play('reorder', [{ type: 'move', id: 'web', to: 1 }])), true);
  const tour = play('reorder', [{ type: 'move', id: 'build', to: 1 }, { type: 'move', id: 'build', to: 0 }]);
  assert.deepEqual(project(tour).tabs.map(tab => tab.id), ['build', 'web', 'server']);
  assert.equal(stepDone(step('reorder'), tour), true);
  assert.equal(project(reduce(tour, { type: 'closeTab', id: 'web' })).tabs.length, 3);
  assert.equal(project(reduce(tour, { type: 'merge', id: 'web', into: 'build' })).tabs.length, 3);
});

test('palette: any command counts; settings open then close', () => {
  let tour = play('palette', [{ type: 'palette', open: true }, { type: 'launch', target: '', agent: 'codex' }, { type: 'command' }, { type: 'palette', open: false }]);
  assert.equal(stepDone(step('palette'), tour), true);
  assert.equal(activeTab(tour).label, 'Codex');
  tour = play('settings', [{ type: 'settings', open: true }, { type: 'settings', open: false }]);
  assert.equal(stepDone(step('settings'), tour), true);
});

test('loose input: any agent, empty requests, Korean-layout commands', () => {
  let tour = play('newTab', [{ type: 'launch', target: '', agent: 'cursor' }]);
  assert.equal(stepDone(step('newTab'), tour), true, 'Cursor CLI is as good as Claude Code');
  const leaf = tour.claude.leaf;
  tour = play('followUp', [{ type: 'submit', leaf, text: '' }, { type: 'submit', leaf, text: '' }], tour);
  assert.equal(stepDone(step('followUp'), tour), true, 'Enter on an empty prompt sends an example, then queues one');
  assert.equal(tour.claude.queue.length, 1);
  assert.equal(latin('치명ㄷ'), 'claude');
  const shell = play('newTab', [{ type: 'submit', leaf: 'l-web', text: '치명ㄷ' }]);
  assert.equal(shell.agents['l-web'], 'claude', 'claude typed with the Korean layout on');
});
