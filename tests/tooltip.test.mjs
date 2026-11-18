import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tooltipCopy } from '../apps/web/src/tooltip.ts';

test('tooltips omit visible labels and redundant lines, while retaining extra information', () => {
  assert.equal(tooltipCopy('src/app.ts:42', 'src/app.ts:42'), '');
  assert.equal(tooltipCopy('현재 모델\n전체 모델 ID\n전체 모델 ID', '아이콘\n현재 모델'), '전체 모델 ID');
  assert.equal(tooltipCopy('취소 (Esc)', '취소'), '(Esc)');
  assert.equal(tooltipCopy('Git 로그 (Fetch)', 'Git 로그'), 'Git 로그 (Fetch)');
  assert.equal(tooltipCopy('파일 열기 (⌘O)', ''), '파일 열기 (⌘O)');
});
