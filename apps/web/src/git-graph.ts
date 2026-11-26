// The commit graph of the Git tool window, laid out the way IntelliJ's VCS log does it:
// - every commit gets a "layout index": a depth-first walk from the branch heads (first parent first) gives each new path the next
//   index, so a branch keeps one index along its first-parent line;
// - in each row the node and the edges passing through it are ordered by layout index (an edge uses the larger index of its two ends),
//   which keeps the main line on the left and every branch in a stable column;
// - edges are straight segments from row centre to row centre; an edge 30 rows or longer is cut to short arrows unless long edges are shown;
// - a branch's colour comes from the name of the ref at its head, so a branch keeps its colour across refreshes.
// Pure functions only (no React, no DOM), so the layout can be tested in Node.
import { parseTurnRevision } from './turn-changes.ts';

export type Commit = { h: string; p: string[]; an: string; ae: string; at: number; ct: number; s: string; cn?: string; ce?: string };
export type RefKind = 'local' | 'remote' | 'tag';
export type Ref = { ref: string; name: string; kind: RefKind; sha: string; current?: boolean; upstream?: string; ahead?: number; behind?: number; gone?: boolean };
export type SortType = 'date' | 'topo' | 'linear';
export type RepoState = { op: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null; conflicts: string[]; branch?: string };
export type LogData = { signature: string; head: { sha: string | null; branch: string | null }; refs: Ref[]; commits: Commit[]; truncated: boolean; limit: number; state: RepoState; me: { name: string; email: string }; remotes: string[]; urls: Record<string, string> };

// PrintElementGeneratorImpl: with "Long Edges" off an edge of 30+ rows shows only its row next to each end; with it on, only edges of
// 1000+ rows are cut, keeping 250 rows at each end.
export const LONG_EDGE = 30, LONG_EDGE_VISIBLE = 1, VERY_LONG_EDGE = 1000, VERY_LONG_EDGE_VISIBLE = 250;
const TRUNK = ['main', 'master'];

// ---- the graph over the loaded commits ----
export type Graph = {
  commits: Commit[];
  index: Map<string, number>;
  // parents by commit index; -1 marks a parent that is not loaded (beyond the limit)
  parents: number[][];
  children: number[][];
  refsAt: Map<string, Ref[]>;
};
export function buildGraph(commits: Commit[], refs: Ref[]): Graph {
  const index = new Map<string, number>();
  commits.forEach((commit, i) => index.set(commit.h, i));
  const parents = commits.map(commit => commit.p.map(hash => index.get(hash) ?? -1));
  const children: number[][] = commits.map(() => []);
  parents.forEach((list, child) => list.forEach(parent => { if (parent >= 0 && !children[parent].includes(child)) children[parent].push(child); }));
  const refsAt = new Map<string, Ref[]>();
  for (const ref of refs) { const list = refsAt.get(ref.sha); if (list) list.push(ref); else refsAt.set(ref.sha, [ref]); }
  return { commits, index, parents, children, refsAt };
}

// Commits reachable from the given commit indices (the branch filter, "In N branches").
export function ancestors(graph: Graph, starts: number[]): Uint8Array {
  const seen = new Uint8Array(graph.commits.length), stack = starts.filter(i => i >= 0);
  for (const start of stack) seen[start] = 1;
  while (stack.length) {
    const node = stack.pop()!;
    for (const parent of graph.parents[node]) if (parent >= 0 && !seen[parent]) { seen[parent] = 1; stack.push(parent); }
  }
  return seen;
}
// The refs whose history contains the commit: walk up through the children and collect the refs met on the way.
export function containingRefs(graph: Graph, commit: number): Ref[] {
  const seen = new Uint8Array(graph.commits.length), stack = [commit], found: Ref[] = [];
  seen[commit] = 1;
  while (stack.length) {
    const node = stack.pop()!;
    for (const ref of graph.refsAt.get(graph.commits[node].h) ?? []) if (ref.kind !== 'tag') found.push(ref);
    for (const child of graph.children[node]) if (!seen[child]) { seen[child] = 1; stack.push(child); }
  }
  return found;
}

