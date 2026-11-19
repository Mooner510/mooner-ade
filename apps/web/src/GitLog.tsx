import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { ApiError, basename } from './api';
import { GIT_STATUS_RETRY_MS, notAGitRepository } from './errors';
import { DiffView, type Settings } from './Editor';
import { FileIcon } from './FileIcon';
import { Icon, IconButton, type IconName } from './Icon';
import { copyText } from './toast';
import type { Ask } from './views';
import { closeAll, PopupMenu, type MenuEntry } from './GitMenu';
import { BranchesPane, TagGlyph } from './GitBranches';
import { BranchDialog, ConflictsDialog, LocalChangesDialog, MessageDialog, opName, PushDialog, RebaseDialog, ResetDialog, TagDialog } from './GitDialogs';
import {
  type Call, absoluteDate, ancestors, branchColorName, buildGraph, containingRefs, firstParentReach, foldedBetween, graphColor, headPriority, javaHash, layoutGraph, linearRun, makeView,
  loadSpec, prettyDate, refGroups, rowDrawing, sortView, isLinear, type Commit, type Layout, type LogData, type Ref, type RepoState
} from './git-graph';

// The Git tool window's Log tab, in a drawer that rises from the bottom: Branches pane, commit graph, changed files and details.
// It follows IntelliJ's rules (see git-graph.ts) and runs every action through `git/op` on the local server.
export type GitLogProps = {
  call: Call; settings: Settings; setSettings: Dispatch<SetStateAction<Settings>>; visible: boolean; ask: Ask; fail(cause: unknown): void;
  onClose(): void; onChanged(): void; openDiff(spec: string): void; repoKey: string; controls?: ReactNode; unavailable?: string;
  // the tutorial's sample history: no server, and actions only explain themselves
  demo?: { data: LogData; details: Record<string, Details>; note(text: string): void };
};
type FileChange = { status: string; path: string; original?: string };
export type Details = { sha: string; parents: string[]; author: string; email: string; authorTime: number; committer: string; committerEmail: string; commitTime: number; message: string; files: FileChange[] };
type Filters = { text: string; regex: boolean; matchCase: boolean; branches: string[]; users: string[]; since: number | null; until: number | null; paths: string[] };
type Notice = { id: number; text: string; kind: 'info' | 'warn' | 'error'; actions?: { label: string; run(): void }[] };
type OpResult = { stopped?: boolean; state: RepoState; warning?: string; restore?: { name: string; sha: string }; output?: string };
type MenuName = 'commit' | 'branch' | 'branchFilter' | 'user' | 'date' | 'path' | 'graph' | 'view' | 'branchSettings';
const noFilters: Filters = { text: '', regex: false, matchCase: false, branches: [], users: [], since: null, until: null, paths: [] };
const ROW = 22, LANE = 16, RADIUS = 4;
const REF_COLORS = { head: 'var(--git-ref-head)', local: 'var(--git-ref-local)', remote: 'var(--git-ref-remote)', tag: 'var(--git-ref-tag)' };
const short = (hash: string) => hash.slice(0, 8);
const clip = (name: string) => name.length > 22 ? `${name.slice(0, 10)}..${name.slice(-10)}` : name;
const STATUS: Record<string, string> = { A: '추가', M: '수정', D: '삭제', R: '이름 변경', C: '복사', T: '형식 변경' };

