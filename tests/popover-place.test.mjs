import test from 'node:test';
import assert from 'node:assert/strict';
import { clampBox, clampLeft, listRoom, placeVertical, submenuLeft, tipShift } from '../apps/web/src/popover-place.ts';

test('위로 열리는 팝오버: 위 공간에 들어가면 위, 크기는 그대로 둔다', () => {
  const placed = placeVertical({ anchorTop: 500, anchorBottom: 530, viewport: 700, height: 300, gap: 14 });
  assert.equal(placed.side, 'above');
  assert.equal(placed.maxHeight, 500 - 14 - 8);
});

test('위 공간이 모자라고 아래가 더 넓으면 아래로 뒤집는다', () => {
  const placed = placeVertical({ anchorTop: 120, anchorBottom: 150, viewport: 700, height: 400, gap: 14 });
  assert.equal(placed.side, 'below');
  assert.equal(placed.maxHeight, 700 - 150 - 14 - 8);
});

test('양쪽 다 모자라면 더 넓은 쪽에서 max-height로 줄여 안쪽 스크롤', () => {
  const placed = placeVertical({ anchorTop: 200, anchorBottom: 230, viewport: 320, height: 500, gap: 8 });
  assert.equal(placed.side, 'above');
  assert.ok(placed.maxHeight <= 200 - 8 - 8);
  const lower = placeVertical({ anchorTop: 60, anchorBottom: 90, viewport: 320, height: 500, gap: 8 });
  assert.equal(lower.side, 'below');
  assert.equal(lower.maxHeight, 320 - 90 - 8 - 8);
});

test('위 공간이 모자라도 아래가 더 좁으면 선호하는 쪽을 지킨다', () => {
  const placed = placeVertical({ anchorTop: 100, anchorBottom: 400, viewport: 440, height: 300, gap: 8 });
  assert.equal(placed.side, 'above');
});

test('아래를 선호하는 호출도 같은 규칙으로 뒤집고 cap을 지킨다', () => {
  assert.equal(placeVertical({ anchorTop: 400, anchorBottom: 430, viewport: 450, height: 300, prefer: 'below' }).side, 'above');
  assert.equal(placeVertical({ anchorTop: 10, anchorBottom: 40, viewport: 900, height: 500, prefer: 'below', cap: 340 }).maxHeight, 340);
});

test('공간이 음수가 되어도 max-height는 0 아래로 가지 않는다', () => {
  assert.equal(placeVertical({ anchorTop: 4, anchorBottom: 700, viewport: 700, height: 100, gap: 14 }).maxHeight, 0);
});

test('가로: 왼쪽 맞춤과 오른쪽 끝 맞춤, 뷰포트 안으로 밀기', () => {
  assert.equal(clampLeft({ anchorLeft: 100, anchorRight: 140, viewport: 800, width: 280 }), 100);
  assert.equal(clampLeft({ anchorLeft: 700, anchorRight: 740, viewport: 800, width: 280 }), 800 - 280 - 8);
  assert.equal(clampLeft({ anchorLeft: 20, anchorRight: 60, viewport: 800, width: 280, align: 'right' }), 8);
  assert.equal(clampLeft({ anchorLeft: 0, anchorRight: 400, viewport: 800, width: 240, align: 'right' }), 160);
  assert.equal(clampLeft({ anchorLeft: 0, anchorRight: 40, viewport: 200, width: 280 }), 8, '뷰포트보다 넓으면 왼쪽 여백에 붙인다');
});

test('서브메뉴: 오른쪽에 자리가 있으면 부모 오른쪽, 없으면 부모 왼쪽으로 뒤집는다', () => {
  assert.equal(submenuLeft({ parentLeft: 100, parentRight: 330, viewport: 1000, width: 240 }), 328);
  assert.equal(submenuLeft({ parentLeft: 600, parentRight: 830, viewport: 1000, width: 240 }), 600 - 240 + 2);
  assert.equal(submenuLeft({ parentLeft: 10, parentRight: 240, viewport: 400, width: 240 }), 400 - 240 - 4, '양쪽 다 없으면 뷰포트 안으로');
});

test('포인터 메뉴: 실제 크기로 네 변을 뷰포트 안에 둔다', () => {
  assert.deepEqual(clampBox({ x: 900, y: 600, width: 200, height: 300, viewWidth: 1000, viewHeight: 700 }), { left: 792, top: 392 });
  assert.deepEqual(clampBox({ x: -5, y: -5, width: 200, height: 300, viewWidth: 1000, viewHeight: 700 }), { left: 8, top: 8 });
  assert.deepEqual(clampBox({ x: 50, y: 50, width: 200, height: 900, viewWidth: 1000, viewHeight: 700 }), { left: 50, top: 8 }, '더 높으면 위 여백에 붙인다');
});

test('컴포저 위 목록: 팬 윗면까지 남는 높이, 음수 없음', () => {
  assert.equal(listRoom({ paneTop: 0, composerTop: 300 }), 300 - 6 - 8);
  assert.equal(listRoom({ paneTop: 100, composerTop: 110 }), 0);
});

test('호버 말풍선: 스레드 상자 안으로 밀고, 위가 좁으면 아래', () => {
  assert.deepEqual(tipShift({ boxLeft: 700, boxRight: 1000, boxTop: 300, hostLeft: 0, hostRight: 900, hostTop: 0 }), { shift: -108, side: 'above' });
  assert.deepEqual(tipShift({ boxLeft: -20, boxRight: 200, boxTop: 300, hostLeft: 0, hostRight: 900, hostTop: 0 }), { shift: 28, side: 'above' });
  assert.equal(tipShift({ boxLeft: 10, boxRight: 100, boxTop: 30, hostLeft: 0, hostRight: 900, hostTop: 0 }).side, 'below');
});
