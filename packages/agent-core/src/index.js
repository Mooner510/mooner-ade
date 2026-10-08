import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export async function* parseJsonLines(chunks, { maxLineBytes = 2_097_152 } = {}) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const emitLine = line => {
    if (!line.trim()) return null;
    try { return JSON.parse(line); }
    catch { throw new Error('Agent produced malformed JSONL output'); }
  };
  for await (const chunk of chunks) {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).replace(/\r$/, '');
      pending = pending.slice(end + 1);
      if (Buffer.byteLength(line) > maxLineBytes) throw new Error('Agent JSONL line exceeds size limit');
      const value = emitLine(line);
      if (value !== null) yield value;
    }
    if (Buffer.byteLength(pending) > maxLineBytes) throw new Error('Agent JSONL line exceeds size limit');
  }
  pending += decoder.end();
  const last = emitLine(pending);
  if (last !== null) yield last;
}

/** A portable JSONL subprocess backend. stdout is JSONL and stderr remains diagnostic only. */
export class JsonlCliAgent {
  constructor({ id, executable, buildArgs, normalize, spawnProcess = spawn, maxStderrBytes = 65536 }) {
    this.id = id;
    this.executable = executable;
    this.buildArgs = buildArgs;
    this.normalize = normalize;
    this.spawnProcess = spawnProcess;
    this.maxStderrBytes = maxStderrBytes;
  }

  async *run({ prompt, cwd = process.cwd(), threadId, signal, env, ...options }) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('Prompt required');
    if (signal?.aborted) throw signal.reason || new Error('Aborted');
    const args = this.buildArgs({ threadId, ...options });
    const child = this.spawnProcess(this.executable, args, {
      cwd, env: env ? { ...process.env, ...env } : process.env,
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '', spawnedError;
    const endPromise = new Promise(resolve => {
      child.once('error', error => { spawnedError = error; resolve(null); });
      child.once('close', code => resolve(code));
    });
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stderr?.on('data', chunk => { if (stderr.length < this.maxStderrBytes) stderr += chunk.toString('utf8').slice(0, this.maxStderrBytes - stderr.length); });
    child.stdin?.on('error', () => {}); // EPIPE when CLI exits early, handled by exit status.
    child.stdin?.end(prompt);
    try {
      for await (const entry of parseJsonLines(child.stdout)) {
        for (const event of this.normalize(entry)) yield event;
      }
      const code = await endPromise;
      if (signal?.aborted) throw signal.reason || new Error('Aborted');
      if (spawnedError) throw spawnedError;
      if (code !== 0) throw new Error(`${this.id} exited with ${code}: ${stderr.trim().slice(-1000)}`);
    } finally {
      signal?.removeEventListener('abort', stop);
      if (child.exitCode === null) child.kill('SIGTERM');
      await endPromise;
    }
  }
}
