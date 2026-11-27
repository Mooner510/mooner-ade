import test from 'node:test';
import assert from 'node:assert/strict';
import { BAR_FIT_LEVELS, barFits, chooseBarFit } from '../apps/web/src/bar-fit.ts';

test('들어가면 줄이지 않는다(0단계), 안 들어가면 들어가는 가장 낮은 단계를 고른다', () => {
  assert.equal(chooseBarFit(() => true), 0);
  assert.equal(chooseBarFit(level => level >= 1), 1);
  assert.equal(chooseBarFit(level => level >= 2), 2);
  assert.equal(chooseBarFit(level => level >= 3), BAR_FIT_LEVELS);
});

test('3단계로도 안 들어가면 마지막 단계(3)를 돌려주고, 그 단계는 재 보지 않는다', () => {
  const tried = [];
  assert.equal(chooseBarFit(level => { tried.push(level); return false; }), BAR_FIT_LEVELS);
  assert.deepEqual(tried, [0, 1, 2]);
});

test('가장 덜 줄인 단계에서 멈춘다(더 줄이는 단계를 재지 않는다)', () => {
  const tried = [];
  chooseBarFit(level => { tried.push(level); return level === 1; });
  assert.deepEqual(tried, [0, 1]);
});

test('묶음의 오른쪽 끝이 한계 안이면 들어간 것이고, 반 픽셀 오차는 넘친 것으로 보지 않는다', () => {
  assert.equal(barFits(862, 862), true);
  assert.equal(barFits(862.4, 862), true);
  assert.equal(barFits(863, 862), false);
  assert.equal(barFits(400, 862), true);
});