export function GitLog(props: GitLogProps) {
  const { call, settings, setSettings, visible, ask, fail, demo } = props;
  const [data, setData] = useState<LogData | null>(demo?.data ?? null), [state, setState] = useState<RepoState>(demo?.data.state ?? { op: null, conflicts: [] });
  const [loadError, setLoadError] = useState(''), [busy, setBusy] = useState(''), [limit, setLimit] = useState(settings.gitLogLimit);
  // A non-repo keeps answering the same way. Skip the timer until the retry delay, another repo, or the drawer opens again.
  const quietUntil = useRef(0);
  const [filters, setFilters] = useState<Filters>(noFilters), [pathHashes, setPathHashes] = useState<Set<string> | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string[]>([]), anchor = useRef(''), [lead, setLead] = useState('');
  const [hover, setHover] = useState<Set<number> | null>(null);
  // built on every render, so a menu opened right after a click sees the new selection and its checkboxes follow the settings
  const [menu, setMenu] = useState<{ x: number; y: number; name: MenuName; ref?: Ref; label: string; align?: 'start' | 'end' } | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null), [notices, setNotices] = useState<Notice[]>([]);
  const [branchSel, setBranchSel] = useState(''), [compare, setCompare] = useState<{ from: string; to: string | null; title: string } | null>(null);
  const signature = useRef(''), table = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(previous => ({ ...previous, [key]: value }));
  const closeMenu = useCallback(() => setMenu(null), []);
  const notify = useCallback((text: string, kind: Notice['kind'] = 'info', actions?: Notice['actions']) => {
    const id = Date.now() + Math.random();
    setNotices(list => [...list.slice(-3), { id, text, kind, actions }]);
    setTimeout(() => setNotices(list => list.filter(item => item.id !== id)), actions ? 15000 : 6000);
  }, []);

  // ---- loading ----
  const load = useCallback(async (force = false) => {
    if (demo || (!force && Date.now() < quietUntil.current)) return;
    try {
      const next = await call<LogData & { unchanged?: boolean }>('git/log', { limit, ...(force ? {} : { signature: signature.current }) });
      setState(previous => JSON.stringify(previous) === JSON.stringify(next.state) ? previous : next.state);
      quietUntil.current = 0;
      if (next.unchanged) return;
      signature.current = next.signature; setData(next); setLoadError('');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setLoadError(message);
      if (notAGitRepository(message)) quietUntil.current = Date.now() + GIT_STATUS_RETRY_MS;
    }
  }, [call, limit, demo]);
  useEffect(() => { signature.current = ''; quietUntil.current = 0; if (!demo) setData(null); setSelected([]); setCollapsed(new Set()); setCompare(null); setFilters(noFilters); }, [props.repoKey]);
  useEffect(() => {
    if (!visible || props.unavailable || demo) return;
    void load(true);
    const timer = setInterval(() => { if (!document.hidden && Date.now() >= quietUntil.current) void load(); }, Math.max(2, settings.diffRefresh) * 1000);
    return () => clearInterval(timer);
  }, [visible, load, settings.diffRefresh, props.unavailable, demo]);
  useEffect(() => {
    if (!filters.paths.length || demo) { setPathHashes(null); return; }
    let live = true;
    call<{ hashes: string[] }>('git/paths', { paths: filters.paths, limit }).then(value => { if (live) setPathHashes(new Set(value.hashes)); }, fail);
    return () => { live = false; };
  }, [filters.paths.join('\n'), limit, data?.signature]);

  // ---- graph ----
  const fullGraph = useMemo(() => data ? buildGraph(data.commits, data.refs) : null, [data]);
  const graph = useMemo(() => !data || !fullGraph ? null : settings.gitFirstParent ? buildGraph(data.commits.map(commit => commit.p.length > 1 ? { ...commit, p: commit.p.slice(0, 1) } : commit), data.refs) : fullGraph, [data, fullGraph, settings.gitFirstParent]);
  const headIndex = data?.head.sha && graph ? graph.index.get(data.head.sha) ?? -1 : -1;
  const refIndex = (name: string) => { if (!data || !graph) return -1; if (name === 'HEAD') return headIndex; const ref = data.refs.find(item => item.name === name); return ref ? graph.index.get(ref.sha) ?? -1 : -1; };
  const visibility = useMemo(() => {
    if (!data || !graph) return null;
    const checks: ((i: number) => boolean)[] = [];
    if (filters.branches.length) {
      const starts = filters.branches.map(refIndex);
      const reach = settings.gitFirstParent ? firstParentReach(graph, starts) : ancestors(graph, starts);
      checks.push(i => reach[i] === 1);
    } else if (settings.gitFirstParent) {
      const reach = firstParentReach(graph, [...data.refs.map(ref => graph.index.get(ref.sha) ?? -1), headIndex]);
      checks.push(i => reach[i] === 1);
    }
    const text = filters.text.trim();
    if (text) {
      let test: (value: string) => boolean;
      if (filters.regex) { try { const pattern = new RegExp(text, filters.matchCase ? '' : 'i'); test = value => pattern.test(value); } catch { test = () => true; } }
      else { const needle = filters.matchCase ? text : text.toLowerCase(); test = value => (filters.matchCase ? value : value.toLowerCase()).includes(needle); }
      const hashLike = /^[0-9a-f]{4,40}$/i.test(text);
      checks.push(i => { const commit = graph.commits[i]; return test(commit.s) || (hashLike && commit.h.startsWith(text.toLowerCase())); });
    }
    if (filters.users.length) {
      const names = new Set(filters.users.flatMap(user => user === '*me' ? [data.me.name, data.me.email] : [user]));
      checks.push(i => names.has(graph.commits[i].an) || names.has(graph.commits[i].ae));
    }
    if (filters.since !== null || filters.until !== null) {
      const since = filters.since ?? -Infinity, until = filters.until ?? Infinity;
      checks.push(i => { const time = settings.gitCommitTime ? graph.commits[i].ct : graph.commits[i].at; return time >= since && time <= until; });
    }
    if (pathHashes) checks.push(i => pathHashes.has(graph.commits[i].h));
    if (settings.gitNoMerges) checks.push(i => data.commits[i].p.length < 2);
    if (collapsed.size) checks.push(i => !collapsed.has(graph.commits[i].h));
    return checks.length ? (i: number) => checks.every(check => check(i)) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, graph, filters, pathHashes, collapsed, settings.gitFirstParent, settings.gitNoMerges, settings.gitCommitTime]);
  const sortType = settings.gitLinear ? 'linear' : settings.gitSort;
  const layout = useMemo(() => {
    if (!graph || !data) return null;
    const view = makeView(graph, visibility), order = sortView(view, graph.commits, sortType);
    return layoutGraph(graph, view, order, {
      showLongEdges: settings.gitLongEdges,
      headPriority: i => headPriority(graph.refsAt.get(graph.commits[i].h), i === headIndex),
      colorOf: head => javaHash(branchColorName(graph.refsAt.get(graph.commits[head].h)))
    });
  }, [graph, data, visibility, sortType, settings.gitLongEdges, headIndex]);
  const palette = useMemo(() => { const cache = new Map<number, string>(); return (id: number) => { if (!cache.has(id)) cache.set(id, graphColor(id, settings.gitSaturation / 100, settings.gitBrightness / 100) ?? 'var(--muted)'); return cache.get(id)!; }; }, [settings.gitSaturation, settings.gitBrightness]);
  const inHead = useMemo(() => fullGraph && data?.head.sha ? ancestors(fullGraph, [fullGraph.index.get(data.head.sha) ?? -1]) : null, [fullGraph, data]);
  const highlightCurrent = settings.gitCurrent && inHead && layout ? Array.from(layout.commitAt).some(i => !inHead[i]) : false;
  const manyAuthors = useMemo(() => data ? new Set(data.commits.slice(0, 2000).map(commit => commit.ae)).size > 1 : false, [data]);
  // pushed: reachable from a remote branch; protected: reachable from a remote branch named in the settings
  const remoteReach = useMemo(() => {
    if (!fullGraph || !data) return { pushed: null as Uint8Array | null, guarded: null as Uint8Array | null };
    const remote = data.refs.filter(ref => ref.kind === 'remote');
    const names = settings.gitProtected.split(/[,\s]+/).filter(Boolean);
    const guarded = remote.filter(ref => names.some(name => ref.name.slice(ref.name.indexOf('/') + 1) === name));
    return { pushed: ancestors(fullGraph, remote.map(ref => fullGraph.index.get(ref.sha) ?? -1)), guarded: ancestors(fullGraph, guarded.map(ref => fullGraph.index.get(ref.sha) ?? -1)) };
  }, [fullGraph, data, settings.gitProtected]);

  // ---- selection and navigation ----
  const rowOfHash = (hash: string) => { const index = graph?.index.get(hash); return index === undefined || !layout ? -1 : layout.rowOf.get(index) ?? -1; };
  const hashAt = (row: number) => graph && layout ? graph.commits[layout.commitAt[row]].h : '';
  const scrollTo = (row: number, center = false) => {
    const box = table.current; if (!box || row < 0) return;
    const top = row * ROW, bottom = top + ROW;
    if (center) box.scrollTop = Math.max(0, top - box.clientHeight / 2);
    else if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  };
  const select = (hash: string, mode: 'set' | 'toggle' | 'range' = 'set') => {
    if (mode === 'toggle') setSelected(list => list.includes(hash) ? list.filter(item => item !== hash) : [...list, hash]);
    else if (mode === 'range' && anchor.current) {
      const a = rowOfHash(anchor.current), b = rowOfHash(hash);
      if (a >= 0 && b >= 0) { const list: string[] = []; for (let row = Math.min(a, b); row <= Math.max(a, b); row++) list.push(hashAt(row)); setSelected(list); }
    } else setSelected([hash]);
    if (mode !== 'range') anchor.current = hash;
    setLead(hash);
  };
  const jump = (hash: string) => {
    const row = rowOfHash(hash);
    if (row < 0) { notify(graph?.index.has(hash) ? '필터 때문에 숨겨진 커밋입니다. 필터를 풀고 다시 시도하세요.' : '불러온 기록에 없는 커밋입니다.', 'warn'); return; }
    select(hash); scrollTo(row, true); table.current?.focus();
  };
  // A first load selects HEAD (IntelliJ opens the log on the current commit).
  useEffect(() => { if (data && !selected.length && data.head.sha && layout) { const row = rowOfHash(data.head.sha); if (row >= 0) { setSelected([data.head.sha]); setLead(data.head.sha); anchor.current = data.head.sha; } } }, [data?.signature, layout]);
  const selectedRows = selected.map(rowOfHash).filter(row => row >= 0).sort((a, b) => a - b);
  const selection = selectedRows.map(row => graph!.commits[layout!.commitAt[row]]);

  // ---- details ----
  const cache = useRef(new Map<string, Details>()), [detailsTick, setDetailsTick] = useState(0);
  useEffect(() => { if (demo) for (const [sha, value] of Object.entries(demo.details)) cache.current.set(sha, value); }, [demo]);
  const wanted = selection.slice(0, 20).map(commit => commit.h);
  useEffect(() => {
    if (!visible || demo) return;
    const missing = wanted.filter(hash => !cache.current.has(hash));
    if (!missing.length) return;
    const timer = setTimeout(() => { void Promise.all(missing.map(sha => call<Details>('git/commit-details', { sha }).then(value => { cache.current.set(sha, value); }, () => {}))).then(() => setDetailsTick(tick => tick + 1)); }, 90);
    return () => clearTimeout(timer);
  }, [wanted.join(','), visible]);
  const [compareFiles, setCompareFiles] = useState<FileChange[] | null>(null);
  useEffect(() => {
    if (!compare || demo) { setCompareFiles(null); return; }
    let live = true; setCompareFiles(null);
    call<{ files: FileChange[] }>('git/compare', { from: compare.from, ...(compare.to ? { to: compare.to } : {}) }).then(value => { if (live) setCompareFiles(value.files); }, cause => { if (live) { fail(cause); setCompare(null); } });
    return () => { live = false; };
  }, [compare]);

  // ---- operations ----
  const changed = () => { void load(true); props.onChanged(); };
  async function op(input: Record<string, unknown>, label: string, success?: string): Promise<OpResult | null> {
    if (demo) { demo.note(`실제 저장소에서는 여기서 ‘${label}’이(가) 실행됩니다.`); return null; }
    setBusy(label);
    try {
      const result = await call<OpResult>('git/op', input);
      setState(result.state);
      if (result.warning) notify(result.warning, 'warn');
      if (result.stopped) {
        if (result.state.conflicts.length) showConflicts(result.state);
        else notify(`${opName(result.state.op)}가 멈췄습니다. 작업을 마친 뒤 위 막대에서 계속하세요.`, 'warn');
      } else if (success) notify(success);
      return result;
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'LOCAL_CHANGES') {
        setDialog(<LocalChangesDialog action={label} files={cause.files ?? []} onClose={() => setDialog(null)} onChoose={mode => { setDialog(null); void op({ ...input, mode }, label, success); }} />);
        return null;
      }
      fail(cause); return null;
    } finally { setBusy(''); changed(); }
  }
  const showConflicts = (current: RepoState) => setDialog(<ConflictsDialog state={current} onClose={() => setDialog(null)}
    onResolve={async (path, side) => { const result = await op({ op: 'resolve', path, side }, '충돌 해결'); if (result) showConflicts(result.state); }}
    onContinue={() => { setDialog(null); void op({ op: 'continue' }, `${opName(current.op)} 계속`); }}
    onAbort={() => { setDialog(null); void op({ op: 'abort' }, `${opName(current.op)} 중단`); }} />);
  const current = data?.refs.find(ref => ref.kind === 'local' && ref.current) ?? null;
  const currentName = current?.name ?? (data?.head.sha ? 'HEAD' : '');
  const refsOf = (hash: string) => graph?.refsAt.get(hash) ?? [];
  const subjectOf = (hash: string) => graph?.commits[graph.index.get(hash) ?? -1]?.s ?? short(hash);
  const branchExists = (name: string) => Boolean(data?.refs.some(ref => ref.kind === 'local' && ref.name === name));
  const newBranch = (from: string, label: string) => setDialog(<BranchDialog from={label} exists={branchExists} onClose={() => setDialog(null)}
    onSubmit={value => { setDialog(null); void op({ op: 'branch-create', from, ...value }, '새 브랜치', value.checkout ? `${value.name} 브랜치를 만들고 체크아웃했습니다.` : `${value.name} 브랜치를 만들었습니다.`); }} />);
  const newTag = (sha: string) => setDialog(<TagDialog target={short(sha)} onClose={() => setDialog(null)} onSubmit={value => { setDialog(null); void op({ op: 'tag-create', sha, ...value }, '새 태그', `${value.name} 태그를 만들었습니다.`); }} />);
  const checkout = (ref: Ref | string) => typeof ref === 'string'
    ? op({ op: 'checkout', ref }, '체크아웃', `${short(ref)}을(를) 체크아웃했습니다. (Detached HEAD)`)
    : op({ op: 'checkout', ref: ref.ref }, '체크아웃', `${ref.kind === 'remote' ? ref.name.slice(ref.name.indexOf('/') + 1) : ref.name}을(를) 체크아웃했습니다.`);
  const deleteBranch = async (ref: Ref) => {
    if (ref.kind === 'remote') {
      if (!(await ask.confirm(`원격 브랜치 ${ref.name}을(를) 삭제할까요?`))) return;
      await op({ op: 'remote-branch-delete', ref: ref.ref }, '원격 브랜치 삭제', `원격 브랜치 ${ref.name}을(를) 삭제했습니다.`); return;
    }
    if (ref.kind === 'tag') { await op({ op: 'tag-delete', name: ref.name }, '태그 삭제', `${ref.name} 태그를 삭제했습니다.`); return; }
    // IntelliJ deletes at once and offers Restore; an unmerged branch is force-deleted with a note that its commits were discarded.
    let unmerged = false;
    let result = await call<OpResult>('git/op', { op: 'branch-delete', name: ref.name }).catch(cause => { if (cause instanceof ApiError && cause.code === 'NOT_MERGED') { unmerged = true; return null; } fail(cause); return undefined; });
    if (result === undefined) return;
    if (unmerged) result = await call<OpResult>('git/op', { op: 'branch-delete', name: ref.name, force: true }).catch(cause => { fail(cause); return null; });
    changed();
    if (!result?.restore) return;
    const { restore } = result, tracked = ref.upstream ? data?.refs.find(item => item.kind === 'remote' && item.name === ref.upstream) : undefined;
    notify(`브랜치 ${ref.name}을(를) 삭제했습니다.${unmerged ? ' 머지되지 않은 커밋이 버려졌습니다.' : ''}`, unmerged ? 'warn' : 'info', [
      { label: '복원', run: () => void op({ op: 'branch-restore', ...restore }, '브랜치 복원', `${restore.name} 브랜치를 복원했습니다.`) },
      ...(unmerged ? [{ label: '커밋 보기', run: () => jump(restore.sha) }] : []),
      ...(tracked ? [{ label: '추적 브랜치도 삭제', run: () => void deleteBranch(tracked) }] : [])
    ]);
  };
  const renameBranch = async (ref: Ref) => {
    const name = await ask.input(`브랜치 ${ref.name}의 새 이름`, ref.name);
    if (name && name.trim() && name.trim() !== ref.name) await op({ op: 'branch-rename', from: ref.name, to: name.trim() }, '이름 바꾸기', `${ref.name} → ${name.trim()}`);
  };
  const outgoing = (localSha: string, upstreamSha: string | null) => {
    if (!fullGraph) return [];
    const local = fullGraph.index.get(localSha) ?? -1, there = upstreamSha ? ancestors(fullGraph, [fullGraph.index.get(upstreamSha) ?? -1]) : remoteReach.pushed;
    const mine = ancestors(fullGraph, [local]), list: Commit[] = [];
    for (let i = 0; i < fullGraph.commits.length && list.length < 200; i++) if (mine[i] && !there?.[i]) list.push(fullGraph.commits[i]);
    return list;
  };
  const push = (branch: Ref | null, upTo?: string) => {
    const local = branch ?? current;
    if (!local) { notify('HEAD가 브랜치에 있지 않아 push할 수 없습니다.', 'warn'); return; }
    const upstream = local.upstream ? data?.refs.find(ref => ref.kind === 'remote' && ref.name === local.upstream) : undefined;
    const remote = data?.remotes.includes('origin') ? 'origin' : data?.remotes[0];
    if (!upstream && !remote) { notify('원격 저장소가 없습니다.', 'warn'); return; }
    const commits = outgoing(upTo ?? local.sha, upstream?.sha ?? null);
    setDialog(<PushDialog source={upTo ? `${short(upTo)} (${local.name})` : local.name} target={local.upstream ?? `${remote}/${local.name}`} newBranch={!upstream} commits={commits.map(commit => ({ sha: commit.h, subject: commit.s }))}
      onClose={() => setDialog(null)} onSubmit={force => { setDialog(null); void op({ op: 'push', branch: local.name, ...(upTo ? { upTo } : {}), force }, 'Push', `${local.upstream ?? `${remote}/${local.name}`}(으)로 push했습니다.`); }} />);
  };
  const update = (ref: Ref | null) => {
    const target = ref ?? current;
    if (!target) return;
    void op({ op: 'update', branch: target.name, method: settings.gitUpdateMethod }, '업데이트', `${target.name}을(를) 업데이트했습니다.`);
  };
  const fetchAll = () => void op({ op: 'fetch', prune: settings.gitFetchPrune }, 'Fetch', '모든 원격 저장소에서 가져왔습니다.');
  const toggleFavorite = (ref: Ref) => set('gitFavorites', settings.gitFavorites.includes(ref.name) ? settings.gitFavorites.filter(name => name !== ref.name) : [...settings.gitFavorites, ref.name]);
  const filterBranch = (name: string) => setFilters(previous => ({ ...previous, branches: previous.branches.length === 1 && previous.branches[0] === name ? [] : [name] }));
  const editable = (commit: Commit, many = false) => {
    if (!fullGraph || !inHead) return '저장소 로딩 중';
    const index = fullGraph.index.get(commit.h) ?? -1;
    if (!current) return 'Detached HEAD';
    if (!inHead[index]) return '현재 브랜치 밖의 커밋';
    if (commit.p.length > 1) return `머지 커밋 · 부모 ${commit.p.length}개`;
    if (remoteReach.guarded?.[index]) return '보호 브랜치에 Push된 커밋';
    if (many) return '';
    return '';
  };
  const confirmRewrite = async (commits: Commit[]) => {
    const pushed = commits.some(commit => remoteReach.pushed?.[fullGraph!.index.get(commit.h) ?? -1]);
    return !pushed || ask.confirm('이미 push된 커밋의 기록을 바꿉니다. 원격에 반영하려면 강제 push가 필요합니다. 계속할까요?');
  };
  const details = async (sha: string): Promise<Details> => { const hit = cache.current.get(sha); if (hit) return hit; const value = await call<Details>('git/commit-details', { sha }); cache.current.set(sha, value); return value; };
  const rangeFrom = (commit: Commit) => {
    // commits from HEAD down to `commit` along the first parent, newest first
    if (!fullGraph || !data?.head.sha) return [];
    const list: Commit[] = [];
    for (let i = fullGraph.index.get(data.head.sha) ?? -1; i >= 0; i = fullGraph.parents[i][0] ?? -1) { list.push(fullGraph.commits[i]); if (fullGraph.commits[i].h === commit.h || list.length > 2000) break; }
    return list[list.length - 1]?.h === commit.h ? list : [];
  };
  const openInBrowser = (sha: string) => {
    const url = Object.values(data?.urls ?? {})[0], match = url && /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
    if (match) window.open(`https://github.com/${match[1]}/${match[2]}/commit/${sha}`, '_blank', 'noopener');
  };
  const browserUrl = Object.values(data?.urls ?? {}).some(url => /github\.com[:/]/.test(url));

  // ---- menus ----
  const branchItems = (ref: Ref): MenuEntry[] => {
    const isCurrent = ref.kind === 'local' && ref.current, other = ref.kind === 'remote' ? ref.name : ref.name;
    if (ref.kind === 'tag') return [
      { label: '체크아웃', icon: 'branch', run: () => void checkout(ref.sha) },
      { label: `'${ref.name}'에서 새 브랜치…`, icon: 'plus', run: () => newBranch(ref.ref, ref.name) },
      'separator', { label: `'${currentName}'에 '${ref.name}' 머지`, icon: 'merge', disabled: !current, run: () => void op({ op: 'merge', ref: ref.ref }, '머지', `${ref.name}을(를) ${currentName}에 머지했습니다.`) },
      'separator', { label: '삭제', icon: 'trash', danger: true, run: () => void deleteBranch(ref) }
    ];
    return [
      !isCurrent && { label: '체크아웃', icon: 'branch', run: () => void checkout(ref) },
      { label: `'${other}'에서 새 브랜치…`, icon: 'plus', run: () => newBranch(ref.ref, ref.name) },
      !isCurrent && ref.kind === 'local' && current && { label: `체크아웃 후 '${currentName}'에 리베이스`, run: () => void op({ op: 'rebase', onto: current.ref, branch: ref.name }, '리베이스', `${ref.name}을(를) ${currentName} 위로 리베이스했습니다.`) },
      'separator',
      !isCurrent && current && { label: `'${currentName}'과(와) 비교`, icon: 'diff', run: () => setCompare({ from: current.ref, to: ref.ref, title: `${currentName} ↔ ${ref.name}` }) },
      { label: '작업 트리와 Diff 보기', icon: 'diff', run: () => setCompare({ from: ref.ref, to: null, title: `${ref.name} ↔ 작업 트리` }) },
      'separator',
      !isCurrent && current && { label: `'${currentName}'을(를) '${other}'에 리베이스`, run: () => void op({ op: 'rebase', onto: ref.ref }, '리베이스', `${currentName}을(를) ${other} 위로 리베이스했습니다.`) },
      !isCurrent && current && { label: `'${other}'을(를) '${currentName}'에 머지`, icon: 'merge', run: () => void op({ op: 'merge', ref: ref.ref }, '머지', `${other}을(를) ${currentName}에 머지했습니다.`) },
      'separator',
      ref.kind === 'local' && { label: '업데이트', icon: 'sync', disabled: !ref.upstream, hint: ref.upstream ? undefined : '원격 브랜치 미연결', run: () => update(ref) },
      ref.kind === 'local' && { label: 'Push…', icon: 'push', run: () => push(ref) },
      'separator',
      ref.kind === 'local' && { label: '이름 바꾸기…', icon: 'edit', run: () => void renameBranch(ref) },
      { label: settings.gitFavorites.includes(ref.name) ? '즐겨찾기 해제' : '즐겨찾기로 표시', icon: 'star', run: () => toggleFavorite(ref) },
      !isCurrent && { label: '삭제', icon: 'trash', danger: true, run: () => void deleteBranch(ref) }
    ];
  };
  const commitItems = (): MenuEntry[] => {
    if (!selection.length || !graph) return [];
    const one = selection.length === 1 ? selection[0] : null;
    const oldestFirst = [...selection].reverse();
    const merges = selection.some(commit => (data?.commits[fullGraph!.index.get(commit.h)!]?.p.length ?? 0) > 1);
    const refsHere = one ? refsOf(one.h) : [];
    const branches = refsHere.filter(ref => ref.kind !== 'tag' && !(ref.kind === 'local' && ref.current)), tags = refsHere.filter(ref => ref.kind === 'tag');
    const isHead = one?.h === data?.head.sha;
    const editProblem = one ? editable(data!.commits[fullGraph!.index.get(one.h)!]) : '커밋 하나 선택 필요';
    const manyProblem = selection.map(commit => editable(data!.commits[fullGraph!.index.get(commit.h)!], true)).find(Boolean) ?? '';
    const children = one ? (fullGraph!.children[fullGraph!.index.get(one.h)!] ?? []).map(i => fullGraph!.commits[i].h) : [];
    const parents = one ? data!.commits[fullGraph!.index.get(one.h)!].p : [];
    return [
      { label: '리비전 번호 복사', icon: 'copy', keys: 'Ctrl+Alt+Shift+C', run: () => copyText(selection.map(commit => commit.h).join(' ')) },
      { label: '패치 만들기 (클립보드로)', icon: 'patch', run: () => { if (demo) { demo.note('실제 저장소에서는 패치가 클립보드로 복사됩니다.'); return; } void call<{ patch: string }>('git/patch', { shas: oldestFirst.map(commit => commit.h) }).then(value => { copyText(value.patch); notify(`커밋 ${selection.length}개의 패치를 복사했습니다.`); }, fail); } },
      { label: '체리픽', icon: 'cherry', disabled: merges || !data?.head.sha, hint: merges ? '머지 커밋 체리픽 불가' : undefined, run: () => void op({ op: 'cherry-pick', shas: oldestFirst.map(commit => commit.h) }, '체리픽', `커밋 ${selection.length}개를 체리픽했습니다.`) },
      'separator',
      one && (branches.length ? { label: '체크아웃', icon: 'branch', items: [...branches.map(ref => ({ label: ref.name, icon: 'branch' as IconName, run: () => void checkout(ref) })), 'separator' as const, { label: `리비전 '${short(one.h)}'`, run: () => void checkout(one.h) }] }
        : { label: `리비전 '${short(one.h)}' 체크아웃`, icon: 'branch', run: () => void checkout(one.h) }),
      selection.length === 2 && { label: '버전 비교', icon: 'diff', run: () => setCompare({ from: oldestFirst[0].h, to: oldestFirst[1].h, title: `${short(oldestFirst[0].h)} ↔ ${short(oldestFirst[1].h)}` }) },
      one && { label: '로컬과 비교', icon: 'diff', run: () => setCompare({ from: one.h, to: null, title: `${short(one.h)} ↔ 작업 트리` }) },
      'separator',
      one && { label: '현재 브랜치를 여기로 리셋…', icon: 'reset', disabled: !data?.head.sha, run: () => setDialog(<ResetDialog branch={currentName} target={short(one.h)} onClose={() => setDialog(null)} onSubmit={mode => { setDialog(null); void op({ op: 'reset', sha: one.h, mode }, '리셋', `${currentName}을(를) ${short(one.h)}(으)로 리셋했습니다. (${mode})`); }} />) },
      { label: selection.length > 1 ? '커밋 되돌리기 (Revert)' : '커밋 되돌리기 (Revert)', icon: 'undo', disabled: merges, run: () => void op({ op: 'revert', shas: selection.map(commit => commit.h) }, '되돌리기', `커밋 ${selection.length}개를 되돌렸습니다.`) },
      one && { label: '커밋 실행 취소…', icon: 'undo', disabled: !isHead, hint: isHead ? '스테이징 유지' : '현재 브랜치의 마지막 커밋만 가능', run: async () => { if (await confirmRewrite([one])) void op({ op: 'undo-commit', sha: one.h }, '커밋 실행 취소', '마지막 커밋을 취소했습니다. 변경은 스테이징되어 있습니다.'); } },
      'separator',
      { label: '커밋 메시지 편집…', icon: 'edit', disabled: Boolean(editProblem), hint: editProblem || undefined, run: async () => {
        if (!one || !(await confirmRewrite([one]))) return;
        const value = await details(one.h).catch(cause => { fail(cause); return null; }); if (!value) return;
        setDialog(<MessageDialog title="커밋 메시지 편집" submit="저장" initial={value.message} onClose={() => setDialog(null)} onSubmit={message => { setDialog(null); void op({ op: 'reword', sha: one.h, message }, '메시지 편집', '커밋 메시지를 고쳤습니다.'); }} />);
      } },
      { label: selection.length > 1 ? '커밋 삭제 (Drop)' : '커밋 삭제 (Drop)', icon: 'trash', disabled: Boolean(manyProblem), hint: manyProblem || undefined, run: async () => {
        if (!(await confirmRewrite(selection))) return;
        if (await ask.confirm(`커밋 ${selection.length}개를 기록에서 지울까요?`)) void op({ op: 'drop', shas: selection.map(commit => commit.h) }, '커밋 삭제', `커밋 ${selection.length}개를 지웠습니다.`);
      } },
      { label: '커밋 스쿼시…', icon: 'merge', disabled: selection.length < 2 || Boolean(manyProblem), hint: selection.length < 2 ? '커밋 두 개 이상 선택 필요' : manyProblem || undefined, run: async () => {
        if (!(await confirmRewrite(selection))) return;
        const messages = await Promise.all(oldestFirst.map(commit => details(commit.h).then(value => value.message, () => commit.s)));
        setDialog(<MessageDialog title={`커밋 ${selection.length}개 스쿼시`} submit="스쿼시" initial={messages.join('\n\n')} onClose={() => setDialog(null)} onSubmit={message => { setDialog(null); void op({ op: 'squash', shas: selection.map(commit => commit.h), message }, '스쿼시', `커밋 ${selection.length}개를 하나로 합쳤습니다.`); }} />);
      } },
      { label: '여기서부터 대화형 리베이스…', icon: 'layers', disabled: Boolean(editProblem), hint: editProblem || undefined, run: async () => {
        if (!one) return;
        const range = rangeFrom(one);
        if (!range.length) { notify('현재 브랜치의 첫 부모 줄에 있는 커밋에서만 시작할 수 있습니다.', 'warn'); return; }
        if (range.some(commit => commit.p.length > 1)) { notify('범위 안에 머지 커밋이 있어 대화형 리베이스를 할 수 없습니다.', 'warn'); return; }
        if (!(await confirmRewrite(range))) return;
        const rows = await Promise.all(range.map(commit => details(commit.h).then(value => ({ sha: commit.h, subject: commit.s, message: value.message }), () => ({ sha: commit.h, subject: commit.s, message: commit.s }))));
        setDialog(<RebaseDialog commits={rows} onto={short(one.p[0] ?? one.h)} onClose={() => setDialog(null)} onSubmit={entries => { setDialog(null); void op({ op: 'rebase-interactive', base: one.h, entries }, '대화형 리베이스', '대화형 리베이스를 마쳤습니다.'); }} />);
      } },
      one && { label: '여기까지 모두 Push…', icon: 'push', disabled: !current || !inHead?.[fullGraph!.index.get(one.h)!] || Boolean(remoteReach.pushed?.[fullGraph!.index.get(one.h)!]), run: () => push(current, one.h) },
      'separator',
      ...(one ? (branches.length > 2 ? [{ label: '브랜치', icon: 'branch' as IconName, items: branches.map(ref => ({ label: ref.name, items: branchItems(ref) })) }]
        : branches.length ? branches.map(ref => ({ label: `브랜치 '${ref.name}'`, icon: 'branch' as IconName, items: branchItems(ref) }))
        : current ? [{ label: `'${currentName}'을(를) 선택한 커밋에 리베이스`, run: () => void op({ op: 'rebase', onto: one.h }, '리베이스', `${currentName}을(를) ${short(one.h)} 위로 리베이스했습니다.`) }] : []) : []),
      ...(one ? (tags.length > 1 ? [{ label: '태그', icon: 'tag' as IconName, items: tags.map(ref => ({ label: ref.name, items: branchItems(ref) })) }] : tags.map(ref => ({ label: `태그 '${ref.name}'`, icon: 'tag' as IconName, items: branchItems(ref) }))) : []),
      one && { label: '새 브랜치…', icon: 'plus', keys: 'Ctrl+Alt+N', run: () => newBranch(one.h, short(one.h)) },
      one && { label: '새 태그…', icon: 'tag', run: () => newTag(one.h) },
      'separator',
      one && { label: '자식 커밋으로 이동', icon: 'arrowUp', disabled: !children.length, run: () => jump(children[0]) },
      one && { label: '부모 커밋으로 이동', icon: 'arrowDown', disabled: !parents.length, run: () => jump(parents[0]) },
      one && browserUrl && 'separator', one && browserUrl && { label: 'GitHub에서 열기', icon: 'externalLink', run: () => openInBrowser(one.h) }
    ];
  };
  const openMenu = (x: number, y: number, name: MenuName, label: string, ref?: Ref) => setMenu({ x, y, name, label, ref });
  const under = (event: React.MouseEvent) => { const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); return [rect.left, rect.bottom + 2] as const; };

  // ---- toolbar menus ----
  const allRefs = data?.refs ?? [];
  const branchFilterMenu = (): MenuEntry[] => {
    const pick = (name: string) => ({ label: name, checked: filters.branches.includes(name), keep: true, run: () => setFilters(previous => ({ ...previous, branches: previous.branches.includes(name) ? previous.branches.filter(item => item !== name) : [...previous.branches, name] })) });
    const local = allRefs.filter(ref => ref.kind === 'local'), remote = allRefs.filter(ref => ref.kind === 'remote'), tags = allRefs.filter(ref => ref.kind === 'tag');
    return [{ label: '모두 보기', checked: !filters.branches.length, run: () => setFilters(previous => ({ ...previous, branches: [] })) }, 'separator', pick('HEAD'),
      local.length > 0 && { header: '로컬' }, ...local.slice(0, 60).map(ref => pick(ref.name)),
      remote.length > 0 && { header: '원격' }, ...remote.slice(0, 60).map(ref => pick(ref.name)),
      tags.length > 0 && { label: '태그', items: tags.slice(0, 80).map(ref => pick(ref.name)) }];
  };
  const userMenu = (): MenuEntry[] => {
    const counts = new Map<string, number>();
    for (const commit of data?.commits ?? []) counts.set(commit.an, (counts.get(commit.an) ?? 0) + 1);
    const names = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name]) => name);
    const pick = (value: string, label: string) => ({ label, checked: filters.users.includes(value), keep: true, run: () => setFilters(previous => ({ ...previous, users: previous.users.includes(value) ? previous.users.filter(item => item !== value) : [...previous.users, value] })) });
    return [{ label: '모두', checked: !filters.users.length, run: () => setFilters(previous => ({ ...previous, users: [] })) }, 'separator', pick('*me', `나 (${data?.me.name || '알 수 없음'})`), 'separator', ...names.map(name => pick(name, name))];
  };
  const dateMenu = (): MenuEntry[] => {
    const now = Date.now() / 1000;
    const range = (since: number | null, until: number | null = null) => () => setFilters(previous => ({ ...previous, since, until }));
    return [{ label: '모두', checked: filters.since === null && filters.until === null, run: range(null) }, 'separator',
      { label: '최근 24시간', run: range(now - 86400) }, { label: '최근 7일', run: range(now - 7 * 86400) },
      { label: '선택…', icon: 'calendar', run: async () => {
        const value = await ask.input('기간 (예: 2026-11-01 ~ 2026-11-18, 한쪽은 비워도 됩니다)', '');
        if (value === null) return;
        const [from, to] = value.split('~').map(part => part.trim());
        const parse = (text: string | undefined, end: boolean) => text ? (Date.parse(`${text}T${end ? '23:59:59' : '00:00:00'}`) / 1000 || null) : null;
        setFilters(previous => ({ ...previous, since: parse(from, false), until: parse(to, true) }));
      } }];
  };
  const pathMenu = (): MenuEntry[] => [{ label: '모두', checked: !filters.paths.length, run: () => setFilters(previous => ({ ...previous, paths: [] })) }, 'separator',
    { label: '경로 선택…', icon: 'folder', run: async () => {
      const value = await ask.input('저장소 기준 경로 (여러 개는 쉼표로)', filters.paths.join(', '));
      if (value !== null) setFilters(previous => ({ ...previous, paths: value.split(',').map(item => item.trim()).filter(Boolean).slice(0, 50) }));
    } }];
  const graphMenu = (): MenuEntry[] => [
    { header: '정렬' },
    { label: '커밋 날짜순', radio: true, checked: settings.gitSort === 'date', hint: '위상 · 커밋 날짜 기준', run: () => set('gitSort', 'date') },
    { label: '위상 정렬', radio: true, checked: settings.gitSort === 'topo', hint: '머지 커밋 아래에 병합된 커밋 우선 표시', run: () => set('gitSort', 'topo') },
    { header: '옵션' },
    { label: '머지 선형화', checked: settings.gitLinear, hint: '메인 브랜치 위에 병합된 커밋 표시', keep: true, run: () => set('gitLinear', !settings.gitLinear) },
    { label: '첫 부모만', checked: settings.gitFirstParent, hint: '머지 커밋의 첫 번째 부모만 표시', keep: true, run: () => set('gitFirstParent', !settings.gitFirstParent) },
    { label: '머지 커밋 숨기기', checked: settings.gitNoMerges, keep: true, run: () => set('gitNoMerges', !settings.gitNoMerges) },
    'separator',
    { label: '선형 브랜치 모두 접기', run: collapseAll },
    { label: '선형 브랜치 모두 펼치기', disabled: !collapsed.size, run: () => setCollapsed(new Set()) }
  ];
  const viewMenu = (): MenuEntry[] => {
    const column = (id: string, label: string) => ({ label, checked: settings.gitColumns.includes(id), keep: true, run: () => set('gitColumns', settings.gitColumns.includes(id) ? settings.gitColumns.filter(item => item !== id) : ['author', 'date', 'hash'].filter(item => item === id || settings.gitColumns.includes(item))) });
    const toggle = (key: 'gitCompactRefs' | 'gitTagNames' | 'gitLongEdges' | 'gitCommitTime' | 'gitRefsLeft' | 'gitMine' | 'gitMerges' | 'gitCurrent' | 'gitBranchesPane' | 'gitDetails' | 'gitDiffPreview', label: string) => ({ label, checked: settings[key], keep: true, run: () => set(key, !settings[key]) });
    return [{ header: '표시' }, toggle('gitCompactRefs', '참조 간결하게 보기'), toggle('gitTagNames', '태그 이름'), toggle('gitLongEdges', '긴 선'), toggle('gitCommitTime', '커밋 시각 (작성 시각 대신)'), toggle('gitRefsLeft', '참조를 왼쪽에'),
      { label: '열', items: [column('author', '작성자'), column('date', '날짜'), column('hash', '해시')] },
      { header: '강조' }, toggle('gitMine', '내 커밋'), toggle('gitMerges', '머지 커밋'), toggle('gitCurrent', '현재 브랜치'),
      { header: '레이아웃' }, toggle('gitBranchesPane', '브랜치 패널'), toggle('gitDetails', '커밋 세부 정보'), toggle('gitDiffPreview', 'Diff 미리 보기')];
  };
  function collapseAll() {
    if (!fullGraph || !data) return;
    const keep = (i: number) => (fullGraph.refsAt.get(fullGraph.commits[i].h)?.length ?? 0) > 0 || fullGraph.commits[i].h === data.head.sha;
    const hide = new Set<string>();
    for (let i = 0; i < fullGraph.commits.length; i++) if (isLinear(fullGraph, i, keep)) hide.add(fullGraph.commits[i].h);
    setCollapsed(hide);
  }

  // ---- edges: hover highlights the linear run, a click folds it (or unfolds a folded one) ----
  const keepNode = useCallback((i: number) => !fullGraph || !data ? true : (fullGraph.refsAt.get(fullGraph.commits[i].h)?.length ?? 0) > 0 || fullGraph.commits[i].h === data.head.sha, [fullGraph, data]);
  const edgeEnds = (edge: number) => {
    const e = layout!.edges[edge], up = layout!.commitAt[e.up], down = e.down >= 0 ? layout!.commitAt[e.down] : -1;
    return { up: fullGraph!.index.get(graph!.commits[up].h)!, down: down >= 0 ? fullGraph!.index.get(graph!.commits[down].h)! : -1, dotted: e.dotted };
  };
  const hoverEdge = (edge: number | null) => {
    if (edge === null || !fullGraph || !layout) { setHover(null); return; }
    const { up, down } = edgeEnds(edge);
    const run = down >= 0 ? linearRun(fullGraph, up, down, keepNode) : [];
    setHover(new Set([up, down, ...run, ...run.flatMap(node => [fullGraph.parents[node][0], ...fullGraph.children[node]])].filter(node => node >= 0)));
  };
  const clickEdge = (edge: number) => {
    if (!fullGraph || !layout) return;
    const { up, down, dotted } = edgeEnds(edge);
    if (down < 0) { if (layout.edges[edge].loose && data?.truncated) setLimit(value => value + 5000); return; }
    if (dotted) {
      const hidden = foldedBetween(fullGraph, up, down).map(i => fullGraph.commits[i].h);
      if (hidden.some(hash => collapsed.has(hash))) { setCollapsed(previous => { const next = new Set(previous); hidden.forEach(hash => next.delete(hash)); return next; }); return; }
    }
    const run = linearRun(fullGraph, up, down, keepNode);
    if (run.length) setCollapsed(previous => new Set([...previous, ...run.map(i => fullGraph.commits[i].h)]));
  };
  const arrowJump = (edge: number, down: boolean) => {
    const e = layout!.edges[edge];
    if (down && e.down < 0) { if (data?.truncated) setLimit(value => value + 5000); return; }
    const row = down ? e.down : e.up; select(hashAt(row)); scrollTo(row, true);
  };

  // ---- keyboard ----
  const onTableKey = (event: React.KeyboardEvent) => {
    if (!layout) return;
    const at = rowOfHash(lead), page = Math.max(1, Math.floor((table.current?.clientHeight ?? ROW * 10) / ROW) - 1);
    const go = (row: number) => { const next = Math.max(0, Math.min(layout.rows - 1, row)); const hash = hashAt(next); select(hash, event.shiftKey ? 'range' : 'set'); scrollTo(next); };
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'PageDown') go(at + page);
    else if (event.key === 'PageUp') go(at - page);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(layout.rows - 1);
    else if (mod && event.key.toLowerCase() === 'a') { const all: string[] = []; for (let row = 0; row < layout.rows; row++) all.push(hashAt(row)); setSelected(all); }
    else if (mod && event.key.toLowerCase() === 'c' && !event.altKey) copyText(selection.map(commit => commit.h).join(' '));
    else if (mod && event.altKey && event.shiftKey && event.code === 'KeyC') copyText(selection.map(commit => commit.h).join(' '));
    else if (mod && event.key.toLowerCase() === 'f') search.current?.focus();
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const box = table.current!.getBoundingClientRect(); openMenu(box.left + 80, box.top + (at + 1) * ROW - table.current!.scrollTop, 'commit', '커밋 메뉴');
    } else return;
    event.preventDefault();
  };

  // ---- virtual rows ----
  const [scroll, setScroll] = useState(0), [viewHeight, setViewHeight] = useState(400);
  useLayoutEffect(() => {
    const box = table.current; if (!box) return;
    const observer = new ResizeObserver(() => setViewHeight(box.clientHeight)); observer.observe(box); setViewHeight(box.clientHeight);
    return () => observer.disconnect();
  }, [data !== null]);
  const first = Math.max(0, Math.floor(scroll / ROW) - 8), last = layout ? Math.min(layout.rows - 1, Math.ceil((scroll + viewHeight) / ROW) + 8) : -1;
  const selectedSet = new Set(selected);
  const columns = settings.gitColumns;
  const rows: ReactNode[] = [];
  if (layout && graph && data) for (let row = first; row <= last; row++) {
    const index = layout.commitAt[row], commit = graph.commits[index], original = data.commits[index];
    const full = fullGraph!.index.get(commit.h)!;
    const refs = refsOf(commit.h), isHeadRow = commit.h === data.head.sha;
    const classes = ['git-row', selectedSet.has(commit.h) ? 'selected' : '', commit.h === lead ? 'lead' : '', highlightCurrent && inHead?.[full] ? 'current' : '', settings.gitMerges && original.p.length > 1 ? 'merge' : '',
      settings.gitMine && manyAuthors && (commit.ae === data.me.email || commit.an === data.me.name) ? 'mine' : ''].filter(Boolean).join(' ');
    const labels = refs.length || (isHeadRow && !current) ? <RefLabels refs={refs} detached={isHeadRow && !current} compact={settings.gitCompactRefs} tagNames={settings.gitTagNames} /> : null;
    const time = settings.gitCommitTime ? commit.ct : commit.at;
    rows.push(<div key={commit.h} className={classes} style={{ top: row * ROW }} role="row" aria-selected={selectedSet.has(commit.h)}
      onMouseDown={event => { if (event.button === 2 && selectedSet.has(commit.h)) return; select(commit.h, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'set'); }}
      onContextMenu={event => { event.preventDefault(); table.current?.focus(); openMenu(event.clientX, event.clientY, 'commit', '커밋 메뉴'); }}>
      <div className="git-cell subject" role="gridcell">
        <GraphCell layout={layout} row={row} color={palette} hover={hover} fullIndex={i => fullGraph!.index.get(graph.commits[layout.commitAt[i]].h)!} isHead={isHeadRow}
          onHoverEdge={hoverEdge} onClickEdge={clickEdge} onArrow={arrowJump} describe={target => { const c = graph.commits[layout.commitAt[target]]; return `${c.s} — ${c.an}, ${absoluteDate(c.at)}`; }} />
        {settings.gitRefsLeft && labels}<span className="git-text" data-tip-overflow="">{commit.s}</span>{!settings.gitRefsLeft && labels}
      </div>
      {columns.includes('author') && <div className="git-cell author" role="gridcell" title={commit.cn ? `작성: ${commit.an} <${commit.ae}>\n커밋: ${commit.cn} <${commit.ce}>` : `${commit.an} <${commit.ae}>`}>{commit.an}{commit.cn && commit.cn !== commit.an ? '*' : ''}</div>}
      {columns.includes('date') && <div className="git-cell date" role="gridcell" title={settings.gitPrettyDate ? absoluteDate(time) : undefined}>{settings.gitPrettyDate ? prettyDate(time) : absoluteDate(time)}</div>}
      {columns.includes('hash') && <div className="git-cell hash" role="gridcell">{short(commit.h)}</div>}
    </div>);
  }

  // ---- details pane content ----
  const one = selection.length === 1 ? selection[0] : null;
  void detailsTick;
  const oneDetails = one ? cache.current.get(one.h) : undefined;
  const files: (FileChange & { spec: string; commit?: string })[] = useMemo(() => {
    if (compare) return (compareFiles ?? []).map(file => ({ ...file, spec: `diff:${compare.from}..${compare.to ?? ''}:${file.path}${file.original ? `\t${file.original}` : ''}` }));
    const map = new Map<string, FileChange & { spec: string; commit?: string }>();
    for (const commit of selection.slice(0, 20)) {
      const value = cache.current.get(commit.h); if (!value) continue;
      for (const file of value.files) if (!map.has(file.path)) map.set(file.path, { ...file, commit: commit.h, spec: `diff:${commit.h}:${file.path}${file.original ? `\t${file.original}` : ''}` });
    }
    return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compare, compareFiles, selection.map(commit => commit.h).join(','), detailsTick]);
  const [fileSel, setFileSel] = useState('');
  const previewSpec = settings.gitDiffPreview ? files.find(file => file.spec === fileSel)?.spec ?? files[0]?.spec ?? '' : '';
  const loadingFiles = compare ? compareFiles === null : selection.slice(0, 20).some(commit => !cache.current.has(commit.h));
  const containing = useMemo(() => one && fullGraph ? containingRefs(fullGraph, fullGraph.index.get(one.h) ?? -1) : [], [one?.h, fullGraph]);
  const [allBranches, setAllBranches] = useState(false);

  // ---- resizing the side panes ----
  const drag = (key: 'gitBranchesWidth' | 'gitDetailsWidth', sign: 1 | -1, min: number, max: number) => (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget, start = event.clientX, base = settings[key], body = handle.parentElement!;
    let width = base;
    handle.setPointerCapture(event.pointerId); document.body.classList.add('resizing');
    const move = (e: PointerEvent) => { width = Math.max(min, Math.min(max, Math.round(base + sign * (e.clientX - start)))); body.style.setProperty(key === 'gitBranchesWidth' ? '--git-branches-w' : '--git-details-w', `${width}px`); };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); set(key, width); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
  };

  const builders: Record<MenuName, () => MenuEntry[]> = {
    commit: commitItems, branchFilter: branchFilterMenu, user: userMenu, date: dateMenu, path: pathMenu, graph: graphMenu, view: viewMenu, branchSettings: () => branchSettingsMenu(),
    branch: () => { const ref = menu?.ref && (allRefs.find(item => item.ref === menu.ref!.ref) ?? menu.ref); return ref ? branchItems(ref) : []; }
  };
  const filterLabel = (base: string, values: string[]) => values.length ? `${base}: ${values.map(value => value === '*me' ? '나' : value).join(', ')}` : base;
  const toolbar = <div className="git-toolbar" role="toolbar" aria-label="로그 필터">
    <div className="git-search">
      <Icon name="search" size={14} />
      <input ref={search} type="search" placeholder="텍스트 또는 해시" value={filters.text} aria-label="텍스트 또는 해시로 필터" onChange={event => setFilters(previous => ({ ...previous, text: event.target.value }))} />
      <IconButton icon="regex" label="정규식으로 검색" pressed={filters.regex} className={filters.regex ? 'on' : ''} onClick={() => setFilters(previous => ({ ...previous, regex: !previous.regex }))} />
      <IconButton icon="matchCase" label="대소문자 구분" pressed={filters.matchCase} className={filters.matchCase ? 'on' : ''} onClick={() => setFilters(previous => ({ ...previous, matchCase: !previous.matchCase }))} />
    </div>
    <button className={`git-filter ${filters.branches.length ? 'on' : ''}`} onClick={event => openMenu(...under(event), 'branchFilter', '브랜치 필터')}>{filterLabel('브랜치', filters.branches)}<Icon name="chevronDown" size={12} /></button>
    <button className={`git-filter ${filters.users.length ? 'on' : ''}`} onClick={event => openMenu(...under(event), 'user', '사용자 필터')}>{filterLabel('사용자', filters.users)}<Icon name="chevronDown" size={12} /></button>
    <button className={`git-filter ${filters.since !== null || filters.until !== null ? 'on' : ''}`} onClick={event => openMenu(...under(event), 'date', '날짜 필터')}>{filters.since !== null || filters.until !== null ? `날짜: ${filters.since ? absoluteDate(filters.since).slice(0, 10) : '…'} ~ ${filters.until ? absoluteDate(filters.until).slice(0, 10) : '…'}` : '날짜'}<Icon name="chevronDown" size={12} /></button>
    <button className={`git-filter ${filters.paths.length ? 'on' : ''}`} onClick={event => openMenu(...under(event), 'path', '경로 필터')}>{filterLabel('경로', filters.paths)}<Icon name="chevronDown" size={12} /></button>
    <span className="git-sep" />
    <IconButton icon="graph" label="그래프 정렬·표시 옵션" dot={settings.gitSort !== 'date' || settings.gitLinear || settings.gitFirstParent || settings.gitNoMerges} onClick={event => openMenu(...under(event), 'graph', '그래프 옵션')} />
    <IconButton icon="refresh" label="기록 새로고침" onClick={() => void load(true)} />
    <IconButton icon="cherry" label="선택한 커밋 체리픽" disabled={!selection.length} onClick={() => { const list = [...selection].reverse(); if (list.some(commit => (data?.commits[fullGraph!.index.get(commit.h)!]?.p.length ?? 0) > 1)) { notify('머지 커밋은 체리픽할 수 없습니다.', 'warn'); return; } void op({ op: 'cherry-pick', shas: list.map(commit => commit.h) }, '체리픽', `커밋 ${list.length}개를 체리픽했습니다.`); }} />
    <IconButton icon="eye" label="열·표시 옵션" onClick={event => openMenu(...under(event), 'view', '보기 옵션')} />
    <IconButton icon="target" label="해시·브랜치·태그로 이동" onClick={async () => {
      const value = (await ask.input('해시, 브랜치 또는 태그로 이동', ''))?.trim(); if (!value || !data) return;
      const ref = data.refs.find(item => item.name === value) ?? data.refs.find(item => item.name.endsWith(`/${value}`));
      const hash = ref?.sha ?? data.commits.find(commit => commit.h.startsWith(value.toLowerCase()))?.h;
      if (hash) jump(hash); else notify(`‘${value}’을(를) 찾지 못했습니다.`, 'warn');
    }} />
  </div>;
  const branchTools = <>
    <IconButton icon="plus" label="새 브랜치" onClick={() => { const ref = allRefs.find(item => item.ref === branchSel); newBranch(ref?.ref ?? data?.head.sha ?? '', ref?.name ?? currentName); }} />
    <IconButton icon="sync" label="선택 항목 업데이트" disabled={!allRefs.find(item => item.ref === branchSel && item.kind === 'local' && item.upstream)} onClick={() => update(allRefs.find(item => item.ref === branchSel) ?? null)} />
    <IconButton icon="trash" label="브랜치 삭제" disabled={!allRefs.find(item => item.ref === branchSel && !item.current)} onClick={() => { const ref = allRefs.find(item => item.ref === branchSel); if (ref) void deleteBranch(ref); }} />
    <IconButton icon="fetch" label="모든 원격 Fetch" disabled={!data?.remotes.length} onClick={fetchAll} />
    <IconButton icon="star" label="즐겨찾기 고정/해제" disabled={!branchSel} onClick={() => { const ref = allRefs.find(item => item.ref === branchSel); if (ref) toggleFavorite(ref); }} />
    <IconButton icon="target" label="브랜치 최신 커밋으로 이동" disabled={!branchSel} onClick={() => { const ref = allRefs.find(item => item.ref === branchSel); if (ref) jump(ref.sha); }} />
    <span className="spacer" />
    <IconButton icon="settings" label="브랜치 패널 설정" onClick={event => openMenu(...under(event), 'branchSettings', '브랜치 패널 설정')} />
  </>;
  const branchSettingsMenu = (): MenuEntry[] => [
      { header: '한 번 클릭하면' }, { label: '브랜치 필터 바꾸기', checked: settings.gitBranchClick === 'filter', keep: true, run: () => set('gitBranchClick', settings.gitBranchClick === 'filter' ? 'none' : 'filter') },
      { label: '브랜치 헤드로 이동', checked: settings.gitBranchClick === 'navigate', keep: true, run: () => set('gitBranchClick', settings.gitBranchClick === 'navigate' ? 'none' : 'navigate') },
      'separator', { label: '폴더로 묶기', checked: settings.gitBranchDirs, keep: true, run: () => set('gitBranchDirs', !settings.gitBranchDirs) },
      { label: '태그 보기', checked: settings.gitBranchTags, keep: true, run: () => set('gitBranchTags', !settings.gitBranchTags) }];

  // A stash that came back with conflicts (smart checkout) leaves conflicts without an operation: only the resolve button applies.
  const opBar = !state.op && state.conflicts.length > 0 ? <div className="git-op-bar" role="status"><Icon name="alert" size={14} /><b>해결하지 않은 충돌</b><span className="warn">{state.conflicts.length}개</span><span className="spacer" /><button onClick={() => showConflicts(state)}>충돌 해결…</button></div>
    : state.op && <div className="git-op-bar" role="status">
    <Icon name="alert" size={14} /><b>{opName(state.op)} 진행 중</b>{state.branch && <span>({state.branch})</span>}{state.conflicts.length > 0 && <span className="warn">충돌 {state.conflicts.length}개</span>}
    <span className="spacer" />
    {state.conflicts.length > 0 && <button onClick={() => showConflicts(state)}>충돌 해결…</button>}
    <button className="primary" disabled={state.conflicts.length > 0} onClick={() => void op({ op: 'continue' }, `${opName(state.op)} 계속`)}>{state.op === 'merge' ? '머지 커밋' : `${opName(state.op)} 계속`}</button>
    {(state.op === 'rebase' || state.op === 'cherry-pick') && <button onClick={() => void op({ op: 'skip' }, '커밋 건너뛰기')}>커밋 건너뛰기</button>}
    <button className="danger" onClick={() => void op({ op: 'abort' }, `${opName(state.op)} 중단`)}>{opName(state.op)} 중단</button>
  </div>;

  const body = props.unavailable ? <div className="git-empty"><Icon name="graph" size={22} /><p>{props.unavailable}</p></div>
    : !data ? <div className="git-empty">{loadError ? <><p className="git-error">{loadError}</p><button onClick={() => void load(true)}>다시 시도</button></> : <p className="hint">기록을 불러오는 중…</p>}</div>
    : <div className="git-body" style={{ '--git-branches-w': `${settings.gitBranchesWidth}px`, '--git-details-w': `${settings.gitDetailsWidth}px` } as React.CSSProperties}>
      {settings.gitBranchesPane && <>
        <BranchesPane refs={data.refs} headBranch={data.head.branch} detached={Boolean(data.head.sha && !data.head.branch)} favorites={settings.gitFavorites} dirs={settings.gitBranchDirs} tags={settings.gitBranchTags} filtered={filters.branches}
          selected={branchSel} toolbar={branchTools}
          onSelect={ref => { setBranchSel(ref.ref); if (settings.gitBranchClick === 'filter') setFilters(previous => ({ ...previous, branches: [ref.name] })); else if (settings.gitBranchClick === 'navigate') jump(ref.sha); }}
          onActivate={ref => filterBranch(ref.name)} onMenu={(ref, x, y) => openMenu(x, y, 'branch', `${ref.name} 메뉴`, ref)} />
        <div className="git-split" role="separator" aria-orientation="vertical" aria-label="브랜치 패널 너비" onPointerDown={drag('gitBranchesWidth', 1, 120, 800)} />
      </>}
      <div className="git-log">
        {toolbar}
        <div className="git-table" ref={table} tabIndex={0} role="grid" aria-label="커밋 기록" aria-rowcount={layout?.rows ?? 0} onKeyDown={onTableKey} onScroll={event => setScroll(event.currentTarget.scrollTop)} onMouseLeave={() => setHover(null)}
          style={{ '--git-cols': `minmax(0, 1fr)${columns.includes('author') ? ' 140px' : ''}${columns.includes('date') ? ' 128px' : ''}${columns.includes('hash') ? ' 76px' : ''}` } as React.CSSProperties}>
          <div className="git-rows" style={{ height: (layout?.rows ?? 0) * ROW + (data.truncated ? 32 : 0) }}>
            {rows}
            {data.truncated && <div className="git-more" style={{ top: (layout?.rows ?? 0) * ROW }}><button onClick={() => setLimit(value => value + 5000)}>커밋 더 불러오기 (지금 {data.commits.length.toLocaleString()}개)</button></div>}
          </div>
          {layout && !layout.rows && <p className="git-none">조건에 맞는 커밋이 없습니다.</p>}
        </div>
      </div>
      <>
        <div className="git-split" role="separator" aria-orientation="vertical" aria-label="세부 정보 패널 너비" onPointerDown={drag('gitDetailsWidth', -1, 200, 1200)} />
        <div className="git-side">
          <div className="git-changes">
            <div className="git-pane-head">
              {compare ? <><Icon name="diff" size={14} /><b title={compare.title}>{compare.title}</b><IconButton icon="x" label="비교 닫기" onClick={() => setCompare(null)} /></>
                : <><b>{selection.length > 1 ? `커밋 ${selection.length}개의 변경` : '변경된 파일'}</b>{files.length > 0 && <small>{files.length}개</small>}</>}
              <span className="spacer" />
              <IconButton icon="folder" label="폴더로 묶기" pressed={settings.gitFilesByDir} className={settings.gitFilesByDir ? 'on' : ''} onClick={() => set('gitFilesByDir', !settings.gitFilesByDir)} />
              <IconButton icon="info" label="커밋 세부 정보 보기" pressed={settings.gitDetails} className={settings.gitDetails ? 'on' : ''} onClick={() => set('gitDetails', !settings.gitDetails)} />
              <IconButton icon="diff" label="Diff 미리 보기" pressed={settings.gitDiffPreview} className={settings.gitDiffPreview ? 'on' : ''} onClick={() => set('gitDiffPreview', !settings.gitDiffPreview)} />
            </div>
            <ChangedFiles files={files} byDir={settings.gitFilesByDir} selected={fileSel} loading={loadingFiles && !files.length} empty={!selection.length && !compare ? '커밋을 선택하세요.' : '변경된 파일이 없습니다.'}
              onSelect={setFileSel} onOpen={spec => demo ? demo.note('실제 앱에서는 편집기 영역의 diff 탭으로 열립니다.') : props.openDiff(spec)} />
          </div>
          {previewSpec && <DiffPreview key={previewSpec} spec={previewSpec} call={call} settings={settings} setSettings={setSettings} demo={Boolean(demo)} />}
          {settings.gitDetails && !compare && selection.length > 0 && <div className="git-details">
            {one ? <CommitDetails commit={one} details={oneDetails} refs={refsOf(one.h)} containing={containing} all={allBranches} onAll={() => setAllBranches(value => !value)} onJump={jump} known={hash => Boolean(graph?.index.has(hash) || data.commits.some(commit => commit.h.startsWith(hash)))} resolve={hash => data.commits.find(commit => commit.h.startsWith(hash))?.h ?? hash} />
              : <div className="git-multi">{selection.length > 50 && <p className="hint">(선택한 커밋 {selection.length}개 중 50개 표시)</p>}{selection.slice(0, 50).map(commit => <div key={commit.h} className="git-multi-row" onClick={() => jump(commit.h)}><code>{short(commit.h)}</code><span>{commit.s}</span><small>{commit.an}</small></div>)}</div>}
          </div>}
        </div>
      </>
    </div>;

  return <section className="git-window" aria-label="Git 로그" data-feedback-region="Git 커밋 그래프" onKeyDown={event => { if (event.key === 'Escape' && event.shiftKey) { event.preventDefault(); props.onClose(); } }}>
    <header className="git-head">
      <Icon name="graph" size={15} /><strong>Git</strong><span className="git-tab">로그</span>
      {props.controls}
      {busy && <span className="git-busy" role="status"><span className="spinner" />{busy}…</span>}
      <span className="spacer" />
      {data && current && <span className="git-head-branch"><Icon name="branch" size={13} />{current.name}{current.ahead ? <small className="out">↑{current.ahead}</small> : null}{current.behind ? <small className="in">↓{current.behind}</small> : null}</span>}
      {data && !current && data.head.sha && <span className="git-head-branch warn"><Icon name="alert" size={13} />Detached HEAD</span>}
      {data && data.remotes.length > 0 && <IconButton icon="fetch" label="원격 변경 가져오기 (Fetch)" onClick={fetchAll} />}
      {data && current?.upstream && <IconButton icon="sync" label={`업데이트 (${settings.gitUpdateMethod === 'rebase' ? '리베이스' : '머지'})`} onClick={() => update(null)} />}
      {data && current && <IconButton icon="push" label="커밋 올리기 (Push)" onClick={() => push(null)} />}
      <IconButton icon="x" tip="none" label="닫기 (Shift+Esc)" onClick={props.onClose} />
    </header>
    {opBar}
    {body}
    {notices.length > 0 && <div className="git-notices">{notices.map(item => <div key={item.id} className={`git-notice ${item.kind}`} role="status">
      <span>{item.text}</span>{item.actions?.map(action => <button key={action.label} onClick={() => { setNotices(list => list.filter(other => other.id !== item.id)); action.run(); }}>{action.label}</button>)}
      <IconButton icon="x" tip="none" label="알림 닫기" onClick={() => setNotices(list => list.filter(other => other.id !== item.id))} /></div>)}</div>}
    {menu && <PopupMenu x={menu.x} y={menu.y} items={closeAll(builders[menu.name](), closeMenu)} label={menu.label} align={menu.align} onClose={closeMenu} />}
    {dialog}
  </section>;
}

