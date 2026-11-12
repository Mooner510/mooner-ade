import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// Opening and closing a section, the same way everywhere (tool cards, tool bundles, the subagent list, command output; the "과정" rows and
// <details> do the same in CSS): opening, the space opens first and the contents come in a beat later, sliding down a few px, so a half-open
// box never shows its contents squeezed or cut mid-height. Closing runs the other way: the contents fade out at once, then the space closes.
// A toggle in the middle of a run starts from where it is. Reduced motion switches at once.
const EASE = 'cubic-bezier(.22, 1, .36, 1)';
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const clipped = (height: number) => ({ height: `${height}px`, overflow: 'hidden' });

// A body that is only in the DOM while open: it stays mounted until it has closed.
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [shown, setShown] = useState(open);
  const box = useRef<HTMLDivElement>(null), runs = useRef<Animation[]>([]), was = useRef(open);
  if (open && !shown) setShown(true);
  useLayoutEffect(() => {
    if (was.current === open) return;
    was.current = open;
    const el = box.current, live = runs.current;
    runs.current = [];
    if (!el || calm()) { live.forEach(run => run.cancel()); if (!open) setShown(false); return; }
    const inner = el.firstElementChild as HTMLElement | null, moving = live.some(run => run.playState === 'running');
    const from = moving || !open ? el.getBoundingClientRect().height : 0;
    const fade = moving && inner ? Number(getComputedStyle(inner).opacity) : open ? 0 : 1;
    live.forEach(run => run.cancel());
    const to = open ? el.getBoundingClientRect().height : 0;
    const height = el.animate([clipped(from), clipped(to)], { duration: open ? 320 : 260, delay: open ? 0 : 60, easing: EASE, fill: 'both' });
    const content = inner?.animate(open ? [{ opacity: fade, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }] : [{ opacity: fade }, { opacity: 0 }],
      open ? { duration: 220, delay: moving ? 0 : 100, easing: 'ease', fill: 'both' } : { duration: 110, easing: 'ease', fill: 'both' });
    runs.current = content ? [height, content] : [height];
    height.finished.then(() => {
      if (runs.current[0] !== height) return;
      // Closed: unmount while still held at 0 (cancelling first would flash the contents for a frame). Opened: let go, back to auto height.
      if (!open) { setShown(false); return; }
      runs.current.forEach(run => run.cancel()); runs.current = [];
    }, () => {});
  }, [open]);
  if (!shown) return null;
  return <div ref={box} className={className ? `collapse ${className}` : 'collapse'}><div className="collapse-inner">{children}</div></div>;
}

// A box that stays mounted but changes height (clipped output shown whole, a list that drops its max-height): call capture() just before the
// state change, and the box eases from the old height to the new one.
export function useHeightMorph<T extends HTMLElement>() {
  const ref = useRef<T>(null), from = useRef<number | null>(null), run = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const el = ref.current, start = from.current;
    from.current = null;
    if (!el || start == null || calm()) return;
    run.current?.cancel();
    const end = el.getBoundingClientRect().height;
    if (Math.abs(end - start) < 1) return;
    run.current = el.animate([clipped(start), clipped(end)], { duration: 300, easing: EASE });
  });
  const capture = () => { const el = ref.current; if (el) from.current = el.getBoundingClientRect().height; };
  return [ref, capture] as const;
}
