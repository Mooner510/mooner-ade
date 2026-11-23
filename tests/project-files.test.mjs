import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalWorkspace } from '../apps/local-server/src/runtime.js';
import { copyProjectEntries, createProjectEntry, deleteProjectEntries, moveProjectEntries, projectDirectory, readProjectFile, writeProjectFile } from '../apps/local-server/src/project-files.js';
import { FileBuffer } from '../apps/web/src/file-buffer.ts';

async function project(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ade-project-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, workspace: new LocalWorkspace(dir) };
}

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
