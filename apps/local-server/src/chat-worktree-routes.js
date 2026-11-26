// `chat/worktree/*`: the screen's (and the agent bus') way to a chat's git worktree. Moving a chat in and out is the chat session's own work
// (chat.js); the git work is chat-worktree.js. Everything that changes a repository runs in the project's `mutation` queue, one at a time.
// A commit here exists only inside the merge flow ("원본으로 합치기"): the app still has no general stage/commit UI (git/stage, git/commit 404).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fault } from './files.js';
import { commitWorktree, conflictPrompt, integrateBranches, listChatWorktrees, mergePreview, mergeWorktree, predictConflicts, readOwnWorktree, removeWorktree, samePath, worktreeDiff, worktreeStatus, writeOwnWorktree } from './chat-worktree.js';

// A refused merge is an answer, not a failure: the screen shows why and what to do (and the agent bus passes it on).
const BLOCKED = new Set(['MERGE_CONFLICT', 'ORIGIN_DIRTY', 'ORIGIN_BUSY', 'ORIGIN_DETACHED', 'ORIGIN_SAME_BRANCH', 'WORKTREE_DIRTY', 'WORKTREE_BUSY', 'WORKTREE_DETACHED', 'MERGE_FAILED']);
const by = input => input.by === 'agent' ? 'agent' : 'user';

function chatOf(project, input) {
  const chat = typeof input.id === 'string' ? project.chats.get(input.id) : null;
  if (!chat) throw fault('NOT_FOUND', '채팅을 찾을 수 없습니다.', 404);
  return chat;
}
async function infoOf(chat) {
  const info = await chat.refreshWorktree();
  if (!info) throw fault('NO_WORKTREE', '이 채팅에는 worktree가 없습니다.', 409);
  return info;
}
// Chats that are closed keep their worktree in their folder (worktree.json); open ones say where they are now.
async function owners(project) {
  const list = [];
  for (const [id, chat] of project.chats) {
    const info = chat.worktreeInfo?.(); if (info) list.push({ path: info.path, chatId: id, title: chat.state().chatTitle || '', open: true, inside: info.inside });
  }
  const root = path.join(project.directory, 'chat');
  for (const name of await fs.readdir(root).catch(() => [])) {
    if (project.chats.has(name)) continue;
    const own = await readOwnWorktree(path.join(root, name)); if (!own) continue;
    const meta = await fs.readFile(path.join(root, name, 'meta.json'), 'utf8').then(JSON.parse, () => ({}));
    list.push({ path: own.path, chatId: name, title: typeof meta.title === 'string' ? meta.title : '', open: false, inside: typeof meta.worktreePath === 'string' && samePath(meta.worktreePath, own.path) });
  }
  return list;
}
const repositories = project => [...new Map([project.root, ...(project.repositories ?? []).map(repo => repo.path)].map(item => [path.resolve(item).toLowerCase(), item])).values()];

// One chat's worktree in a few words, for the agent bus' list_peers (who works where, and how far along).
export function peerWorktree(chat) {
  const info = chat?.worktreeInfo?.();
  if (!info) return null;
  const status = info.status ?? {};
  return { branch: info.branch, path: info.path, origin: info.origin, originBranch: status.originBranch ?? '', inside: info.inside, managed: info.managed, ahead: status.ahead ?? 0, behind: status.behind ?? 0, dirty: status.dirty ?? 0, merged: status.merged === true, conflicted: status.conflicted?.length ?? 0 };
}