// ---- the view: the visible commits (after filters) with their edges ----
export type View = {
  ids: number[];            // graph commit index per view node
  parents: number[][];      // view node indices; -1 = not loaded
  dotted: boolean[][];      // an edge that skips hidden commits (a filter is on)
};
// With a filter, hidden commits drop out and each visible commit links to its nearest visible ancestors with a dotted edge, as IntelliJ does.
export function makeView(graph: Graph, visible: ((i: number) => boolean) | null): View {
  const n = graph.commits.length;
  if (!visible) return { ids: Array.from({ length: n }, (_, i) => i), parents: graph.parents.map(list => list.slice()), dotted: graph.parents.map(list => list.map(() => false)) };
  const ids: number[] = [], position = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (visible(i)) { position[i] = ids.length; ids.push(i); }
  // nearest visible ancestors of a hidden commit, computed oldest first (parents come after children in the loaded order)
  const near: (number[] | null)[] = new Array(n).fill(null);
  const CAP = 6;
  const reach = (i: number): number[] => {
    if (near[i]) return near[i]!;
    const found: number[] = [];
    for (const parent of graph.parents[i]) {
      if (parent < 0) { if (!found.includes(-1)) found.push(-1); continue; }
      const list = position[parent] >= 0 ? [parent] : (near[parent] ?? []);
      for (const item of list) if (!found.includes(item) && found.length < CAP) found.push(item);
    }
    near[i] = found;
    return found;
  };
  for (let i = n - 1; i >= 0; i--) if (position[i] < 0) reach(i);
  const parents: number[][] = [], dotted: boolean[][] = [];
  for (const id of ids) {
    const list: number[] = [], dots: boolean[] = [];
    for (const parent of graph.parents[id]) {
      if (parent < 0) { if (!list.includes(-1)) { list.push(-1); dots.push(false); } continue; }
      if (position[parent] >= 0) { if (!list.includes(position[parent])) { list.push(position[parent]); dots.push(false); } continue; }
      for (const far of near[parent] ?? []) {
        const target = far < 0 ? -1 : position[far];
        if (!list.includes(target)) { list.push(target); dots.push(true); }
      }
    }
    parents.push(list); dotted.push(dots);
  }
  return { ids, parents, dotted };
}

// "First Parent": only the first-parent lines from the heads.
export function firstParentReach(graph: Graph, starts: number[]): Uint8Array {
  const seen = new Uint8Array(graph.commits.length);
  for (let node of starts) while (node >= 0 && !seen[node]) { seen[node] = 1; node = graph.parents[node][0] ?? -1; }
  return seen;
}
// Linear branches: a run of commits with one parent and one child each (and no ref on them) can fold into one dashed edge.
export const isLinear = (graph: Graph, node: number, keep: (node: number) => boolean) =>
  graph.parents[node].length === 1 && graph.parents[node][0] >= 0 && graph.children[node].length === 1 && !keep(node);
// The foldable commits of the run that an edge (child → parent) belongs to.
export function linearRun(graph: Graph, up: number, down: number, keep: (node: number) => boolean): number[] {
  const run: number[] = [];
  for (let node = up; node >= 0 && isLinear(graph, node, keep); node = graph.children[node][0]) run.push(node);
  for (let node = down; node >= 0 && isLinear(graph, node, keep); node = graph.parents[node][0]) run.push(node);
  return run;
}
// The commits a folded edge hides: from the child's parent down the single line to the parent.
export function foldedBetween(graph: Graph, up: number, down: number): number[] {
  const hidden: number[] = [];
  for (let node = graph.parents[up][0] ?? -1; node >= 0 && node !== down && hidden.length < 100_000; node = graph.parents[node][0] ?? -1) hidden.push(node);
  return hidden;
}

