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
