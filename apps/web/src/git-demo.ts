import type { Commit, LogData, Ref } from './git-graph';
import type { Details } from './GitLog';

// The sample history the tutorial's Git drawer shows: a merged feature branch, an open fix branch, a tag, and a main that is ahead of origin.
export function demoGit(now = Math.floor(Date.now() / 1000)) {
  const me = { name: '나', email: 'me@example.com' }, mate = { name: '민지', email: 'minji@example.com' };
  const list: [string, string[], number, typeof me, string, [string, string][]][] = [
    ['c8a1f00d3e', ['c6b2e11a0f', 'c7d4a90b12'], 40, me, "Merge branch 'feature/login'", [['M', 'src/app.ts']]],
    ['f1e9c2a774', ['c6b2e11a0f'], 90, mate, '안내 문구 오타 수정', [['M', 'src/pages/home.tsx']]],
    ['c7d4a90b12', ['c5e0f3c4d9'], 150, me, '로그인 화면 추가', [['A', 'src/pages/login.tsx'], ['M', 'src/app.ts']]],
    ['c6b2e11a0f', ['c4a7d2e310'], 600, mate, 'README 정리', [['M', 'README.md']]],
    ['c5e0f3c4d9', ['c4a7d2e310'], 3600 * 5, me, '로그인 API 연결', [['A', 'src/api/login.ts'], ['M', 'src/server.ts']]],
    ['c4a7d2e310', ['c3f8b1a2c4'], 86400 + 3600, me, '서버 시작 스크립트', [['M', 'package.json'], ['A', 'scripts/start.mjs']]],
    ['c3f8b1a2c4', ['c2b6e7d5a1'], 86400 * 3, mate, '테스트 추가', [['A', 'tests/server.test.ts']]],
    ['c2b6e7d5a1', ['c1a0d9f4b8'], 86400 * 6, me, '첫 화면', [['A', 'src/pages/home.tsx'], ['A', 'src/app.ts']]],
    ['c1a0d9f4b8', [], 86400 * 9, me, 'Initial commit', [['A', 'README.md'], ['A', 'package.json'], ['A', 'src/server.ts']]]
  ];
  const pad = (hash: string) => hash.padEnd(40, '0');
  const commits: Commit[] = list.map(([h, p, ago, who, s]) => ({ h: pad(h), p: p.map(pad), an: who.name, ae: who.email, at: now - ago, ct: now - ago, s }));
  const refs: Ref[] = [
    { ref: 'refs/heads/main', name: 'main', kind: 'local', sha: pad('c8a1f00d3e'), current: true, upstream: 'origin/main', ahead: 3 },
    { ref: 'refs/remotes/origin/main', name: 'origin/main', kind: 'remote', sha: pad('c6b2e11a0f') },
    { ref: 'refs/heads/feature/login', name: 'feature/login', kind: 'local', sha: pad('c7d4a90b12') },
    { ref: 'refs/heads/fix/typo', name: 'fix/typo', kind: 'local', sha: pad('f1e9c2a774'), upstream: 'origin/fix/typo' },
    { ref: 'refs/remotes/origin/fix/typo', name: 'origin/fix/typo', kind: 'remote', sha: pad('f1e9c2a774') },
    { ref: 'refs/tags/v0.1.0', name: 'v0.1.0', kind: 'tag', sha: pad('c4a7d2e310') }
  ];
  const data: LogData = { signature: 'demo', head: { sha: pad('c8a1f00d3e'), branch: 'main' }, refs, commits, truncated: false, limit: 5000, state: { op: null, conflicts: [] }, me, remotes: ['origin'], urls: {} };
  const details: Record<string, Details> = Object.fromEntries(list.map(([h, p, ago, who, s, files]) => [pad(h), {
    sha: pad(h), parents: p.map(pad), author: who.name, email: who.email, authorTime: now - ago, committer: who.name, committerEmail: who.email, commitTime: now - ago, message: s,
    files: files.map(([status, path]) => ({ status, path }))
  }]));
  return { data, details };
}
