import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalWorkspace } from '../apps/local-server/src/runtime.js';
import { copyProjectEntries, createProjectEntry, deleteProjectEntries, moveDroppedFiles, moveProjectEntries, projectDirectory, readProjectFile, writeProjectFile } from '../apps/local-server/src/project-files.js';
import { FileBuffer } from '../apps/web/src/file-buffer.ts';

async function project(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ade-project-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, workspace: new LocalWorkspace(dir) };
}

test('native drops move multiple files and report project-relative paths for open editors', async t => {
  const { dir, workspace } = await project(t);
  const outside = await project(t);
  const external = path.join(outside.dir, '외부 파일.txt'), internal = path.join(dir, 'note.txt');
  await writeFile(external, 'outside');
  await writeFile(internal, 'inside');
  await mkdir(path.join(dir, 'dest'));
  assert.deepEqual(await moveDroppedFiles(workspace, { paths: [external, internal], dir: 'dest' }), {
    moved: [{ from: null, to: 'dest/외부 파일.txt' }, { from: 'note.txt', to: 'dest/note.txt' }]
  });
  await assert.rejects(lstat(external), { code: 'ENOENT' });
  await assert.rejects(lstat(internal), { code: 'ENOENT' });
  const moved = path.join(dir, 'dest', '외부 파일.txt');
  assert.equal(await readFile(moved, 'utf8'), 'outside');
  assert.equal(await readFile(path.join(dir, 'dest', 'note.txt'), 'utf8'), 'inside');
  assert.deepEqual(await moveDroppedFiles(workspace, { paths: [moved], dir: 'dest' }), { moved: [] });
});

test('native drops reject conflicts and dirty editors before moving any files', async t => {
  const { dir, workspace } = await project(t);
  const outside = await project(t);
  const first = path.join(outside.dir, 'first.txt'), conflict = path.join(outside.dir, 'note.txt'), note = path.join(dir, 'note.txt');
  await writeFile(first, 'first');
  await writeFile(conflict, 'external note');
  await writeFile(note, 'project note');
  await mkdir(path.join(dir, 'dest'));
  await symlink(outside.dir, path.join(dir, 'link'), 'junction');

  await assert.rejects(moveDroppedFiles(workspace, { paths: [first, conflict], dir: '.' }), { code: 'EXISTS' });
  await assert.rejects(moveDroppedFiles(workspace, { paths: [first, note], dir: 'dest', dirty: ['note.txt'] }), { code: 'FILE_DIRTY' });
  await assert.rejects(moveDroppedFiles(workspace, { paths: [first], dir: 'link' }), /symlink escape/);
  await assert.rejects(moveDroppedFiles(workspace, { paths: [outside.dir], dir: '.' }), { code: 'INVALID_INPUT' });
  assert.deepEqual(await readdir(path.join(dir, 'dest')), []);
  assert.equal(await readFile(first, 'utf8'), 'first');
  assert.equal(await readFile(conflict, 'utf8'), 'external note');
  assert.equal(await readFile(note, 'utf8'), 'project note');
});

test('native drops copy across volumes and preserve the source if a destination appears during the move', async t => {
  const { dir, workspace } = await project(t);
  const outside = await project(t);
  const source = path.join(outside.dir, 'note.txt'), dest = path.join(dir, 'note.txt');
  await writeFile(source, 'source');
  const acrossVolumes = Object.assign(new Error('different volumes'), { code: 'EXDEV' });
  const link = t.mock.method(fs, 'link', async () => {
    await writeFile(dest, 'concurrent file');
    throw acrossVolumes;
  });
  assert.deepEqual(await moveDroppedFiles(workspace, { paths: [source], dir: '.' }), {
    moved: [], error: '같은 이름이 이미 있습니다: note.txt'
  });
  assert.equal(await readFile(source, 'utf8'), 'source');
  assert.equal(await readFile(dest, 'utf8'), 'concurrent file');
  await unlink(dest);
  link.mock.mockImplementation(async () => { throw acrossVolumes; });
  assert.deepEqual(await moveDroppedFiles(workspace, { paths: [source], dir: '.' }), { moved: [{ from: null, to: 'note.txt' }] });
  assert.equal(await readFile(dest, 'utf8'), 'source');
  await assert.rejects(lstat(source), { code: 'ENOENT' });
});

