// 떠 있는 요소(팝오버·안내 말풍선)를 뷰포트 안에 두는 순수한 계산과 얇은 DOM 도우미.
// 계산은 JSX·DOM 없이 두어 노드 테스트가 바로 읽는다(tests/popover-place.test.mjs).

export type Side = 'above' | 'below';

// 앵커 위/아래 중 어디에 얼마까지 펼칠지. `height`는 제한이 없을 때의 자연 높이.
// 선호하는 쪽에 자연 높이가 들어가면 거기에 둔다. 안 들어가고 반대쪽이 더 넓을 때만 뒤집는다(둘 다 좁으면 선호 쪽 유지가 아니라 더 넓은 쪽).
// `maxHeight`는 고른 쪽의 남는 공간(그리고 `cap`)이라, 자연 높이가 그보다 크면 안쪽 스크롤이 된다.
export function placeVertical({ anchorTop, anchorBottom, viewport, height, gap = 8, margin = 8, prefer = 'above', cap = Infinity }: {
  anchorTop: number; anchorBottom: number; viewport: number; height: number; gap?: number; margin?: number; prefer?: Side; cap?: number;
}): { side: Side; maxHeight: number } {
  const room = { above: Math.max(0, anchorTop - gap - margin), below: Math.max(0, viewport - anchorBottom - gap - margin) };
  const other: Side = prefer === 'above' ? 'below' : 'above';
  const side = height > room[prefer] && room[other] > room[prefer] ? other : prefer;
  return { side, maxHeight: Math.floor(Math.min(cap, room[side])) };
}

// 컴포저 위에 펼치는 목록(슬래시 명령·@ 언급)이 쓸 수 있는 높이: 컴포저 윗면에서 팬 윗면까지, 컴포저와의 틈과 팬 가장자리 여백을 뺀 값.
export const listRoom = ({ paneTop, composerTop, gap = 6, margin = 8 }: { paneTop: number; composerTop: number; gap?: number; margin?: number }) => Math.max(0, Math.floor(composerTop - paneTop - gap - margin));

// 가로: 앵커의 왼쪽(또는 오른쪽 끝 맞춤)에서 시작해 뷰포트 `margin` 안으로 민다.
export function clampLeft({ anchorLeft, anchorRight, viewport, width, align = 'left', margin = 8 }: {
  anchorLeft: number; anchorRight: number; viewport: number; width: number; align?: 'left' | 'right'; margin?: number;
}): number {
  const left = align === 'right' ? anchorRight - width : anchorLeft;
  return Math.max(margin, Math.min(left, viewport - width - margin));
}

// 부모 메뉴 옆에 펼치는 서브메뉴의 x: 오른쪽에 자리가 없으면 부모의 왼쪽으로 뒤집어 부모를 덮지 않게 한다.
export function submenuLeft({ parentLeft, parentRight, viewport, width, overlap = 2, margin = 4 }: {
  parentLeft: number; parentRight: number; viewport: number; width: number; overlap?: number; margin?: number;
}): number {
  const right = parentRight - overlap;
  if (right + width <= viewport - margin) return right;
  const left = parentLeft - width + overlap;
  return left >= margin ? left : Math.max(margin, viewport - width - margin);
}

// 포인터 위치(x, y)에서 열린 메뉴(실제 크기 width x height)를 뷰포트 `margin` 안으로 민다. 한 변이 뷰포트보다 크면 시작 쪽 여백에 붙인다.
export function clampBox({ x, y, width, height, viewWidth, viewHeight, margin = 8 }: { x: number; y: number; width: number; height: number; viewWidth: number; viewHeight: number; margin?: number }) {
  const fit = (at: number, size: number, view: number) => Math.max(margin, Math.min(at, view - size - margin));
  return { left: fit(x, width, viewWidth), top: fit(y, height, viewHeight) };
}

