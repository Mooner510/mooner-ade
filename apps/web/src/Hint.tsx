import { useLayoutEffect, useRef, type ReactNode } from 'react';

// A one-time pointer at an easy-to-miss button. The button gets the `hint-anchor` class (CSS anchor-name) and this card sits right under it
// in the top layer, so pane edges never clip it. It never takes focus; "알겠어요" records it, and tips.ts nextHint decides which one is due.
// The card flips above or sideways when there is no room (composer controls sit at the bottom), so its tip is aimed here, at the anchor's centre.
// `wide`: the anchor is wider than the card (the whole input box), so the card is centred on it instead of hanging from its right end.
export function Hint({ title, text, onDone, wide }: { title: string; text: ReactNode; onDone(): void; wide?: boolean }) {
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = card.current; if (!el?.showPopover) return;
    el.showPopover();
    const target = el.parentElement?.querySelector('.hint-anchor'); if (!target) return;
    const aim = () => {
      const anchor = target.getBoundingClientRect(), box = el.getBoundingClientRect();
      el.dataset.side = box.top >= anchor.bottom ? 'below' : 'above';
      el.style.setProperty('--tip-x', `${Math.min(box.width - 16, Math.max(16, anchor.left + anchor.width / 2 - box.left))}px`); // a wide anchor (the input box): stay on the card
    };
    // Again when the anchor changes size (the model label the user just picked is wider) or the window does.
    const watch = new ResizeObserver(aim); watch.observe(target); addEventListener('resize', aim);
    return () => { watch.disconnect(); removeEventListener('resize', aim); };
  }, []);
  return <div ref={card} popover="manual" className={`hint-card${wide ? ' wide' : ''}`} role="status" aria-label={title}>
    <strong>{title}</strong>
    <p>{text}</p>
    <button type="button" className="primary" onClick={onDone}>알겠어요</button>
  </div>;
}
