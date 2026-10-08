import { promises as fs, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export class LocalWorkspace {
  constructor(root = process.cwd(), { scope = 'unrestricted' } = {}) {
    if (!['unrestricted', 'root'].includes(scope)) throw new TypeError('Unknown scope');
    this.root = path.resolve(root);
    this.scope = scope;
  }

  async resolve(requested = '.') {
    if (typeof requested !== 'string' || requested.includes('\0')) throw new TypeError('Invalid file path');
    const target = path.resolve(this.root, requested);
    if (this.scope !== 'root') return target;
    const realRoot = await fs.realpath(this.root);
    if (!inside(this.root, target)) throw new Error('Workspace path escape');
    let ancestor = target;
    while (true) {
      try { ancestor = await fs.realpath(ancestor); break; }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw e;
        ancestor = parent;
      }
    }
    if (!inside(realRoot, ancestor)) throw new Error('Workspace symlink escape');
    return target;
  }

  async readFile(requested) { return fs.readFile(await this.resolve(requested), 'utf8'); }

  async writeFile(requested, content) {
    if (typeof content !== 'string') throw new TypeError('Content must be text');
    const file = await this.resolve(requested);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await this.resolve(requested);
    await fs.writeFile(file, content, 'utf8');
  }

  async listFiles(requested = '.') {
    const dir = await this.resolve(requested);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' }));
  }

  async *watch(requested = '.', { signal } = {}) {
    const folder = await this.resolve(requested);
    const iterator = fsWatch(folder, { signal });
    try { for await (const event of iterator) yield { kind: event.eventType, path: event.filename }; }
    finally { iterator.close(); }
  }
}

export class LocalProcesses {
  constructor({ cwd = process.cwd() } = {}) { this.cwd = path.resolve(cwd); }

  async exec(file, args = [], { cwd = this.cwd, env, signal, timeoutMs = 0, maxOutputBytes = 1_048_576 } = {}) {
    if (typeof file !== 'string' || !file || !Array.isArray(args) || !args.every(x => typeof x === 'string')) {
      throw new TypeError('Expected executable and argv string array');
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new TypeError('Invalid output limit');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError('Invalid timeout');
    if (signal?.aborted) throw signal.reason || new Error('Aborted');
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { cwd, env: env ? { ...process.env, ...env } : process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '', bytes = 0, completed = false;
      const stop = (reason) => { child.kill('SIGTERM'); finish(reason); };
      const finish = (error, code) => {
        if (completed) return;
        completed = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve({ exitCode: code, stdout, stderr });
      };
      const onAbort = () => stop(signal.reason || new Error('Aborted'));
      const timer = timeoutMs ? setTimeout(() => stop(new Error(`Process timed out after ${timeoutMs}ms`)), timeoutMs) : null;
      const receive = (chunk, channel) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) return stop(new Error('Process output limit exceeded'));
        if (channel === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };
      child.stdout.on('data', chunk => receive(chunk, 'stdout'));
      child.stderr.on('data', chunk => receive(chunk, 'stderr'));
      child.once('error', error => finish(error));
      child.once('close', code => finish(null, code));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}

export class LocalGit {
  constructor(processes, workspace) { this.processes = processes; this.workspace = workspace; }
  async status(requested = '.') {
    const cwd = await this.workspace.resolve(requested);
    const result = await this.processes.exec('git', ['status', '--short', '--branch'], { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'git status failed');
    const [branch = '', ...changes] = result.stdout.trimEnd().split('\n');
    return { branch, changes: changes.filter(Boolean), clean: changes.every(x => !x) };
  }
  async diff(requested = '.') {
    const cwd = await this.workspace.resolve(requested);
    const result = await this.processes.exec('git', ['diff', '--no-ext-diff'], { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'git diff failed');
    return result.stdout;
  }
}

export class LocalTerminal {
  constructor({ shell } = {}) { this.shell = shell || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh'); }
  async open({ cwd = process.cwd(), cols = 100, rows = 28, env = {} } = {}) {
    let mod;
    try { mod = await import('node-pty'); }
    catch { throw new Error('Interactive terminal requires node-pty. Install it in the local runtime package.'); }
    const pty = mod.spawn(this.shell, [], { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, ...env } });
    return {
      pid: pty.pid,
      onData: callback => pty.onData(callback),
      onExit: callback => pty.onExit(callback),
      write: data => pty.write(data),
      resize: (nextCols, nextRows) => pty.resize(nextCols, nextRows),
      close: () => pty.kill()
    };
  }
}

export function createLocalRuntime({ root = process.cwd(), scope = 'unrestricted', shell } = {}) {
  const workspace = new LocalWorkspace(root, { scope });
  const processes = new LocalProcesses({ cwd: root });
  return { workspace, processes, git: new LocalGit(processes, workspace), terminal: new LocalTerminal({ shell }), platform: { type: 'local', os: os.platform() } };
}
