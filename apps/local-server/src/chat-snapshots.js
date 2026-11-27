// Turn snapshots (CHAT_MODE_FEATURES §15): the chat's work folder captured as a git commit when a turn starts and when it ends, so the thread can show
// what changed during a turn (whoever changed it: the agent's edits, its Bash commands, the user) and Rewind can put the files back.
//
// A snapshot never touches the working tree, the real index, HEAD or any branch: the real index is copied to a temporary file that GIT_INDEX_FILE
// points at, the changed tracked files and the untracked files that are not ignored are added to that copy, and write-tree / commit-tree make a
// commit whose parent is HEAD. The commit is kept from `git gc` by a ref of its own, `refs/ade/snap/<chat id>/<time>`; each chat keeps its
// newest `keep` refs and drops the rest (the chat's events.jsonl keeps every record: only the refs go). Ignored files and .git are never captured,
// files over `maxFileBytes` are left out (and listed in the commit message, so a restore leaves them alone), and the whole snapshot has a time limit.
//
// Restoring writes only the paths that differ between a fresh snapshot of now and the target: content back for changed and deleted files, files
// created since then removed. HEAD, the index and branches stay as they are, and a snapshot of the state before the restore is kept so it can be undone.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitEnv } from './runtime.js';

export const SNAP_ROOT = 'refs/ade/snap';
export const SNAPSHOT_DEFAULTS = Object.freeze({ timeoutMs: 15_000, maxFileBytes: 5 * 1024 * 1024, maxPaths: 50_000, keep: 120, maxFiles: 300, restMs: 10 * 60_000 });
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const HASH = /^[0-9a-f]{40,64}$/;
const SKIPPED_LINE = 'ade-skipped: ';
// The C locale keeps git's messages parseable; identity variables let commit-tree work in a repository with no user.name (the commit is never on a branch).
const QUIET = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANGUAGE: 'C', GIT_AUTHOR_NAME: 'ADE snapshot', GIT_AUTHOR_EMAIL: 'snapshot@ade.invalid', GIT_COMMITTER_NAME: 'ADE snapshot', GIT_COMMITTER_EMAIL: 'snapshot@ade.invalid' };
// Inherited repository overrides (a test run from a git hook) would point every command at another repository or index.
const INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'];

export class SnapshotError extends Error {
  constructor(reason, message) { super(message || reason); this.reason = reason; }
}

function baseEnv(extra) {
  const env = { ...process.env };
  for (const key of INHERITED) delete env[key];
  return { ...env, ...QUIET, ...extra };
}

