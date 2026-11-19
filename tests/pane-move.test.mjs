import test from 'node:test';
import assert from 'node:assert/strict';
import { dragHolds, dragPlace, findLeaf, paneDrop, placeLeaf } from '../apps/web/src/api.ts';

const leaf = (id, extra) => ({ id, ...extra });
const row = (children, sizes = children.map(() => 1)) => ({ direction: 'row', children, sizes });
const column = (children, sizes = children.map(() => 1)) => ({ direction: 'column', children, sizes });
const shape = pane => 'id' in pane ? pane.id : { direction: pane.direction, sizes: pane.sizes, children: pane.children.map(shape) };

test('paneDrop uses the outer band as an insert edge and the center as a split', () => {
  assert.deepEqual(paneDrop(0.05, 0.5), { how: 'before', axis: 'row' });
  assert.deepEqual(paneDrop(0.21, 0.5), { how: 'before', axis: 'row' });
  assert.deepEqual(paneDrop(0.96, 0.4), { how: 'after', axis: 'row' });
  assert.deepEqual(paneDrop(0.5, 0.04), { how: 'before', axis: 'column' });
  assert.deepEqual(paneDrop(0.4, 0.9), { how: 'after', axis: 'column' });
  // A corner follows the nearer edge. Equal distance stays on the horizontal edge.
  assert.deepEqual(paneDrop(0.1, 0.1), { how: 'before', axis: 'row' });
  assert.deepEqual(paneDrop(0.1, 0.05), { how: 'before', axis: 'column' });
  assert.deepEqual(paneDrop(0.95, 0.9), { how: 'after', axis: 'row' });
  assert.deepEqual(paneDrop(0.9, 0.97), { how: 'after', axis: 'column' });
  // Just inside the band is the center. The larger offset from the middle picks the axis; a tie is a row.
  assert.deepEqual(paneDrop(0.22, 0.5), { how: 'row', axis: 'row' });
  assert.deepEqual(paneDrop(0.5, 0.5), { how: 'row', axis: 'row' });
  assert.deepEqual(paneDrop(0.7, 0.5), { how: 'row', axis: 'row' });
  assert.deepEqual(paneDrop(0.5, 0.7), { how: 'column', axis: 'column' });
});

test('dragPlace picks a side through the center and keeps header travel horizontal', () => {
  assert.deepEqual(dragPlace(0.1, 0.5, 'row'), { how: 'before', axis: 'row' });
  assert.deepEqual(dragPlace(0.2, 0.5, 'row'), { how: 'before', axis: 'row' });
  assert.deepEqual(dragPlace(0.8, 0.5, 'row'), { how: 'after', axis: 'row' });
  assert.deepEqual(dragPlace(0.5, 0.5, 'row'), { how: 'before', axis: 'row' });
  assert.deepEqual(dragPlace(0.5, 0.5, 'column'), { how: 'before', axis: 'column' });
  assert.deepEqual(dragPlace(0.5, 0.1, 'row'), { how: 'before', axis: 'column' });
  assert.deepEqual(dragPlace(0.5, 0.9, 'row'), { how: 'after', axis: 'column' });
  // A corner follows the nearer side. The title strip is not a top split.
  assert.deepEqual(dragPlace(0.1, 0.1, 'row'), { how: 'before', axis: 'row' });
  assert.deepEqual(dragPlace(0.2, 0.05, 'row'), { how: 'before', axis: 'column' });
  assert.deepEqual(dragPlace(0.55, 0.03, 'row', 0.08), { how: 'after', axis: 'row' });
  assert.deepEqual(dragPlace(0.1, 0.03, 'row', 0.08), { how: 'before', axis: 'row' });
  assert.deepEqual(dragPlace(0.5, 0.12, 'row', 0.08), { how: 'before', axis: 'column' });
  assert.deepEqual(dragPlace(0.08, 0.5, 'column'), { how: 'before', axis: 'row' });

  assert.equal(dragHolds({ how: 'before', axis: 'row' }, 0.52, 0.5), true);
  assert.equal(dragHolds({ how: 'before', axis: 'row' }, 0.54, 0.5), false);
  assert.equal(dragHolds({ how: 'before', axis: 'column' }, 0.31, 0.35), true);
  assert.equal(dragHolds({ how: 'before', axis: 'column' }, 0.27, 0.35), false);
  assert.equal(dragHolds({ how: 'before', axis: 'column' }, 0.5, 0.05, 0.08), false);
});

