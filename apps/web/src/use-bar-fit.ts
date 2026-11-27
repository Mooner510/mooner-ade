import { useLayoutEffect, type RefObject } from 'react';
import { barFits, chooseBarFit } from './bar-fit';

// 상단 바(`<header class="tabbar" ref={bar}>`)가 좁으면 `data-fit` 단계를 올려 오른쪽 버튼 묶음이 창 버튼 영역에 들어오게 한다(style.css).
// 하단 상태바(StatusFit.tsx)와 같이 폭을 직접 재고, 단계는 DOM 속성으로만 둔다(React 상태가 아니라 다시 그릴 일이 없다).
// 단계마다 속성을 바꿔 가며 같은 프레임 안에서 재므로 중간 모습은 화면에 그려지지 않는다. 폰 레이아웃(enabled=false)은 자체 규칙이 있어 건드리지 않는다.
export function useBarFit(bar: RefObject<HTMLElement | null>, enabled: boolean, ready = true) {
  useLayoutEffect(() => {
    const el = bar.current; if (!el) return;
    if (!enabled) { el.removeAttribute('data-fit'); return; }
    const fit = () => {
      const tools = el.querySelector<HTMLElement>(':scope > .bar-tools');
      // 화면에 없는 프로젝트(hidden)는 잴 것이 없다. 다시 보일 때 ResizeObserver가 부른다.
      if (!tools || !el.getClientRects().length) return;
      const limit = el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight);
      const level = chooseBarFit(next => { el.dataset.fit = String(next); return barFits(tools.getBoundingClientRect().right, limit); });
      el.dataset.fit = String(level);
    };
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; fit(); }); };
    fit();
    const resize = new ResizeObserver(schedule);
    resize.observe(el);
    const tools = el.querySelector('.bar-tools'); if (tools) resize.observe(tools);
    return () => { resize.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [bar, enabled, ready]);
}
