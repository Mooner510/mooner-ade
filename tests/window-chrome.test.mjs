import test from 'node:test';
import assert from 'node:assert/strict';
import { cardTopLimit, dialogYRange, errorToastMaxWidth } from '../apps/web/src/window-chrome.ts';

test('an error toast never gets wider than what is left of the window beside its right inset', () => {
  assert.equal(errorToastMaxWidth(1440, 200), 800, 'a wide window keeps the 800px cap');
  assert.equal(errorToastMaxWidth(900, 200), 692, 'right 200 + 8px gap leave 692');
  assert.equal(errorToastMaxWidth(360, 8), 344, 'a phone: the whole width minus both gaps');
  assert.equal(errorToastMaxWidth(200, 190), 120, 'never narrower than the floor');
  for (const [width, right] of [[1000, 200], [885, 140], [360, 8]]) assert.ok(width - right - errorToastMaxWidth(width, right) >= 8, `left edge stays on screen at ${width}/${right}`);
});

test('a dragged dialog keeps its top edge under the bar of the window controls', () => {
  assert.deepEqual(dialogYRange(100, 780, 900, 40), [-60, 120], 'centred dialog: up to 60px, down to the bottom edge');
  assert.deepEqual(dialogYRange(100, 780, 900, 40, 36), [-60, 84], 'bar-live: the status bar stays clear');
  assert.deepEqual(dialogYRange(10, 890, 900, 40), [0, 10], 'one starting higher than the bar does not move further up');
  assert.deepEqual(dialogYRange(100, 780, 900, 0), [-100, 120], 'without window controls the old limit applies (top edge at the window top)');
  assert.deepEqual(dialogYRange(0, 480, 480, 40), [0, 0], 'full screen: no movement');
});

test('floating cards start under the window-controls bar, else at the margin', () => {
  assert.equal(cardTopLimit(16, 0), 16);
  assert.equal(cardTopLimit(16, 40), 44);
  assert.equal(cardTopLimit(50, 40), 50);
});
