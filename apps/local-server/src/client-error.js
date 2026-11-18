import { promises as fs } from 'node:fs';

const MAX_BYTES = 256 * 1024;
const REPEAT_MS = 60_000;

const clip = (value, max) => typeof value === 'string' ? value.replace(/\0/g, '').trim().slice(0, max) : '';

// One block a person can read later: the message, then the stack, then where in the tree it threw.
export function clientErrorText(input = {}) {
  const message = clip(input.message, 500) || '알 수 없는 오류';
  const stack = clip(input.stack, 4000);
  const componentStack = clip(input.componentStack, 2000);
  const lines = [`화면 렌더링 오류: ${message}`];
  if (stack && stack !== message) lines.push(stack);
  if (componentStack) lines.push(`컴포넌트:\n${componentStack}`);
  return lines.join('\n');
}

// Printed on the server and appended under the data folder. The installed app has no console to keep, so the file is what is still there next time.
// The same text inside a minute is skipped: a render loop must not fill the log.
export function createClientErrorLog({ file, appendFile = fs.appendFile, stat = fs.stat, rename = fs.rename, rm = fs.rm, now = () => Date.now(), error = console.error, maxBytes = MAX_BYTES } = {}) {
  let last = { key: '', at: 0 };
  return async function record(input) {
    const text = clientErrorText(input);
    if (text === '화면 렌더링 오류: 알 수 없는 오류' && !clip(input?.stack, 1) && !clip(input?.componentStack, 1)) return { logged: false };
    const at = now();
    if (text === last.key && at - last.at < REPEAT_MS) return { logged: false };
    last = { key: text, at };
    error(text);
    try {
      const size = await stat(file).then(info => info.size, () => 0);
      if (size > maxBytes) {
        await rm(`${file}.old`, { force: true }).catch(() => {});
        await rename(file, `${file}.old`).catch(() => {});
      }
      await appendFile(file, `--- ${new Date(at).toISOString()}\n${text}\n`, { mode: 0o600 });
    } catch (cause) {
      error(`화면 오류를 기록하지 못했습니다: ${cause instanceof Error ? cause.message : cause}`);
    }
    return { logged: true };
  };
}
