import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fault, serial } from './files.js';

export const INLINE_CHAT_TEXT_BYTES = 64 * 1024;
export const MAX_CHAT_TEXT_BYTES = 8 * 1024 * 1024;
export const CHAT_TEXT_TTL_MS = 30 * 60_000;

export function createChatTextStore(dataRoot) {
  const id = createHash('sha256').update(path.resolve(dataRoot)).digest('hex').slice(0, 24);
  const directory = path.join(os.tmpdir(), `mooner-ade-chat-text-${id}`);
  const run = serial();
  let stopped = false;

  async function checkDirectory() {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw fault('INVALID_PATH', '채팅 임시 폴더에 접근할 수 없습니다.');
    }
  }

  const prune = (clear = false) => run(async () => {
    let entries;
    try { await checkDirectory(); entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const cutoff = Date.now() - CHAT_TEXT_TTL_MS;
    await Promise.all(entries.filter(entry => entry.isFile() && /^message-[0-9a-f-]{36}\.txt$/.test(entry.name)).map(async entry => {
      const file = path.join(directory, entry.name);
      try { if (clear || (await fs.stat(file)).mtimeMs <= cutoff) await fs.rm(file, { force: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }));
  });

  return {
    async prepare(text) {
      if (typeof text !== 'string' || !text.trim() || text.includes('\0')) throw fault('INVALID_INPUT', '메시지를 확인하세요.');
      const bytes = Buffer.byteLength(text);
      if (bytes > MAX_CHAT_TEXT_BYTES) throw fault('PAYLOAD_TOO_LARGE', '채팅 메시지는 8MiB까지 보낼 수 있습니다. 큰 로그는 파일로 첨부하세요.', 413);
      if (/^\/[\w:-]+(?:\s|$)/.test(text)) {
        if (text.length > 200_000) throw fault('PAYLOAD_TOO_LARGE', '채팅 명령은 20만 자까지 입력할 수 있습니다.', 413);
        return text;
      }
      if (bytes <= INLINE_CHAT_TEXT_BYTES) return text;
      return run(async () => {
        if (stopped) throw fault('SHUTTING_DOWN', '서버가 종료 중입니다.', 503);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await checkDirectory();
        const file = path.join(directory, `message-${randomUUID()}.txt`);
        await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 });
        const ref = file.split(path.sep).join('/');
        return `긴 메시지 원문 [[file:${ref}]]\n\n이 UTF-8 파일을 읽고 그 안의 사용자 메시지에 답하세요. 로그가 길면 필요한 부분부터 나눠 읽으세요. 파일이 만료되었으면 원문을 다시 보내 달라고 알려주세요.`;
      });
    },
    prune,
    stop(clear) { stopped = true; return prune(clear); }
  };
}
