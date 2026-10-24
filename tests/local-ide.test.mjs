import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalProcesses, LocalTerminal, LocalWorkspace } from '../apps/local-server/src/runtime.js';
import { readText, serial } from '../apps/local-server/src/files.js';
import { validateUi, validateAppState } from '../apps/local-server/src/ui-state.js';
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

test('diff text reads stay inside the workspace and reject binary files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ade-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new LocalWorkspace(root);
  await writeFile(join(root, 'file.txt'), '한글\n');
  assert.equal(await readText(workspace, 'file.txt'), '한글\n');
  await assert.rejects(readText(workspace, '../escape'), /escape/);
  await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]));
  await assert.rejects(readText(workspace, 'binary'), { code: 'BINARY_FILE' });
  await writeFile(join(root, 'large'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(readText(workspace, 'large'), { code: 'UNSUPPORTED_FILE' });
});

test('serial runs operations one at a time in call order', async () => {
  const run = serial(), order = [];
  const slow = run(async () => { await new Promise(resolve => setTimeout(resolve, 30)); order.push('first'); throw new Error('fails'); });
  const next = run(async () => { order.push('second'); });
  await assert.rejects(slow, /fails/); await next;
  assert.deepEqual(order, ['first', 'second']);
});

const layout = (pane, extra = {}) => ({ gitRepositoryId: '', focus: '', activeTab: 'tab-1', rightVisible: false, paneTabs: [{ id: 'tab-1', pane }], ...extra });

test('saved layout rejects duplicate terminals and invalid pane ratios', () => {
  const state = layout({ id: 'terminal' });
  assert.deepEqual(validateUi(state), state);
  assert.throws(() => validateUi(layout({ direction: 'row', sizes: [0, 1], children: [{ id: 'a' }, { id: 'b' }] })), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi(layout({ direction: 'row', sizes: [1, 1], children: [{ id: 'same' }, { id: 'same' }] })), { code: 'INVALID_INPUT' });
});

test('saved layout accepts diff panes but rejects malformed ones', () => {
  const editor = { id: 'e1', kind: 'editor', tabs: ['diff:all:a.ts', 'diff:staged:b.ts'], active: 'diff:all:a.ts' };
  const state = layout({ direction: 'row', sizes: [1, 1], children: [editor, { id: 't1', kind: 'terminal' }] });
  assert.deepEqual(validateUi(state), state);
  assert.throws(() => validateUi(layout({ id: 'x', kind: 'browser' })), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi(layout({ id: 'e', kind: 'editor', tabs: 'a.ts' })), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi(layout({ id: 'e', kind: 'editor', tabs: ['a.ts'] })), { code: 'INVALID_INPUT' }); // plain files are no longer opened
});

