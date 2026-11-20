import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// While a tip is up: a very light blur over the whole window, with the element the tip is about (a selector or the element itself) left sharp.
// The blur is one fixed layer whose mask has a hole at that element; it never takes clicks. ponytail: the hole follows by polling (4x/s), a layout watcher if that ever shows.
const PAD = 4;
// `ring`: also outline the element in the accent colour (the same border and tint a button pointer gets); a Hint's button already draws its own.
export function Spotlight({ target, ring = true }: { target?: string | HTMLElement | null; ring?: boolean }) {
  const [hole, setHole] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const measure = () => {
      const el = typeof target === 'string' ? [...document.querySelectorAll<HTMLElement>(target)].find(item => item.getClientRects().length) : target;
      const box = el?.getBoundingClientRect();
      const next = box && box.width > 0 ? { x: Math.round(box.x - PAD), y: Math.round(box.y - PAD), w: Math.round(box.width + PAD * 2), h: Math.round(box.height + PAD * 2) } : null;
      setHole(previous => previous?.x === next?.x && previous?.y === next?.y && previous?.w === next?.w && previous?.h === next?.h ? previous : next);
    };
    measure(); const timer = setInterval(measure, 250); addEventListener('resize', measure);
    return () => { clearInterval(timer); removeEventListener('resize', measure); };
  }, [target]);
  const style = hole ? { '--hx': `${hole.x}px`, '--hy': `${hole.y}px`, '--hw': `${hole.w}px`, '--hh': `${hole.h}px` } as React.CSSProperties : undefined;
  return createPortal(<><div className="notice-scrim" aria-hidden="true" style={style} />{ring && hole && <div className="notice-ring" aria-hidden="true" style={style} />}</>, document.body);
}