export async function chatWorktreeRoute(action, input, project) {
  switch (action) {
    case 'chat/worktree/status': {
      const chat = chatOf(project, input), info = await chat.refreshWorktree();
      return { info, ...(info && input.detail === true && { preview: await mergePreview(info) }) };
    }
    case 'chat/worktree/enter': { const chat = chatOf(project, input); return { info: await project.mutation(() => chat.enterWorktree()) }; }
    case 'chat/worktree/leave': { const chat = chatOf(project, input); return { info: await chat.leaveWorktree() }; }
    case 'chat/worktree/commit': {
      const chat = chatOf(project, input);
      return project.mutation(async () => {
        const info = await infoOf(chat), done = await commitWorktree(info, input.message);
        if (done.committed) await chat.noteWorktree({ phase: 'commit', branch: info.branch, commit: done.commit, subject: String(input.message).trim().split('\n')[0].slice(0, 200), by: by(input) });
        return { ...done, info: chat.worktreeInfo() };
      });
    }
    case 'chat/worktree/merge': {
      const chat = chatOf(project, input);
      return project.mutation(async () => {
        const info = await infoOf(chat);
        let committed = null;
        try {
          if (typeof input.message === 'string' && input.message.trim() && (await worktreeStatus(info)).dirty) {
            committed = await commitWorktree(info, input.message);
            if (committed.committed) await chat.noteWorktree({ phase: 'commit', branch: info.branch, commit: committed.commit, subject: input.message.trim().split('\n')[0].slice(0, 200), by: by(input) });
          }
          const result = await mergeWorktree(info);
          if (result.merged) await chat.noteWorktree({ phase: 'merge', branch: result.branch, into: result.into, commit: result.commit, fastForward: result.fastForward, commits: result.commits, by: by(input) });
          else await chat.refreshWorktree();
          return { ...result, committed, info: chat.worktreeInfo() };
        } catch (error) {
          if (!BLOCKED.has(error.code)) throw error;
          const info2 = await chat.refreshWorktree();
          const prompt = error.code === 'MERGE_CONFLICT' ? conflictPrompt({ originBranch: error.originBranch ?? info2?.status?.originBranch ?? '', files: error.files ?? [], branch: info.branch }) : '';
          return { merged: false, committed, blocked: { code: error.code, message: error.message, files: error.files ?? [], ...(prompt && { prompt }) }, info: info2 };
        }
      });
    }
    case 'chat/worktree/remove': {
      const chat = chatOf(project, input);
      return project.mutation(async () => {
        const info = await infoOf(chat);
        if (!info.managed) throw fault('AGENT_WORKTREE', '에이전트가 직접 만든 worktree는 에이전트에게 정리를 맡기세요(Claude: ExitWorktree).', 409);
        if (input.discard === true && input.confirm !== info.branch) throw fault('INVALID_INPUT', '버릴 worktree의 브랜치 이름을 확인하세요.');
        // "합치지 않고 해제": what is not committed yet goes onto the branch first (the branch is kept), when the user wrote a message for it.
        if (input.discard !== true && (info.status?.dirty ?? 0) > 0 && typeof input.message === 'string' && input.message.trim()) {
          const done = await commitWorktree(info, input.message);
          if (done.committed) await chat.noteWorktree({ phase: 'commit', branch: info.branch, commit: done.commit, subject: input.message.trim().split('\n')[0].slice(0, 200), by: by(input) });
          info.status = (await chat.refreshWorktree())?.status ?? info.status;
        }
        if (input.discard !== true && (info.status?.dirty ?? 0) > 0) throw fault('WORKTREE_DIRTY', 'worktree에 커밋하지 않은 변경이 있습니다. 먼저 합치거나, 버리기를 고르세요.', 409);
        if (info.inside) await chat.leaveWorktree();
        const done = await removeWorktree(info, { deleteBranch: input.deleteBranch === true, discard: input.discard === true });
        const after = await chat.forgetWorktree({ path: info.path, branch: info.branch, branchDeleted: done.branchDeleted, discarded: input.discard === true, by: by(input) });
        return { ...done, info: after };
      });
    }
    case 'chat/worktree/diff': { const chat = chatOf(project, input); return worktreeDiff(await infoOf(chat), { file: input.file }); }
    case 'chat/worktree/list': return { items: await listChatWorktrees({ directory: project.directory, repos: repositories(project), owners: await owners(project) }) };
    // A worktree no open chat holds: one left behind by a chat that was forgotten, or a closed chat's (which then forgets it).
    case 'chat/worktree/cleanup': return project.mutation(async () => {
      const items = await listChatWorktrees({ directory: project.directory, repos: repositories(project), owners: await owners(project) });
      const item = items.find(entry => typeof input.path === 'string' && samePath(entry.path, input.path));
      if (!item) throw fault('NOT_FOUND', '정리할 worktree를 찾을 수 없습니다.', 404);
      if (item.open) throw fault('WORKTREE_IN_USE', '열려 있는 채팅의 worktree입니다. 그 채팅에서 해제하세요.', 409);
      if (item.inside) throw fault('WORKTREE_IN_USE', '닫힌 채팅이 이 worktree 안에서 쉬고 있습니다. 채팅을 다시 열어 worktree에서 나온 뒤 정리하세요.', 409);
      if (input.discard === true && input.confirm !== item.branch) throw fault('INVALID_INPUT', '버릴 worktree의 브랜치 이름을 확인하세요.');
      const done = await removeWorktree(item, { deleteBranch: input.deleteBranch === true, discard: input.discard === true });
      if (item.chatId) await writeOwnWorktree(path.join(project.directory, 'chat', item.chatId), null).catch(() => {});
      return done;
    });
    // Read-only: for each chat (all open chats with a worktree when none are named) whether it can be merged into its origin now and which files
    // would conflict, and which pairs of chats touch the same lines. A suggested order: the ones that conflict with nothing, smallest first.
    case 'chat/worktree/check': {
      const wanted = Array.isArray(input.ids) && input.ids.length ? input.ids.filter(item => typeof item === 'string').slice(0, 16) : [...project.chats.keys()];
      const rows = [];
      for (const id of wanted) {
        const chat = project.chats.get(id); if (!chat) continue;
        const info = await chat.refreshWorktree(); if (!info) continue;
        const status = info.status ?? await worktreeStatus(info);
        const conflicts = status.exists && status.behind && status.ahead ? await predictConflicts(info.origin, status.originHead, status.head).catch(() => []) : [];
        rows.push({ id, title: chat.state().chatTitle || '', agent: chat.agent, branch: info.branch, origin: info.origin, originBranch: status.originBranch ?? '', head: status.head ?? '', ahead: status.ahead ?? 0, behind: status.behind ?? 0, dirty: status.dirty ?? 0, merged: status.merged === true, conflicts,
          ready: Boolean(status.exists && status.ahead && !status.dirty && !conflicts.length && !status.midMerge && status.originBranch && !status.originDirty && !status.originBusy) });
      }
      const pairs = [];
      for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i], b = rows[j];
        if (!samePath(a.origin, b.origin) || !a.head || !b.head || !a.ahead || !b.ahead) continue;
        const files = await predictConflicts(a.origin, a.head, b.head).catch(() => []);
        if (files.length) pairs.push({ a: a.id, b: b.id, files });
      }
      const touchy = id => pairs.filter(pair => pair.a === id || pair.b === id).length;
      const order = rows.filter(row => row.ahead).sort((x, y) => (x.conflicts.length - y.conflicts.length) || (touchy(x.id) - touchy(y.id)) || (x.ahead - y.ahead)).map(row => row.id);
      return { chats: rows, pairs, order };
    }
    // Other chats' branches into this chat's worktree (the integrator), in the given order; the first conflict is left in this worktree for its agent.
    case 'chat/worktree/integrate': {
      const chat = chatOf(project, input);
      return project.mutation(async () => {
        const info = await infoOf(chat);
        if (!info.inside) throw fault('NO_WORKTREE', '통합하는 채팅이 자기 worktree 안에 있어야 합니다.', 409);
        const from = (Array.isArray(input.from) ? input.from : []).filter(item => typeof item === 'string' && item !== input.id).slice(0, 8);
        if (!from.length) throw fault('INVALID_INPUT', '합칠 채팅을 고르세요.');
        const branches = [], skipped = [];
        for (const id of from) {
          const other = project.chats.get(id), theirs = other ? await other.refreshWorktree() : null;
          if (!theirs?.branch) { skipped.push({ id, reason: 'no worktree' }); continue; }
          if (!samePath(theirs.origin, info.origin)) { skipped.push({ id, reason: 'another repository' }); continue; }
          branches.push(theirs.branch);
          if (theirs.status?.dirty) skipped.push({ id, reason: `uncommitted changes (${theirs.status.dirty}) are not included; ask that chat to commit first`, partial: true });
        }
        const result = branches.length ? await integrateBranches(info, branches) : { done: [], stopped: null };
        if (result.done.length || result.stopped) await chat.noteWorktree({ phase: 'integrate', branches: result.done.map(item => item.branch), ...(result.stopped && { stopped: result.stopped.branch }), by: by(input) });
        return { ...result, skipped, info: chat.worktreeInfo() };
      });
    }
    default: throw fault('NOT_FOUND', '지원하지 않는 작업입니다.', 404);
  }
}

// The built-in agent bus may also use these (they are app-internal, not part of the plugin API contract: a plugin the user installed never gets
// them). `chat/peers` answers it in full: the contract's shape drops what the bus needs (the user's latest message for the "ADE verified" line,
// and each chat's worktree).
const BUILTIN = { 'agent-bus': { 'chat/peers': 'scope', 'chat/worktree/status': 'id detail', 'chat/worktree/diff': 'id file', 'chat/worktree/check': 'ids', 'chat/worktree/merge': 'id message by', 'chat/worktree/integrate': 'id from by', 'chat/worktree/list': '' } };
export function builtinWorkspaceRequest(plugin, action, input) {
  const fields = BUILTIN[plugin]?.[action];
  if (fields === undefined || !input || typeof input !== 'object') return null;
  return Object.fromEntries(['projectId', ...fields.split(' ').filter(Boolean)].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
}
