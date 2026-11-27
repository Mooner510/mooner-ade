// Chat worktrees: a chat can run in its own git worktree (its own branch), leave it, come back, merge it into the repository it came from,
// and let it go. ADE makes the worktree itself for every agent (Claude, Codex, Cursor), so it always knows the folder, the branch, the
// repository it belongs to and the commit it started from. Every git call goes through runtime.js (argv only, the repository's hooks and
// fsmonitor off) and never rewrites history: merges are fast-forward or a merge commit, never squash or rebase.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LocalProcesses } from './runtime.js';
import { fault } from './files.js';

const processes = new LocalProcesses();
const MAX_FILES = 200, MAX_COMMITS = 50;
// A merge or commit started from ADE must never wait for an editor or a password, and must never be turned into a squash or a rebase by the user's config.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_SEQUENCE_EDITOR: 'true' };

export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const norm = value => { const resolved = path.resolve(value).replace(/[\\/]+$/, ''); return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved; };
  return norm(a) === norm(b);
}
const inside = (parent, child) => { const rel = path.relative(path.resolve(parent), path.resolve(child)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

async function git(cwd, args, { ok = [0], maxOutputBytes = 4 * 1024 * 1024, timeoutMs = 120_000 } = {}) {
  const result = await processes.exec('git', args, { cwd, env: GIT_ENV, maxOutputBytes, timeoutMs });
  if (!ok.includes(result.exitCode)) throw Object.assign(fault('GIT_FAILED', (result.stderr || result.stdout).trim().split('\n').slice(-6).join('\n') || `git ${args[0]} 실패`, 409), { exitCode: result.exitCode });
  return result;
}
// One value from git, or '' when git says no (a ref that does not exist, not a repository).
const value = async (cwd, args) => { const result = await git(cwd, args, { ok: [0, 1, 128] }).catch(() => null); return result?.exitCode === 0 ? result.stdout.trim() : ''; };

// Where ADE puts a chat's worktree: the project's data folder, next to the repository worktrees (`<data>/worktrees/<repo>`), never inside
// the repository (no `.gitignore` entry needed, the project's file watcher and `git status` do not see the agent's edits as the user's).
export const worktreeRoot = directory => path.join(directory, 'worktrees');
// A short, readable branch per chat. The full id is the fallback when the short one is taken (another chat's, or a leftover).
export const branchCandidates = id => [`ade/chat-${String(id).slice(0, 8)}`, `ade/chat-${id}`];
const sidecarOf = worktreePath => `${path.resolve(worktreePath)}.ade.json`;
export async function readSidecar(worktreePath) {
  try { const data = JSON.parse(await fs.readFile(sidecarOf(worktreePath), 'utf8')); return data && typeof data === 'object' ? data : null; } catch { return null; }
}
const writeSidecar = (worktreePath, data) => fs.writeFile(sidecarOf(worktreePath), JSON.stringify(data, null, 2), { mode: 0o600 });

// The chat's own worktree (made by ADE for it), kept while it exists whether or not the chat is in it right now.
const ownFile = root => path.join(root, 'worktree.json');
export async function readOwnWorktree(chatRoot) { try { const data = JSON.parse(await fs.readFile(ownFile(chatRoot), 'utf8')); return typeof data?.path === 'string' ? data : null; } catch { return null; } }
export async function writeOwnWorktree(chatRoot, data) { if (data) await fs.writeFile(ownFile(chatRoot), JSON.stringify(data), { mode: 0o600 }); else await fs.rm(ownFile(chatRoot), { force: true }); }

async function worktreeList(repo) {
  const { stdout } = await git(repo, ['worktree', 'list', '--porcelain', '-z']);
  return stdout.split('\0\0').filter(Boolean).map(block => Object.fromEntries(block.split('\0').filter(Boolean).map(line => { const at = line.indexOf(' '); return at < 0 ? [line, true] : [line.slice(0, at), line.slice(at + 1)]; })));
}

// What git says about a folder: the worktree it is in, and whether that is a linked worktree (not the repository's main one).
// The origin (where a merge goes) is the folder ADE recorded when it made the worktree; for one an agent made (Claude's EnterWorktree puts
// them in `<repo>/.claude/worktrees/<name>`) it is the repository that holds that folder, else the repository's main worktree.
export async function detectWorktree(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const probe = await git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], { ok: [0, 128] }).catch(() => null);
  if (!probe || probe.exitCode !== 0) return null;
  const [top, gitDir, common] = probe.stdout.trim().split(/\r?\n/).map(line => path.resolve(line));
  if (!top || !gitDir || !common || samePath(gitDir, common)) return null;
  const branch = await value(top, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const extra = await readSidecar(top);
  let origin = typeof extra?.origin === 'string' ? extra.origin : '';
  const claude = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/.test(top);
  if (!origin && claude) origin = path.resolve(top, '..', '..', '..');
  if (!origin) origin = path.resolve((await worktreeList(top).catch(() => []))[0]?.worktree ?? path.dirname(common));
  return { path: top, cwd: path.resolve(cwd), branch, origin, base: extra?.base ?? '', baseBranch: extra?.baseBranch ?? '', createdAt: extra?.createdAt ?? null, chatId: extra?.chatId ?? '', kind: extra ? 'ade' : claude ? 'claude' : 'other' };
}

// A new worktree for a chat, branched from the commit the chat's folder is on now. `cwd` may be a subfolder of the repository: the chat then
// runs in the same subfolder of the worktree.
export async function createChatWorktree({ directory, id, cwd }) {
  const top = await value(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) throw fault('NOT_A_REPOSITORY', '이 폴더는 Git 저장소가 아니라 worktree를 만들 수 없습니다.', 409);
  const origin = path.resolve(top), rel = path.relative(origin, path.resolve(cwd));
  const base = await value(origin, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!base) throw fault('NO_COMMITS', '커밋이 하나도 없는 저장소에서는 worktree를 만들 수 없습니다. 먼저 커밋하세요.', 409);
  const baseBranch = await value(origin, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const taken = async name => Boolean(await value(origin, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]));
  let branch = '';
  for (const candidate of branchCandidates(id)) if (!(await taken(candidate))) { branch = candidate; break; }
  if (!branch) throw fault('WORKTREE_EXISTS', `이 채팅의 브랜치(${branchCandidates(id)[1]})가 이미 있습니다. worktree 관리에서 정리하세요.`, 409);
  const folder = path.join(worktreeRoot(directory), `chat-${branch.slice('ade/chat-'.length)}`);
  if (await fs.stat(folder).then(() => true, () => false)) throw fault('WORKTREE_PATH_CONFLICT', `worktree 폴더가 이미 있습니다: ${folder}`, 409);
  await fs.mkdir(worktreeRoot(directory), { recursive: true });
  await git(origin, ['worktree', 'add', '-b', branch, '--', folder, base]);
  const createdAt = Date.now();
  await writeSidecar(folder, { chatId: id, origin, base, baseBranch, branch, createdAt });
  return { path: folder, cwd: rel && !rel.startsWith('..') ? path.join(folder, rel) : folder, branch, origin, originCwd: path.resolve(cwd), base, baseBranch, createdAt, chatId: id, kind: 'ade' };
}

// Porcelain v1 -z: "XY path" records; a rename carries its old path in the next record.
function parseStatus(stdout) {
  const files = [], parts = stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]; if (entry.length < 4) continue;
    const code = entry.slice(0, 2), file = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++;
    files.push({ path: file, status: code.trim() || code });
  }
  return files;
}
const counts = text => { const [behind, ahead] = text.trim().split(/\s+/).map(Number); return { behind: behind || 0, ahead: ahead || 0 }; };

