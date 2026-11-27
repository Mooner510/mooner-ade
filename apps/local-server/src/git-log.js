// The Git tool window (commit graph): reading the history and refs, one commit's details and file contents, and the operations
// its menus run (checkout, branch, merge, rebase, cherry-pick, reset, ...). Every git call is argv-only (no shell) and runs with
// prompts and editors switched off, so nothing waits for a terminal that is not there.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fault, readText, text } from './files.js';

const SEP = '\x1f', END = '\x1e';
const HASH = /^[0-9a-f]{4,64}$/i;
const FULL_REF = /^refs\/(heads|remotes|tags)\/[^\0\s~^:?*[\\]+$/;
// GIT_EDITOR=true keeps git from opening an editor (merge, revert, rebase --continue keep the prepared message); the C locale keeps
// the messages that are parsed below (local changes in the way, branch not merged) in English.
const QUIET = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', LC_ALL: 'C', LANGUAGE: 'C' };
const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%s'].join('%x1f') + '%x1e';
export const LOG_LIMIT_MAX = 50_000;

const hash = (value, name = '커밋') => {
  if (typeof value !== 'string' || !HASH.test(value)) throw fault('INVALID_INPUT', `${name} 해시가 올바르지 않습니다.`);
  return value.toLowerCase();
};
const hashes = (list, name = '커밋') => {
  if (!Array.isArray(list) || !list.length || list.length > 1000) throw fault('INVALID_INPUT', `${name} 목록이 올바르지 않습니다.`);
  return list.map(item => hash(item, name));
};
const fullRef = value => {
  if (typeof value !== 'string' || !FULL_REF.test(value) || value.includes('..') || value.endsWith('/') || value.endsWith('.lock')) throw fault('INVALID_INPUT', '참조 이름이 올바르지 않습니다.');
  return value;
};
const shortRef = ref => ref.replace(/^refs\/(heads|remotes|tags)\//, '');

async function git(runtime, args, { env, timeoutMs = 120_000, max = 16 * 1024 * 1024, ok = true } = {}) {
  const result = await runtime.processes.exec('git', args, { env: { ...QUIET, ...env }, timeoutMs, maxOutputBytes: max });
  if (ok && result.exitCode !== 0) throw failed(result);
  return result;
}
const failed = (result, fallback = 'git 명령이 실패했습니다.') => fault('GIT_FAILED', `${result.stderr || ''}\n${result.stdout || ''}`.trim().slice(-3000) || fallback, 409);
const exists = async (runtime, ref) => (await git(runtime, ['show-ref', '--verify', '--quiet', ref], { ok: false })).exitCode === 0;
async function branchName(runtime, value, label = '브랜치') {
  const name = text(value, `${label} 이름`, 250).trim();
  if (name.startsWith('-') || (await git(runtime, ['check-ref-format', '--branch', name], { ok: false })).exitCode !== 0) throw fault('INVALID_INPUT', `${label} 이름을 쓸 수 없습니다: ${name}`);
  return name;
}
async function tagName(runtime, value) {
  const name = text(value, '태그 이름', 250).trim();
  if (name.startsWith('-') || (await git(runtime, ['check-ref-format', `refs/tags/${name}`], { ok: false })).exitCode !== 0) throw fault('INVALID_INPUT', `태그 이름을 쓸 수 없습니다: ${name}`);
  return name;
}
async function existingRef(runtime, value) {
  const ref = fullRef(value);
  if (!(await exists(runtime, ref))) throw fault('NOT_FOUND', `${shortRef(ref)}을(를) 찾을 수 없습니다.`, 404);
  return ref;
}
// A commit to start from or reset to: a hash or a full ref name.
const revision = async (runtime, value) => typeof value === 'string' && value.startsWith('refs/') ? existingRef(runtime, value) : hash(value);
async function headHash(runtime) {
  const result = await git(runtime, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: false });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}
async function currentBranchName(runtime) {
  const result = await git(runtime, ['symbolic-ref', '-q', '--short', 'HEAD'], { ok: false });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}
async function remotes(runtime) {
  return (await git(runtime, ['remote'], { ok: false })).stdout.split('\n').map(line => line.trim()).filter(Boolean);
}
// refs/remotes/<remote>/<branch>: a remote's name may itself contain '/', so the longest known remote wins.
async function splitRemote(runtime, ref) {
  const rest = fullRef(ref).replace(/^refs\/remotes\//, '');
  const remote = (await remotes(runtime)).filter(name => rest.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0];
  if (!remote) throw fault('NOT_FOUND', `원격 저장소를 찾을 수 없습니다: ${rest}`, 404);
  return { remote, branch: rest.slice(remote.length + 1) };
}

// ---- state: an operation that stopped half-way (conflicts, an "edit" stop) ----
async function gitDir(runtime) {
  const dir = (await git(runtime, ['rev-parse', '--git-dir'])).stdout.trim();
  return path.resolve(runtime.workspace.root, dir);
}
export async function repoState(runtime) {
  const dir = await gitDir(runtime);
  const has = name => fs.stat(path.join(dir, name)).then(() => true, () => false);
  const op = (await has('rebase-merge')) || (await has('rebase-apply')) ? 'rebase' : await has('MERGE_HEAD') ? 'merge' : await has('CHERRY_PICK_HEAD') ? 'cherry-pick' : await has('REVERT_HEAD') ? 'revert' : null;
  // The index lists its unmerged entries (`<mode> <object> <stage>\t<path>`) without comparing every tracked file to the working tree as `git diff` does; this runs on each poll of the graph.
  const unmerged = await git(runtime, ['ls-files', '-u', '-z'], { ok: false });
  const conflicts = unmerged.exitCode === 0 ? [...new Set(unmerged.stdout.split('\0').filter(Boolean).map(entry => entry.slice(entry.indexOf('\t') + 1)))] : [];
  let onto = '';
  if (op === 'rebase') {
    const head = await fs.readFile(path.join(dir, 'rebase-merge', 'head-name'), 'utf8').catch(() => fs.readFile(path.join(dir, 'rebase-apply', 'head-name'), 'utf8').catch(() => ''));
    onto = shortRef(head.trim());
  }
  return { op, conflicts, ...(onto ? { branch: onto } : {}) };
}

// ---- reading ----
function parseRefs(output) {
  const refs = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [ref, object, peeled, upstream, track, head] = line.split(SEP);
    const kind = ref.startsWith('refs/heads/') ? 'local' : ref.startsWith('refs/remotes/') ? 'remote' : 'tag';
    if (kind === 'remote' && ref.endsWith('/HEAD')) continue; // origin/HEAD only points at another remote branch
    const entry = { ref, name: shortRef(ref), kind, sha: peeled || object };
    if (head === '*') entry.current = true;
    if (upstream) entry.upstream = shortRef(upstream);
    if (track) {
      if (track === 'gone') entry.gone = true;
      const ahead = /ahead (\d+)/.exec(track), behind = /behind (\d+)/.exec(track);
      if (ahead) entry.ahead = Number(ahead[1]);
      if (behind) entry.behind = Number(behind[1]);
    }
    refs.push(entry);
  }
  return refs;
}
export function parseLog(output) {
  const commits = [];
  for (const record of output.split(END)) {
    const clean = record.replace(/^\n/, '');
    if (!clean) continue;
    const [h, p, an, ae, at, cn, ce, ct, s = ''] = clean.split(SEP);
    const commit = { h, p: p ? p.split(' ') : [], an, ae, at: Number(at), ct: Number(ct), s };
    if (cn !== an || ce !== ae) Object.assign(commit, { cn, ce });
    commits.push(commit);
  }
  return commits;
}
// The whole graph is read again only when a ref or HEAD moved (or the limit changed): the client sends the signature it holds.
export async function readLog(runtime, input = {}) {
  const limit = Number.isSafeInteger(input.limit) ? Math.max(100, Math.min(LOG_LIMIT_MAX, input.limit)) : 5000;
  const [refsResult, head] = await Promise.all([git(runtime, ['for-each-ref', `--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream)%1f%(upstream:track,nobracket)%1f%(HEAD)`, 'refs/heads', 'refs/remotes', 'refs/tags']), headHash(runtime)]);
  const refsOutput = refsResult.stdout;
  const [branch, state] = await Promise.all([head || refsOutput ? currentBranchName(runtime) : null, repoState(runtime)]);
  const signature = createHash('sha1').update(`${limit}\n${head}\n${branch}\n${refsOutput}`).digest('hex');
  if (input.signature === signature) return { unchanged: true, signature, state };
  const refs = parseRefs(refsOutput);
  let commits = [];
  if (head || refs.length) {
    const output = await git(runtime, ['log', '--date-order', `-n${limit}`, `--format=${LOG_FORMAT}`, '--branches', '--remotes', '--tags', ...(head ? ['HEAD'] : []), '--'], { max: 256 * 1024 * 1024 });
    commits = parseLog(output.stdout);
  }
  const [name, email] = await Promise.all(['user.name', 'user.email'].map(key => git(runtime, ['config', '--get', key], { ok: false }).then(result => result.stdout.trim())));
  const urls = {};
  for (const line of (await git(runtime, ['config', '--get-regexp', '^remote\\..*\\.url$'], { ok: false })).stdout.split('\n')) {
    const match = /^remote\.(.+)\.url (.+)$/.exec(line.trim());
    if (match) urls[match[1]] = match[2];
  }
  return { signature, head: { sha: head, branch }, refs, commits, truncated: commits.length >= limit, limit, state, me: { name, email }, remotes: await remotes(runtime), urls };
}

// Commits that touch any of the paths (the log's path filter), from the same starting points as the graph.
export async function pathCommits(runtime, input = {}) {
  if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 50) throw fault('INVALID_INPUT', '경로 목록이 올바르지 않습니다.');
  const paths = input.paths.map(item => text(item, '경로', 4096));
  const limit = Number.isSafeInteger(input.limit) ? Math.max(100, Math.min(LOG_LIMIT_MAX, input.limit)) : 5000;
  const head = await headHash(runtime);
  const output = await git(runtime, ['--literal-pathspecs', 'log', '--date-order', `-n${limit}`, '--format=%H', '--branches', '--remotes', '--tags', ...(head ? ['HEAD'] : []), '--', ...paths], { max: 64 * 1024 * 1024 });
  return { hashes: output.stdout.split('\n').filter(Boolean) };
}