// ---- graph cell ----
type GraphCellProps = { layout: Layout; row: number; color(id: number): string; hover: Set<number> | null; fullIndex(row: number): number; isHead: boolean;
  onHoverEdge(edge: number | null): void; onClickEdge(edge: number): void; onArrow(edge: number, down: boolean): void; describe(row: number): string };
const GraphCell = memo(function GraphCell({ layout, row, color, hover, fullIndex, isHead, onHoverEdge, onClickEdge, onArrow, describe }: GraphCellProps) {
  const { segments, arrows } = rowDrawing(layout, row);
  const width = Math.max(1, layout.width[row]) * LANE, mid = ROW / 2, cx = (x: number) => x * LANE + LANE / 2;
  const lit = (edge: number) => { if (!hover) return false; const e = layout.edges[edge]; return hover.has(fullIndex(e.up)) && (e.down < 0 || hover.has(fullIndex(e.down))); };
  const nodeLit = hover?.has(fullIndex(row));
  const dash = (ROW / 2 - 2);
  const head = 0.3 * ROW, ax = head * Math.sqrt(1 - 0.7), ay = head * Math.sqrt(0.7);
  return <svg className="git-graph" width={width} height={ROW} viewBox={`0 0 ${width} ${ROW}`} aria-hidden="true">
    {segments.map((s, i) => {
      const strong = lit(s.edge);
      const props = { x1: cx(s.x1), y1: s.y1 * ROW, x2: cx(s.x2), y2: s.y2 * ROW };
      return <g key={i}>
        {strong && <line {...props} className="git-halo" strokeWidth={4} />}
        <line {...props} stroke={color(s.color)} strokeWidth={strong ? 2.5 : 1.5} strokeLinecap="round" strokeDasharray={s.dotted ? `2 ${dash}` : undefined} />
        <line {...props} className="git-hit" strokeWidth={7} onPointerEnter={() => onHoverEdge(s.edge)} onPointerLeave={() => onHoverEdge(null)} onMouseDown={event => event.stopPropagation()} onClick={() => onClickEdge(s.edge)}>
          <title>{s.dotted ? '접힌 커밋 펼치기' : '이 선형 브랜치 접기'}</title></line>
      </g>;
    })}
    {arrows.map((a, i) => {
      const x = cx(a.x), tip = a.down ? ROW - 1 : 1, base = a.down ? mid : mid;
      const e = layout.edges[a.edge], target = a.down ? e.down : e.up;
      return <g key={`a${i}`} className="git-arrow" onMouseDown={event => event.stopPropagation()} onClick={() => onArrow(a.edge, a.down)}>
        <title>{target >= 0 ? `이동: ${describe(target)}` : '더 오래된 커밋 불러오기'}</title>
        <line x1={x} y1={base} x2={x} y2={tip} stroke={color(a.color)} strokeWidth={1.5} strokeLinecap="round" />
        <polyline points={`${x - ax},${tip + (a.down ? -ay : ay)} ${x},${tip} ${x + ax},${tip + (a.down ? -ay : ay)}`} fill="none" stroke={color(a.color)} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        <rect x={x - 6} y={a.down ? mid : 0} width={12} height={mid} fill="transparent" />
      </g>;
    })}
    {nodeLit && <circle cx={cx(layout.nodeX[row])} cy={mid} r={RADIUS + 2} className="git-halo-fill" />}
    {isHead ? <>
      <circle cx={cx(layout.nodeX[row])} cy={mid} r={RADIUS + 2} fill={color(layout.nodeColor[row])} />
      <circle cx={cx(layout.nodeX[row])} cy={mid} r={RADIUS} className="git-node-hole" />
      <circle cx={cx(layout.nodeX[row])} cy={mid} r={RADIUS / 2} fill={color(layout.nodeColor[row])} />
    </> : <circle cx={cx(layout.nodeX[row])} cy={mid} r={nodeLit ? RADIUS + 1 : RADIUS} fill={color(layout.nodeColor[row])} />}
  </svg>;
}, (a, b) => a.layout === b.layout && a.row === b.row && a.color === b.color && a.hover === b.hover && a.isHead === b.isHead);

