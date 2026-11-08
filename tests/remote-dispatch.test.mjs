import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteApi, remoteMessage, scopeSummary } from '../apps/local-server/src/remote-dispatch.js';

const forbidden = { code: 'REMOTE_FORBIDDEN' }, invalid = { code: 'INVALID_INPUT' };

test('actions outside the list are refused for every scope', () => {
  for (const action of ['project/clone', 'project/create', 'picker/parent', 'dialog/folder', 'wakatime/config', 'wakatime/status', 'recent/remove', 'recent/pin', 'ui', 'project/close', 'remote/config', 'constructor', '__proto__', 'toString', ''])
    for (const scope of ['view', 'control']) assert.throws(() => remoteApi(action, {}, scope), forbidden, `${action} ${scope}`);
  assert.throws(() => remoteApi('snapshot', { projectId: 'p' }, 'admin'), forbidden);
  assert.throws(() => remoteApi('snapshot', { projectId: 'p' }, undefined), forbidden);
});

test('view reads; control also changes things', () => {
  assert.equal(remoteApi('git/status', { projectId: 'p' }, 'view').action, 'git/status');
  for (const action of ['terminal/open', 'terminal/close', 'terminal/follow-up', 'git/checkout', 'project/open'])
    assert.throws(() => remoteApi(action, {}, 'view'), forbidden, action);
  assert.equal(remoteApi('terminal/open', { projectId: 'p' }, 'control').check, 'remote-terminal');
  assert.equal(remoteApi('project/open', { path: '/x' }, 'control').check, 'known-project');
});

test('only listed fields pass, so flags like force never reach the server', () => {
  assert.deepEqual(remoteApi('readiness', { force: true }, 'control').input, {});
  assert.deepEqual(remoteApi('usage/status', { provider: 'claude', force: true }, 'control').input, { provider: 'claude' });
  assert.deepEqual(remoteApi('terminal/open', { projectId: 'p', restoreId: '../x', agent: 'claude' }, 'control').input, { projectId: 'p', agent: 'claude' });
  assert.throws(() => remoteApi('terminal/open', { projectId: 'p', agent: 'bash' }, 'control'), invalid);
  assert.throws(() => remoteApi('snapshot', {}, 'view'), invalid);
  assert.throws(() => remoteApi('snapshot', { projectId: 'a\nb' }, 'view'), invalid);
  assert.throws(() => remoteApi('snapshot', [], 'view'), invalid);
});

test('app state is read-only and the working tree needs control', () => {
  assert.deepEqual(remoteApi('app/state', {}, 'view').input, {});
  assert.throws(() => remoteApi('app/state', { state: { openProjects: [] } }, 'control'), forbidden);
  assert.ok(remoteApi('git/show', { projectId: 'p', path: 'a.txt', staged: true }, 'view'));
  assert.throws(() => remoteApi('git/show', { projectId: 'p', path: 'a.txt', working: true }, 'view'), forbidden);
  assert.ok(remoteApi('git/show', { projectId: 'p', path: 'a.txt', working: true }, 'control'));
});

test('session messages follow the same rules', () => {
  assert.deepEqual(remoteMessage({ type: 'subscribe', projectId: 'p', extra: 1 }, 'view'), { type: 'subscribe', projectId: 'p' });
  for (const type of ['terminal/input', 'terminal/resize', 'terminal/paste-image']) assert.throws(() => remoteMessage({ type, projectId: 'p', id: 't' }, 'view'), forbidden);
  assert.ok(remoteMessage({ type: 'terminal/input', projectId: 'p', id: 't', data: 'ls\r' }, 'control'));
  assert.throws(() => remoteMessage({ type: 'terminal/input', projectId: 'p', id: 't', data: 'x'.repeat(16385) }, 'control'), invalid);
  assert.throws(() => remoteMessage({ type: 'terminal/resize', projectId: 'p', id: 't', cols: 0, rows: 10 }, 'control'), invalid);
  assert.throws(() => remoteMessage({ type: 'terminal/paste-image', projectId: 'p', id: 't', mime: 'image/svg+xml', data: '' }, 'control'), invalid);
  assert.throws(() => remoteMessage({ type: 'hasOwnProperty' }, 'control'), forbidden);
  assert.throws(() => remoteMessage(null, 'control'), forbidden);
});

test('the scope summary lists what the app may show', () => {
  const view = scopeSummary('view'), control = scopeSummary('control');
  assert.ok(view.api.includes('snapshot') && !view.api.includes('terminal/open'));
  assert.ok(control.api.includes('terminal/open') && control.messages.includes('terminal/input'));
  assert.deepEqual(view.messages, ['subscribe', 'unsubscribe']);
});