// ---- sorting (IntelliSort) ----
// date ("By Commit Date", IntelliJ's default): by date, children before parents (the order git gives with --date-order).
// topo ("Topologically"): a merged branch's commits come right below the merge commit, before the main line continues.
// linear ("Linearize Merges"): like topo, but a merged branch's commits are kept above the main-line commits made while the branch was open, as if it had been rebased.
export function sortView(view: View, commits: Commit[], type: SortType): number[] {
  const n = view.ids.length;
  if (type === 'date' || n < 2) return Array.from({ length: n }, (_, i) => i);
  const pending = new Int32Array(n);
  for (let i = 0; i < n; i++) for (const parent of view.parents[i]) if (parent >= 0) pending[parent]++;
  const time = (i: number) => commits[view.ids[i]].ct;
  // ready commits that are not inside a merged branch, newest first (a max-heap keyed by commit time, then load order)
  const heap: number[] = [];
  const better = (a: number, b: number) => time(a) > time(b) || (time(a) === time(b) && a < b);
  const push = (value: number) => { heap.push(value); let i = heap.length - 1; while (i > 0) { const up = (i - 1) >> 1; if (!better(heap[i], heap[up])) break; [heap[i], heap[up]] = [heap[up], heap[i]]; i = up; } };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && better(heap[l], heap[m])) m = l; if (r < heap.length && better(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } }
    return top;
  };
  for (let i = 0; i < n; i++) if (!pending[i]) push(i);
  const stack: number[] = [], order: number[] = [], inBranch = new Uint8Array(n);
  const linear = type === 'linear';
  // linear: the main-line parent of a merge waits until the merged branch has been laid out
  const held = new Map<number, number>();
  while (heap.length || stack.length) {
    const node = stack.length ? stack.pop()! : pop();
    order.push(node);
    const list = view.parents[node];
    const nested = inBranch[node];
    // non-first parents (the merged branches) go on the stack, the first one ends up on top; the first parent continues the
    // current line: on the stack inside a merged branch, by date otherwise.
    for (let k = list.length - 1; k >= 0; k--) {
      const parent = list[k];
      if (parent < 0) continue;
      if (--pending[parent]) continue;
      if (k > 0) { inBranch[parent] = 1; stack.push(parent); }
      else if (nested) { inBranch[parent] = 1; stack.push(parent); }
      else if (linear && list.length > 1) held.set(parent, node);
      else push(parent);
    }
    // a held first parent is released once the merged branch above it is done (the stack has emptied)
    if (linear && !stack.length && held.size) { for (const parent of held.keys()) push(parent); held.clear(); }
  }
  // Anything left (a cycle cannot happen, but a broken input should not lose commits) goes last in load order.
  if (order.length < n) { const placed = new Uint8Array(n); order.forEach(i => { placed[i] = 1; }); for (let i = 0; i < n; i++) if (!placed[i]) order.push(i); }
  return order;
}

// ---- layout ----
export type Edge = { up: number; down: number; key: number; color: number; dotted: boolean; xs: Int16Array; loose: boolean };
export type Layout = {
  rows: number;                // number of rows
  commitAt: Int32Array;        // row -> graph commit index
  rowOf: Map<number, number>;  // graph commit index -> row
  nodeX: Int16Array;           // row -> node column
  nodeColor: Int16Array;       // row -> colour index
  nodeKey: Int32Array;         // row -> layout index (for hover highlighting)
  edges: Edge[];
  touching: number[][];        // row -> edges drawn in it
  width: Int16Array;           // row -> columns used (incl. neighbours' half segments)
  maxWidth: number;
};
export type LayoutOptions = { showLongEdges: boolean; headPriority?: (commit: number) => number; colorOf?: (headCommit: number, layoutIndex: number) => number };