// ---- ref labels ----
function RefLabels({ refs, detached, compact, tagNames }: { refs: Ref[]; detached: boolean; compact: boolean; tagNames: boolean }) {
  const groups = refGroups(refs);
  return <span className="git-refs">
    {detached && <span className="git-ref detached"><Icon name="alert" size={12} />Detached HEAD</span>}
    {groups.map(group => {
      const [main] = group, colorOf = (ref: Ref) => ref.kind === 'local' && ref.current ? REF_COLORS.head : REF_COLORS[ref.kind];
      const shown = compact ? [main] : group;
      // A name drawn in full stays out of the tooltip; the tooltip keeps only what the chip does not show: hidden names, clipped names, the HEAD marker and the overflow count.
      const iconOnly = main.kind === 'tag' && !tagNames;
      const lines = group.flatMap((ref, at) => {
        const current = ref.kind === 'local' && ref.current;
        if (!iconOnly && !(compact && at > 0) && clip(ref.name) === ref.name) return current ? ['현재 브랜치 (HEAD)'] : [];
        return [`${ref.name}${current ? ' (HEAD)' : ''}`];
      });
      const tooltip = (lines.join('\n') + (compact && group.length > 1 ? `\n… 외 ${group.length - 1}개 (세부 정보 패널)` : '')) || undefined;
      if (main.kind === 'tag' && !tagNames) return <span key={main.ref} className="git-ref icon-only" title={tooltip}><TagGlyph color={REF_COLORS.tag} /></span>;
      return <span key={main.ref} className={`git-ref ${main.kind} ${main.kind === 'local' && main.current ? 'current' : ''}`} title={tooltip}>
        <span className="git-ref-icons">{group.map(ref => <TagGlyph key={ref.ref} color={colorOf(ref)} />)}</span>
        {shown.map(ref => clip(ref.name)).join(' · ')}
      </span>;
    })}
  </span>;
}

