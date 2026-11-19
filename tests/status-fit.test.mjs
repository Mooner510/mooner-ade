import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseFolded, foldOrder, STATUS_MENU_BUTTON } from '../apps/web/src/status-fit.ts';

const right = ['cpu', 'memory', 'claudeusage', 'codexusage', 'cursorusage', 'wakatime', 'clock', 'readiness'];

test('접는 순서: CPU·메모리 → 시계·WakaTime → Codex·Cursor, 같은 순위끼리는 사용자가 정한 순서의 뒤쪽부터, Claude 사용량·준비 상태는 접지 않는다', () => {
  assert.deepEqual(foldOrder(right), ['memory', 'cpu', 'clock', 'wakatime', 'cursorusage', 'codexusage']);
  // 사용자가 순서를 바꾸면 그 순서의 뒤쪽이 먼저 접힌다.
  assert.deepEqual(foldOrder(['clock', 'wakatime', 'cpu', 'memory']), ['memory', 'cpu', 'wakatime', 'clock']);
  assert.equal(foldOrder(['claudeusage', 'readiness']).length, 0);
});

test('폭이 모자라면 순서대로 접고, 처음 접을 때는 … 버튼 폭을 더한다', () => {
  const widths = { cpu: 60, memory: 70, claudeusage: 200, codexusage: 150, cursorusage: 200, wakatime: 0, clock: 70, readiness: 27 };
  const order = foldOrder(right);
  const full = 60 + 70 + 200 + 150 + 200 + 70 + 27;
  assert.deepEqual(chooseFolded({ available: full, fixed: 0, widths, order }), []);
  // 메모리 하나만 접으면(70) 딱 맞는 폭: … 버튼(30)이 들어가서 모자라 CPU까지 접는다.
  assert.deepEqual(chooseFolded({ available: full - 70, fixed: 0, widths, order }), ['memory', 'cpu']);
  assert.deepEqual(chooseFolded({ available: full - 70 + STATUS_MENU_BUTTON, fixed: 0, widths, order }), ['memory']);
  // 배지처럼 접을 수 없는 폭(fixed)도 계산에 들어간다.
  assert.deepEqual(chooseFolded({ available: full, fixed: 41, widths, order }), ['memory', 'cpu']);
  // 아무것도 그리지 않는 항목(폭 0)은 접어도 자리가 나지 않으니 건너뛴다.
  assert.deepEqual(chooseFolded({ available: 400, fixed: 0, widths: { cpu: 0, memory: 0, clock: 100, wakatime: 0, claudeusage: 380 }, order: foldOrder(['cpu', 'memory', 'clock', 'wakatime']) }), ['clock']);
  // 다 접어도 모자라면 접을 수 있는 것만 접는다(Claude 사용량은 남는다).
  assert.deepEqual(chooseFolded({ available: 10, fixed: 0, widths, order }), ['memory', 'cpu', 'clock', 'cursorusage', 'codexusage']);
});