// 호버 말풍선(앵커 위, 앵커 왼쪽 또는 오른쪽 가장자리 기준)을 `host` 상자 안으로 미는 양과, 위에 자리가 없을 때 아래로 뒤집을지.
export function tipShift({ boxLeft, boxRight, boxTop, hostLeft, hostRight, hostTop, margin = 8, topRoom = 44 }: {
  boxLeft: number; boxRight: number; boxTop: number; hostLeft: number; hostRight: number; hostTop: number; margin?: number; topRoom?: number;
}): { shift: number; side: Side } {
  const left = hostLeft + margin, right = hostRight - margin;
  let shift = 0;
  if (boxRight > right) shift = right - boxRight;
  if (boxLeft + shift < left) shift = left - boxLeft;
  return { shift: Math.round(shift), side: boxTop < hostTop + topRoom ? 'below' : 'above' };
}

// `.chat-done-pop`(턴 토큰·/btw 카드 토큰 호버 말풍선)를 스레드 상자 안에 둔다. 호버·포커스 때 부른다.
export function placeDonePop(el: HTMLElement | null) {
  if (!el) return;
  el.style.setProperty('--pop-x', '0px'); el.dataset.side = 'above';
  const box = el.getBoundingClientRect(), host = el.closest('.chat-scroll')?.getBoundingClientRect();
  const { shift, side } = tipShift({
    boxLeft: box.left, boxRight: box.right, boxTop: box.top,
    hostLeft: Math.max(host?.left ?? 0, 0), hostRight: Math.min(host?.right ?? innerWidth, innerWidth), hostTop: host?.top ?? 0,
  });
  el.style.setProperty('--pop-x', `${shift}px`);
  el.dataset.side = side;
}

const live = new WeakMap<HTMLElement, () => void>();

// top layer 팝오버를 `anchor` 위(기본)에 둔다. 위 공간이 모자라면 아래로 뒤집고, 어느 쪽이든 남는 공간만큼으로 max-height를 걸어 안쪽에서 스크롤하게 한다.
// 열려 있는 동안 창 크기와 팝오버 자신의 크기(데이터가 늦게 도착)가 바뀌면 다시 놓는다. 닫히면 감시를 거둔다.
export function placePopover(menu: HTMLElement, anchor: HTMLElement, { align = 'left', gap = 14, margin = 8 }: { align?: 'left' | 'right'; gap?: number; margin?: number } = {}) {
  live.get(menu)?.();
  const place = () => {
    const box = anchor.getBoundingClientRect();
    const height = menu.scrollHeight + menu.offsetHeight - menu.clientHeight; // 자연 높이(걸어 둔 max-height와 무관, 테두리 포함)
    const { side, maxHeight } = placeVertical({ anchorTop: box.top, anchorBottom: box.bottom, viewport: innerHeight, height, gap, margin });
    menu.style.maxHeight = `${maxHeight}px`;
    menu.style.left = `${clampLeft({ anchorLeft: box.left, anchorRight: box.right, viewport: innerWidth, width: menu.offsetWidth, align, margin })}px`;
    if (side === 'above') { menu.style.top = 'auto'; menu.style.bottom = `${innerHeight - box.top + gap}px`; }
    else { menu.style.bottom = 'auto'; menu.style.top = `${box.bottom + gap}px`; }
    menu.dataset.placement = side;
  };
  place();
  let frame = 0;
  const again = () => {
    if (!menu.matches(':popover-open')) { stop(); return; }
    cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if (menu.matches(':popover-open')) place(); });
  };
  const observer = new ResizeObserver(again);
  observer.observe(menu);
  addEventListener('resize', again);
  const closed = (event: Event) => { if ((event as ToggleEvent).newState === 'closed') stop(); };
  const stop = () => { cancelAnimationFrame(frame); observer.disconnect(); removeEventListener('resize', again); menu.removeEventListener('toggle', closed); live.delete(menu); };
  menu.addEventListener('toggle', closed);
  live.set(menu, stop);
}