test('placeLeaf reorders siblings, wraps a mismatched axis, and splits like split()', () => {
  const a = leaf('a', { cwd: '/a' }), b = leaf('b'), c = leaf('c', { kind: 'editor', tabs: ['diff:1:x'] });
  const pane = row([a, b, c], [1, 2, 3]);
  const before = JSON.stringify(pane);

  assert.equal(placeLeaf(pane, 'a', 'a', 'before', 'column'), pane);
  assert.equal(placeLeaf(pane, 'missing', 'a', 'row'), pane);
  assert.equal(placeLeaf(pane, 'a', 'missing', 'after', 'column'), pane);

  assert.equal(placeLeaf(pane, 'a', 'b', 'before', 'row'), pane);

  const moved = placeLeaf(pane, 'c', 'a', 'before', 'row');
  assert.deepEqual(shape(moved), { direction: 'row', sizes: [3, 1, 2], children: ['c', 'a', 'b'] });
  assert.equal(findLeaf(moved, 'a'), a);
  assert.equal(findLeaf(moved, 'b'), b);
  assert.equal(findLeaf(moved, 'c'), c);
  assert.equal(findLeaf(moved, 'a').cwd, '/a');

  const after = placeLeaf(column([a, b, c]), 'a', 'b', 'after', 'column');
  assert.deepEqual(shape(after), { direction: 'column', sizes: [1, 1, 1], children: ['b', 'a', 'c'] });

  const wrapped = placeLeaf(pane, 'b', 'c', 'before', 'column');
  assert.deepEqual(shape(wrapped), { direction: 'row', sizes: [1, 3], children: ['a', { direction: 'column', sizes: [1, 1], children: ['b', 'c'] }] });
  assert.equal(findLeaf(wrapped, 'c'), c);

  const wrappedAfter = placeLeaf(pane, 'b', 'c', 'after', 'column');
  assert.deepEqual(shape(wrappedAfter), { direction: 'row', sizes: [1, 3], children: ['a', { direction: 'column', sizes: [1, 1], children: ['c', 'b'] }] });

  // Default axis is a row, so a column parent wraps instead of inserting.
  assert.deepEqual(shape(placeLeaf(column([a, b]), 'a', 'b', 'before')), { direction: 'row', sizes: [1, 1], children: ['a', 'b'] });

  const splitRow = placeLeaf(pane, 'a', 'b', 'row');
  assert.deepEqual(shape(splitRow), { direction: 'row', sizes: [1, 1, 1], children: ['b', 'a', 'c'] });
  assert.equal(findLeaf(splitRow, 'c'), c);

  // `column` is the split direction even if an axis argument says otherwise. The moved leaf is the second child.
  assert.deepEqual(shape(placeLeaf(row([a, b]), 'a', 'b', 'column', 'row')), { direction: 'column', sizes: [1, 1], children: ['b', 'a'] });

  const nested = column([a, row([b, c])]);
  const splitNested = placeLeaf(nested, 'a', 'b', 'column');
  assert.deepEqual(shape(splitNested), { direction: 'row', sizes: [1, 1], children: [{ direction: 'column', sizes: [1, 1], children: ['b', 'a'] }, 'c'] });
  assert.equal(findLeaf(splitNested, 'b'), b);
  assert.equal(findLeaf(splitNested, 'c'), c);

  // Removing b collapses its column, then b is inserted beside a in the row.
  const collapsed = placeLeaf(row([a, column([b, c], [2, 5])], [3, 4]), 'b', 'a', 'after', 'row');
  assert.deepEqual(shape(collapsed), { direction: 'row', sizes: [1.5, 1.5, 4], children: ['a', 'b', 'c'] });
  assert.equal(findLeaf(collapsed, 'a'), a);
  assert.equal(findLeaf(collapsed, 'c'), c);

  assert.equal(JSON.stringify(pane), before);
});

test('dragging a stacked pane back into an even row restores equal widths from either side', () => {
  const a = leaf('a'), b = leaf('b'), c = leaf('c');
  const original = row([a, b, c], [2, 2, 2]);

  const stackedRight = placeLeaf(original, 'c', 'b', 'after', 'column');
  assert.deepEqual(stackedRight, row([a, column([b, c])], [2, 2]));
  assert.deepEqual(placeLeaf(stackedRight, 'c', 'b', 'after', 'row'), original);

  const stackedLeft = placeLeaf(original, 'a', 'b', 'after', 'column');
  assert.deepEqual(stackedLeft, row([column([b, a]), c], [2, 2]));
  assert.deepEqual(placeLeaf(stackedLeft, 'a', 'b', 'before', 'row'), original);
});
