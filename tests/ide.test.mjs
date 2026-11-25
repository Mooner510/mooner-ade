import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectIdes, ideCommand, revealCommand, launch, openPath, outsideTarget } from '../apps/local-server/src/ide.js';
import { COLOR_PROMPT, FILE_PROMPT, MEDIA_PROMPT, chatPrompt } from '../apps/local-server/src/chat-prompt.js';
import { UI_PROMPT } from '../apps/local-server/src/chat-ui-prompt.js';

const touch = async file => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, ''); };

test('Windows: VS Code family and JetBrains products are found from their install folders', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ade-ide-'));
  try {
    const local = path.join(home, 'AppData', 'Local');
    await touch(path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'));
    await touch(path.join(home, 'PF', 'cursor', 'Cursor.exe'));
    // JetBrains: the launcher comes from product-info.json, not from a guess at the file name.
    const idea = path.join(local, 'Programs', 'IntelliJ IDEA Ultimate');
    await touch(path.join(idea, 'bin', 'idea64.exe'));
    await writeFile(path.join(idea, 'product-info.json'), JSON.stringify({ name: 'IntelliJ IDEA', productCode: 'IU', version: '2026.2.3', launch: [{ launcherPath: 'bin/idea64.exe' }] }));
    // A product folder whose launcher is missing, and one that tries to leave its folder, are skipped.
    const broken = path.join(local, 'Programs', 'Broken');
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, 'product-info.json'), JSON.stringify({ name: 'Broken', productCode: 'XX', launch: [{ launcherPath: 'bin/none64.exe' }] }));
    const escape = path.join(local, 'Programs', 'Escape');
    await mkdir(escape, { recursive: true });
    await writeFile(path.join(escape, 'product-info.json'), JSON.stringify({ name: 'Escape', productCode: 'ES', launch: [{ launcherPath: '../IntelliJ IDEA Ultimate/bin/idea64.exe' }] }));
    const found = detectIdes({ platform: 'win32', env: { LOCALAPPDATA: local, ProgramFiles: path.join(home, 'PF'), PATH: '' }, home });
    assert.deepEqual(found.map(item => [item.id, item.label, item.kind]), [['vscode', 'Visual Studio Code', 'vscode'], ['cursor', 'Cursor', 'vscode'], ['jetbrains:IU', 'IntelliJ IDEA', 'jetbrains']]);
    assert.equal(found[0].file, path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an editor reachable only through a PATH shim is found next to the shim', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ade-ide-'));
  try {
    const app = path.join(home, 'Tools', 'cursor');
    await touch(path.join(app, 'Cursor.exe'));
    await touch(path.join(app, 'resources', 'app', 'bin', 'cursor.cmd'));
    const found = detectIdes({ platform: 'win32', env: { LOCALAPPDATA: path.join(home, 'x'), PATH: path.join(app, 'resources', 'app', 'bin') }, home });
    assert.deepEqual(found.map(item => [item.id, item.file]), [['cursor', path.join(app, 'Cursor.exe')]]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Linux: editors come from PATH, nothing is guessed', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ade-ide-'));
  try {
    const bin = path.join(home, 'bin');
    await touch(path.join(bin, 'code')); await touch(path.join(bin, 'zeditor'));
    const found = detectIdes({ platform: 'linux', env: { PATH: bin }, home });
    assert.deepEqual(found.map(item => item.id), ['vscode', 'zed']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('each editor family gets its own command line; a folder opens as the project', () => {
  const root = path.resolve('/p/app'), file = path.join(root, 'src', 'a.ts');
  assert.deepEqual(ideCommand({ kind: 'vscode', file: 'code' }, { root, target: root, directory: true }).args, [root]);
  assert.deepEqual(ideCommand({ kind: 'vscode', file: 'code' }, { root, target: file, line: 42, column: 7 }).args, [root, '-g', `${file}:42:7`]);
  assert.deepEqual(ideCommand({ kind: 'vscode', file: 'code' }, { root, target: file }).args, [root, '-g', file]);
  assert.deepEqual(ideCommand({ kind: 'vscode', file: 'code' }, { root, target: file, column: 7 }).args, [root, '-g', file], 'a column without a line is dropped');
  assert.deepEqual(ideCommand({ kind: 'zed', file: 'zed' }, { root, target: file, line: 3 }).args, [root, `${file}:3`]);
  assert.deepEqual(ideCommand({ kind: 'jetbrains', file: 'idea' }, { root, target: file, line: 3 }).args, [root, '--line', '3', file]);
  assert.deepEqual(ideCommand({ kind: 'jetbrains', file: 'idea' }, { root, target: file }).args, [root, file]);
  assert.deepEqual(ideCommand({ kind: 'jetbrains', file: 'idea' }, { root, target: file, line: -1.5 }).args, [root, file], 'a bad line number is ignored');
});

test('the file manager command shows a file selected, or a folder opened', () => {
  assert.deepEqual(revealCommand({ target: 'C:\\p\\a b.ts', platform: 'win32' }).args, ['/select,', 'C:\\p\\a b.ts']);
  assert.deepEqual(revealCommand({ target: 'C:\\p', directory: true, platform: 'win32' }).args, ['C:\\p']);
  assert.deepEqual(revealCommand({ target: '/p/a.ts', platform: 'darwin' }), { file: '/usr/bin/open', args: ['-R', '/p/a.ts'] });
  assert.deepEqual(revealCommand({ target: '/p/a.ts', platform: 'linux' }), { file: 'xdg-open', args: [path.dirname('/p/a.ts')] });
});

test('a started editor does not inherit Electron\'s run-as-node switch or ADE tokens, and a missing program is reported', async () => {
  let seen;
  const fake = (file, args, options) => { seen = { file, args, options }; const child = { once(event, handler) { if (event === 'spawn') setImmediate(handler); return child; }, unref() { child.unrefed = true; } }; return child; };
  await launch({ file: 'x.exe', args: ['a'] }, { spawnProcess: fake, env: { PATH: 'p', ELECTRON_RUN_AS_NODE: '1', ADE_DEV_TOKEN: 't', NODE_OPTIONS: '--x' } });
  assert.deepEqual(seen.options.env, { PATH: 'p' });
  assert.equal(seen.options.detached, true);
  assert.equal(seen.options.stdio, 'ignore');
  await assert.rejects(launch({ file: path.join(tmpdir(), 'ade-no-such-program.exe'), args: [] }), /프로그램을 찾을 수 없습니다/);
});

test('opening a path that does not exist, or an editor that is not installed, is refused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ade-ide-'));
  try {
    await assert.rejects(openPath({ ide: 'files', root, target: path.join(root, 'nope.ts') }), { code: 'NOT_FOUND' });
    await touch(path.join(root, 'a.ts'));
    await assert.rejects(openPath({ ide: 'jetbrains:ZZ', root, target: path.join(root, 'a.ts') }), { code: 'NOT_FOUND' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a chip may name a place outside the project (absolute or ../), but never a network share', () => {
  const root = path.join(tmpdir(), 'ade-ide-root');
  assert.equal(outsideTarget(root, '../sibling/dist/a.zip'), path.resolve(root, '..', 'sibling', 'dist', 'a.zip'));
  assert.equal(outsideTarget(root, tmpdir()), path.resolve(tmpdir()));
  for (const share of ['//server/share/a.txt', '\\\\server\\share\\a.txt']) assert.throws(() => outsideTarget(root, share), { code: 'INVALID_INPUT' }, share);
  assert.throws(() => outsideTarget(root, 'a\0b'), { code: 'INVALID_INPUT' });
});

test('a file outside the project opens in an editor with its own folder as the project, a file inside keeps the project root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ade-ide-')), other = await mkdtemp(path.join(tmpdir(), 'ade-ide-other-'));
  try {
    await touch(path.join(root, 'a.ts')); await touch(path.join(other, 'dist', 'b.zip'));
    const ide = { id: 'vscode', label: 'VS Code', kind: 'vscode', file: 'code.exe' };
    // ideCommand is what openPath builds; openPath itself needs a detected editor, so the command is checked directly.
    const outside = path.join(other, 'dist', 'b.zip');
    assert.deepEqual(ideCommand(ide, { root: path.dirname(outside), target: outside }).args, [path.dirname(outside), '-g', outside]);
    assert.deepEqual(ideCommand(ide, { root, target: path.join(root, 'a.ts') }).args, [root, '-g', path.join(root, 'a.ts')]);
    await assert.rejects(openPath({ ide: 'files', root, target: path.join(other, 'nope.zip') }), { code: 'NOT_FOUND' });
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test('a new chat is told how to write file paths, the UI blocks only when enabled, and an older chat keeps its prompt unchanged', () => {
  assert.equal(chatPrompt(false, true), FILE_PROMPT);
  assert.equal(chatPrompt(true, true), `${FILE_PROMPT}\n\n${UI_PROMPT}`);
  assert.equal(chatPrompt(true, false), UI_PROMPT, 'a chat from before this existed gets the same text as it always had (prompt cache)');
  assert.equal(chatPrompt(false, false), undefined);
  assert.equal(chatPrompt(false, false, 'claude', true), MEDIA_PROMPT, 'media does not depend on interactive UI');
  assert.ok(chatPrompt(false, false, 'codex', true).endsWith(MEDIA_PROMPT));
  assert.equal(chatPrompt(false, false, 'claude', false, true), COLOR_PROMPT);
  assert.ok(chatPrompt(false, false, 'codex', false, true).endsWith(COLOR_PROMPT));
  assert.equal(chatPrompt(false, false, 'cursor', false, true), undefined);
  for (const word of ['[[file:src/app.ts]]', ':42', 'relative to the project', 'folder', 'outside the project', '[[file:../', 'only when the user asks']) assert.ok(FILE_PROMPT.includes(word), word);
  assert.ok(!/outside the project stays in backticks/.test(FILE_PROMPT), 'a path outside the project is a chip too');
  assert.ok(FILE_PROMPT.length < 1200, `cached, but every word competes for attention: ${FILE_PROMPT.length} chars`);
});
