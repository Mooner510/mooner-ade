import { promises as fs } from 'node:fs';
import { watch as fsWatch } from 'node:fs/promises';
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

// A cloned repository's core.fsmonitor is a command git runs on `git status`, and its .git/hooks run on checkout and
// worktree add. ADE runs these commands itself and never needs either, so both are forced off through the environment
// (command-scope config outranks the repo's .git/config). Hooks are off for ADE's git calls only, not for the user's shell.
const GIT_TRUSTED_REPO_CONFIG = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
};

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
      const childEnv = { ...process.env, ...env };
      if (file === 'git') Object.assign(childEnv, GIT_TRUSTED_REPO_CONFIG);
      const child = spawn(file, args, { cwd, env: childEnv, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

  async #run(requested, args) {
    const cwd = await this.workspace.resolve(requested);
    const result = await this.processes.exec('git', args, { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
    return result.stdout;
  }

  async status(requested = '.') {
    const output = await this.#run(requested, ['status', '--short', '--branch']);
    const [branch = '', ...changes] = output.trimEnd().split('\n');
    return { branch, changes: changes.filter(Boolean), clean: changes.every(x => !x) };
  }

  async diff(requested = '.', { staged = false } = {}) {
    return this.#run(requested, ['diff', '--no-ext-diff', ...(staged ? ['--cached'] : [])]);
  }

  #checkPaths(files) {
    if (!Array.isArray(files) || files.length === 0 || !files.every(f => typeof f === 'string' && f.length > 0 && !f.includes('\0'))) {
      throw new TypeError('At least one valid file path is required');
    }
    return files;
  }

  async stage(files, requested = '.') {
    await this.#run(requested, ['add', '--', ...this.#checkPaths(files)]);
  }

  async unstage(files, requested = '.') {
    await this.#run(requested, ['restore', '--staged', '--', ...this.#checkPaths(files)]);
  }

  async commit(message, requested = '.') {
    if (typeof message !== 'string' || !message.trim() || message.includes('\0')) throw new TypeError('Commit message required');
    await this.#run(requested, ['commit', '-m', message]);
    return (await this.#run(requested, ['rev-parse', 'HEAD'])).trim();
  }

  async worktrees() {
    const output = await this.#run('.', ['worktree', 'list', '--porcelain', '-z']);
    return output.split('\0\0').filter(Boolean).map(block => Object.fromEntries(block.split('\0').filter(Boolean).map(line => {
      const index = line.indexOf(' ');
      return index < 0 ? [line, true] : [line.slice(0, index), line.slice(index + 1)];
    })));
  }

  async createWorktree(target, branch) {
    if (typeof target !== 'string' || !path.isAbsolute(target) || typeof branch !== 'string' || !/^ade\/[a-zA-Z0-9_-]+$/.test(branch)) throw new TypeError('Invalid worktree target or branch');
    await this.#run('.', ['worktree', 'add', '-b', branch, '--', target]);
  }

  async removeWorktree(target) {
    if (!(await this.worktrees()).some(tree => tree.worktree === target) || target === this.workspace.root) throw new Error('Unknown secondary worktree');
    // Git refuses dirty worktrees; never force removal or delete their branch.
    await this.#run('.', ['worktree', 'remove', '--', target]);
  }

  async integrateWorktree(branch) {
    if (typeof branch !== 'string' || !/^ade\/[a-zA-Z0-9_-]+$/.test(branch)) throw new TypeError('Invalid task branch');
    if (!(await this.status()).clean) throw new Error('Commit or stash target changes manually first');
    await this.#run('.', ['merge', '--ff-only', '--', branch]);
  }
}

export class LocalTerminal {
  constructor({ shell, ptyFactory } = {}) {
    this.shell = shell || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh');
    this.ptyFactory = ptyFactory;
  }

  async open({ cwd = process.cwd(), cols = 100, rows = 28, env = {} } = {}) {
    if (![cols, rows].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000)) {
      throw new TypeError('Terminal dimensions must be integers between 1 and 1000');
    }
    const factory = this.ptyFactory ?? (await import('node-pty').catch(() => {
      throw new Error('Interactive terminal requires node-pty. Install it in the local runtime package.');
    }));
    const pty = factory.spawn(this.shell, [], { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, ...env } });
    return {
      pid: pty.pid,
      onData: callback => pty.onData(callback),
      onExit: callback => pty.onExit(callback),
      write: data => pty.write(data),
      resize: (nextCols, nextRows) => {
        if (![nextCols, nextRows].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000)) {
          throw new TypeError('Invalid terminal resize dimensions');
        }
        pty.resize(nextCols, nextRows);
      },
      close: () => pty.kill()
    };
  }
}

export function createLocalRuntime({ root = process.cwd(), scope = 'unrestricted', shell, ptyFactory } = {}) {
  const workspace = new LocalWorkspace(root, { scope });
  const processes = new LocalProcesses({ cwd: root });
  return { workspace, processes, git: new LocalGit(processes, workspace), terminal: new LocalTerminal({ shell, ptyFactory }), platform: { type: 'local', os: os.platform() } };
}
