import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalProcesses, LocalWorkspace } from '../packages/runtime-local/src/index.js';
import { FileSessionStore } from '../packages/session-store/src/index.js';
import { readText, saveText, serial } from '../apps/local-server/src/files.js';
import { parseAgentEvent } from '../packages/protocol/src/index.js';
import { validateUi } from '../apps/local-server/src/ui-state.js';
import { discoverRepositories } from '../apps/local-server/src/repositories.js';

test('project discovery distinguishes a root repository from repositories below a non-repository root', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'ade-repos-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'workspace'), alpha = join(root, 'alpha'), beta = join(root, 'beta');
  await mkdir(root);
  await Promise.all([mkdir(alpha), mkdir(beta), mkdir(join(root, 'notes'))]);
  const processes = new LocalProcesses({ cwd: parent });
  async function git(cwd, ...args) {
    const result = await processes.exec('git', args, { cwd });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  await git(parent, 'init', '-q');
  await git(alpha, 'init', '-q');
  await git(beta, 'init', '-q');

  const multi = await discoverRepositories(root, processes);
  assert.equal(multi.multiRepo, true);
  assert.deepEqual(multi.repositories.map(repo => repo.name).sort(), ['alpha', 'beta']);
  assert.notEqual(multi.repositories[0].id, multi.repositories[1].id);
  const single = await discoverRepositories(alpha, processes);
  assert.equal(single.multiRepo, false);
  assert.equal(single.repositories[0].path, alpha);
});

test('IDE save rejects external changes and serializes competing revisions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ade-ide-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new LocalWorkspace(root, { scope: 'root' });
  await saveText(workspace, 'file.txt', 'base', null);
  const base = await readText(workspace, 'file.txt');
  await writeFile(join(root, 'file.txt'), 'external');
  await assert.rejects(saveText(workspace, 'file.txt', 'draft', base.revision), error => error.code === 'REVISION_CONFLICT' && error.details.content === 'external');
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'external');
  const current = await readText(workspace, 'file.txt'), mutate = serial();
  const results = await Promise.allSettled(['first', 'second'].map(content => mutate(() => saveText(workspace, 'file.txt', content, current.revision))));
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  await assert.rejects(saveText(workspace, 'file.txt', 'overwrite', null), { code: 'EEXIST' });
  await assert.rejects(readText(workspace, '../escape'), /escape/);
  await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]));
  await assert.rejects(readText(workspace, 'binary'), { code: 'BINARY_FILE' });
  if (process.platform !== 'win32') {
    await symlink(tmpdir(), join(root, 'outside'));
    await assert.rejects(saveText(workspace, 'outside/escape', 'no', null), /escape/);
  }
});

test('startup recovery retains prompts and events while interrupting active runs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ade-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileSessionStore(root);
  await store.create({ id: 'run', status: 'running', conversationId: 'conversation', projectId: 'project', prompt: 'hello' });
  await store.append('run', { kind: 'text', text: 'one' });
  await store.append('run', { kind: 'text', text: 'two' });
  const restored = new FileSessionStore(root);
  assert.equal((await restored.recoverAll())[0].session.status, 'interrupted');
  assert.equal((await restored.list())[0].prompt, 'hello');
  assert.deepEqual((await restored.replay('run', { afterSequence: 1 })).map(event => event.sequence), [2]);
  assert.equal((await restored.recoverAll())[0].session.status, 'interrupted');
});

test('approval and text update contracts reject invalid modes and retain legacy events', () => {
  const base = { schemaVersion: 1, sessionId: 'run', agent: 'codex', sequence: 1, timestamp: 1 };
  assert.equal(parseAgentEvent({ ...base, kind: 'approval', phase: 'requested', tool: 'command', approvalId: 'id' }).kind, 'approval');
  assert.throws(() => parseAgentEvent({ ...base, kind: 'approval', phase: 'allow-anything', tool: 'command' }));
  assert.throws(() => parseAgentEvent({ ...base, kind: 'text', text: 'x', mode: 'unknown' }));
  assert.equal(parseAgentEvent({ ...base, schemaVersion: undefined, kind: 'text', text: 'legacy' }, { allowLegacy: true }).schemaVersion, 1);
});

test('saved layout rejects duplicate terminals and invalid pane ratios', () => {
  const state = { activeFile: '', conversationId: '', workspaceId: '', focus: '', tabs: [], widths: [1, 2, 1], heights: [2, 1], pane: { id: 'terminal' } };
  assert.equal(validateUi(state), state);
  assert.throws(() => validateUi({ ...state, widths: [0, 1, 1] }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi({ ...state, pane: { direction: 'row', sizes: [1, 1], children: [{ id: 'same' }, { id: 'same' }] } }), { code: 'INVALID_INPUT' });
});

test('saved layout accepts typed editor groups and settings but rejects malformed ones', () => {
  const base = { activeFile: '', conversationId: '', workspaceId: '', focus: '', tabs: [], widths: [24, 76], heights: [2, 1], pane: null };
  const editor = { id: 'e1', kind: 'editor', tabs: ['a.ts', 'diff:staged:b.ts'], active: 'a.ts', preview: 'a.ts' };
  const state = { ...base, editorPane: { direction: 'row', sizes: [1, 1], children: [editor, { id: 'e2', kind: 'editor', tabs: [] }] }, pane: { id: 't1', kind: 'terminal' }, settings: { theme: 'light', fontSize: 14, tabSize: 4, wordWrap: false, minimap: true, autoSave: 'afterDelay' }, side: 'git', sideVisible: true, panelVisible: false, panelTab: 'problems' };
  assert.equal(validateUi(state), state);
  // editor groups and terminals have separate id spaces per tree, but ids inside one tree stay unique
  assert.throws(() => validateUi({ ...state, editorPane: { direction: 'row', sizes: [1, 1], children: [editor, editor] } }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi({ ...state, pane: { id: 'x', kind: 'browser' } }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi({ ...state, editorPane: { id: 'e', kind: 'editor', tabs: 'a.ts' } }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi({ ...state, settings: { fontSize: 0 } }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi({ ...state, settings: { theme: 'neon' } }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi({ ...state, side: 'debug' }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi({ ...state, widths: [1] }), { code: 'INVALID_INPUT' });
});