function parseNameStatus(output) {
  const parts = output.split('\0'), files = [];
  for (let index = 0; index < parts.length; index++) {
    const status = parts[index];
    if (!status) continue;
    if (/^[RC]/.test(status)) { files.push({ status: status[0], original: parts[index + 1], path: parts[index + 2] }); index += 2; }
    else { files.push({ status: status[0], path: parts[index + 1] }); index += 1; }
  }
  return files;
}
// One commit: full message, author and committer, and the files it changed against its first parent (or the parent asked for).
export async function commitDetails(runtime, input = {}) {
  const id = hash(input.sha);
  const show = await git(runtime, ['show', '-s', `--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B`, id, '--']);
  const [sha, parentLine, author, email, authorTime, committer, committerEmail, commitTime, ...body] = show.stdout.split(SEP);
  const parents = parentLine ? parentLine.split(' ') : [];
  const index = Number.isSafeInteger(input.parent) && input.parent >= 0 && input.parent < parents.length ? input.parent : 0;
  const base = parents[index];
  const diff = await git(runtime, ['diff-tree', '-r', '-z', '-M', '--name-status', '--no-commit-id', '--no-ext-diff', '--no-textconv', ...(base ? [base, sha] : ['--root', sha]), '--'], { max: 64 * 1024 * 1024 });
  return { sha, parents, parent: base ?? null, author, email, authorTime: Number(authorTime), committer, committerEmail, commitTime: Number(commitTime), message: body.join(SEP).replace(/\n+$/, ''), files: parseNameStatus(diff.stdout) };
}
// Files that differ between two commits, or between a commit and the working tree (Compare Versions, Compare with Local).
export async function compareFiles(runtime, input = {}) {
  const from = await revision(runtime, input.from), to = input.to ? await revision(runtime, input.to) : null;
  const diff = await git(runtime, ['diff', '-z', '-M', '--name-status', '--no-ext-diff', '--no-textconv', from, ...(to ? [to] : []), '--'], { max: 64 * 1024 * 1024 });
  const files = parseNameStatus(diff.stdout);
  // `git diff <commit>` leaves out files git does not track yet: against the working tree they are added files too (ignored ones stay out).
  if (!to) {
    const known = new Set(files.map(file => file.path));
    const untracked = await git(runtime, ['ls-files', '--others', '--exclude-standard', '-z'], { ok: false, max: 64 * 1024 * 1024 });
    for (const file of untracked.stdout.split('\0').filter(item => item && !item.endsWith('/') && !known.has(item)).slice(0, 5000)) files.push({ status: 'A', path: file, untracked: true });
  }
  return { files };
}
// A commit as a patch (Create Patch): `git format-patch` output, oldest first for several commits.
export async function commitPatch(runtime, input = {}) {
  const list = hashes(input.shas);
  const parts = [];
  for (const id of list) parts.push((await git(runtime, ['format-patch', '-1', '--stdout', '--no-signature', id], { max: 64 * 1024 * 1024 })).stdout);
  return { patch: parts.join('') };
}
// Both sides of one file in a commit, for the diff tab. Binary or oversized content comes back empty with a reason.
export async function commitFile(runtime, input = {}) {
  const id = input.working ? null : hash(input.sha), file = text(input.path, '경로', 4096), original = input.original ? text(input.original, '경로', 4096) : file;
  const parent = input.working ? await revision(runtime, input.parent) : input.parent ? hash(input.parent, '부모 커밋') : await git(runtime, ['rev-parse', '--verify', '-q', `${id}^`], { ok: false }).then(result => result.exitCode === 0 ? result.stdout.trim() : null);
  const read = async (rev, name) => {
    if (!rev) return { content: '' };
    const result = await git(runtime, ['--literal-pathspecs', 'show', `${rev}:${name}`], { ok: false, max: 4 * 1024 * 1024 }).catch(() => null);
    if (!result) return { content: '', note: '파일이 너무 큽니다.' };
    if (result.exitCode !== 0) return { content: '' };
    if (result.stdout.includes('\0')) return { content: '', note: '바이너리 파일입니다.' };
    return { content: result.stdout };
  };
  const local = async () => {
    try { return { content: await readText(runtime.workspace, file) }; }
    catch (error) { return { content: '', note: error.code === 'BINARY_FILE' ? '바이너리 파일입니다.' : error.code === 'UNSUPPORTED_FILE' ? error.message : '' }; }
  };
  const [before, after] = await Promise.all([read(parent, original), input.working ? local() : read(id, file)]);
  return { original: before.content, modified: after.content, note: before.note || after.note || '' };
}