export function layoutGraph(graph: Graph, view: View, order: number[], options: LayoutOptions): Layout {
  const rows = order.length;
  const rowOfNode = new Int32Array(view.ids.length).fill(-1);
  order.forEach((node, row) => { rowOfNode[node] = row; });
  const commitAt = new Int32Array(rows), rowOf = new Map<number, number>();
  order.forEach((node, row) => { commitAt[row] = view.ids[node]; rowOf.set(view.ids[node], row); });
  // layout indices: depth-first from the heads (rows with no visible child), heads in priority order
  const hasChild = new Uint8Array(view.ids.length);
  view.parents.forEach(list => list.forEach(parent => { if (parent >= 0) hasChild[parent] = 1; }));
  const heads = order.filter(node => !hasChild[node]);
  const priority = options.headPriority ?? (() => 0);
  heads.sort((a, b) => priority(view.ids[a]) - priority(view.ids[b]) || rowOfNode[a] - rowOfNode[b]);
  const layoutIndex = new Int32Array(view.ids.length);
  const fragmentHead: number[] = [0], fragmentRoot: number[] = [0];
  // IntelliJ's GraphLayoutBuilder: one running index; a node visited for the first time takes it, and a first visit that finds no
  // unvisited parent ends the path (the index moves on). The walk then backtracks to the nearest node with an unvisited parent.
  let current = 1;
  const walk = (start: number) => {
    if (layoutIndex[start]) return;
    const stack = [start];
    while (stack.length) {
      const node = stack[stack.length - 1];
      const first = !layoutIndex[node];
      if (first) {
        if (fragmentHead[current] === undefined) { fragmentHead[current] = node; fragmentRoot[current] = start; }
        layoutIndex[node] = current;
      }
      const down = view.parents[node].find(parent => parent >= 0 && !layoutIndex[parent]);
      if (down === undefined) { stack.pop(); if (first) current++; continue; }
      stack.push(down);
    }
  };
  for (const head of heads) walk(head);
  for (const node of order) walk(node);
  // GraphColorManagerImpl: the fragment that starts at a head (the head's own path) is coloured by the head's ref name; any other
  // fragment by its layout index.
  const colorOf = options.colorOf ?? ((_head: number, index: number) => index);
  const colors = fragmentHead.map((head, index) => !index || head === undefined ? 0 : head === fragmentRoot[index] && !hasChild[head] ? colorOf(view.ids[head], index) : index);
  // edges
  const edges: Edge[] = [];
  for (let row = 0; row < rows; row++) {
    const node = order[row], list = view.parents[node];
    list.forEach((parent, k) => {
      const down = parent < 0 ? Infinity : rowOfNode[parent];
      const key = parent < 0 ? layoutIndex[node] : Math.max(layoutIndex[node], layoutIndex[parent]);
      const last = Math.min(down, rows - 1 + (parent < 0 ? 1 : 0));
      const span = (parent < 0 ? Math.min(rows, last) : down) - row;
      edges.push({ up: row, down: parent < 0 ? -1 : down, key, color: colors[key], dotted: view.dotted[node][k], xs: new Int16Array(Math.max(1, span + 1)).fill(-1), loose: parent < 0 });
    });
  }
  // which edges occupy a column in each row (passing through it); a cut long edge only near its ends
  const passing: number[][] = Array.from({ length: rows }, () => []);
  const [limit, keep] = options.showLongEdges ? [VERY_LONG_EDGE, VERY_LONG_EDGE_VISIBLE] : [LONG_EDGE, LONG_EDGE_VISIBLE];
  edges.forEach((edge, id) => {
    const end = edge.loose ? rows : edge.down;
    const cut = end - edge.up >= limit;
    for (let row = edge.up + 1; row < end && row < rows; row++) {
      if (cut && row > edge.up + keep && (edge.loose || row < end - keep)) continue;
      passing[row].push(id);
    }
  });
  const nodeX = new Int16Array(rows), nodeColor = new Int16Array(rows), nodeKey = new Int32Array(rows), width = new Int16Array(rows);
  const touching: number[][] = Array.from({ length: rows }, () => []);
  let maxWidth = 1;
  for (let row = 0; row < rows; row++) {
    const node = order[row], key = layoutIndex[node];
    // elements: the node (-1) and the passing edges, by layout index; edges before a node of the same index (a long edge to an already
    // walked parent keeps its column straight, the merged branch's commits go beside it); edges by their ends
    const elements = [-1, ...passing[row]];
    elements.sort((a, b) => {
      const ka = a < 0 ? key : edges[a].key, kb = b < 0 ? key : edges[b].key;
      if (ka !== kb) return ka - kb;
      if (a < 0) return 1; if (b < 0) return -1;
      return edges[a].up - edges[b].up || (edges[a].down < 0 ? Infinity : edges[a].down) - (edges[b].down < 0 ? Infinity : edges[b].down);
    });
    elements.forEach((element, x) => {
      if (element < 0) { nodeX[row] = x; return; }
      const edge = edges[element];
      edge.xs[row - edge.up] = x;
    });
    nodeKey[row] = key; nodeColor[row] = colors[key];
    width[row] = elements.length;
    if (elements.length > maxWidth) maxWidth = elements.length;
  }
  // ends: an edge starts at its upper node and ends at its lower node
  edges.forEach((edge, id) => {
    edge.xs[0] = nodeX[edge.up];
    if (edge.down >= 0) edge.xs[edge.down - edge.up] = nodeX[edge.down];
    for (let i = 0; i < edge.xs.length; i++) if (edge.xs[i] >= 0 && edge.up + i < rows) touching[edge.up + i].push(id);
  });
  // a row draws half segments toward its neighbours, so it is as wide as the widest of the three
  const drawn = new Int16Array(rows);
  for (let row = 0; row < rows; row++) drawn[row] = Math.max(width[row], row > 0 ? width[row - 1] : 0, row + 1 < rows ? width[row + 1] : 0);
  return { rows, commitAt, rowOf, nodeX, nodeColor, nodeKey, edges, touching, width: drawn, maxWidth };
}

