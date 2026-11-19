import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

// A one-time pointer at an easy-to-miss button. The button gets the `hint-anchor` class (CSS anchor-name) and this card sits right under it
// in the top layer, so pane edges never clip it. It never takes focus; "알겠어요" records it, and tips.ts nextHint decides which one is due.
// The card flips above or sideways when there is no room (composer controls sit at the bottom), so its tip is aimed here, at the anchor's centre.
// `wide`: the anchor is wider than the card (the whole input box), so the card is centred on it instead of hanging from its right end.
export function Hint({ title, text, onDone, wide }: { title: string; text: ReactNode; onDone(): void; wide?: boolean }) {
  const card = useRef<HTMLDivElement>(null), anchorName = `--ade-hint-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  useLayoutEffect(() => {
    const el = card.current; if (!el?.showPopover) return;
    el.showPopover();
    const target = el.parentElement?.querySelector<HTMLElement>('.hint-anchor'); if (!target) return;
    // 모든 .hint-anchor가 같은 anchor-name을 쓰면 카드가 여러 장일 때 전부 마지막 anchor 한 곳에 겹쳐 쌓인다: 카드마다 자기 anchor 이름을 쓴다.
    target.style.setProperty('anchor-name', anchorName); el.style.setProperty('position-anchor', anchorName);
    const aim = () => {
      const anchor = target.getBoundingClientRect(), box = el.getBoundingClientRect();
      el.dataset.side = box.top >= anchor.bottom ? 'below' : 'above';
      el.style.setProperty('--tip-x', `${Math.min(box.width - 16, Math.max(16, anchor.left + anchor.width / 2 - box.left))}px`); // a wide anchor (the input box): stay on the card
    };
    // Again when the anchor changes size (the model label the user just picked is wider) or the window does.
    const watch = new ResizeObserver(aim); watch.observe(target); addEventListener('resize', aim);
    return () => { watch.disconnect(); removeEventListener('resize', aim); target.style.removeProperty('anchor-name'); };
  }, [anchorName]);
  return <div ref={card} popover="manual" className={`hint-card${wide ? ' wide' : ''}`} role="status" aria-label={title}>
    <strong>{title}</strong>
    <p>{text}</p>
    <button type="button" className="primary" onClick={onDone}>알겠어요</button>
  </div>;
}