// ---- operations ----
const OVERWRITE = /would be overwritten|commit your changes or stash them|untracked working tree files would be/i;
function overwriteFiles(message) {
  return message.split('\n').filter(line => /^\t/.test(line)).map(line => line.trim()).filter(Boolean).slice(0, 200);
}
// A command that may stop half-way: a stop leaves the repository in a state (conflicts, an edit stop) that the UI continues or aborts.
async function stoppable(runtime, args, options = {}) {
  const result = await git(runtime, args, { ...options, ok: false });
  const state = await repoState(runtime);
  // An interactive rebase that reaches an `edit` line exits 0 but has not finished.
  if (result.exitCode === 0) return state.op ? { stopped: true, output: `${result.stdout}${result.stderr}`.trim().slice(-3000), state } : { output: `${result.stdout}${result.stderr}`.trim() };
  if (state.op) return { stopped: true, output: `${result.stdout}${result.stderr}`.trim().slice(-3000), state };
  const message = `${result.stderr}\n${result.stdout}`;
  if (OVERWRITE.test(message)) throw Object.assign(fault('LOCAL_CHANGES', '커밋하지 않은 변경이 이 작업과 겹칩니다.', 409), { files: overwriteFiles(message) });
  throw failed(result);
}
// IntelliJ's smart checkout: the local changes are stashed, the command runs, and the changes come back on top.
async function smart(runtime, run) {
  const stash = await git(runtime, ['stash', 'push', '--include-untracked', '-m', 'ADE: smart checkout'], { ok: false });
  if (stash.exitCode !== 0) throw failed(stash);
  const stashed = !/No local changes to save/i.test(stash.stdout + stash.stderr);
  let result;
  try { result = await run(); }
  catch (error) { if (stashed) await git(runtime, ['stash', 'pop'], { ok: false }); throw error; }
  if (!stashed) return result;
  const pop = await git(runtime, ['stash', 'pop'], { ok: false });
  if (pop.exitCode !== 0) return { ...result, warning: '보관해 둔 변경을 되돌리다 충돌이 났습니다. 충돌을 해결하세요. (변경은 stash에도 남아 있습니다.)' };
  return result;
}
async function withLocalChanges(runtime, mode, run) {
  if (mode === 'smart') return smart(runtime, run);
  return run();
}
async function tempFolder() { return fs.mkdtemp(path.join(os.tmpdir(), 'ade-git-')); }
const shellQuote = value => `'${value.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
// Runs `git rebase -i` with a prepared todo list. The sequence editor copies it over git's own; a reworded or squashed commit gets
// its message from an `exec git commit --amend -F` line right after it.
async function rebaseWithTodo(runtime, upstream, entries) {
  const folder = await tempFolder();
  try {
    const lines = [];
    for (const [index, entry] of entries.entries()) {
      const action = entry.action === 'reword' ? 'pick' : entry.action;
      lines.push(`${action} ${entry.sha}`);
      if (typeof entry.message === 'string' && (entry.action === 'reword' || entry.amend)) {
        const file = path.join(folder, `message-${index}.txt`);
        await fs.writeFile(file, entry.message.endsWith('\n') ? entry.message : `${entry.message}\n`, 'utf8');
        lines.push(`exec git commit --amend --allow-empty --cleanup=strip -F ${shellQuote(file)}`);
      }
    }
    const todo = path.join(folder, 'todo');
    await fs.writeFile(todo, `${lines.join('\n')}\n`, 'utf8');
    return await stoppable(runtime, ['rebase', '-i', '--autostash', ...(upstream ? [upstream] : ['--root'])], { env: { GIT_SEQUENCE_EDITOR: `cp ${shellQuote(todo)}` }, timeoutMs: 600_000 });
  } finally { await fs.rm(folder, { recursive: true, force: true }).catch(() => {}); }
}
// Commits from `oldest` up to HEAD (oldest first) for a history edit; merges in the range cannot be replayed one by one.
async function rangeToHead(runtime, oldest) {
  const head = await headHash(runtime);
  if (!head) throw fault('INVALID_STATE', '커밋이 없습니다.');
  if ((await git(runtime, ['merge-base', '--is-ancestor', oldest, head], { ok: false })).exitCode !== 0) throw fault('INVALID_INPUT', '현재 브랜치에 있는 커밋만 고칠 수 있습니다.');
  const parent = await git(runtime, ['rev-parse', '--verify', '-q', `${oldest}^`], { ok: false }).then(result => result.exitCode === 0 ? result.stdout.trim() : null);
  const list = (await git(runtime, ['rev-list', '--reverse', '--parents', parent ? `${parent}..${head}` : head])).stdout.split('\n').filter(Boolean).map(line => line.split(' '));
  if (list.some(item => item.length > 2)) throw fault('INVALID_INPUT', '범위 안에 머지 커밋이 있어 커밋을 하나씩 다시 쌓을 수 없습니다.');
  return { upstream: parent, commits: list.map(item => item[0]) };
}
const ensureIdle = async runtime => {
  const state = await repoState(runtime);
  if (state.op) throw fault('INVALID_STATE', `진행 중인 ${({ merge: '머지', rebase: '리베이스', 'cherry-pick': '체리픽', revert: '되돌리기' })[state.op]}를 먼저 끝내거나 중단하세요.`, 409);
};

export async function runOperation(runtime, input = {}) {
  const op = input.op;
  const done = async (result = {}) => ({ ...result, state: result.state ?? await repoState(runtime) });
  switch (op) {
    case 'checkout': {
      const target = input.ref;
      const run = async () => {
        if (typeof target === 'string' && target.startsWith('refs/heads/')) return stoppable(runtime, ['switch', ...(input.mode === 'force' ? ['--discard-changes'] : []), shortRef(await existingRef(runtime, target)), '--']);
        if (typeof target === 'string' && target.startsWith('refs/remotes/')) {
          const ref = await existingRef(runtime, target), { branch } = await splitRemote(runtime, ref);
          const local = await branchName(runtime, input.name || branch);
          const force = input.mode === 'force' ? ['--discard-changes'] : [];
          if (await exists(runtime, `refs/heads/${local}`)) return stoppable(runtime, ['switch', ...force, local, '--']);
          return stoppable(runtime, ['switch', ...force, '--track', '-c', local, shortRef(ref), '--']);
        }
        return stoppable(runtime, ['switch', ...(input.mode === 'force' ? ['--discard-changes'] : []), '--detach', await revision(runtime, target), '--']);
      };
      return done(await withLocalChanges(runtime, input.mode, run));
    }
    case 'branch-create': {
      const name = await branchName(runtime, input.name), from = await revision(runtime, input.from);
      if (!input.force && await exists(runtime, `refs/heads/${name}`)) throw fault('BRANCH_EXISTS', `${name} 브랜치가 이미 있습니다.`, 409);
      if (input.checkout) return done(await withLocalChanges(runtime, input.mode, () => stoppable(runtime, ['switch', input.force ? '-C' : '-c', name, from, '--'])));
      await git(runtime, ['branch', ...(input.force ? ['-f'] : []), '--', name, from]);
      return done();
    }
    case 'tag-create': {
      const name = await tagName(runtime, input.name), target = await revision(runtime, input.sha);
      if (await exists(runtime, `refs/tags/${name}`)) throw fault('TAG_EXISTS', `${name} 태그가 이미 있습니다.`, 409);
      const message = typeof input.message === 'string' && input.message.trim() ? input.message : '';
      await git(runtime, ['tag', ...(message ? ['-a', '-m', message] : []), '--', name, target]);
      return done();
    }
    case 'branch-delete': {
      const name = await branchName(runtime, input.name);
      const sha = (await git(runtime, ['rev-parse', '--verify', `refs/heads/${name}`])).stdout.trim();
      const result = await git(runtime, ['branch', input.force ? '-D' : '-d', '--', name], { ok: false });
      if (result.exitCode !== 0) {
        if (/not fully merged/i.test(result.stderr)) throw fault('NOT_MERGED', `${name} 브랜치는 아직 머지되지 않은 커밋이 있습니다.`, 409);
        throw failed(result);
      }
      return done({ restore: { name, sha } });
    }
    case 'branch-restore': {
      const name = await branchName(runtime, input.name);
      await git(runtime, ['branch', '--', name, hash(input.sha)]);
      return done();
    }
    case 'remote-branch-delete': {
      const { remote, branch } = await splitRemote(runtime, await existingRef(runtime, input.ref));
      await git(runtime, ['push', remote, '--delete', `refs/heads/${branch}`], { timeoutMs: 180_000 });
      return done();
    }
    case 'tag-delete': {
      const name = await tagName(runtime, input.name);
      await git(runtime, ['tag', '-d', '--', name]);
      return done();
    }
    case 'branch-rename': {
      const from = await branchName(runtime, input.from), to = await branchName(runtime, input.to);
      if (await exists(runtime, `refs/heads/${to}`)) throw fault('BRANCH_EXISTS', `${to} 브랜치가 이미 있습니다.`, 409);
      await git(runtime, ['branch', '-m', '--', from, to]);
      return done();
    }
    case 'merge': {
      await ensureIdle(runtime);
      const ref = await revision(runtime, input.ref);
      const flags = { 'no-ff': ['--no-ff'], 'ff-only': ['--ff-only'], squash: ['--squash'], 'no-commit': ['--no-commit', '--no-ff'] }[input.mode] ?? [];
      return done(await stoppable(runtime, ['merge', '--no-edit', '--autostash', ...flags, ref]));
    }
    case 'rebase': {
      await ensureIdle(runtime);
      const onto = await revision(runtime, input.onto);
      const branch = input.branch ? await branchName(runtime, input.branch) : null;
      return done(await stoppable(runtime, ['rebase', '--autostash', onto, ...(branch ? [branch] : [])], { timeoutMs: 600_000 }));
    }
    case 'cherry-pick': {
      await ensureIdle(runtime);
      return done(await stoppable(runtime, ['cherry-pick', ...hashes(input.shas)], { timeoutMs: 600_000 }));
    }
    case 'revert': {
      await ensureIdle(runtime);
      return done(await stoppable(runtime, ['revert', '--no-edit', ...hashes(input.shas)], { timeoutMs: 600_000 }));
    }
    case 'reset': {
      const mode = ['soft', 'mixed', 'hard', 'keep'].includes(input.mode) ? input.mode : null;
      if (!mode) throw fault('INVALID_INPUT', '리셋 방식을 고르세요.');
      await git(runtime, ['reset', `--${mode}`, await revision(runtime, input.sha), '--']);
      return done();
    }
    case 'undo-commit': {
      await ensureIdle(runtime);
      const head = await headHash(runtime);
      if (!head || head !== hash(input.sha)) throw fault('INVALID_INPUT', '마지막 커밋만 되돌릴 수 있습니다.');
      const parent = await git(runtime, ['rev-parse', '--verify', '-q', 'HEAD^'], { ok: false });
      if (parent.exitCode === 0) await git(runtime, ['reset', '--soft', 'HEAD^']);
      else await git(runtime, ['update-ref', '-d', 'HEAD']);
      return done();
    }
    case 'reword': {
      await ensureIdle(runtime);
      const id = hash(input.sha), message = text(input.message, '커밋 메시지', 64 * 1024);
      const head = await headHash(runtime);
      if (head === id || head?.startsWith(id)) {
        const folder = await tempFolder();
        try {
          const file = path.join(folder, 'message.txt'); await fs.writeFile(file, message, 'utf8');
          await git(runtime, ['commit', '--amend', '--only', '--allow-empty', '--cleanup=strip', '-F', file]);
        } finally { await fs.rm(folder, { recursive: true, force: true }).catch(() => {}); }
        return done();
      }
      const { upstream, commits } = await rangeToHead(runtime, id);
      return done(await rebaseWithTodo(runtime, upstream, commits.map(sha => sha.startsWith(id) ? { sha, action: 'reword', message } : { sha, action: 'pick' })));
    }
    case 'drop': {
      await ensureIdle(runtime);
      const drop = new Set(hashes(input.shas));
      const all = [...drop];
      const { upstream, commits } = await rangeToHead(runtime, await oldestOf(runtime, all));
      const isDropped = sha => all.some(id => sha.startsWith(id));
      return done(await rebaseWithTodo(runtime, upstream, commits.map(sha => ({ sha, action: isDropped(sha) ? 'drop' : 'pick' }))));
    }
    case 'squash': {
      await ensureIdle(runtime);
      const selected = hashes(input.shas);
      if (selected.length < 2) throw fault('INVALID_INPUT', '커밋을 두 개 이상 고르세요.');
      const message = text(input.message, '커밋 메시지', 64 * 1024);
      const { upstream, commits } = await rangeToHead(runtime, await oldestOf(runtime, selected));
      const picked = sha => selected.some(id => sha.startsWith(id));
      // The selected commits gather where the oldest of them was, in their original order; the rest keep theirs.
      const chosen = commits.filter(picked), rest = commits.filter(sha => !picked(sha));
      const entries = chosen.map((sha, index) => ({ sha, action: index === 0 ? 'pick' : 'fixup' }));
      entries[entries.length - 1] = { ...entries[entries.length - 1], amend: true, message };
      return done(await rebaseWithTodo(runtime, upstream, [...entries, ...rest.map(sha => ({ sha, action: 'pick' }))]));
    }
    case 'rebase-interactive': {
      await ensureIdle(runtime);
      if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 1000) throw fault('INVALID_INPUT', '리베이스할 커밋 목록이 올바르지 않습니다.');
      const entries = input.entries.map(entry => {
        const action = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'].includes(entry?.action) ? entry.action : null;
        if (!action) throw fault('INVALID_INPUT', '리베이스 동작이 올바르지 않습니다.');
        return { sha: hash(entry.sha), action, ...(action === 'reword' ? { message: text(entry.message, '커밋 메시지', 64 * 1024) } : {}) };
      });
      if (['squash', 'fixup'].includes(entries.find(entry => entry.action !== 'drop')?.action)) throw fault('INVALID_INPUT', '첫 커밋은 squash/fixup으로 합칠 대상이 없습니다.');
      const { upstream, commits } = await rangeToHead(runtime, hash(input.base));
      const known = new Set(commits);
      const full = entries.map(entry => ({ ...entry, sha: commits.find(sha => sha.startsWith(entry.sha)) }));
      if (full.some(entry => !entry.sha || !known.has(entry.sha)) || new Set(full.map(entry => entry.sha)).size !== commits.length) throw fault('INVALID_INPUT', '리베이스 목록이 현재 브랜치와 맞지 않습니다. 새로고침 후 다시 시도하세요.');
      return done(await rebaseWithTodo(runtime, upstream, full));
    }
    case 'push': {
      const branch = input.branch ? await branchName(runtime, input.branch) : await currentBranchName(runtime);
      if (!branch) throw fault('INVALID_STATE', 'push할 브랜치가 없습니다. (HEAD가 브랜치에 있지 않음)');
      const upstream = (await git(runtime, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`])).stdout.trim();
      let remote, target;
      if (upstream) ({ remote, branch: target } = await splitRemote(runtime, upstream));
      else {
        const list = await remotes(runtime);
        remote = input.remote && list.includes(input.remote) ? input.remote : list.includes('origin') ? 'origin' : list[0];
        if (!remote) throw fault('INVALID_STATE', '원격 저장소가 없습니다.');
        target = branch;
      }
      const source = input.upTo ? hash(input.upTo) : `refs/heads/${branch}`;
      const args = ['push', '--porcelain', ...(input.force ? ['--force-with-lease'] : []), ...(!upstream && !input.upTo ? ['-u'] : []), remote, `${source}:refs/heads/${target}`];
      const result = await git(runtime, args, { ok: false, timeoutMs: 300_000 });
      if (result.exitCode !== 0) {
        if (/\[rejected\]|non-fast-forward|fetch first/i.test(result.stdout + result.stderr)) throw fault('PUSH_REJECTED', `원격의 ${target}에 로컬에 없는 커밋이 있어 거부되었습니다. 먼저 업데이트(가져오기)하거나 강제 push를 고르세요.`, 409);
        throw failed(result);
      }
      return done({ output: `${remote}/${target}` });
    }
    case 'fetch': {
      const result = await git(runtime, ['fetch', '--all', ...(input.prune ? ['--prune'] : [])], { ok: false, timeoutMs: 300_000 });
      if (result.exitCode !== 0) throw failed(result);
      return done();
    }
    case 'update': {
      const current = await currentBranchName(runtime);
      const branch = input.branch ? await branchName(runtime, input.branch) : current;
      if (!branch) throw fault('INVALID_STATE', 'HEAD가 브랜치에 있지 않습니다.');
      const upstream = (await git(runtime, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`])).stdout.trim();
      if (!upstream) throw fault('NO_UPSTREAM', `${branch} 브랜치에 연결된 원격 브랜치가 없습니다.`, 409);
      const { remote, branch: remoteBranch } = await splitRemote(runtime, upstream);
      if (branch === current) {
        await ensureIdle(runtime);
        return done(await stoppable(runtime, ['pull', '--autostash', input.method === 'rebase' ? '--rebase' : '--no-rebase', '--no-edit', remote, remoteBranch], { timeoutMs: 300_000 }));
      }
      // Another branch can only move forward: fetch straight into it.
      const result = await git(runtime, ['fetch', remote, `refs/heads/${remoteBranch}:refs/heads/${branch}`], { ok: false, timeoutMs: 300_000 });
      if (result.exitCode !== 0) {
        if (/non-fast-forward|rejected/i.test(result.stderr)) throw fault('NOT_FAST_FORWARD', `${branch}과(와) ${remote}/${remoteBranch}이 갈라져 있어 앞으로 당길 수 없습니다. 체크아웃한 뒤 업데이트하세요.`, 409);
        throw failed(result);
      }
      return done();
    }
    case 'continue': case 'abort': case 'skip': {
      const state = await repoState(runtime);
      if (!state.op) throw fault('INVALID_STATE', '진행 중인 작업이 없습니다.');
      if (op === 'continue' && state.conflicts.length) throw fault('CONFLICTS', '아직 해결하지 않은 충돌이 있습니다.', 409);
      if (op === 'skip' && state.op === 'merge') throw fault('INVALID_INPUT', '머지는 건너뛸 수 없습니다.');
      const args = state.op === 'merge' ? (op === 'abort' ? ['merge', '--abort'] : ['commit', '--no-edit'])
        : [state.op, `--${op}`];
      // Changes from a conflict that were all resolved to nothing leave an empty commit, which `--continue` would otherwise refuse.
      if (op === 'continue' && state.op === 'cherry-pick') {
        const staged = await git(runtime, ['diff', '--cached', '--quiet'], { ok: false });
        if (staged.exitCode === 0) return done(await stoppable(runtime, ['cherry-pick', '--skip'], { timeoutMs: 600_000 }));
      }
      return done(await stoppable(runtime, args, { timeoutMs: 600_000 }));
    }
    case 'resolve': {
      const file = text(input.path, '경로', 4096);
      const state = await repoState(runtime);
      if (!state.conflicts.includes(file)) throw fault('INVALID_INPUT', '충돌 중인 파일이 아닙니다.');
      if (input.side === 'ours' || input.side === 'theirs') {
        const picked = await git(runtime, ['--literal-pathspecs', 'checkout', `--${input.side}`, '--', file], { ok: false });
        // The chosen side deleted the file: resolving to it removes the file.
        if (picked.exitCode !== 0) await git(runtime, ['--literal-pathspecs', 'rm', '-q', '--', file]);
        else await git(runtime, ['--literal-pathspecs', 'add', '--', file]);
      } else if (input.side === 'mark') {
        const present = await fs.stat(path.join(runtime.workspace.root, file)).then(() => true, () => false);
        await git(runtime, ['--literal-pathspecs', present ? 'add' : 'rm', ...(present ? [] : ['-q']), '--', file]);
      } else throw fault('INVALID_INPUT', '해결 방법을 고르세요.');
      return done();
    }
    default: throw fault('INVALID_INPUT', '알 수 없는 Git 작업입니다.');
  }
}
// Of several commits on the current branch, the one furthest from HEAD.
async function oldestOf(runtime, list) {
  const order = (await git(runtime, ['rev-list', '--topo-order', '--no-walk=sorted', ...list])).stdout.split('\n').filter(Boolean);
  return order[order.length - 1] ?? list[0];
}