// What one row draws: segments in row-local coordinates (column units; y 0 = top, 0.5 = centre, 1 = bottom) and arrow stubs.
export type Segment = { x1: number; y1: number; x2: number; y2: number; color: number; dotted: boolean; key: number; edge: number };
export type Arrow = { x: number; down: boolean; color: number; edge: number; key: number };
export function rowDrawing(layout: Layout, row: number): { segments: Segment[]; arrows: Arrow[] } {
  const segments: Segment[] = [], arrows: Arrow[] = [];
  for (const id of layout.touching[row]) {
    const edge = layout.edges[id], at = row - edge.up, x = edge.xs[at];
    if (x < 0) continue;
    const prev = at > 0 ? edge.xs[at - 1] : -1, next = at + 1 < edge.xs.length ? edge.xs[at + 1] : -1;
    const isUp = at === 0, isDown = edge.down >= 0 && row === edge.down;
    if (!isUp && prev >= 0) segments.push({ x1: (prev + x) / 2, y1: 0, x2: x, y2: 0.5, color: edge.color, dotted: edge.dotted, key: edge.key, edge: id });
    if (!isDown && next >= 0 && row + 1 < layout.rows) segments.push({ x1: x, y1: 0.5, x2: (x + next) / 2, y2: 1, color: edge.color, dotted: edge.dotted, key: edge.key, edge: id });
    // a cut edge: the visible stub ends in an arrow pointing the way it continues
    if (!isDown && next < 0 && !isUp) arrows.push({ x, down: true, color: edge.color, edge: id, key: edge.key });
    if (!isUp && prev < 0 && !isDown) arrows.push({ x, down: false, color: edge.color, edge: id, key: edge.key });
    if (isUp && !isDown && next < 0 && row + 1 < layout.rows && edge.xs.length > 1) arrows.push({ x, down: true, color: edge.color, edge: id, key: edge.key });
    // the last loaded row: an edge that goes on past it points down
    if (row + 1 === layout.rows && !isDown && (edge.loose || edge.down > row)) arrows.push({ x, down: true, color: edge.color, edge: id, key: edge.key });
  }
  return { segments, arrows };
}

