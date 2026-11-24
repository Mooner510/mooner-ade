import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fault, serial } from './files.js';

const maxBytes = 2 * 1024 * 1024;
const metadata = name => name.toLowerCase() === '.git' || /^\.ade-save-[a-f0-9-]+\.tmp$/.test(name);
const unsupported = () => fault('UNSUPPORTED_FILE', 'UTF-8 텍스트 파일(2 MiB 이하)만 편집할 수 있습니다.');
const save = serial();

async function targetOf(workspace, file) {
  if (typeof file !== 'string' || !file || file.length > 8192 || file.includes('\0') ||
      path.isAbsolute(file) || file.split(path.sep === '\\' ? /[\\/]/ : '/').some(part => part === '..' || metadata(part))) {
    throw fault('INVALID_INPUT', '프로젝트 내부 경로를 지정하세요.');
  }
  const target = await workspace.resolve(file);
  const root = await fs.realpath(workspace.root);
  const relative = path.relative(workspace.root, target);
  const canonical = path.join(root, relative);
  // Keep renames on the canonical parent and refuse links, including aliases for internal metadata.
  const parent = relative && await fs.realpath(path.dirname(canonical));
  if (parent && path.relative(parent, path.dirname(canonical))) throw fault('INVALID_INPUT', '심볼릭 링크 경로는 지원하지 않습니다.');
  return canonical;
}

export async function projectDirectory(workspace, file) {
  const target = await targetOf(workspace, file);
  if (!(await fs.lstat(target)).isDirectory()) throw fault('INVALID_INPUT', '폴더 경로를 지정하세요.');
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries.filter(entry => !metadata(entry.name) && (entry.isFile() || entry.isDirectory()))
    .map(entry => ({ name: entry.name, folder: entry.isDirectory() }));
}

function signature(stat) { return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }

async function snapshot(target) {
  let handle;
  try {
    const entry = await fs.lstat(target);
    if (!entry.isFile()) throw unsupported();
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size > maxBytes) throw unsupported();
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== Number(stat.size) || signature(stat) !== signature(await handle.stat({ bigint: true }))) {
      throw fault('FILE_CHANGING', '파일이 변경되는 중입니다. 잠시 후 다시 시도하세요.', 409);
    }
    const content = bytes.subarray(0, offset);
    if (content.includes(0)) throw unsupported();
    let value;
    try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content); }
    catch { throw unsupported(); }
    // The revision is the content alone: a touch, chmod, sync tool or xattr changes mtime/ctime without changing the text, and that must not look like someone else's edit.
    const revision = createHash('sha256').update(content).digest('hex');
    return { file: { revision, content: value }, mode: Number(stat.mode & 0o777n) };
  } catch (error) {
    if (error.code === 'ENOENT') return { file: null, mode: 0 };
    throw error;
  } finally { await handle?.close(); }
}

