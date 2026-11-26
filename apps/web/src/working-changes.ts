// The Git drawer's "커밋 안 된 변경" list: the files that differ from HEAD (`git/compare` against the working tree, untracked files included, one row
// per file even inside a new folder), with the line counts `git/status` already has. Each row opens against HEAD in the diff tab. Pure, for Node tests.
import type { GitChange } from './views';

export type WorkingFile = { status: string; path: string; original?: string; added?: number; deleted?: number; untracked?: boolean; spec: string };
// A repository with no commit yet compares with the empty tree: everything in it is new.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function workingFiles(files: { status: string; path: string; original?: string; untracked?: boolean }[], status: GitChange[], head: string | null): WorkingFile[] {
  const base = head || EMPTY_TREE, counts = new Map(status.map(change => [change.path, change]));
  return files.filter(file => file.path && !file.path.endsWith('/')).map(file => {
    const known = counts.get(file.path);
    return { status: file.status, path: file.path, ...(file.original && { original: file.original }), ...(known?.added != null && { added: known.added }), ...(known?.deleted != null && { deleted: known.deleted }),
      ...((file.untracked || known?.status === '??') && { untracked: true }), spec: `diff:${base}..:${file.path}${file.original ? `\t${file.original}` : ''}` };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
export const workingTotals = (files: WorkingFile[]) => files.reduce((sum, file) => ({ added: sum.added + (file.added ?? 0), deleted: sum.deleted + (file.deleted ?? 0) }), { added: 0, deleted: 0 });
// Refetch when what status reports moved (a file, its state or its line counts) or HEAD moved.
export const workingKey = (status: GitChange[], head: string | null) => `${head ?? ''}\n${status.map(change => `${change.status}${change.path}:${change.added ?? ''}:${change.deleted ?? ''}`).join('\n')}`;
