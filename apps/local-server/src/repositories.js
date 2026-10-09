import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const identity = value => createHash('sha256').update(value).digest('hex');

async function gitValue(processes, cwd, args) {
  try {
    const result = await processes.exec('git', args, { cwd });
    return result.exitCode === 0 ? result.stdout.trim() : '';
  } catch { return ''; }
}

export async function discoverRepositories(root, processes) {
  const currentTop = await gitValue(processes, root, ['rev-parse', '--show-toplevel']);
  if (currentTop && await fs.realpath(currentTop) === root) {
    const commonDir = await gitValue(processes, root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return { multiRepo: false, repositories: [{ id: identity(await fs.realpath(commonDir)), name: path.basename(root), path: root }] };
  }

  const repositories = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const repoPath = path.join(root, entry.name);
    try { await fs.lstat(path.join(repoPath, '.git')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const top = await gitValue(processes, repoPath, ['rev-parse', '--show-toplevel']);
    if (!top || await fs.realpath(top) !== repoPath) continue;
    const commonDir = await gitValue(processes, repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    repositories.push({ id: identity(await fs.realpath(commonDir)), name: entry.name, path: repoPath });
  }
  repositories.sort((a, b) => a.name.localeCompare(b.name));
  return { multiRepo: true, repositories };
}
