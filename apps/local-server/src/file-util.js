import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Writes `content` only when the file does not already hold exactly that. A rewrite of identical bytes still counts as a new
// write to antivirus (Defender asks to upload "new" files again) and to the disk, so launch files that rarely change are left alone.
// The replacement goes through a temp file so a reader that opens the file mid-write never sees half of it.
// Returns true when the file was written.
export async function writeIfChanged(file, content, mode = 0o600) {
  try { if (await fs.readFile(file, 'utf8') === content) return false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, content, { mode });
  try { await fs.rename(temporary, file); } catch {
    // Windows refuses to replace a file another process has open (a `claude` reading it at start): fall back to writing in place.
    await fs.rm(temporary, { force: true }).catch(() => {});
    await fs.writeFile(file, content, { mode });
  }
  return true;
}

// On Windows a rename onto a file another process has open at that moment (antivirus scanning it, the indexer, our own list reading it)
// fails with EPERM/EBUSY/EACCES for a few milliseconds. It is tried again with a growing pause (about 2 s in all) before the error is given up.
export async function renameRetry(from, to, { rename = fs.rename, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 20 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= attempts) throw error; await wait(10 + attempt * 10); }
  }
}

// A file whose name carries a hash of its content: every chat that needs the same content points at the one file, and a changed content
// becomes a new file instead of racing a running reader. `name` keeps a readable prefix, `ext` includes the dot.
export async function writeShared(directory, name, ext, content) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${name}-${createHash('sha256').update(content).digest('hex').slice(0, 12)}${ext}`);
  await writeIfChanged(file, content);
  return file;
}

// The last `count` complete lines of a text file, read from the end so a long log costs what its tail costs, not its whole size.
// The file itself is untouched: nothing is trimmed or dropped on disk. A missing file reads as no lines.
export async function readLastLines(file, count, chunkBytes = 1 << 20) {
  let handle;
  try { handle = await fs.open(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  try {
    let position = (await handle.stat()).size, newlines = 0;
    const chunks = [];
    // Stop once there are more line breaks than wanted lines: then even if the first line read is cut off, `count` whole lines follow it.
    while (position > 0 && newlines <= count) {
      const length = Math.min(chunkBytes, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) { const { bytesRead } = await handle.read(chunk, filled, length - filled, position + filled); if (!bytesRead) break; filled += bytesRead; }
      chunks.unshift(chunk.subarray(0, filled));
      for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) newlines++;
    }
    let text = Buffer.concat(chunks).toString('utf8');
    // Not at the start of the file: the first line may be cut in the middle (a line break byte never sits inside a multi-byte character, so cutting there is safe).
    if (position > 0) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-count);
  } finally { await handle.close(); }
}