test('project tree lists real folders and files, including empty directories, within the workspace', async t => {
  const { dir, workspace } = await project(t);
  await mkdir(path.join(dir, 'empty'));
  await mkdir(path.join(dir, '.git'));
  await writeFile(path.join(dir, 'note.txt'), 'hello');
  await symlink(dir, path.join(dir, 'link'), 'junction');
  const entries = await projectDirectory(workspace, '.');
  assert.deepEqual(entries.sort((a, b) => a.name.localeCompare(b.name)), [{ name: 'empty', folder: true }, { name: 'note.txt', folder: false }]);
  assert.deepEqual(await projectDirectory(workspace, 'empty'), []);
  await assert.rejects(projectDirectory(workspace, '.git'), { code: 'INVALID_INPUT' });
  await assert.rejects(readProjectFile(workspace, '../note.txt'), { code: 'INVALID_INPUT' });
  await assert.rejects(readProjectFile(workspace, 'link/note.txt'), { code: 'INVALID_INPUT' });
});

test('editor reloads clean buffers and leaves the external version on disk until an explicit overwrite', async t => {
  const { dir, workspace } = await project(t);
  const disk = path.join(dir, 'note.txt');
  const read = () => readFile(disk, 'utf8');
  await writeFile(disk, '\uFEFFfirst\r\n', { mode: 0o744 });
  const buffer = new FileBuffer('note.txt', (action, input) => action === 'files/read'
    ? readProjectFile(workspace, input.path).then(file => ({ file }))
    : writeProjectFile(workspace, input));
  await buffer.refresh();
  assert.equal(buffer.get().draft, '\uFEFFfirst\r\n');
  buffer.edit('\uFEFFsaved\r\n');
  await buffer.save();
  assert.equal(await read(), '\uFEFFsaved\r\n');
  if (process.platform !== 'win32') assert.equal((await stat(disk)).mode & 0o777, 0o744);

  await writeFile(disk, 'external clean update\n');
  await buffer.refresh();
  assert.equal(buffer.get().draft, 'external clean update\n');
  buffer.edit('ADE draft\n');
  await writeFile(disk, 'external edit one\n');
  await buffer.save();
  assert.equal(await read(), 'external edit one\n');
  assert.equal(buffer.get().draft, 'ADE draft\n');
  assert.ok(buffer.get().conflict);

  await writeFile(disk, 'external edit two\n');
  await buffer.save(true);
  assert.equal(await read(), 'external edit two\n');
  assert.equal(buffer.get().conflict.file.content, 'external edit two\n');
  await buffer.reload();
  assert.equal(buffer.get().draft, 'external edit two\n');
  assert.equal(buffer.dirty, false);

  buffer.edit('explicit overwrite\n');
  await unlink(disk);
  await buffer.save();
  assert.equal(buffer.get().conflict.file, null);
  await assert.rejects(read(), { code: 'ENOENT' });
  await buffer.save(true);
  assert.equal(await read(), 'explicit overwrite\n');
  assert.equal(buffer.dirty, false);
  assert.equal(buffer.get().file.revision, (await readProjectFile(workspace, 'note.txt')).revision);
});

test('concurrent ADE saves with the same base revision cannot both commit', async t => {
  const { dir, workspace } = await project(t);
  await writeFile(path.join(dir, 'note.txt'), 'base');
  const { revision } = await readProjectFile(workspace, 'note.txt');
  const [first, second] = await Promise.all(['first', 'second'].map(content =>
    writeProjectFile(workspace, { path: 'note.txt', revision, content })));
  assert.equal(first.conflict, false);
  assert.equal(second.conflict, true);
  assert.deepEqual(second.file, first.file);
  assert.equal(await readFile(path.join(dir, 'note.txt'), 'utf8'), 'first');
});

test('closing an editor waits for an undo made during an in-flight save', async () => {
  const writes = [];
  let commitFirst;
  const first = new Promise(resolve => { commitFirst = resolve; });
  const buffer = new FileBuffer('note.txt', async (action, input) => {
    if (action === 'files/read') return { file: { revision: 'base', content: 'base' } };
    writes.push(input.content);
    if (writes.length === 1) await first;
    return { file: { revision: String(writes.length), content: input.content }, conflict: false };
  });
  await buffer.refresh();
  buffer.edit('first edit');
  const saving = buffer.save();
  buffer.edit('base');
  assert.equal(buffer.dirty, true);
  const closing = buffer.save();
  commitFirst();
  await Promise.all([saving, closing]);
  assert.deepEqual(writes, ['first edit', 'base']);
  assert.equal(buffer.dirty, false);
});

