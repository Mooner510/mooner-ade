import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, makeView, sortView, layoutGraph, rowDrawing, firstParentReach, linearRun, foldedBetween, graphColor, headPriority, refGroups, prettyDate, javaHash, LONG_EDGE } from '../apps/web/src/git-graph.ts';

// commits newest first: [hash, parents, time]
const make = list => list.map(([h, p, t]) => ({ h, p, an: 'a', ae: 'a@a', at: t, ct: t, s: h }));
const ref = (name, sha, kind = 'local', extra = {}) => ({ ref: `refs/${kind === 'local' ? 'heads' : kind === 'remote' ? 'remotes' : 'tags'}/${name}`, name, kind, sha, ...extra });
const layout = (commits, refs = [], sort = 'date', showLongEdges = false) => {
  const graph = buildGraph(commits, refs), view = makeView(graph, null), order = sortView(view, commits, sort);
  return { graph, order: order.map(i => commits[view.ids[i]].h), result: layoutGraph(graph, view, order, { showLongEdges, headPriority: i => headPriority(graph.refsAt.get(commits[i].h), false) }) };
};

test('a merged branch: main line stays in the first column, the branch beside it', () => {
  // M merges F2 (feature) into main; main moved on with A while feature had F1, F2
  const commits = make([['M', ['A', 'F2'], 50], ['F2', ['F1'], 40], ['A', ['B'], 35], ['F1', ['B'], 30], ['B', [], 10]]);
  const { result, order } = layout(commits, [ref('main', 'M', 'local', { current: true })]);
  assert.deepEqual(order, ['M', 'F2', 'A', 'F1', 'B'], 'by commit date');
  const x = Object.fromEntries(order.map((h, row) => [h, result.nodeX[row]]));
  assert.deepEqual(x, { M: 0, F2: 1, A: 0, F1: 1, B: 0 });
  assert.equal(result.maxWidth, 2);
});

test('a merged branch\'s commit sits right of a long edge that shares its index, so that edge stays straight', () => {
  // V merges D into a line (S1) that main (A) already walked: V's edge to S1 and the D chain share one index
  const commits = make([['A', ['S1'], 100], ['V', ['S1', 'D'], 90], ['D', ['B'], 80], ['S1', ['B'], 70], ['B', [], 10]]);
  const { result, order } = layout(commits, [ref('main', 'A'), ref('feat', 'V')]);
  assert.deepEqual(order, ['A', 'V', 'D', 'S1', 'B']);
  assert.deepEqual(Array.from(result.nodeX), [0, 1, 2, 0, 0]);
});

test('topological sort puts the merged branch right below the merge; linearize keeps it above the main-line commits', () => {
  const commits = make([['M', ['A', 'F2'], 50], ['A', ['B'], 45], ['F2', ['F1'], 40], ['F1', ['B'], 30], ['B', [], 10]]);
  assert.deepEqual(layout(commits, [], 'date').order, ['M', 'A', 'F2', 'F1', 'B']);
  assert.deepEqual(layout(commits, [], 'topo').order, ['M', 'F2', 'F1', 'A', 'B']);
  assert.deepEqual(layout(commits, [], 'linear').order, ['M', 'F2', 'F1', 'A', 'B']);
});

test('edges are cut to arrows past 30 rows unless long edges are shown', () => {
  // a side branch from the root, with a long main line in between
  const list = [['S', ['R'], 1000]];
  for (let i = 0; i < LONG_EDGE + 5; i++) list.push([`m${i}`, [i + 1 < LONG_EDGE + 5 ? `m${i + 1}` : 'R'], 900 - i]);
  list.push(['R', [], 1]);
  const commits = make(list);
  const cut = layout(commits).result, full = layout(commits, [], 'date', true).result;
  const sideEdge = r => r.edges.find(edge => edge.up === 0);
  assert.equal(sideEdge(cut).xs.filter(x => x >= 0).length, 4, 'both ends and one row next to each');
  assert.equal(sideEdge(full).xs.every(x => x >= 0), true);
  const arrows = rowDrawing(cut, 1).arrows;
  assert.equal(arrows.length, 1); assert.equal(arrows[0].down, true);
  assert.equal(rowDrawing(cut, cut.rows - 2).arrows[0].down, false);
});

test('a parent beyond the loaded commits ends in an arrow at the bottom', () => {
  const commits = make([['A', ['B'], 2], ['B', ['missing'], 1]]);
  const { result } = layout(commits);
  assert.ok(rowDrawing(result, 1).arrows.some(arrow => arrow.down));
});

test('filters: dotted edges to the nearest visible ancestor; first parent; linear runs', () => {
  const commits = make([['M', ['A', 'F'], 5], ['F', ['B'], 4], ['A', ['B'], 3], ['B', ['C'], 2], ['C', [], 1]]);
  const graph = buildGraph(commits, []);
  const view = makeView(graph, i => ['M', 'C'].includes(commits[i].h));
  assert.deepEqual(view.parents, [[1], []]);
  assert.deepEqual(view.dotted, [[true], []]);
  const reach = firstParentReach(graph, [0]);
  assert.deepEqual([...reach], [1, 0, 1, 1, 1]);
  const keep = () => false;
  assert.deepEqual(linearRun(graph, graph.index.get('A'), graph.index.get('B'), keep).map(i => commits[i].h).sort(), ['A']);
  assert.deepEqual(foldedBetween(graph, 0, graph.index.get('B')).map(i => commits[i].h), ['A']);
});

test('colours, head order, label groups, dates', () => {
  assert.equal(graphColor(0), null);
  assert.match(graphColor(javaHash('main')), /^#[0-9a-f]{6}$/);
  assert.equal(graphColor(5), graphColor(5));
  assert.notEqual(graphColor(javaHash('main')), graphColor(javaHash('feature')));
  assert.equal(javaHash('main'), 3343801, 'same as Java String.hashCode');
  assert.ok(headPriority([ref('origin/main', 'x', 'remote')], false) < headPriority([ref('main', 'x')], false));
  assert.ok(headPriority([ref('feature', 'x')], false) < headPriority([], true));
  const groups = refGroups([ref('v1', 'x', 'tag'), ref('origin/feature', 'x', 'remote'), ref('feature', 'x', 'local', { upstream: 'origin/feature' }), ref('main', 'x', 'local', { current: true })]);
  assert.deepEqual(groups.map(group => group.map(item => item.name)), [['main'], ['feature', 'origin/feature'], ['v1']]);
  const now = new Date(2026, 10, 18, 15, 0).getTime();
  assert.equal(prettyDate(now / 1000 - 30, now), '방금 전');
  assert.equal(prettyDate(now / 1000 - 600, now), '10분 전');
  assert.equal(prettyDate(new Date(2026, 10, 18, 9, 5).getTime() / 1000, now), '오늘 09:05');
  assert.equal(prettyDate(new Date(2026, 10, 17, 9, 5).getTime() / 1000, now), '어제 09:05');
  assert.equal(prettyDate(new Date(2026, 0, 2, 9, 5).getTime() / 1000, now), '2026-01-02 09:05');
});
