import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const revision = data => createHash('sha256').update(data).digest('hex');
export function fault(code, message, status = 400, details) {
  return Object.assign(new Error(message), { code, status, details });
}
export function text(value, name = '값', max = 8192) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fault('INVALID_INPUT', `${name}이 올바르지 않습니다.`);
  return value;
}
export async function readText(workspace, file) {
  const target = await workspace.resolve(text(file, '경로'));
  const handle = await fs.open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw fault('UNSUPPORTED_FILE', '일반 텍스트 파일(2 MiB 이하)만 편집할 수 있습니다.');
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset === buffer.length) throw fault('UNSUPPORTED_FILE', '파일 크기 제한을 초과했습니다.');
    const bytes = buffer.subarray(0, offset);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw fault('BINARY_FILE', 'UTF-8 텍스트가 아닙니다.'); }
    if (bytes.includes(0)) throw fault('BINARY_FILE', '바이너리 파일은 편집할 수 없습니다.');
    return { content, revision: revision(bytes) };
  } finally { await handle.close(); }
}

// ponytail: serialize IDE mutations per project; external tools still need revision checks.
export function serial() {
  let tail = Promise.resolve();
  return operation => { const next = tail.then(operation); tail = next.catch(() => {}); return next; };
}
export async function saveText(workspace, file, content, expected) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024) throw fault('INVALID_INPUT', '파일 크기 제한을 초과했습니다.');
  const target = await workspace.resolve(text(file, '경로'));
  if (expected === null) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await workspace.resolve(file);
    await fs.writeFile(target, content, { flag: 'wx' });
  } else {
    const current = await readText(workspace, file);
    if (current.revision !== expected) throw fault('REVISION_CONFLICT', '외부에서 변경되었습니다. 편집 내용은 유지됩니다.', 409, current);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const stat = await fs.stat(target);
      await fs.writeFile(temp, content, { flag: 'wx', mode: stat.mode });
      const latest = await readText(workspace, file);
      if (latest.revision !== expected) throw fault('REVISION_CONFLICT', '저장 중 외부 변경이 감지되었습니다.', 409, latest);
      await workspace.resolve(file);
      await fs.rename(temp, target);
    } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { content, revision: revision(Buffer.from(content)) };
}
const SKIP = ['.git', 'node_modules', 'dist', '.idea'];
const LIMIT = 10000;
async function* walkFiles(workspace, state, folder = '.') {
  for (const entry of await workspace.listFiles(folder)) {
    if (++state.visited > LIMIT) return;
    if (SKIP.includes(entry.name) || entry.kind === 'symlink') continue;
    const file = path.posix.join(folder, entry.name);
    if (entry.kind === 'directory') yield* walkFiles(workspace, state, file);
    else yield file;
  }
}
export async function indexFiles(workspace) {
  const state = { visited: 0 }, files = [];
  for await (const file of walkFiles(workspace, state)) files.push(file);
  return { files, truncated: state.visited > LIMIT };
}
const globs = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
const matches = (file, patterns) => patterns.some(pattern => path.posix.matchesGlob(file, pattern) || path.posix.matchesGlob(file, `**/${pattern}`) || path.posix.matchesGlob(file, `${pattern}/**`));
export function matcher({ query, regex, caseSensitive, wholeWord }) {
  text(query, '검색어', 500);
  let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) source = `\\b(?:${source})\\b`;
  try { return new RegExp(source, caseSensitive ? 'g' : 'gi'); }
  catch { throw fault('INVALID_INPUT', '정규식이 올바르지 않습니다.'); }
}
export async function search(workspace, query, options = {}) {
  const pattern = matcher({ ...options, query }), include = globs(options.include), exclude = globs(options.exclude);
  const hits = [], state = { visited: 0 };
  for await (const file of walkFiles(workspace, state)) {
    if (hits.length >= 200) break;
    if ((include.length && !matches(file, include)) || matches(file, exclude)) continue;
    try {
      const { content } = await readText(workspace, file);
      for (const [index, line] of content.split('\n').entries()) {
        pattern.lastIndex = 0;
        const found = pattern.exec(line);
        if (found) hits.push({ path: file, line: index + 1, column: found.index + 1, length: found[0].length, text: line.slice(0, 300) });
        if (hits.length >= 200) break;
      }
    } catch (error) { if (!['UNSUPPORTED_FILE', 'BINARY_FILE', 'ENOENT', 'EACCES'].includes(error.code)) throw error; }
  }
  return { hits, truncated: hits.length >= 200 || state.visited > LIMIT };
}
export async function replaceInFile(workspace, file, expected, options) {
  const current = await readText(workspace, file);
  if (current.revision !== expected) throw fault('REVISION_CONFLICT', '파일이 변경되었습니다.', 409, current);
  if (typeof options.replacement !== 'string' || options.replacement.length > 8192) throw fault('INVALID_INPUT', '바꿀 내용이 올바르지 않습니다.');
  let count = 0;
  const content = current.content.replace(matcher(options), () => { count++; return options.replacement; });
  if (!count) return { count, ...current };
  return { count, ...(await saveText(workspace, file, content, expected)) };
}