export async function readProjectFile(workspace, file) {
  try { return (await snapshot(await targetOf(workspace, file))).file; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

const mediaTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm'
};

export async function openProjectMedia(workspace, file, directory = workspace.root) {
  const type = mediaTypes[path.extname(file).toLowerCase()];
  if (!type) throw fault('UNSUPPORTED_MEDIA', '지원하지 않는 미디어 형식입니다.', 415);
  // Absolute paths are accepted only when they resolve inside the chat's workspace.
  const relative = path.isAbsolute(file) ? path.relative(workspace.root, file) : [path.relative(workspace.root, directory), file].filter(Boolean).join('/');
  if (path.sep === '\\' && relative.includes(':')) throw fault('INVALID_INPUT', '프로젝트 내부 경로를 지정하세요.');
  const target = await targetOf(workspace, relative);
  const entry = await fs.lstat(target);
  if (!entry.isFile()) throw fault('NOT_FOUND', '미디어 파일이 없습니다.', 404);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || entry.dev !== stat.dev || entry.ino !== stat.ino) throw fault('NOT_FOUND', '미디어 파일이 없습니다.', 404);
    return { handle, size: stat.size, type };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function writeProjectFile(workspace, { path: file, revision, content }) {
  if ((revision !== null && (typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision))) ||
      typeof content !== 'string' || content.includes('\0') || !content.isWellFormed()) {
    throw fault('INVALID_INPUT', '파일 내용 또는 버전이 올바르지 않습니다.');
  }
  if (Buffer.byteLength(content) > maxBytes) throw unsupported();
  return save(async () => {
    let target;
    try { target = await targetOf(workspace, file); }
    catch (error) {
      if (error.code === 'ENOENT' && revision !== null) return { file: null, conflict: true };
      throw error;
    }
    const current = await snapshot(target);
    if ((current.file?.revision ?? null) !== revision) return { file: current.file, conflict: true };
    if (current.file?.content === content) return { file: current.file, conflict: false };
    if (current.file) await fs.access(target, constants.W_OK);
    const temp = path.join(path.dirname(target), `.ade-save-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(content, 'utf8');
        if (current.file) await handle.chmod(current.mode);
        await handle.sync();
      } finally { await handle.close(); }
      // Check again after preparing the replacement, then commit in one rename.
      await targetOf(workspace, file);
      const latest = await snapshot(target);
      if ((latest.file?.revision ?? null) !== revision) return { file: latest.file, conflict: true };
      if (latest.file) await fs.rename(temp, target);
      else {
        // Recreating a deleted file must not clobber a concurrent creation.
        await fs.link(temp, target);
        await fs.unlink(temp);
      }
      const updated = await snapshot(target);
      return { file: updated.file, conflict: updated.file?.content !== content };
    } catch (error) {
      if (error.code === 'EEXIST') return { file: (await snapshot(target)).file, conflict: true };
      throw error;
    } finally { await fs.unlink(temp).catch(() => {}); }
  });
}

// ---- Creating, moving, copying and deleting from the project tree. Every path goes through targetOf, so nothing leaves the project or touches .git. ----
const taken = name => fault('EXISTS', `같은 이름이 이미 있습니다: ${name}`, 409);
const missing = name => fault('NOT_FOUND', `찾을 수 없습니다: ${name}`, 404);
const lstat = target => fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
// "./", ".//" and "./." name the project folder like "." does; targetOf allows them (a listing needs the root) but nothing here may move, copy or delete it.
const inner = async (workspace, file) => {
  const target = await targetOf(workspace, file);
  if (target === await fs.realpath(workspace.root)) throw fault('INVALID_INPUT', '프로젝트 폴더 자체는 대상이 될 수 없습니다.');
  return target;
};
const names = list => { if (!Array.isArray(list) || !list.length || list.length > 500 || list.some(item => typeof item !== 'string' || !item || item === '.')) throw fault('INVALID_INPUT', '대상이 올바르지 않습니다.'); return list; };

export async function createProjectEntry(workspace, { path: file, folder }) {
  const parts = typeof file === 'string' ? file.split('/') : [];
  if (!parts.length || parts.some(part => !part || part === '.')) throw fault('INVALID_INPUT', '이름이 올바르지 않습니다.');
  // "a/b/c.txt" makes the missing folders on the way, each checked like any other project path.
  for (let at = 1; at < parts.length; at++) await fs.mkdir(await targetOf(workspace, parts.slice(0, at).join('/'))).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const target = await targetOf(workspace, file);
  try { if (folder) await fs.mkdir(target); else await (await fs.open(target, 'wx')).close(); }
  catch (error) { throw error.code === 'EEXIST' ? taken(file) : error; }
}

// All-or-nothing preflight: every source exists, no destination exists (a case-only rename on a case-insensitive disk is the same entry), none moves into itself.
export const moveProjectEntries = (workspace, input) => save(() => moveEntries(workspace, input));
async function moveEntries(workspace, { moves }) {
  if (!Array.isArray(moves)) throw fault('INVALID_INPUT', '대상이 올바르지 않습니다.');
  names(moves.map(move => move?.from)); names(moves.map(move => move?.to));
  const steps = [], seen = new Set();
  for (const { from, to } of moves) {
    const source = await inner(workspace, from), dest = await inner(workspace, to), entry = await lstat(source);
    if (!entry) throw missing(from);
    // A source named twice, or inside another source that moves too, would be gone (or moved) by the time its turn comes.
    if (steps.some(step => (source + path.sep).startsWith(step.source + path.sep) || (step.source + path.sep).startsWith(source + path.sep))) throw fault('INVALID_INPUT', '같은 항목이 중복되었거나 다른 항목 안에 들어 있습니다.');
    if (source === dest) continue;
    if (dest.startsWith(source + path.sep)) throw fault('INVALID_INPUT', '폴더를 자기 자신 안으로 옮길 수 없습니다.');
    const there = await lstat(dest);
    if ((there && (there.ino !== entry.ino || there.dev !== entry.dev)) || seen.has(dest)) throw taken(to);
    seen.add(dest); steps.push({ source, dest });
  }
  for (const { source, dest } of steps) await fs.rename(source, dest);
}

// Copies into `dir`; a name already taken there gets " copy", " copy 2"… (like a Finder duplicate). Returns the new paths.
export const copyProjectEntries = (workspace, input) => save(() => copyEntries(workspace, input));
async function copyEntries(workspace, { paths, dir }) {
  const folder = await targetOf(workspace, typeof dir === 'string' && dir ? dir : '.');
  if (!(await lstat(folder))?.isDirectory()) throw fault('INVALID_INPUT', '폴더 경로를 지정하세요.');
  // targetOf answers in real (symlink-resolved) paths, so the new path is cut against the real root too.
  const created = [], root = await fs.realpath(workspace.root);
  for (const from of names(paths)) {
    const source = await inner(workspace, from), entry = await lstat(source);
    if (!entry) throw missing(from);
    if (folder === source || folder.startsWith(source + path.sep)) throw fault('INVALID_INPUT', '폴더를 자기 자신 안에 복사할 수 없습니다.');
    const base = path.basename(source), dot = entry.isDirectory() ? 0 : base.lastIndexOf('.'), stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : '';
    let name = base;
    for (let n = 1; await lstat(path.join(folder, name)); n++) name = `${stem} copy${n > 1 ? ` ${n}` : ''}${ext}`;
    await fs.cp(source, path.join(folder, name), { recursive: true, errorOnExist: true, force: false, filter: entry => !metadata(path.basename(entry)) });
    created.push(path.relative(root, path.join(folder, name)).split(path.sep).join('/'));
  }
  return { created };
}

export const deleteProjectEntries = (workspace, input) => save(() => deleteEntries(workspace, input));
async function deleteEntries(workspace, { paths }) {
  const targets = [];
  for (const file of names(paths)) targets.push(await inner(workspace, file));
  for (const target of targets) await fs.rm(target, { recursive: true, force: true });
}
