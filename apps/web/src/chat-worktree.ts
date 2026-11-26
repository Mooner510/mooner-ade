// A chat's git worktree as the screen shows it: the badge (branch, commits ahead, uncommitted files), its tooltip, and the lines the thread
// gets when the chat goes in or out, commits, merges, integrates or lets the worktree go. Pure functions (tests/chat-worktree-view.test.mjs).
// The server side is apps/local-server/src/chat-worktree.js; the state arrives as `worktreeInfo` in the chat state.

export type WorktreeStatus = {
  exists: boolean; at: number; branch?: string; head?: string; ahead?: number; behind?: number; merged?: boolean; dirty?: number;
  files?: { path: string; status: string }[]; conflicted?: string[]; midMerge?: boolean;
  originBranch?: string; originHead?: string; originDirty?: number; originFiles?: string[]; originBusy?: boolean;
};
export type WorktreeInfo = {
  path: string; cwd: string; branch: string; origin: string; originCwd?: string; base?: string; baseBranch?: string; createdAt?: number | null;
  chatId?: string; kind: 'ade' | 'claude' | 'other'; inside: boolean; managed: boolean; status: WorktreeStatus | null;
};
export type WorktreeTone = { value: string; color: string; icon?: string };

// The chat state carries it under its own key (not part of ChatState's type, so other changes to that type never meet this one).
export const worktreeOf = (state: unknown): WorktreeInfo | null => {
  const info = (state as { worktreeInfo?: WorktreeInfo | null } | null)?.worktreeInfo;
  return info && typeof info.path === 'string' ? info : null;
};
const folder = (value: unknown) => typeof value === 'string' ? value.split(/[\\/]/).filter(Boolean).at(-1) ?? '' : '';

// What the badge says: the branch, ↑ commits not in the origin branch yet, ● uncommitted files. `tone`: what the colour should tell at a glance.
export function worktreeBadge(info: WorktreeInfo) {
  const status = info.status, ahead = status?.ahead ?? 0, dirty = status?.dirty ?? 0;
  const tone: 'conflict' | 'dirty' | 'ahead' | 'merged' | 'clean' | 'missing' = status && !status.exists ? 'missing' : status?.conflicted?.length || status?.midMerge ? 'conflict' : dirty ? 'dirty' : ahead ? 'ahead' : status?.merged ? 'merged' : 'clean';
  const lines = [
    `${info.inside ? 'worktree에서 작업 중' : '이 채팅의 worktree (지금은 원본에서 작업 중)'}${info.kind === 'claude' ? ' · 에이전트가 직접 만든 worktree' : ''}`,
    `브랜치: ${info.branch || '(detached)'}`,
    `경로: ${info.path}`,
    `원본: ${info.origin}${status?.originBranch ? ` (${status.originBranch})` : ''}`,
    status?.exists === false ? 'worktree 폴더가 없습니다' : [ahead ? `원본보다 커밋 ${ahead}개 앞섬` : status?.merged ? '원본에 모두 합쳐짐' : '원본과 같은 커밋', status?.behind ? `원본이 ${status.behind}개 앞섬` : '', dirty ? `커밋 안 한 변경 ${dirty}개` : '', status?.conflicted?.length ? `충돌 ${status.conflicted.length}개` : ''].filter(Boolean).join(' · ')
  ];
  return { label: info.branch || folder(info.path), ahead, dirty, tone, title: lines.join('\n') };
}

// The default commit message in the merge flow: the chat's title, then the files that change.
export function defaultCommitMessage(title: string, files: { path: string }[] = []) {
  const head = (title.trim() || '채팅 작업').replace(/\s+/g, ' ').slice(0, 72);
  const list = files.slice(0, 12).map(file => `- ${file.path}`);
  return [head, ...(list.length ? ['', ...list, ...(files.length > 12 ? [`- 외 ${files.length - 12}개`] : [])] : [])].join('\n');
}

const BRANCH = (value: string): WorktreeTone => ({ value, color: 'var(--accent)', icon: 'account_tree' });
// The thread's line for a worktree event. Lines without `by` (older transcripts) and `by: 'agent'` are the agent's own moves (Claude's
// EnterWorktree/ExitWorktree, or a resumed CLI found in another folder); the rest the user did from ADE, or an agent through the agent bus.
export function worktreeLine(event: Record<string, unknown>): { text: string; tones: WorktreeTone[] } | null {
  const phase = event.phase, by = event.by, branch = typeof event.branch === 'string' ? event.branch : '', ai = by === 'agent' ? 'AI가 ' : '';
  if ((phase === 'enter' || phase === 'exit') && by !== 'user') {
    const enter = phase === 'enter', name = folder(enter ? event.path : event.from);
    const tail = enter ? (branch && branch !== name ? ` (${branch})` : '') : name ? ` ${event.removed ? '삭제됨' : '유지됨'}` : '';
    return { text: `AI가 워크트리${enter ? '로 이동했습니다' : '에서 나왔습니다'}${name ? `, ${name}` : ''}${tail}`, tones: name ? [BRANCH(name)] : [] };
  }
  if (phase === 'enter') return { text: `worktree 진입 · ${branch || folder(event.path)}`, tones: [BRANCH(branch || folder(event.path))] };
  if (phase === 'exit') { const name = folder(event.path); return { text: `worktree에서 나옴 · 원본 ${name}`, tones: [{ value: name, color: 'var(--fg)', icon: 'folder' }] }; }
  if (phase === 'create') return { text: `새 worktree를 만들었습니다 · ${branch}`, tones: [BRANCH(branch)] };
  if (phase === 'commit') { const subject = typeof event.subject === 'string' ? event.subject.split('\n')[0].slice(0, 80) : ''; return { text: `${ai}worktree에 커밋했습니다${subject ? ` · ${subject}` : ''}`, tones: subject ? [{ value: subject, color: 'var(--fg)', icon: 'commit' }] : [] }; }
  if (phase === 'merge') {
    const into = typeof event.into === 'string' ? event.into : '원본', how = event.fastForward ? 'fast-forward' : 'merge 커밋', count = Number(event.commits) || 0;
    return { text: `${ai}${branch}을(를) 원본 ${into}에 합쳤습니다 (${how}${count ? `, 커밋 ${count}개` : ''})`, tones: [BRANCH(branch), { value: into, color: 'var(--ok, var(--accent))', icon: 'merge' }] };
  }
  if (phase === 'integrate') {
    const done = Array.isArray(event.branches) ? event.branches.filter((item): item is string => typeof item === 'string') : [];
    const stopped = typeof event.stopped === 'string' ? event.stopped : '';
    const text = `${ai}다른 채팅의 브랜치를 이 worktree로 통합했습니다${done.length ? ` · ${done.join(', ')}` : ''}${stopped ? ` · ${stopped}에서 충돌, 해결 필요` : ''}`;
    return { text, tones: [...done.map(BRANCH), ...(stopped ? [{ value: stopped, color: 'var(--warn)', icon: 'warning' }] : [])] };
  }
  if (phase === 'remove') {
    const name = branch || folder(event.path);
    return { text: `${ai}worktree를 해제했습니다 · ${name}${event.discarded ? ' · 변경을 버림' : ''}${event.branchDeleted ? ' · 브랜치 삭제' : ' · 브랜치 유지'}`, tones: [BRANCH(name)] };
  }
  return null;
}
