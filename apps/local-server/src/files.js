import { promises as fs } from 'node:fs';

export function fault(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
export function text(value, name = '값', max = 8192) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fault('INVALID_INPUT', `${name}이 올바르지 않습니다.`);
  return value;
}
// Reads a UTF-8 text file of at most 2 MiB inside the workspace, for diffs of untracked and working-tree files.
export async function readText(workspace, file) {
  const target = await workspace.resolve(text(file, '경로'));
  const handle = await fs.open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw fault('UNSUPPORTED_FILE', '일반 텍스트 파일(2 MiB 이하)만 표시할 수 있습니다.');
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
    if (bytes.includes(0)) throw fault('BINARY_FILE', '바이너리 파일은 표시할 수 없습니다.');
    return content;
  } finally { await handle.close(); }
}

// Runs operations one at a time, in call order.
export function serial() {
  let tail = Promise.resolve();
  return operation => { const next = tail.then(operation); tail = next.catch(() => {}); return next; };
}