// ---- changed files ----
function ChangedFiles({ files, byDir, selected, loading, empty, onSelect, onOpen }: { files: (FileChange & { spec: string })[]; byDir: boolean; selected: string; loading: boolean; empty: string; onSelect(spec: string): void; onOpen(spec: string): void }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (loading) return <p className="hint git-files-empty">불러오는 중…</p>;
  if (!files.length) return <p className="hint git-files-empty">{empty}</p>;
  const item = (file: FileChange & { spec: string }, depth: number, label: string) => <div key={file.spec} role="treeitem" tabIndex={-1} aria-selected={selected === file.spec} className={`git-file ${selected === file.spec ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}
    title={`${STATUS[file.status] ?? file.status}${file.original ? `\n원래 경로: ${file.original}` : ''}\n더블클릭: diff 열기`} onClick={() => onSelect(file.spec)} onDoubleClick={() => onOpen(file.spec)}>
    <FileIcon name={basename(file.path)} size={14} /><span className={`git-file-name s-${file.status}`}>{label}</span>{!byDir && file.path.includes('/') && <small>{file.path.slice(0, file.path.lastIndexOf('/'))}</small>}{file.original && <small>← {basename(file.original)}</small>}
  </div>;
  const onKey = (event: React.KeyboardEvent) => {
    const at = files.findIndex(file => file.spec === selected);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = files[Math.max(0, Math.min(files.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]; if (next) onSelect(next.spec); }
    else if (event.key === 'Enter' && at >= 0) { event.preventDefault(); onOpen(files[at].spec); }
  };
  if (!byDir) return <div className="git-files" role="tree" tabIndex={0} onKeyDown={onKey}>{files.map(file => item(file, 0, basename(file.path)))}</div>;
  // folders: one level per distinct directory path, as IntelliJ's "Group by Directory"
  const dirs = new Map<string, (FileChange & { spec: string })[]>();
  for (const file of files) { const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''; dirs.set(dir, [...(dirs.get(dir) ?? []), file]); }
  return <div className="git-files" role="tree" tabIndex={0} onKeyDown={onKey}>{[...dirs].sort(([a], [b]) => a.localeCompare(b)).flatMap(([dir, list]) => [
    dir ? <div key={`d:${dir}`} className="git-file-dir" onClick={() => setClosed(previous => { const next = new Set(previous); if (!next.delete(dir)) next.add(dir); return next; })}>
      <Icon name={closed.has(dir) ? 'chevronRight' : 'chevronDown'} size={13} /><Icon name="folder" size={13} />{dir}<small>{list.length}</small></div> : null,
    ...(closed.has(dir) ? [] : list.map(file => item(file, dir ? 1 : 0, basename(file.path))))
  ])}</div>;
}

// The diff of one changed file, beside the list ("Show Diff Preview").
function DiffPreview({ spec, call, settings, setSettings, demo }: { spec: string; call: Call; settings: Settings; setSettings: GitLogProps['setSettings']; demo: boolean }) {
  const [value, setValue] = useState<{ original: string; modified: string; note: string } | null>(null), [error, setError] = useState('');
  useEffect(() => { if (demo) { setValue({ original: 'const port = 3000;\n', modified: 'const port = Number(process.env.PORT ?? 3000);\n', note: '' }); return; } let live = true; loadSpec(call, spec).then(next => { if (live) setValue(next); }, cause => { if (live) setError(String(cause?.message ?? cause)); }); return () => { live = false; }; }, [spec]);
  const path = spec.replace(/^diff:[^:]*:/, '').split('\t')[0];
  return <div className="git-preview">{error ? <p className="git-error">{error}</p> : !value ? <p className="hint">불러오는 중…</p> : value.note && value.original === value.modified ? <p className="hint">{value.note}</p>
    : <DiffView original={value.original} modified={value.modified} path={path} settings={settings} onLayoutChange={diffLayout => setSettings(previous => ({ ...previous, diffLayout }))} />}</div>;
}

// ---- details ----
function CommitDetails({ commit, details, refs, containing, all, onAll, onJump, known, resolve }: { commit: Commit; details?: Details; refs: Ref[]; containing: Ref[]; all: boolean; onAll(): void; onJump(hash: string): void; known(hash: string): boolean; resolve(hash: string): string }) {
  const message = details?.message ?? commit.s;
  const linked = message.split(/(\b[0-9a-f]{7,40}\b)/g).map((part, i) => i % 2 && known(part) ? <a key={i} href="#" onClick={event => { event.preventDefault(); onJump(resolve(part)); }}>{part}</a> : part);
  const when = (seconds: number) => absoluteDate(seconds);
  const names = [...new Set(containing.map(ref => ref.name))].sort((a, b) => a.localeCompare(b));
  return <div className="git-commit">
    <div className="git-message">{linked}</div>
    <p className="git-meta"><a href="#" title="해시 복사" onClick={event => { event.preventDefault(); copyText(commit.h); }}><code>{short(commit.h)}</code></a> {commit.an} &lt;{commit.ae}&gt;, {when(commit.at)}</p>
    {details && (details.committer !== details.author || details.committerEmail !== details.email || details.commitTime !== details.authorTime) && <p className="git-meta muted">커밋: {details.committer} &lt;{details.committerEmail}&gt;, {when(details.commitTime)}</p>}
    {details && details.parents.length > 1 && <p className="git-meta muted">부모: {details.parents.map(parent => <a key={parent} href="#" onClick={event => { event.preventDefault(); onJump(parent); }}><code>{short(parent)}</code> </a>)}</p>}
    {refs.length > 0 && <p className="git-meta"><RefLabels refs={refs} detached={false} compact={false} tagNames /></p>}
    <p className="git-meta muted">{names.length ? <>브랜치 {names.length}개에 포함: {(all ? names : names.slice(0, 6)).join(', ')}{names.length > 6 && <> <a href="#" onClick={event => { event.preventDefault(); onAll(); }}>{all ? '접기' : '모두 보기'}</a></>}</> : '어느 브랜치에도 없음'}</p>
  </div>;
}