const local = workspace => (action, input) => action === 'files/read'
  ? readProjectFile(workspace, input.path).then(file => ({ file }))
  : writeProjectFile(workspace, input);

test('a touch that leaves the text alone is not an external edit, and typing does not reach the disk until save', async t => {
  const { dir, workspace } = await project(t);
  const disk = path.join(dir, 'note.txt');
  await writeFile(disk, 'one\n');
  const calls = [];
  const buffer = new FileBuffer('note.txt', (action, input) => { calls.push(action); return local(workspace)(action, input); });
  await buffer.refresh();
  buffer.edit('one\ntwo\n');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(calls.includes('files/write'), false, 'no autosave');
  assert.equal(await readFile(disk, 'utf8'), 'one\n');
  assert.equal(buffer.dirty, true);

  // mtime/ctime move (a sync tool, a formatter that rewrites the same text), the content does not.
  await utimes(disk, new Date(), new Date(Date.now() + 60_000));
  await buffer.refresh();
  assert.equal(buffer.get().conflict, undefined);
  await buffer.save();
  assert.equal(await readFile(disk, 'utf8'), 'one\ntwo\n');
  assert.equal(buffer.dirty, false);

  buffer.edit('discard me');
  assert.equal(buffer.dirty, true);
  buffer.revert();
  assert.equal(buffer.dirty, false);
  assert.equal(buffer.get().draft, 'one\ntwo\n');

  // A real change of the text is still one.
  buffer.edit('mine\n');
  await writeFile(disk, 'theirs\n');
  await buffer.refresh();
  assert.ok(buffer.get().conflict);
});

test('the project tree creates, moves, copies and deletes inside the project only', async t => {
  const { dir, workspace } = await project(t);
  const list = async at => (await readdir(path.join(dir, at))).sort();
  await createProjectEntry(workspace, { path: 'src', folder: true });
  await createProjectEntry(workspace, { path: 'src/deep/er/a.txt', folder: false });
  assert.deepEqual(await list('src/deep/er'), ['a.txt']);
  await assert.rejects(createProjectEntry(workspace, { path: 'src', folder: true }), { code: 'EXISTS' });
  await assert.rejects(createProjectEntry(workspace, { path: '../out.txt', folder: false }), { code: 'INVALID_INPUT' });
  await assert.rejects(createProjectEntry(workspace, { path: '.git/x', folder: false }), { code: 'INVALID_INPUT' });
  await assert.rejects(createProjectEntry(workspace, { path: 'a//b', folder: false }), { code: 'INVALID_INPUT' });

  await writeFile(path.join(dir, 'b.txt'), 'B');
  await mkdir(path.join(dir, 'dest'));
  await writeFile(path.join(dir, 'dest', 'b.txt'), 'taken');
  // All or nothing: one collision keeps every other item where it was.
  await assert.rejects(moveProjectEntries(workspace, { moves: [{ from: 'src/deep/er/a.txt', to: 'dest/a.txt' }, { from: 'b.txt', to: 'dest/b.txt' }] }), { code: 'EXISTS' });
  assert.deepEqual(await list('src/deep/er'), ['a.txt']);
  await assert.rejects(moveProjectEntries(workspace, { moves: [{ from: 'src', to: 'src/deep/src' }] }), { code: 'INVALID_INPUT' });
  await assert.rejects(moveProjectEntries(workspace, { moves: [{ from: 'nope.txt', to: 'x.txt' }] }), { code: 'NOT_FOUND' });
  await assert.rejects(moveProjectEntries(workspace, { moves: [{ from: '.', to: 'root' }] }), { code: 'INVALID_INPUT' });
  await assert.rejects(moveProjectEntries(workspace, { moves: [{ from: 'b.txt', to: '../b.txt' }] }), { code: 'INVALID_INPUT' });
  await moveProjectEntries(workspace, { moves: [{ from: 'src/deep/er/a.txt', to: 'dest/a.txt' }, { from: 'b.txt', to: 'renamed.txt' }] });
  assert.deepEqual(await list('.'), ['dest', 'renamed.txt', 'src']);
  assert.equal(await readFile(path.join(dir, 'dest', 'a.txt'), 'utf8'), '');

  // A name taken in the target folder gets " copy", " copy 2"; folders copy with their contents.
  assert.deepEqual((await copyProjectEntries(workspace, { paths: ['renamed.txt'], dir: '.' })).created, ['renamed copy.txt']);
  assert.deepEqual((await copyProjectEntries(workspace, { paths: ['renamed.txt'], dir: '.' })).created, ['renamed copy 2.txt']);
  assert.deepEqual((await copyProjectEntries(workspace, { paths: ['dest'], dir: 'src' })).created, ['src/dest']);
  assert.deepEqual(await list('src/dest'), ['a.txt', 'b.txt']);
  await assert.rejects(copyProjectEntries(workspace, { paths: ['src'], dir: 'src/dest' }), { code: 'INVALID_INPUT' });

  await assert.rejects(deleteProjectEntries(workspace, { paths: ['.'] }), { code: 'INVALID_INPUT' });
  await assert.rejects(deleteProjectEntries(workspace, { paths: ['../x'] }), { code: 'INVALID_INPUT' });
  await deleteProjectEntries(workspace, { paths: ['src', 'renamed copy.txt'] });
  assert.deepEqual(await list('.'), ['dest', 'renamed copy 2.txt', 'renamed.txt']);
});

