import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCommitMessage, worktreeBadge, worktreeLine, worktreeOf } from '../apps/web/src/chat-worktree.ts';

const info = (status = {}, extra = {}) => ({ path: '/data/p/worktrees/chat-ab12', cwd: '/data/p/worktrees/chat-ab12', branch: 'ade/chat-ab12', origin: '/repo', kind: 'ade', inside: true, managed: true, status: { exists: true, at: 0, ahead: 0, behind: 0, dirty: 0, originBranch: 'main', ...status }, ...extra });

test('the badge says branch, commits ahead and uncommitted files, with the path and origin in its tooltip', () => {
  const badge = worktreeBadge(info({ ahead: 3, dirty: 2, behind: 1 }));
  assert.deepEqual([badge.label, badge.ahead, badge.dirty, badge.tone], ['ade/chat-ab12', 3, 2, 'dirty']);
  assert.match(badge.title, /경로: \/data\/p\/worktrees\/chat-ab12/); assert.match(badge.title, /원본: \/repo \(main\)/);
  assert.match(badge.title, /커밋 3개 앞섬/); assert.match(badge.title, /원본이 1개 앞섬/); assert.match(badge.title, /커밋 안 한 변경 2개/);
  assert.equal(worktreeBadge(info({ ahead: 1 })).tone, 'ahead');
  assert.equal(worktreeBadge(info({ merged: true })).tone, 'merged');
  assert.equal(worktreeBadge(info({ conflicted: ['a'] })).tone, 'conflict');
  assert.equal(worktreeBadge(info({ exists: false })).tone, 'missing');
  assert.match(worktreeBadge(info({}, { inside: false })).title, /지금은 원본에서 작업 중/);
  assert.equal(worktreeOf({ worktreeInfo: info() })?.branch, 'ade/chat-ab12');
  assert.equal(worktreeOf({ worktreeInfo: null }), null); assert.equal(worktreeOf(null), null);
});

test('thread lines: the user\'s moves, commits, merges, integration and release; the agent\'s own moves keep their wording', () => {
  assert.equal(worktreeLine({ phase: 'enter', path: '/w/chat-ab12', branch: 'ade/chat-ab12', by: 'user' }).text, 'worktree 진입 · ade/chat-ab12');
  assert.equal(worktreeLine({ phase: 'exit', path: '/repo', from: '/w/chat-ab12', by: 'user' }).text, 'worktree에서 나옴 · 원본 repo');
  assert.equal(worktreeLine({ phase: 'create', branch: 'ade/chat-ab12', by: 'user' }).text, '새 worktree를 만들었습니다 · ade/chat-ab12');
  assert.equal(worktreeLine({ phase: 'commit', subject: '작업\n본문', by: 'user' }).text, 'worktree에 커밋했습니다 · 작업');
  assert.equal(worktreeLine({ phase: 'merge', branch: 'ade/chat-ab12', into: 'main', fastForward: true, commits: 2, by: 'user' }).text, 'ade/chat-ab12을(를) 원본 main에 합쳤습니다 (fast-forward, 커밋 2개)');
  assert.equal(worktreeLine({ phase: 'merge', branch: 'b', into: 'main', fastForward: false, by: 'agent' }).text, 'AI가 b을(를) 원본 main에 합쳤습니다 (merge 커밋)');
  assert.equal(worktreeLine({ phase: 'integrate', branches: ['x', 'y'], stopped: 'z', by: 'agent' }).text, 'AI가 다른 채팅의 브랜치를 이 worktree로 통합했습니다 · x, y · z에서 충돌, 해결 필요');
  assert.equal(worktreeLine({ phase: 'remove', branch: 'b', branchDeleted: true, by: 'user' }).text, 'worktree를 해제했습니다 · b · 브랜치 삭제');
  assert.equal(worktreeLine({ phase: 'remove', branch: 'b', discarded: true, by: 'user' }).text, 'worktree를 해제했습니다 · b · 변경을 버림 · 브랜치 유지');
  assert.equal(worktreeLine({ phase: 'enter', path: '/p/.claude/worktrees/a', branch: 'worktree-a' }).text, 'AI가 워크트리로 이동했습니다, a (worktree-a)');
  assert.equal(worktreeLine({ phase: 'enter', path: '/p/.claude/worktrees/a', branch: 'worktree-a', by: 'agent' }).text, 'AI가 워크트리로 이동했습니다, a (worktree-a)');
  assert.equal(worktreeLine({ phase: 'unknown' }), null);
});

test('the default commit message is the chat title and the files', () => {
  assert.equal(defaultCommitMessage('  로그인 오류   고치기 ', [{ path: 'a.ts' }, { path: 'b.ts' }]), '로그인 오류 고치기\n\n- a.ts\n- b.ts');
  assert.equal(defaultCommitMessage('', []), '채팅 작업');
  assert.match(defaultCommitMessage('t', Array.from({ length: 15 }, (_, i) => ({ path: `f${i}` }))), /- 외 3개$/);
});