// ---- colours ----
// Java's String.hashCode, which IntelliJ feeds to its colour generator for a branch's name.
export function javaHash(name: string) {
  let value = 0;
  for (let i = 0; i < name.length; i++) value = (Math.imul(value, 31) + name.charCodeAt(i)) | 0;
  return value;
}
// A colour per id: the hue steps by the golden angle, so consecutive ids (neighbouring lanes) and unrelated ids (branch names hashed by
// javaHash) land far apart on the wheel; saturation and brightness are the settings. Id 0 has no colour of its own (null: the UI uses the muted text colour).
export function graphColor(id: number, saturation = 0.6, brightness = 0.85): string | null {
  if (id === 0) return null;
  const hue = (((id * 137.508) % 360) + 360) % 360;
  const c = brightness * saturation, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = brightness - c;
  const [rr, gg, bb] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(rr)}${hex(gg)}${hex(bb)}`;
}
// HeadCommitsComparator: heads with refs first, by their best ref: origin/main|master, remote branches, main|master, local branches,
// tags, the current branch, HEAD; heads without refs last.
export function headPriority(refs: Ref[] | undefined, isHead: boolean) {
  let best = isHead ? 6 : 7;
  for (const ref of refs ?? []) {
    const p = ref.kind === 'remote' ? (ref.name.startsWith('origin/') && TRUNK.includes(ref.name.slice(7)) ? 0 : 1)
      : ref.kind === 'local' ? (ref.current ? 5 : TRUNK.includes(ref.name) ? 2 : 3) : 4;
    if (p < best) best = p;
  }
  return best;
}
// The name a head is coloured by: its first ref in label order (current branch, main/master, origin/main, local, remote).
export function branchColorName(refs: Ref[] | undefined) {
  return sortRefs(refs?.filter(ref => ref.kind !== 'tag') ?? [])[0]?.name ?? '';
}
// Label order (GitRefManager): current branch, main/master, origin/main|master, local branches, remote branches, tags; then by name.
export function refRank(ref: Ref) {
  if (ref.kind === 'local') return ref.current ? 0 : TRUNK.includes(ref.name) ? 1 : 3;
  if (ref.kind === 'remote') return ref.name.startsWith('origin/') && TRUNK.includes(ref.name.slice(7)) ? 2 : 4;
  return 5;
}
export const sortRefs = (refs: Ref[]) => [...refs].sort((a, b) => refRank(a) - refRank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
// Labels of one commit, grouped like IntelliJ: a local branch and the remote branch it tracks are one group.
export function refGroups(refs: Ref[]): Ref[][] {
  const sorted = sortRefs(refs), used = new Set<Ref>(), groups: Ref[][] = [];
  for (const ref of sorted) {
    if (used.has(ref)) continue;
    used.add(ref);
    const group = [ref];
    if (ref.kind === 'local' && ref.upstream) {
      const tracked = sorted.find(other => other.kind === 'remote' && other.name === ref.upstream && !used.has(other));
      if (tracked) { used.add(tracked); group.push(tracked); }
    }
    groups.push(group);
  }
  return groups;
}

// ---- dates ----
// DateFormatUtil.formatPrettyDateTime: moments/minutes ago within the hour, then today/yesterday with the time, then the full date.
export function prettyDate(seconds: number, now = Date.now()) {
  const date = new Date(seconds * 1000), today = new Date(now), ago = now - date.getTime();
  if (ago >= 0 && ago < 61 * 60_000) {
    const minutes = Math.floor(ago / 60_000);
    return minutes < 1 ? '방금 전' : minutes < 60 ? `${minutes}분 전` : '1시간 전';
  }
  const time = date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = Math.round((day(today) - day(date)) / 86_400_000);
  if (diff === 0) return `오늘 ${time}`;
  if (diff === 1) return `어제 ${time}`;
  return absoluteDate(seconds);
}
export function absoluteDate(seconds: number) {
  const date = new Date(seconds * 1000), pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---- diff tabs ----
export type Call = <T = any>(action: string, input?: object) => Promise<T>;
// `diff:<revision>:<path>[<TAB><old path>]`: a commit against its first parent, `a..b` between two commits, `a..` against the working tree.
export async function loadSpec(call: Call, spec: string) {
  const match = /^diff:([^:]*):(.*)$/s.exec(spec);
  if (!match) throw new Error('알 수 없는 diff입니다.');
  const [, rev, rest] = match, [path, original] = rest.split('\t');
  // A chat turn's change card (turn-changes.ts): both sides come from that chat's turn snapshots.
  const turn = parseTurnRevision(rev);
  if (turn) return call<{ original: string; modified: string; note: string }>('chat/turn-file', { id: turn.chat, from: turn.from, to: turn.to, path, original });
  if (rev.includes('..')) {
    const [from, to] = rev.split('..');
    return call<{ original: string; modified: string; note: string }>('git/commit-file', to ? { sha: to, parent: from, path, original } : { working: true, parent: from, path, original });
  }
  return call<{ original: string; modified: string; note: string }>('git/commit-file', { sha: rev, path, original });
}