// Where the worktree stands against the branch its repository has checked out now: commits it has that the origin branch lacks (ahead) and the
// other way round (behind), uncommitted files, and whether the origin is in a state a merge can go into.
export async function worktreeStatus(info) {
  const at = Date.now();
  if (!info?.path || !(await fs.stat(info.path).then(stat => stat.isDirectory(), () => false))) return { exists: false, at };
  const files = parseStatus((await git(info.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout);
  const branch = await value(info.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const head = await value(info.path, ['rev-parse', 'HEAD']);
  const originBranch = info.origin ? await value(info.origin, ['symbolic-ref', '--quiet', '--short', 'HEAD']) : '';
  const originHead = info.origin ? await value(info.origin, ['rev-parse', 'HEAD']) : '';
  let ahead = 0, behind = 0, merged = false;
  if (head && originHead) {
    ({ ahead, behind } = counts((await git(info.path, ['rev-list', '--left-right', '--count', `${originHead}...${head}`])).stdout));
    merged = ahead === 0 && Boolean(info.base) && head !== info.base;
  }
  const originFiles = info.origin ? parseStatus((await git(info.origin, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])).stdout) : [];
  const originBusy = info.origin ? Boolean(await value(info.origin, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) || await fs.stat(path.join(await value(info.origin, ['rev-parse', '--path-format=absolute', '--git-dir']) || info.origin, 'rebase-merge')).then(() => true, () => false) : false;
  const conflicted = files.filter(file => /^(DD|AU|UD|UA|DU|AA|UU)$/.test(file.status)).map(file => file.path);
  const midMerge = Boolean(await value(info.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']));
  return { exists: true, at, branch, head, ahead, behind, merged, dirty: files.length, files: files.slice(0, MAX_FILES), conflicted, midMerge, originBranch, originHead, originDirty: originFiles.length, originFiles: originFiles.slice(0, 50).map(file => file.path), originBusy };
}

// Files that would conflict if `theirs` were merged into `ours` (both commits), from `git merge-tree --write-tree` (git 2.38+), without touching any worktree.
export async function predictConflicts(repo, ours, theirs) {
  if (!ours || !theirs) return [];
  const result = await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs], { ok: [0, 1] });
  return result.exitCode === 0 ? [] : result.stdout.trim().split(/\r?\n/).slice(1).filter(Boolean);
}

// What "원본으로 합치기" will do: the commits, the changed files with their line counts, the uncommitted files that would be committed first,
// and the files that would conflict.
export async function mergePreview(info) {
  const status = await worktreeStatus(info);
  if (!status.exists) return { status, commits: [], changes: [], conflicts: [], fastForward: false };
  const commits = status.originHead ? (await git(info.path, ['log', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%at', `-${MAX_COMMITS}`, `${status.originHead}..HEAD`])).stdout.trim().split('\n').filter(Boolean).map(line => { const [hash, short, subject, author, time] = line.split('\x1f'); return { hash, short, subject, author, at: Number(time) * 1000 }; }) : [];
  const numstat = status.originHead ? (await git(info.path, ['diff', '--numstat', '--no-renames', '--no-textconv', '--no-ext-diff', `${status.originHead}...HEAD`])).stdout : '';
  const changes = numstat.trim().split('\n').filter(Boolean).slice(0, MAX_FILES).map(line => { const [added, deleted, ...rest] = line.split('\t'); return { path: rest.join('\t'), added: Number(added) || 0, deleted: Number(deleted) || 0 }; });
  const conflicts = status.ahead && status.behind ? await predictConflicts(info.origin, status.originHead, status.head).catch(() => []) : [];
  return { status, commits, changes, conflicts, fastForward: status.behind === 0 };
}

// Everything in the worktree (new files too) as one commit on its branch, with the message the user wrote. Nothing to commit is not an error.
export async function commitWorktree(info, message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw fault('INVALID_INPUT', '커밋 메시지를 입력하세요.');
  if (text.length > 4000) throw fault('INVALID_INPUT', '커밋 메시지가 너무 깁니다.');
  await git(info.path, ['add', '-A']);
  const staged = await git(info.path, ['diff', '--cached', '--quiet'], { ok: [0, 1] });
  if (staged.exitCode === 0) return { committed: false };
  await git(info.path, ['commit', '-q', '-m', text]);
  return { committed: true, commit: await value(info.path, ['rev-parse', 'HEAD']) };
}

// The worktree's branch into the branch its repository has checked out: fast-forward when possible, otherwise a merge commit. Never squash
// or rebase. The origin's work is never put at risk: it must be on a branch, have no uncommitted changes to tracked files and no merge or
// rebase in progress, and a predicted conflict stops before anything is touched (the agent can merge the origin branch into its own worktree,
// resolve there, and come back as a fast-forward). A conflict git finds anyway is aborted, so the origin is left as it was.
export async function mergeWorktree(info) {
  const status = await worktreeStatus(info);
  if (!status.exists) throw fault('WORKTREE_MISSING', 'worktree 폴더가 없습니다.', 404);
  if (status.dirty) throw fault('WORKTREE_DIRTY', `worktree에 커밋하지 않은 변경 ${status.dirty}개가 있습니다. 먼저 커밋하세요.`, 409);
  if (status.midMerge) throw fault('WORKTREE_BUSY', 'worktree에서 merge가 진행 중입니다. 충돌을 해결하고 커밋한 뒤 다시 시도하세요.', 409);
  if (!status.branch) throw fault('WORKTREE_DETACHED', 'worktree가 브랜치에 있지 않습니다(detached HEAD).', 409);
  if (!status.ahead) return { merged: false, reason: 'nothing', status };
  if (!status.originBranch) throw fault('ORIGIN_DETACHED', '원본 저장소가 브랜치에 있지 않습니다(detached HEAD). 원본에서 브랜치를 체크아웃하세요.', 409);
  if (status.originBranch === status.branch) throw fault('ORIGIN_SAME_BRANCH', '원본이 worktree와 같은 브랜치에 있습니다.', 409);
  if (status.originBusy) throw fault('ORIGIN_BUSY', '원본 저장소에서 merge나 rebase가 진행 중입니다. 먼저 끝내거나 중단하세요.', 409);
  if (status.originDirty) throw Object.assign(fault('ORIGIN_DIRTY', `원본 작업 트리에 커밋하지 않은 변경 ${status.originDirty}개가 있습니다. 정리(커밋·stash)한 뒤 다시 시도하세요.`, 409), { files: status.originFiles });
  const conflicts = status.behind ? await predictConflicts(info.origin, status.originHead, status.head) : [];
  if (conflicts.length) throw Object.assign(fault('MERGE_CONFLICT', `원본(${status.originBranch})과 충돌하는 파일 ${conflicts.length}개가 있어 합치지 않았습니다.`, 409), { files: conflicts, originBranch: status.originBranch });
  const before = status.originHead;
  const merged = await git(info.origin, ['merge', '--ff', '--no-squash', '--no-edit', '--', status.branch], { ok: [0, 1, 128] });
  if (merged.exitCode !== 0) {
    const conflicted = parseStatus((await git(info.origin, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])).stdout).filter(file => /^(DD|AU|UD|UA|DU|AA|UU)$/.test(file.status)).map(file => file.path);
    if (await value(info.origin, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) await git(info.origin, ['merge', '--abort'], { ok: [0, 128] });
    throw Object.assign(fault(conflicted.length ? 'MERGE_CONFLICT' : 'MERGE_FAILED', conflicted.length ? `충돌이 나서 합치기를 되돌렸습니다(파일 ${conflicted.length}개).` : `합치지 못했습니다: ${(merged.stderr || merged.stdout).trim().split('\n').slice(-3).join(' ')}`, 409), { files: conflicted, originBranch: status.originBranch });
  }
  const after = await value(info.origin, ['rev-parse', 'HEAD']);
  return { merged: true, fastForward: after === status.head, commit: after, before, into: status.originBranch, branch: status.branch, commits: status.ahead };
}

// Other chats' branches into this worktree (the integrator's), one merge commit (or fast-forward) each, in the given order. Stops at the first
// conflict and leaves it in this worktree for its agent to resolve and commit; the branches already merged stay merged.
export async function integrateBranches(info, branches) {
  const status = await worktreeStatus(info);
  if (!status.exists) throw fault('WORKTREE_MISSING', 'worktree 폴더가 없습니다.', 404);
  if (status.dirty || status.midMerge) throw fault('WORKTREE_DIRTY', '통합할 worktree에 커밋하지 않은 변경이나 진행 중인 merge가 있습니다. 먼저 커밋하세요.', 409);
  const done = [];
  for (const branch of branches) {
    if (!/^[\w./-]{1,200}$/.test(branch) || branch.startsWith('-')) throw fault('INVALID_INPUT', `잘못된 브랜치 이름입니다: ${branch}`);
    const merged = await git(info.path, ['merge', '--no-squash', '--no-edit', '--', branch], { ok: [0, 1, 128] });
    if (merged.exitCode !== 0) {
      const conflicted = parseStatus((await git(info.path, ['status', '--porcelain=v1', '-z'])).stdout).filter(file => /^(DD|AU|UD|UA|DU|AA|UU)$/.test(file.status)).map(file => file.path);
      if (!conflicted.length && await value(info.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) await git(info.path, ['merge', '--abort'], { ok: [0, 128] });
      return { done, stopped: { branch, conflicts: conflicted, message: conflicted.length ? '' : (merged.stderr || merged.stdout).trim().split('\n').slice(-3).join(' ') } };
    }
    done.push({ branch, commit: await value(info.path, ['rev-parse', 'HEAD']) });
  }
  return { done, stopped: null };
}

// Gives the worktree up. Without `discard` git refuses a worktree with uncommitted changes and a branch that is not merged yet (`-d`), so
// nothing is lost by accident; `discard` (asked for with a confirmation) forces both.
export async function removeWorktree(info, { deleteBranch = false, discard = false } = {}) {
  const listed = (await worktreeList(info.origin).catch(() => [])).some(tree => samePath(tree.worktree, info.path));
  const exists = await fs.stat(info.path).then(() => true, () => false);
  if (listed && exists) {
    if (!discard && (await worktreeStatus(info)).dirty) throw fault('WORKTREE_DIRTY', 'worktree에 커밋하지 않은 변경이 있습니다. 합치거나 버리기를 고르세요.', 409);
    await git(info.origin, ['worktree', 'remove', ...(discard ? ['--force'] : []), '--', info.path]);
  } else await git(info.origin, ['worktree', 'prune'], { ok: [0, 128] });
  await fs.rm(sidecarOf(info.path), { force: true });
  let branchDeleted = false, branchKept = '';
  if (deleteBranch && info.branch && /^[\w./-]+$/.test(info.branch) && !info.branch.startsWith('-')) {
    const removed = await git(info.origin, ['branch', discard ? '-D' : '-d', '--', info.branch], { ok: [0, 1] });
    branchDeleted = removed.exitCode === 0;
    if (!branchDeleted) branchKept = (removed.stderr || removed.stdout).trim().split('\n')[0] || '브랜치가 아직 합쳐지지 않아 남겨 두었습니다.';
  }
  return { removed: true, branchDeleted, ...(branchKept && { branchKept }) };
}

// A read-only diff of the worktree against where it left the origin branch (merge base), uncommitted changes included. Cut at `max` characters.
export async function worktreeDiff(info, { file, max = 60_000 } = {}) {
  const status = await worktreeStatus(info);
  if (!status.exists) throw fault('WORKTREE_MISSING', 'worktree 폴더가 없습니다.', 404);
  const base = status.originHead ? await value(info.path, ['merge-base', status.originHead, 'HEAD']) : '';
  if (file !== undefined && (typeof file !== 'string' || !file || file.includes('\0') || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))) throw fault('INVALID_INPUT', '파일 경로를 확인하세요.');
  const result = await git(info.path, ['diff', '--no-color', '--no-textconv', '--no-ext-diff', '--stat=200', '-p', base || 'HEAD', '--', ...(file ? [file] : [])], { maxOutputBytes: 16 * 1024 * 1024 }).catch(error => ({ stdout: `(diff를 읽지 못했습니다: ${error.message})` }));
  const text = result.stdout;
  return { base, text: text.length > max ? `${text.slice(0, max)}\n… (${text.length - max}자 생략. file을 지정해 나눠 보세요)` : text, untracked: status.files.filter(item => item.status === '??').map(item => item.path) };
}

// Every worktree that belongs to a chat of this project: the ones ADE made (in `<data>/worktrees/chat-*`), Claude's own (`.claude/worktrees`),
// and any on an `ade/chat-*` branch. `owners` maps a worktree path to the chat that keeps it; one with no owner is left over (orphan).
export async function listChatWorktrees({ directory, repos, owners = [] }) {
  const seen = new Map();
  for (const repo of repos) {
    for (const tree of await worktreeList(repo).catch(() => [])) {
      const where = typeof tree.worktree === 'string' ? path.resolve(tree.worktree) : '';
      const branch = typeof tree.branch === 'string' ? tree.branch.replace(/^refs\/heads\//, '') : '';
      if (!where || seen.has(where.toLowerCase())) continue;
      const ours = inside(worktreeRoot(directory), where) && /^chat-/.test(path.basename(where)), claude = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/.test(where);
      if (!ours && !claude && !branch.startsWith('ade/chat-')) continue;
      const extra = await readSidecar(where), owner = owners.find(item => samePath(item.path, where));
      seen.set(where.toLowerCase(), { path: where, branch, origin: extra?.origin ?? path.resolve(repo), base: extra?.base ?? '', createdAt: extra?.createdAt ?? null, kind: extra ? 'ade' : claude ? 'claude' : 'other', chatId: owner?.chatId ?? extra?.chatId ?? '', title: owner?.title ?? '', open: owner?.open === true, inside: owner?.inside === true, orphan: !owner, prunable: Boolean(tree.prunable) });
    }
  }
  const list = [...seen.values()];
  for (const item of list.slice(0, 32)) item.status = await worktreeStatus(item).catch(() => ({ exists: false }));
  return list;
}

// Claude keeps a session under `<config>/projects/<cwd with non-alphanumerics as '-'>/<id>.jsonl` and `--resume` looks for it under the folder
// it runs in. Moving a chat to another folder copies the transcript (and its subagent folder) there, so the next start resumes the same session.
// The original is never deleted; a copy already at the destination (an earlier move) is kept under a .bak name before it is replaced.
export async function moveClaudeSession({ configDir, sessionId, from, to }) {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId ?? '')) throw fault('INVALID_INPUT', 'Claude 세션 ID를 확인하세요.');
  const folder = cwd => path.join(configDir, 'projects', String(path.resolve(cwd)).replace(/[^a-zA-Z0-9]/g, '-'));
  let source = path.join(folder(from), `${sessionId}.jsonl`);
  if (!(await fs.stat(source).then(stat => stat.isFile(), () => false))) {
    // The CLI may have kept it elsewhere (a session that moved itself with EnterWorktree, or a shortened folder name): the newest copy wins.
    let best = null;
    for (const name of await fs.readdir(path.join(configDir, 'projects')).catch(() => [])) {
      const file = path.join(configDir, 'projects', name, `${sessionId}.jsonl`), stat = await fs.stat(file).catch(() => null);
      if (stat?.isFile() && (!best || stat.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: stat.mtimeMs };
    }
    if (!best) throw fault('SESSION_NOT_FOUND', 'Claude 대화 기록 파일을 찾지 못해 폴더를 옮기지 않았습니다.', 409);
    source = best.file;
  }
  const destination = path.join(folder(to), `${sessionId}.jsonl`);
  if (samePath(source, destination)) return { copied: false, file: destination };
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (await fs.stat(destination).then(() => true, () => false)) await fs.rename(destination, `${destination}.ade-${Date.now()}.bak`);
  await fs.copyFile(source, destination);
  const sideFolder = source.slice(0, -'.jsonl'.length);
  if (await fs.stat(sideFolder).then(stat => stat.isDirectory(), () => false)) await fs.cp(sideFolder, destination.slice(0, -'.jsonl'.length), { recursive: true, force: true });
  return { copied: true, file: destination, from: source };
}

// What the agent is told (ahead of the next message, not shown in the thread) after the user moved the chat: paths in the earlier
// conversation point at the other folder now.
export function moveNote(phase, info, previous) {
  return phase === 'enter'
    ? `[ADE] The user moved this chat into an isolated git worktree. From now on work only in ${info.cwd ?? info.path} (branch ${info.branch}); files mentioned earlier under ${previous} are at the same relative paths here. Do not commit on your own: leave your changes uncommitted, the user reviews them and commits them when merging the worktree back from ADE. Commit only when the user asks you to (also in an agent-bus integration the user asked for), on this branch, never squashing or rebasing.\n\n`
    : `[ADE] The user moved this chat out of its git worktree back to ${info.originCwd ?? info.origin}. From now on work there; paths mentioned earlier under ${previous} are at the same relative paths here.\n\n`;
}

// The message the composer is filled with when a merge stops on a conflict: the agent merges the origin branch into its own worktree and
// resolves it there, so the next "합치기" is a plain fast-forward and the user's checkout never holds a half-done merge.
export function conflictPrompt({ originBranch, files = [], branch }) {
  const list = files.slice(0, 30).map(file => `- ${file}`).join('\n');
  return `원본 브랜치 \`${originBranch}\`를 이 worktree(\`${branch}\`)에 merge해서 충돌을 해결해 줘. \`git merge ${originBranch}\`로 합치고(rebase·squash 금지), 충돌 파일을 고친 뒤 테스트하고 merge 커밋까지 해 줘.${list ? `\n충돌이 예상되는 파일:\n${list}` : ''}`;
}