// argv only, no shell. `binary` keeps stdout as a Buffer. A command that runs past its time is killed and reported as a timeout.
// The repository's own fsmonitor, hooks and filter commands are switched off as for every git call the server makes (runtime.js gitEnv):
// a snapshot runs on its own at every turn, so a cloned repository must not get to run a program through it.
export async function runGit(cwd, args, { env, input, timeoutMs = 10_000, max = 64 * 1024 * 1024, binary = false } = {}) {
  if (timeoutMs <= 0) throw new SnapshotError('timeout', '시간 제한을 넘었습니다.');
  const started = Date.now(), childEnv = await gitEnv(cwd, baseEnv(env), args);
  timeoutMs -= Date.now() - started;
  return new Promise((resolve, reject) => {
    if (timeoutMs <= 0) { reject(new SnapshotError('timeout', '시간 제한을 넘었습니다.')); return; }
    let child;
    try { child = spawn('git', args, { cwd, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(new SnapshotError('error', error.message)); return; }
    const chunks = []; let size = 0, stderr = '', timedOut = false, tooBig = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > max) { if (!tooBig) { tooBig = true; child.kill(); } } else chunks.push(chunk); });
    child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk.toString('utf8'); });
    child.on('error', error => { clearTimeout(timer); reject(new SnapshotError(error.code === 'ENOENT' ? 'no-git' : 'error', error.message)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new SnapshotError('timeout', '시간 제한을 넘었습니다.'));
      if (tooBig) return reject(new SnapshotError('too-large', '출력이 너무 큽니다.'));
      const out = Buffer.concat(chunks);
      resolve({ code, stdout: binary ? out : out.toString('utf8'), stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}
const must = async (promise, what) => {
  const result = await promise;
  if (result.code !== 0) throw new SnapshotError('error', `${what}: ${result.stderr.trim().slice(-500) || `exit ${result.code}`}`);
  return result;
};
const zsplit = text => text.split('\0').filter(Boolean);

// The repository the folder belongs to: its top and its git directory (a linked worktree has its own, with its own index). null: not a work tree.
export async function repositoryOf(cwd, { timeoutMs = 5_000 } = {}) {
  let result;
  try { result = await runGit(cwd, ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--absolute-git-dir'], { timeoutMs }); }
  catch (error) { if (error.reason === 'timeout') throw error; return null; }
  if (result.code !== 0) return null;
  const [inside, top, gitDir] = result.stdout.split(/\r?\n/);
  if (inside !== 'true' || !top || !gitDir) return null;
  return { top: path.resolve(top), gitDir: path.resolve(gitDir) };
}

export const skippedOf = message => {
  const line = String(message ?? '').split('\n').find(item => item.startsWith(SKIPPED_LINE));
  if (!line) return [];
  try { const list = JSON.parse(line.slice(SKIPPED_LINE.length)); return Array.isArray(list) ? list.filter(item => typeof item === 'string') : []; } catch { return []; }
};

// One snapshot of the folder's repository. Resolves { ok: true, commit, tree, top, skipped, ms, reused } or { ok: false, reason, message, ms }
// (reason 'not-git' when the folder is not in a work tree; 'timeout', 'too-many', 'error' otherwise). `reuse` ({ top, tree, commit }): the last
// snapshot; an unchanged tree gives back its commit instead of a new one. `ref`: where to keep the commit (none: a throwaway snapshot).
export async function takeSnapshot(cwd, { ref = null, reuse = null, label = 'ADE snapshot', timeoutMs = SNAPSHOT_DEFAULTS.timeoutMs, maxFileBytes = SNAPSHOT_DEFAULTS.maxFileBytes, maxPaths = SNAPSHOT_DEFAULTS.maxPaths } = {}) {
  const started = Date.now(), deadline = started + timeoutMs;
  const left = () => deadline - Date.now();
  let temp = null;
  try {
    const repo = await repositoryOf(cwd, { timeoutMs: Math.min(5_000, left()) });
    if (!repo) return { ok: false, reason: 'not-git', ms: Date.now() - started };
    const { top, gitDir } = repo;
    const git = (args, options = {}) => runGit(top, args, { ...options, timeoutMs: left() });
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-snap-'));
    const index = path.join(temp, 'index'), env = { GIT_INDEX_FILE: index };
    await fs.copyFile(path.join(gitDir, 'index'), index).catch(error => { if (error.code !== 'ENOENT') throw error; }); // a repository with nothing staged yet has no index
    // Tracked files that differ from the index (by its stat data: a superset of the real changes) and untracked files that are not ignored.
    const [head, tracked, untracked] = await Promise.all([
      git(['rev-parse', '-q', '--verify', 'HEAD^{commit}']),
      must(git(['diff-files', '--name-only', '-z', '--ignore-submodules=all'], { env }), 'diff-files'),
      must(git(['ls-files', '--others', '--exclude-standard', '-z'], { env, max: 256 * 1024 * 1024 }), 'ls-files')
    ]);
    const parent = head.code === 0 ? head.stdout.trim() : null;
    const candidates = [...new Set([...zsplit(tracked.stdout), ...zsplit(untracked.stdout).filter(item => !item.endsWith('/'))])]; // "dir/": a nested repository
    if (candidates.length > maxPaths) return { ok: false, reason: 'too-many', message: `바뀐 파일이 너무 많습니다 (${candidates.length}개).`, top, ms: Date.now() - started };
    const update = [], skipped = [];
    for (let at = 0; at < candidates.length; at += 64) {
      if (left() <= 0) throw new SnapshotError('timeout', '시간 제한을 넘었습니다.');
      await Promise.all(candidates.slice(at, at + 64).map(async name => {
        const info = await fs.lstat(path.join(top, name)).catch(() => null);
        if (!info) { update.push(name); return; } // deleted: --remove takes it out of the copy
        if (info.isDirectory()) return; // a submodule, or a file that became a folder (the files inside are listed on their own)
        if (info.isFile() && info.size > maxFileBytes) { skipped.push(name); return; }
        update.push(name);
      }));
    }
    if (update.length) await must(git(['update-index', '--add', '--remove', '--replace', '-z', '--stdin'], { env, input: update.map(name => `${name}\0`).join('') }), 'update-index');
    const tree = (await must(git(['write-tree'], { env }), 'write-tree')).stdout.trim();
    skipped.sort();
    if (reuse && reuse.top === top && reuse.tree === tree && reuse.commit && JSON.stringify(reuse.skipped ?? []) === JSON.stringify(skipped)) return { ok: true, commit: reuse.commit, tree, top, skipped, reused: true, ms: Date.now() - started };
    const message = `${label}\n\n${skipped.length ? `${SKIPPED_LINE}${JSON.stringify(skipped)}\n` : ''}`;
    const commit = (await must(git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], { input: message }), 'commit-tree')).stdout.trim();
    if (ref) await must(git(['update-ref', ref, commit]), 'update-ref');
    return { ok: true, commit, tree, top, skipped, reused: false, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, reason: error.reason === 'timeout' ? 'timeout' : 'error', message: error.message, ms: Date.now() - started };
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

// Files that differ between two snapshots, with their line counts (binary files have none). Renames are paired (-M).
export async function diffSnapshots(top, from, to, { timeoutMs = 10_000, maxFiles = SNAPSHOT_DEFAULTS.maxFiles } = {}) {
  const base = ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--no-ext-diff', '--no-textconv'];
  const [status, numstat] = await Promise.all([must(runGit(top, [...base, '--name-status', from, to], { timeoutMs }), 'diff-tree'), must(runGit(top, [...base, '--numstat', from, to], { timeoutMs }), 'diff-tree')]);
  const files = [], byPath = new Map();
  const parts = status.stdout.split('\0');
  for (let at = 0; at < parts.length; at++) {
    const code = parts[at]; if (!code) continue;
    const kind = code[0];
    if (kind === 'R' || kind === 'C') { const file = { path: parts[at + 2], original: parts[at + 1], status: 'R' }; files.push(file); byPath.set(file.path, file); at += 2; }
    else { const file = { path: parts[at + 1], status: kind === 'A' || kind === 'D' ? kind : 'M' }; files.push(file); byPath.set(file.path, file); at += 1; }
  }
  const counts = numstat.stdout.split('\0');
  let add = 0, del = 0;
  for (let at = 0; at < counts.length; at++) {
    const line = counts[at]; if (!line) continue;
    const [a, d, name] = line.split('\t');
    let target = name;
    if (name === '') { target = counts[at + 2]; at += 2; } // a rename: "a\td\t" then old and new path
    const file = byPath.get(target); if (!file) continue;
    if (a === '-' || d === '-') { file.binary = true; continue; }
    file.add = Number(a) || 0; file.del = Number(d) || 0; add += file.add; del += file.del;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files: files.slice(0, maxFiles), count: files.length, add, del };
}

// Both sides of one file between two snapshots, for the editor's diff tab. Binary or oversized content comes back empty with a note.
export async function snapshotFile(top, { from, to, path: file, original }) {
  const read = async (rev, name) => {
    if (!rev) return { content: '' };
    const result = await runGit(top, ['--literal-pathspecs', 'show', `${rev}:${name}`], { max: 4 * 1024 * 1024 }).catch(() => null);
    if (!result) return { content: '', note: '파일이 너무 큽니다.' };
    if (result.code !== 0) return { content: '' };
    if (result.stdout.includes('\0')) return { content: '', note: '바이너리 파일입니다.' };
    return { content: result.stdout };
  };
  const [before, after] = await Promise.all([read(from, original || file), read(to, file)]);
  return { original: before.content, modified: after.content, note: before.note || after.note || '' };
}

export const commitExists = async (top, commit) => typeof commit === 'string' && HASH.test(commit) && (await runGit(top, ['cat-file', '-e', `${commit}^{commit}`], { timeoutMs: 5_000 }).catch(() => ({ code: 1 }))).code === 0;
const commitMessage = async (top, commit) => (await runGit(top, ['cat-file', 'commit', commit], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: '' }))).stdout;

// What going from `current` to `target` would do to the working tree: files written back and files removed. Paths either snapshot left out
// (large files) and submodules are not touched.
export async function restorePlan(top, target, current, { timeoutMs = 10_000 } = {}) {
  const raw = await must(runGit(top, ['diff-tree', '-r', '-z', '--no-renames', '--raw', '--no-commit-id', current, target], { timeoutMs }), 'diff-tree');
  const leave = new Set([...skippedOf(await commitMessage(top, target)), ...skippedOf(await commitMessage(top, current))]);
  const restore = [], remove = [], skipped = [];
  const parts = raw.stdout.split('\0');
  for (let at = 0; at < parts.length - 1; at += 2) {
    const head = parts[at], name = parts[at + 1];
    if (!head || !name) continue;
    const [srcMode, dstMode, , blob, status] = head.slice(1).split(' ');
    if (srcMode === '160000' || dstMode === '160000' || leave.has(name)) { skipped.push(name); continue; }
    if (status === 'D') remove.push(name);
    else restore.push({ path: name, mode: dstMode, blob });
  }
  return { restore, remove, skipped };
}

const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
function safeTarget(top, name) {
  const parts = name.split('/');
  if (!name || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('허용되지 않는 경로입니다.');
  const file = path.resolve(top, ...parts);
  if (!inside(top, file)) throw new Error('저장소 밖의 경로입니다.');
  return file;
}
// A folder on the way that is a link to somewhere else would carry the write out of the repository (as git checkout refuses to).
async function checkParent(realTop, file) {
  const parent = await fs.realpath(path.dirname(file));
  if (!inside(realTop, parent)) throw new Error('저장소 밖을 가리키는 링크 아래의 경로입니다.');
}
async function removeEmptyParents(top, file) {
  for (let dir = path.dirname(file); inside(top, dir) && dir !== top; dir = path.dirname(dir)) {
    if ((await fs.readdir(dir).catch(() => ['?'])).length) return;
    await fs.rmdir(dir).catch(() => {});
  }
}

// Carries out a restore plan. Every path is tried; the answer says exactly which were written, removed and which failed (and why).
export async function applyRestore(top, target, plan) {
  const realTop = await fs.realpath(top), restored = [], removed = [], failed = [];
  for (const name of plan.remove) {
    try {
      const file = safeTarget(top, name);
      await checkParent(realTop, file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      const info = await fs.lstat(file).catch(() => null);
      if (info?.isDirectory()) throw new Error('파일이 있던 자리에 폴더가 있습니다.');
      if (info) await fs.rm(file, { force: true });
      removed.push(name);
      await removeEmptyParents(top, file);
    } catch (error) { failed.push({ path: name, message: error.message }); }
  }
  let next = 0;
  const worker = async () => {
    while (next < plan.restore.length) {
      const item = plan.restore[next++];
      try {
        const file = safeTarget(top, item.path);
        // --filters: line endings and other attributes are applied as a checkout would (core.autocrlf), so a restored file matches what was there.
        const content = item.mode === '120000'
          ? (await must(runGit(top, ['cat-file', 'blob', item.blob], { binary: true, timeoutMs: 30_000 }), 'cat-file')).stdout
          : (await must(runGit(top, ['cat-file', '--filters', `${target}:${item.path}`], { binary: true, timeoutMs: 30_000, max: 512 * 1024 * 1024 }), 'cat-file')).stdout;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await checkParent(realTop, file);
        const info = await fs.lstat(file).catch(() => null);
        if (info?.isDirectory()) throw new Error('파일을 되돌릴 자리에 폴더가 있습니다.');
        if (item.mode === '120000') {
          if (info) await fs.rm(file, { force: true });
          // Without the right to make links (Windows), the link is written as a file with its target, as git does with core.symlinks=false.
          await fs.symlink(content.toString('utf8'), file).catch(() => fs.writeFile(file, content));
        } else {
          if (info?.isSymbolicLink()) await fs.rm(file, { force: true });
          await fs.writeFile(file, content);
          if (process.platform !== 'win32') await fs.chmod(file, item.mode === '100755' ? 0o755 : 0o644).catch(() => {});
        }
        restored.push(item.path);
      } catch (error) { failed.push({ path: item.path, message: error.message }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, plan.restore.length) }, worker));
  restored.sort(); return { restored, removed, failed, skipped: plan.skipped };
}

// ---- per chat ----
const LIST_MAX = 200;
const cap = list => list.length > LIST_MAX ? { list: list.slice(0, LIST_MAX), more: list.length - LIST_MAX } : { list, more: 0 };

// The snapshots of one chat. `folder()` is read at every snapshot (a chat can move into a worktree and out again); `emit` stores an event in the chat's
// log; `events()` is the chat's stored log (newest last). All git work runs one job at a time, off the turn's own path: nothing here waits on it.
export function createTurnSnapshots({ chatId, folder, emit, events, options = {}, take = takeSnapshot }) {
  const limits = { ...SNAPSHOT_DEFAULTS, ...options };
  const prefix = `${SNAP_ROOT}/${chatId}/`;
  let last = null, start = null, chain = Promise.resolve(), closed = false, counter = 0;
  const queue = job => { const run = chain.then(job, job); chain = run.catch(() => {}); return run; };
  const refName = () => `${prefix}${String(Date.now()).padStart(15, '0')}${String(++counter % 1000).padStart(3, '0')}`;
  // A folder too big for a snapshot (time limit, too many files: say a whole home folder under git) is not tried again for a while, so every turn does not pay for it.
  const resting = new Map();
  const snap = async cwd => {
    if ((resting.get(cwd) ?? 0) > Date.now()) return { ok: false, reason: 'skipped', ms: 0 };
    const result = await take(cwd, { ref: refName(), reuse: last, label: `ADE snapshot ${chatId}`, timeoutMs: limits.timeoutMs, maxFileBytes: limits.maxFileBytes, maxPaths: limits.maxPaths });
    if (!result.ok && (result.reason === 'timeout' || result.reason === 'too-many')) resting.set(cwd, Date.now() + limits.restMs);
    if (result.ok) { if (!result.reused) void prune(result.top); last = { top: result.top, tree: result.tree, commit: result.commit, skipped: result.skipped }; }
    return result;
  };
  async function prune(top) {
    const list = await runGit(top, ['for-each-ref', '--format=%(refname)', '--sort=refname', prefix], { timeoutMs: 5_000 }).catch(() => null);
    if (!list || list.code !== 0) return;
    // Oldest first by name (the time is in it); the newest `keep` stay. Only refs go: the chat's records of those turns are never touched.
    const refs = list.stdout.split('\n').filter(Boolean), drop = refs.slice(0, Math.max(0, refs.length - limits.keep));
    if (drop.length) await runGit(top, ['update-ref', '--stdin'], { input: drop.map(ref => `delete ${ref}\n`).join(''), timeoutMs: 5_000 }).catch(() => {});
  }
  // The turn's start snapshot, for the change card. A turn that starts while the last job still runs waits behind it.
  function turnStarted() {
    if (closed) return;
    const cwd = folder();
    start = { cwd, result: queue(() => snap(cwd)) };
  }
  // The end snapshot, compared with the start: one `turn_changes` event (also when nothing changed: Rewind needs the end snapshot of every turn).
  function turnEnded(answer = {}) {
    const begin = start; start = null;
    if (closed || !begin) return Promise.resolve();
    return queue(async () => {
      const from = await begin.result;
      if (!from.ok && from.reason === 'not-git') return;
      const to = await snap(folder());
      // skipped: the folder rests after a failure; only the turn that failed leaves a record of it.
      if (closed || (!to.ok && to.reason === 'not-git') || (!to.ok && to.reason === 'skipped' && (from.ok || from.reason === 'skipped'))) return;
      const event = { kind: 'turn_changes', chat: chatId, ...(answer.uuid && { uuid: answer.uuid }), ...(answer.messageId && { messageId: answer.messageId }) };
      if (!to.ok) Object.assign(event, { failed: to.reason === 'skipped' ? from.reason : to.reason, ms: (from.ms ?? 0) + to.ms });
      else {
        Object.assign(event, { top: to.top, to: to.commit, ms: from.ok ? from.ms + to.ms : to.ms, ...(to.skipped.length && { skipped: to.skipped.length }) });
        if (!from.ok) event.startFailed = from.reason;
        else if (from.top !== to.top) event.moved = true;
        else {
          event.from = from.commit;
          if (from.commit !== to.commit) {
            const diff = await diffSnapshots(to.top, from.commit, to.commit, { maxFiles: limits.maxFiles }).catch(() => null);
            if (diff) Object.assign(event, { files: diff.files, count: diff.count, add: diff.add, del: diff.del });
          }
        }
      }
      if (!closed) emit(event);
    });
  }
  // The end snapshot of the turn that answer closed. Only one this chat took itself: a Branch copies its parent's records (their diffs stay readable), but
  // its files are not restored from them.
  function targetOf(answer) {
    const found = [...events()].reverse().find(event => event.kind === 'turn_changes' && event.chat === chatId && event.to && event.top && ((answer.uuid && event.uuid === answer.uuid) || (answer.messageId && event.messageId === answer.messageId)));
    return found ?? null;
  }
  async function plan(top, target) {
    if (!(await commitExists(top, target))) throw new SnapshotError('missing', '이 시점의 파일 기록이 정리되어 되돌릴 수 없습니다.');
    const now = await take(folder(), { ref: null, label: `ADE snapshot ${chatId} (preview)`, timeoutMs: limits.timeoutMs, maxFileBytes: limits.maxFileBytes, maxPaths: limits.maxPaths });
    if (!now.ok) throw new SnapshotError(now.reason, now.reason === 'not-git' ? '작업 폴더가 Git 저장소가 아니어서 파일을 되돌릴 수 없습니다.' : `지금 파일 상태를 읽지 못했습니다 (${now.reason === 'timeout' ? '시간 초과' : now.message || now.reason}).`);
    if (now.top !== top) throw new SnapshotError('moved', '이 대화의 작업 폴더가 그 시점과 다른 저장소입니다. 파일은 되돌리지 않습니다.');
    return { now, ...(await restorePlan(top, target, now.commit)) };
  }
  const summary = found => ({ restore: cap(found.restore.map(item => item.path)), remove: cap(found.remove), skipped: cap(found.skipped) });
  // Rewind's dialog: whether the files can go back to the end of that turn, and which files that would write and remove.
  async function preview(answer) {
    const target = targetOf(answer);
    if (!target) return { available: false, reason: '이 지점에는 파일 기록이 없습니다.' };
    try { const found = await queue(() => plan(target.top, target.to)); const view = summary(found); return { available: true, restore: view.restore.list, restoreMore: view.restore.more, remove: view.remove.list, removeMore: view.remove.more, skipped: view.skipped.list }; }
    catch (error) { return { available: false, reason: error.message }; }
  }
  // Puts the files back to `target` (a commit in `top`) after keeping a snapshot of now. Throws before anything is written when it cannot start.
  async function restoreTo(top, target, label) {
    return queue(async () => {
      if (!(await commitExists(top, target))) throw new SnapshotError('missing', '이 시점의 파일 기록이 정리되어 되돌릴 수 없습니다.');
      const safety = await take(folder(), { ref: `${prefix}undo-${String(Date.now()).padStart(15, '0')}`, label: `ADE snapshot ${chatId} (${label})`, timeoutMs: limits.timeoutMs, maxFileBytes: limits.maxFileBytes, maxPaths: limits.maxPaths });
      if (!safety.ok) throw new SnapshotError(safety.reason, `지금 파일 상태를 저장하지 못해 되돌리지 않았습니다 (${safety.reason === 'timeout' ? '시간 초과' : safety.message || safety.reason}).`);
      if (safety.top !== top) throw new SnapshotError('moved', '이 대화의 작업 폴더가 그 시점과 다른 저장소입니다. 파일은 되돌리지 않았습니다.');
      const fresh = await restorePlan(top, target, safety.commit); // from this snapshot, not the dialog's: what changed since then counts too
      const done = await applyRestore(top, target, fresh);
      last = null; // the working tree moved: the next snapshot is new
      const restored = cap(done.restored), removed = cap(done.removed);
      return { top, target, safety: safety.commit, restored: restored.list, restoredMore: restored.more, removed: removed.list, removedMore: removed.more, failed: done.failed.slice(0, LIST_MAX), failedCount: done.failed.length, skipped: done.skipped.slice(0, LIST_MAX) };
    });
  }
  async function rewindFiles(answer) {
    const target = targetOf(answer);
    if (!target) throw new SnapshotError('missing', '이 지점에는 파일 기록이 없습니다.');
    return restoreTo(target.top, target.to, 'before rewind');
  }
  // "파일 되돌리기 취소": back to the snapshot kept just before that restore.
  function rewindRecord(seq) {
    const record = events().find(event => event.kind === 'file_rewind' && event.seq === seq && !event.undo);
    if (!record?.safety || !record.top) throw new SnapshotError('missing', '취소할 파일 되돌리기를 찾을 수 없습니다.');
    if (events().some(event => event.kind === 'file_rewind' && event.undo === seq)) throw new SnapshotError('done', '이미 취소한 되돌리기입니다.');
    return record;
  }
  async function undoPreview(seq) {
    try { const record = rewindRecord(seq); const found = await queue(() => plan(record.top, record.safety)); const view = summary(found); return { available: true, restore: view.restore.list, restoreMore: view.restore.more, remove: view.remove.list, removeMore: view.remove.more, skipped: view.skipped.list }; }
    catch (error) { return { available: false, reason: error.message }; }
  }
  async function undo(seq) { const record = rewindRecord(seq); return restoreTo(record.top, record.safety, 'before undo'); }
  // Both sides of a file between two snapshots this chat recorded (the turn card's diff tab).
  async function file({ from, to, path: name, original }) {
    if (typeof name !== 'string' || !name || name.length > 4096 || (original != null && (typeof original !== 'string' || original.length > 4096))) throw new SnapshotError('invalid', '경로가 올바르지 않습니다.');
    const record = events().find(event => (event.kind === 'turn_changes' && event.from === from && event.to === to) || (event.kind === 'file_rewind' && event.target === to && event.safety === from));
    if (!record?.top) throw new SnapshotError('missing', '이 변경 기록을 찾을 수 없습니다.');
    if (!(await commitExists(record.top, to)) || (from && !(await commitExists(record.top, from)))) throw new SnapshotError('missing', '이 변경의 파일 기록이 정리되어 열 수 없습니다.');
    return snapshotFile(record.top, { from, to, path: name, original });
  }
  // A forgotten chat takes its refs along, in every repository it took snapshots in.
  async function forget() {
    closed = true;
    await chain.catch(() => {});
    const tops = new Set([last?.top, ...events().map(event => (event.kind === 'turn_changes' || event.kind === 'file_rewind') ? event.top : null)].filter(Boolean));
    const here = await repositoryOf(folder()).catch(() => null);
    if (here) tops.add(here.top);
    for (const top of tops) {
      const list = await runGit(top, ['for-each-ref', '--format=%(refname)', prefix], { timeoutMs: 5_000 }).catch(() => null);
      const refs = list?.code === 0 ? list.stdout.split('\n').filter(Boolean) : [];
      if (refs.length) await runGit(top, ['update-ref', '--stdin'], { input: refs.map(ref => `delete ${ref}\n`).join(''), timeoutMs: 5_000 }).catch(() => {});
    }
  }
  // Closing waits for a snapshot already running: its git process holds the folder (Windows cannot remove a folder a process works in).
  async function close() { closed = true; await chain.catch(() => {}); }
  return { turnStarted, turnEnded, preview, rewindFiles, undoPreview, undo, file, forget, close, idle: () => chain };
}
