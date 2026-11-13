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

test('the tour is short: only ADE-specific lessons, none about typing a request', () => {
  assert.deepEqual(list.map(item => item.id), ['welcome', 'projects', 'chat', 'cli', 'alert', 'diff', 'split', 'palette', 'finish']);
  assert.ok(list.every(item => item.tasks.length <= 3));
  assert.ok(!list.some(item => item.tasks.some(task => ['ask', 'queue'].includes(task.flag))), 'sending a message is not a lesson');
});

test('a step unlocks only after its own gestures', () => {
  assert.equal(stepDone(step('welcome'), initialTour()), true);
  assert.equal(stepDone(step('projects'), play('projects', [{ type: 'project', id: 'api-server' }])), false);
  assert.equal(stepDone(step('chat'), play('chat', [{ type: 'newTab' }, { type: 'launch', target: '', agent: 'codex' }])), false, 'a CLI launch is not the Chat lesson');
  assert.equal(stepDone(step('split'), play('projects', [{ type: 'split', dir: 'row' }, { type: 'launch', target: 'l1', agent: '' }])), true, 'done ahead of its step still counts');
});

test('a goal counts however it is reached: click, key or palette', () => {
  const byKey = play('projects', [{ type: 'project', id: 'api-server' }, { type: 'projectJump', index: 0 }]);
  assert.equal(byKey.current, 'my-app');
  assert.equal(stepDone(step('projects'), byKey), true);
  assert.equal(stepDone(step('projects'), play('projects', [{ type: 'projectJump', index: 1 }, { type: 'project', id: 'my-app' }])), true, 'back to my-app by click');
  assert.equal(stepDone(step('projects'), play('projects', [{ type: 'project', id: 'my-app' }])), false, 'staying put is not going back');
  assert.deepEqual(byKey.done, ['projectVisit', 'projectBack'], 'moving around with no agent yet does not tick the alert lesson');
  const menu = play('chat', [{ type: 'launch', target: '', agent: 'claude', chat: true }]);
  assert.ok(menu.done.includes('newTab') && menu.done.includes('chat'), '▾ menu or palette opens the tab and the chat at once');
});

test('Chat opens as a chat pane, then switches to the same agent CLI in place', () => {
  let tour = play('chat', [{ type: 'newTab' }]);
  assert.equal(activeTab(tour).pane, null, 'a new tab starts on the launcher page');
  tour = play('chat', [{ type: 'launch', target: activeTab(tour).id, agent: 'cursor', chat: true }], tour);
  const leaf = activeTab(tour).pane;
  assert.equal(leaf.kind, 'chat');
  assert.equal(leaf.agent, 'cursor');
  assert.equal(tour.claude, null, 'a chat is not the scripted CLI agent');
  assert.equal(stepDone(step('chat'), tour), true, 'the showcase step only needs the chat open');
  assert.equal(stepDone(step('cli'), tour), false);
  tour = play('cli', [{ type: 'toCli', id: leaf.id }], tour);
  assert.equal(activeTab(tour).pane.kind, 'terminal');
  assert.equal(activeTab(tour).pane.id, leaf.id, 'same pane, same place');
  assert.equal(tour.claude.leaf, leaf.id, 'the switched CLI answers the alert lesson');
  assert.match(tour.lines[leaf.id].join('\n'), /Cursor CLI/);
  assert.equal(stepDone(step('cli'), tour), true);
  assert.equal(reduce(tour, { type: 'toCli', id: 'l-web' }), tour, 'only a chat switches');
});

test('the agent asks only while you look elsewhere; ⚠ tab, answer, diff', () => {
  let tour = play('chat', [{ type: 'launch', target: '', agent: 'claude', chat: true }]);
  tour = play('chat', [{ type: 'toCli', id: activeTab(tour).pane.id }], tour);
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

test('split into a launcher pane and fill it with a chat or a terminal', () => {
  let tour = play('split', [{ type: 'split', dir: 'row' }]);
  const launcher = tour.focus;
  assert.equal(activeTab(tour).pane.children[1].kind, 'launcher');
  tour = play('split', [{ type: 'launch', target: launcher, agent: 'codex', chat: true }], tour);
  assert.equal(activeTab(tour).pane.children[1].kind, 'chat');
  assert.equal(stepDone(step('split'), tour), true);
  tour = play('pane', [{ type: 'focusBy', step: 1 }, { type: 'zoom' }], tour);
  assert.equal(tour.zoom, tour.focus, 'keys still work outside the lessons');
});

test('required tabs cannot be closed or merged; the palette lesson is one gesture', () => {
  const tour = play('reorder', [{ type: 'move', id: 'build', to: 1 }, { type: 'move', id: 'build', to: 0 }]);
  assert.deepEqual(project(tour).tabs.map(tab => tab.id), ['build', 'web', 'server']);
  assert.equal(project(reduce(tour, { type: 'closeTab', id: 'web' })).tabs.length, 3);
  assert.equal(project(reduce(tour, { type: 'merge', id: 'web', into: 'build' })).tabs.length, 3);
  assert.equal(stepDone(step('palette'), play('palette', [{ type: 'palette', open: true }])), true);
});

test('the CLI sandbox still takes requests, follow-ups and loose input', () => {
  let tour = play('chat', [{ type: 'launch', target: '', agent: 'cursor' }]);
  const leaf = tour.claude.leaf;
  tour = play('free', [{ type: 'submit', leaf, text: '' }, { type: 'submit', leaf, text: '' }], tour);
  assert.equal(tour.claude.queue.length, 1, 'Enter on an empty prompt sends an example, then queues one');
  tour = reduce(tour, { type: 'workDone' }, 2000);
  assert.equal(tour.claude.state, 'working', 'the queued follow-up is sent right away');
  assert.equal(latin('치명ㄷ'), 'claude');
  const shell = play('free', [{ type: 'submit', leaf: 'l-web', text: '치명ㄷ' }]);
  assert.equal(shell.agents['l-web'], 'claude', 'claude typed with the Korean layout on');
});