test('tree operations cannot reach the project folder itself, a link out of it, or .git', async t => {
  const { dir, workspace } = await project(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'ade-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret.txt'), 'S');
  await mkdir(path.join(dir, '.git')); await writeFile(path.join(dir, '.git', 'HEAD'), 'ref');
  await writeFile(path.join(dir, 'keep.txt'), 'K');
  await mkdir(path.join(dir, 'sub')); await mkdir(path.join(dir, 'real')); await writeFile(path.join(dir, 'real', 'f.txt'), 'F');
  // 'junction' makes a directory link without the privilege a symlink needs on Windows (it is ignored elsewhere). A link to a
  // file has no junction form and needs that privilege, so on Windows without it only the folder link is covered.
  await symlink(outside, path.join(dir, 'link'), 'junction');
  const fileLink = await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'flink')).then(() => true, error => {
    if (process.platform === 'win32' && error.code === 'EPERM') return false;
    throw error;
  });
  const list = async at => (await readdir(at)).sort();
  const before = await list(dir);

  // "./" and friends are the project folder under another spelling.
  for (const alias of ['./', './/', './.', 'sub/..']) {
    await assert.rejects(deleteProjectEntries(workspace, { paths: [alias] }), { code: 'INVALID_INPUT' }, alias);
    await assert.rejects(moveProjectEntries(workspace, { moves: [{ from: alias, to: 'x' }] }), { code: 'INVALID_INPUT' }, alias);
    await assert.rejects(moveProjectEntries(workspace, { moves: [{ from: 'keep.txt', to: alias }] }), { code: 'INVALID_INPUT' }, alias);
    await assert.rejects(copyProjectEntries(workspace, { paths: [alias], dir: '.' }), { code: 'INVALID_INPUT' }, alias);
  }
  assert.deepEqual(await list(dir), before);

  // A path through a link is refused (the link itself too: the tree never lists links, and what they point to stays out of reach).
  for (const via of ['link/secret.txt', 'link/new.txt', ...(fileLink ? ['flink/x'] : [])]) {
    await assert.rejects(deleteProjectEntries(workspace, { paths: [via] }), /./, via);
    await assert.rejects(createProjectEntry(workspace, { path: via, folder: false }), /./, via);
    await assert.rejects(moveProjectEntries(workspace, { moves: [{ from: 'keep.txt', to: via }] }), /./, via);
    await assert.rejects(copyProjectEntries(workspace, { paths: ['keep.txt'], dir: via }), /./, via);
  }
  await assert.rejects(copyProjectEntries(workspace, { paths: ['keep.txt'], dir: 'link' }), /./);
  assert.deepEqual(await list(outside), ['secret.txt']);
  // A copied folder keeps its links as links, so nothing from outside is pulled in.
  await symlink(outside, path.join(dir, 'real', 'out'), 'junction');
  // fs.cp re-creates a link with a plain symlink call, which Windows refuses without the symlink privilege (fileLink is false then),
  // so copying a folder that holds a link fails closed there with EPERM instead of copying it.
  if (fileLink) {
    await copyProjectEntries(workspace, { paths: ['real'], dir: 'sub' });
    assert.equal((await lstat(path.join(dir, 'sub', 'real', 'out'))).isSymbolicLink(), true);
  } else await assert.rejects(copyProjectEntries(workspace, { paths: ['real'], dir: 'sub' }), { code: 'EPERM' });
  assert.deepEqual(await list(outside), ['secret.txt']);
  await assert.rejects(deleteProjectEntries(workspace, { paths: ['link'] }), /./);
  await deleteProjectEntries(workspace, { paths: ['sub'] });
  assert.deepEqual(await list(outside), ['secret.txt'], 'deleting never follows a link');
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'S');

  for (const name of ['.git', '.GIT', 'real/.git', 'real/.Git/HEAD']) {
    await assert.rejects(deleteProjectEntries(workspace, { paths: [name] }), { code: 'INVALID_INPUT' }, name);
    await assert.rejects(moveProjectEntries(workspace, { moves: [{ from: 'keep.txt', to: name }] }), { code: 'INVALID_INPUT' }, name);
    await assert.rejects(moveProjectEntries(workspace, { moves: [{ from: name, to: 'x' }] }), { code: 'INVALID_INPUT' }, name);
    await assert.rejects(copyProjectEntries(workspace, { paths: [name], dir: '.' }), { code: 'INVALID_INPUT' }, name);
  }
  assert.equal(await readFile(path.join(dir, '.git', 'HEAD'), 'utf8'), 'ref');

  // Malformed input.
  await assert.rejects(deleteProjectEntries(workspace, { paths: 'keep.txt' }), { code: 'INVALID_INPUT' });
  await assert.rejects(deleteProjectEntries(workspace, { paths: [{}] }), { code: 'INVALID_INPUT' });
  await assert.rejects(deleteProjectEntries(workspace, { paths: Array(501).fill('x') }), { code: 'INVALID_INPUT' });
  await assert.rejects(moveProjectEntries(workspace, { moves: [null] }), { code: 'INVALID_INPUT' });
  await assert.rejects(copyProjectEntries(workspace, { paths: [] , dir: '.' }), { code: 'INVALID_INPUT' });
  assert.ok((await list(dir)).includes('keep.txt'));
});

