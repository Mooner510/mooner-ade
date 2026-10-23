import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Every path the app touches is resolved here, so neither `..` nor a symlink can reach outside the project root.
export class LocalWorkspace {
  constructor(root) { this.root = path.resolve(root); }

  async resolve(requested = '.') {
    if (typeof requested !== 'string' || requested.includes('\0')) throw new TypeError('Invalid file path');
    const target = path.resolve(this.root, requested);
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

  async exec(file, args = [], { cwd = this.cwd, env, timeoutMs = 0, maxOutputBytes = 1_048_576 } = {}) {
    if (typeof file !== 'string' || !file || !Array.isArray(args) || !args.every(x => typeof x === 'string')) {
      throw new TypeError('Expected executable and argv string array');
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new TypeError('Invalid output limit');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError('Invalid timeout');
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
        if (error) reject(error);
        else resolve({ exitCode: code, stdout, stderr });
      };
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
    });
  }
}

export class LocalGit {
  constructor(processes, workspace) { this.processes = processes; this.workspace = workspace; }

  async #run(args) {
    const result = await this.processes.exec('git', args, { cwd: this.workspace.root });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
    return result.stdout;
  }

  async status() {
    const output = await this.#run(['status', '--short', '--branch']);
    const [branch = '', ...changes] = output.trimEnd().split('\n');
    return { branch, changes: changes.filter(Boolean), clean: changes.every(x => !x) };
  }

  async worktrees() {
    const output = await this.#run(['worktree', 'list', '--porcelain', '-z']);
    return output.split('\0\0').filter(Boolean).map(block => Object.fromEntries(block.split('\0').filter(Boolean).map(line => {
      const index = line.indexOf(' ');
      return index < 0 ? [line, true] : [line.slice(0, index), line.slice(index + 1)];
    })));
  }

  async createWorktree(target, branch) {
    if (typeof target !== 'string' || !path.isAbsolute(target) || typeof branch !== 'string' || !/^ade\/[a-zA-Z0-9_-]+$/.test(branch)) throw new TypeError('Invalid worktree target or branch');
    await this.#run(['worktree', 'add', '-b', branch, '--', target]);
  }

  async removeWorktree(target) {
    if (!(await this.worktrees()).some(tree => tree.worktree === target) || target === this.workspace.root) throw new Error('Unknown secondary worktree');
    // Git refuses dirty worktrees; never force removal or delete their branch.
    await this.#run(['worktree', 'remove', '--', target]);
  }

  async integrateWorktree(branch) {
    if (typeof branch !== 'string' || !/^ade\/[a-zA-Z0-9_-]+$/.test(branch)) throw new TypeError('Invalid task branch');
    if (!(await this.status()).clean) throw new Error('Commit or stash target changes manually first');
    await this.#run(['merge', '--ff-only', '--', branch]);
  }
}

export class LocalTerminal {
  constructor({ ptyFactory } = {}) {
    this.shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh';
    this.ptyFactory = ptyFactory;
  }

  // `meta` is opaque data a remote PTY host keeps next to the terminal so it can be recognised after a server restart.
  async open({ cwd, cols = 100, rows = 28, env = {}, args = [], meta } = {}) {
    const pty = await this.ptyFactory.spawn(this.shell, args, { name: 'xterm-256color', useConptyDll: process.platform === 'win32', cols, rows, cwd, env: { COLORTERM: 'truecolor', ...process.env, ...env }, ...(meta && { meta }) });
    return {
      pid: pty.pid,
      // Only a remote PTY can outlive this process; a local one is simply closed.
      detach: () => (pty.detach ? pty.detach() : pty.kill()),
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

export function createLocalRuntime({ root, ptyFactory }) {
  const workspace = new LocalWorkspace(root);
  const processes = new LocalProcesses({ cwd: root });
  return { workspace, processes, git: new LocalGit(processes, workspace), terminal: new LocalTerminal({ ptyFactory }) };
}
