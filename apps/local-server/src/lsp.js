import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// Content-Length framed JSON-RPC reader; tolerates split chunks and multiple messages per chunk.
export function createFrameParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))?.[1]);
      if (!Number.isSafeInteger(length) || length > 16 * 1024 * 1024) { buffer = Buffer.alloc(0); return; }
      if (buffer.length < end + 4 + length) return;
      const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8');
      buffer = buffer.subarray(end + 4 + length);
      try { onMessage(JSON.parse(body)); } catch { /* skip malformed frame */ }
    }
  };
}
export const frame = message => { const body = Buffer.from(JSON.stringify(message)); return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]); };

// One typescript-language-server per project root, started on first use.
export function createLspManager(onMessage) {
  const servers = new Map();
  function start(key, root) {
    const bin = createRequire(import.meta.url).resolve('typescript-language-server/lib/cli.mjs');
    const child = spawn(process.execPath, [bin, '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.on('data', createFrameParser(message => onMessage(key, message)));
    child.on('exit', () => servers.delete(key));
    child.on('error', () => servers.delete(key));
    return child;
  }
  return {
    send(key, root, message) {
      let child = servers.get(key);
      if (!child) { child = start(key, root); servers.set(key, child); }
      child.stdin.write(frame(message));
    },
    close(key) { servers.get(key)?.kill(); servers.delete(key); },
    closeAll() { for (const child of servers.values()) child.kill(); servers.clear(); }
  };
}
