import { useLayoutEffect, type RefObject } from 'react';
import { clampBox } from './popover-place';

// A fixed menu opened at the pointer (x, y): measure its real box and keep it inside the window, instead of guessing its size.
// Re-fits when its size changes (items that arrive late) or the window is resized. The CSS caps its height, so a long list scrolls.
export function useFitMenu(ref: RefObject<HTMLElement | null>, x: number, y: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.left = '0px'; el.style.top = '0px'; // natural size: next to the right edge a fixed box would be squeezed to what is left
      const box = el.getBoundingClientRect();
      const at = clampBox({ x, y, width: box.width, height: box.height, viewWidth: innerWidth, viewHeight: innerHeight });
      el.style.left = `${at.left}px`; el.style.top = `${at.top}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    addEventListener('resize', fit);
    return () => { observer.disconnect(); removeEventListener('resize', fit); };
  }, [ref, x, y]);
}
