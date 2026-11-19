import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Icon } from './Icon';
import { chooseFolded, foldOrder } from './status-fit';

// 하단 상태바가 좁을 때 항목을 우선순위대로 접는다. 접은 항목은 지우지 않고 "…" 메뉴에 그대로 들어 있다.
// 폭은 ResizeObserver·MutationObserver로 재고(contain 같은 CSS 격리는 fixed 팝오버에 영향을 줘서 쓰지 않는다), 항목 자리(.status-slot)는
// `display: contents`라 레이아웃에는 끼지 않고 접을 때만 `data-folded`로 숨긴다.
//
const GAP = 2, LEFT_MIN = 220;

export function StatusSlot({ id, children }: { id: string; children: ReactNode }) {
  return <span className="status-slot" data-slot={id}>{children}</span>;
}

// Call from the component that renders `<footer ref={bar}>` with the user's right-hand order. `folded` lists what is hidden right now.
export function useStatusFit(bar: RefObject<HTMLElement | null>, right: string[], ready = true) {
  const [folded, setFolded] = useState<string[]>([]);
  const widths = useRef(new Map<string, number>()), applied = useRef(''), shownOrder = useRef(right);
  shownOrder.current = right;
  const order = foldOrder(right), orderKey = order.join(',');
  const fit = useCallback(() => {
    const footer = bar.current, group = footer?.querySelector<HTMLElement>(':scope > .status-right'), left = footer?.querySelector<HTMLElement>(':scope > .status-left');
    // A project that is not on screen has a hidden status bar: nothing to measure until it shows (the ResizeObserver fires then).
    if (!footer || !group || !left || !footer.getClientRects().length) return;
    const slots = [...group.querySelectorAll<HTMLElement>(':scope > .status-slot')];
    // Natural widths: a folded slot shows nothing, so it is unfolded for the instant of measuring (no paint happens in between).
    const natural: Record<string, number> = {};
    for (const slot of slots) {
      const id = slot.dataset.slot!, wasFolded = slot.hasAttribute('data-folded');
      if (wasFolded) slot.removeAttribute('data-folded');
      let sum = 0; for (const child of slot.children) { const w = child.getBoundingClientRect().width; if (w > 0) sum += w + GAP; }
      if (wasFolded && sum === 0 && widths.current.has(id)) sum = widths.current.get(id)!;
      if (wasFolded) slot.setAttribute('data-folded', '');
      if (sum > 0) widths.current.set(id, sum); else if (!wasFolded) widths.current.delete(id);
      natural[id] = sum;
    }
    // Slots hidden since they were last measured have no reading of their own: use the one from when they were shown.
    for (const slot of slots) { const id = slot.dataset.slot!; if (natural[id] === 0 && slot.hasAttribute('data-folded')) natural[id] = widths.current.get(id) ?? 0; }
    let fixed = 0;
    for (const child of group.children) if (!child.classList.contains('status-slot') && !child.classList.contains('status-more')) { const w = child.getBoundingClientRect().width; if (w > 0) fixed += w + GAP; }
    const style = getComputedStyle(footer), inner = footer.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - (parseFloat(style.columnGap) || 8);
    let leftNeed = 0; for (const child of left.children) for (const item of child.classList.contains('status-slot') ? child.children : [child]) leftNeed += (item as HTMLElement).scrollWidth + GAP;
    const next = chooseFolded({ available: inner - Math.min(leftNeed, LEFT_MIN), fixed, widths: natural, order }).sort((a, b) => shownOrder.current.indexOf(a) - shownOrder.current.indexOf(b)); // 메뉴에는 상태바에 놓인 순서대로
    for (const slot of slots) slot.toggleAttribute('data-folded', next.includes(slot.dataset.slot!));
    const key = next.join(',');
    if (key !== applied.current) { applied.current = key; setFolded(next); }
  }, [bar, orderKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const footer = bar.current; if (!footer) return;
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; fit(); }); };
    fit();
    const resize = new ResizeObserver(schedule), mutate = new MutationObserver(schedule);
    resize.observe(footer);
    mutate.observe(footer, { childList: true, subtree: true, characterData: true });
    return () => { resize.disconnect(); mutate.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [bar, fit, ready]);
  return folded;
}

// "…" at the end of the right group: lists what was folded, with each item shown as it would be on the bar.
export function StatusMore({ ids, labels, nodes }: { ids: string[]; labels: Record<string, string>; nodes: Record<string, ReactNode> }) {
  const [open, setOpen] = useState(false), button = useRef<HTMLButtonElement>(null), [at, setAt] = useState<{ right: number; bottom: number } | null>(null);
  useEffect(() => { if (!ids.length) setOpen(false); }, [ids.length]);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (event.target instanceof Node && (button.current?.contains(event.target) || (event.target as Element).closest?.('.status-more-menu'))) return; setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('pointerdown', close, true); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', key); };
  }, [open]);
  if (!ids.length) return null;
  const names = ids.map(id => labels[id] ?? id).join(', ');
  return <>
    <button ref={button} type="button" className="status-more" data-tip={`창이 좁아 접힌 항목: ${names}`} aria-label={`상태바 항목 ${ids.length}개 더 보기: ${names}`} aria-haspopup="true" aria-expanded={open}
      onClick={() => { const box = button.current?.getBoundingClientRect(); if (box) setAt({ right: Math.max(8, innerWidth - box.right - 4), bottom: innerHeight - box.top + 6 }); setOpen(value => !value); }}><Icon name="more" size={14} /></button>
    {open && at && <div className="status-more-menu" role="group" aria-label="접힌 상태바 항목" style={{ right: at.right, bottom: at.bottom }}>
      {ids.map(id => <div key={id} className="status-more-row"><span className="status-more-label">{labels[id] ?? id}</span><span className="status-more-node">{nodes[id]}</span></div>)}
    </div>}
  </>;
}