test('saved layout accepts Warp-style pane tabs and right panel state, and drops unknown fields', () => {
  const state = { ...layout({ id: 't1', kind: 'terminal' }), focus: 't1', rightVisible: true,
    paneTabs: [{ id: 'tab-1', pane: { id: 't1', kind: 'terminal' }, focus: 't1' }, { id: 'tab-2', title: 'agents', pane: { direction: 'row', sizes: [1, 1], children: [{ id: 't2', kind: 'terminal' }, { id: 'e1', kind: 'editor', tabs: ['diff:all:a.ts'] }] } }, { id: 'tab-3', pane: null }] };
  assert.deepEqual(validateUi(state), state);
  assert.deepEqual(validateUi({ ...state, widths: [1, 2, 1], workspaceId: 'old', settings: { theme: 'light' } }), state);
  assert.throws(() => validateUi({ ...state, paneTabs: [state.paneTabs[0], state.paneTabs[0]] }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi({ ...state, paneTabs: [{ id: 'bad id', pane: null }] }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi({ ...state, paneTabs: [{ id: 'x', title: 7, pane: null }] }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi({ ...state, paneTabs: Array.from({ length: 17 }, (_, i) => ({ id: `t${i}`, pane: null })) }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi({ ...state, rightVisible: 'yes' }), { code: 'INVALID_INPUT' });
});

test('app settings accept terminal, sidebar and status bar preferences', () => {
  const app = settings => ({ openProjects: [], activeProjectId: '', settings });
  const good = { theme: 'dark', terminalFont: 'Cascadia Mono', lineHeight: 1.3, scrollback: 5000, cursorStyle: 'block', cursorBlink: false, copyOnSelect: true,
    sidebarWidth: 300, statusItems: ['path', 'cpu', 'clock'], notifyDone: false, notifyApproval: true, diffRefresh: 5, soundDone: 'bell', soundAttention: 'alert', soundVolume: 40 };
  assert.deepEqual(validateAppState(app(good)).settings, good);
  const extended = { ...good, soundVolumeExtended: true, soundVolume: 200 };
  assert.deepEqual(validateAppState(app(extended)).settings, extended);
  assert.equal(validateAppState(app({ soundVolumeExtended: false, soundVolume: 100 })).settings.soundVolume, 100);
  for (const bad of [{ sidebarWidth: 100 }, { sidebarWidth: 600 }, { scrollback: 10 }, { lineHeight: 5 }, { cursorStyle: 'beam' }, { diffRefresh: 0 },
    { statusItems: ['Not Valid'] }, { statusItems: 'cpu' }, { notifyDone: 'yes' }, { terminalFont: 7 }, { soundVolume: 101 }, { soundVolume: 1.5 },
    { soundVolumeExtended: 'yes' }, { soundVolumeExtended: false, soundVolume: 200 }, { soundVolumeExtended: true, soundVolume: 201 }, { soundVolumeExtended: true, soundVolume: -1 }, { soundVolumeExtended: true, soundVolume: 100.5 },
    { soundDone: 'Not Valid' }, { soundAttention: 3 }]) {
    assert.throws(() => validateAppState(app(bad)), { code: 'INVALID_INPUT' }, JSON.stringify(bad));
  }
});

test('saved layout keeps the folder and agent of terminals for reopening', () => {
  const ok = layout({ id: 't1', kind: 'terminal', cwd: '/work/app', agent: 'claude' });
  assert.deepEqual(validateUi(ok), ok);
  assert.throws(() => validateUi(layout({ id: 't1', kind: 'terminal', agent: 'vim' })), { code: 'INVALID_INPUT' });
  assert.throws(() => validateUi(layout({ id: 't1', kind: 'terminal', cwd: 7 })), { code: 'INVALID_INPUT' });
});

test('workspace paths cannot escape the project root through .. or symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ade-scope-')), outside = await mkdtemp(join(tmpdir(), 'ade-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const workspace = new LocalWorkspace(root);
  await assert.rejects(workspace.resolve('../outside'), /escape/);
  await assert.rejects(workspace.resolve(join(outside, 'x')), /escape/);
  if (process.platform !== 'win32') {
    await symlink(outside, join(root, 'escape'));
    await assert.rejects(workspace.resolve('escape/secret'), /symlink escape/);
  }
});

test('process execution uses argv without a shell and enforces timeout and output limits', async () => {
  const processes = new LocalProcesses();
  const result = await processes.exec(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'hello; echo hacked']);
  assert.deepEqual([result.exitCode, result.stdout], [0, 'hello; echo hacked']);
  await assert.rejects(processes.exec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 }), /timed out/);
  await assert.rejects(processes.exec(process.execPath, ['-e', "process.stdout.write('x'.repeat(200))"], { maxOutputBytes: 20 }), /limit/);
});

test('terminals keep the NODE_ENV the server started with, not the one its dev-mode Vite sets later', async () => {
  const started = process.env.NODE_ENV, spawned = [];
  const terminal = new LocalTerminal({ ptyFactory: { spawn: (_file, _args, options) => { spawned.push(options.env); return { pid: 1, onData() {}, onExit() {}, kill() {} }; } } });
  process.env.NODE_ENV = 'development'; process.env.NO_COLOR = '1';
  try { await terminal.open({ cwd: process.cwd(), env: { EXTRA: 'yes' } }); }
  finally { if (started === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = started; delete process.env.NO_COLOR; }
  assert.equal(spawned[0].NODE_ENV, started);
  assert.equal(spawned[0].NO_COLOR, undefined);
  assert.equal(spawned[0].EXTRA, 'yes');
});