test('a move that names an item twice, or an item and one inside it, changes nothing; a case-only rename works', async t => {
  const { dir, workspace } = await project(t);
  await mkdir(path.join(dir, 'a')); await writeFile(path.join(dir, 'a', 'f.txt'), 'F'); await writeFile(path.join(dir, 'Foo.txt'), 'foo');
  await assert.rejects(moveProjectEntries(workspace, { moves: [{ from: 'a', to: 'x' }, { from: 'a', to: 'y' }] }), { code: 'INVALID_INPUT' });
  await assert.rejects(moveProjectEntries(workspace, { moves: [{ from: 'a', to: 'x' }, { from: 'a/f.txt', to: 'y' }] }), { code: 'INVALID_INPUT' });
  assert.deepEqual((await readdir(dir)).sort(), ['Foo.txt', 'a']);
  // On a case-insensitive disk "foo.txt" is the same entry as "Foo.txt"; on a case-sensitive one it is free. Either way the rename goes through.
  await moveProjectEntries(workspace, { moves: [{ from: 'Foo.txt', to: 'foo.txt' }] });
  assert.deepEqual((await readdir(dir)).sort(), ['a', 'foo.txt']);
  assert.equal(await readFile(path.join(dir, 'foo.txt'), 'utf8'), 'foo');
  // A different file already there is never replaced.
  await writeFile(path.join(dir, 'bar.txt'), 'bar');
  await assert.rejects(moveProjectEntries(workspace, { moves: [{ from: 'bar.txt', to: 'foo.txt' }] }), { code: 'EXISTS' });
  assert.equal(await readFile(path.join(dir, 'foo.txt'), 'utf8'), 'foo');
});
