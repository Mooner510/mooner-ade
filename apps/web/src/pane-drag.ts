import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dragHolds, dragPlace, isLeaf, placeLeaf, type Pane } from './api';

type Target = { id: string; rect: DOMRect; axis: 'row' | 'column'; header: number };
type Place = ReturnType<typeof dragPlace>;
const paneScale = (host: HTMLElement) => parseFloat(getComputedStyle(host).scale) || 1;
type Shot = { rects: Map<HTMLDivElement, { rect: DOMRect; scale: number }>; focused: HTMLElement | null };
const distance = (rect: DOMRect, x: number, y: number) =>
  Math.hypot(Math.max(rect.left - x, x - rect.right, 0), Math.max(rect.top - y, y - rect.bottom, 0));
const paneFrame = (origin: DOMRect, rect: DOMRect, scale = 1) => ({
  width: `${rect.width / scale}px`,
  height: `${rect.height / scale}px`,
  translate: `${rect.x - origin.x}px ${rect.y - origin.y}px`,
  scale: String(scale),
});

function copyPaneContent(content: HTMLElement) {
  const copy = content.cloneNode(true) as HTMLElement;
  copy.inert = true;
  const scroll: { node: Element; left: number; top: number }[] = [];
  const originals = [content, ...content.querySelectorAll('*')];
  [copy, ...copy.querySelectorAll('*')].forEach((node, index) => {
    const original = originals[index];
    node.removeAttribute('id');
    if (original.matches('.chat-scroll, .chat-agent-drawer-body, .xterm-host, .xterm-viewport')) {
      scroll.push({ node, left: original.scrollLeft, top: original.scrollTop });
    }
    if (node instanceof HTMLIFrameElement && original instanceof HTMLIFrameElement) {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = original.style.cssText;
      node.replaceWith(placeholder);
    }
    // shortcut: WebGL canvases can have cleared buffers; use a renderer snapshot if terminal fidelity is needed.
    if (node instanceof HTMLCanvasElement && original instanceof HTMLCanvasElement && original.width && original.height) {
      node.getContext('2d')?.drawImage(original, 0, 0);
    }
  });
  return { copy, scroll };
}

export function usePaneDrag(pane: Pane, onLayout: (pane: Pane) => void, visible: boolean, zoom: string, hosts: Map<string, HTMLDivElement>) {
  const pageRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Pane | null>(null);
  const latest = useRef({ pane, onLayout, visible, zoom });
  latest.current = { pane, onLayout, visible, zoom };
  const cancelDrag = useRef<() => void>(() => {});
  const before = useRef<Shot | null>(null);
  const animations = useRef(new Map<HTMLDivElement, Animation>()).current;
  const dropCopy = useRef<ReturnType<typeof copyPaneContent> | null>(null);

  const origins = useRef(new Map<HTMLDivElement, DOMRect>()).current;
  useLayoutEffect(() => {
    if (!preview) return;
    const slots = [...pageRef.current!.querySelectorAll<HTMLElement>('[data-preview-leaf]')];
    const rects = slots.map(slot => slot.getBoundingClientRect());
    for (const [index, slot] of slots.entries()) {
      const host = hosts.get(slot.dataset.previewLeaf!);
      const from = host && origins.get(host);
      if (!host || !from) continue;
      const { width, height, translate } = paneFrame(from, rects[index]);
      host.style.width = width;
      host.style.height = height;
      const held = host.hasAttribute('data-pane-drag-source');
      slot.toggleAttribute('data-pane-drop-slot', held);
      if (!held) host.style.translate = translate;
      const snapshot = dropCopy.current;
      if (held && snapshot && snapshot.copy.parentElement !== slot) {
        slot.append(snapshot.copy);
        for (const { node, left, top } of snapshot.scroll) node.scrollTo({ left, top, behavior: 'instant' });
      }
    }
  }, [preview, hosts, origins]);
  useLayoutEffect(() => { cancelDrag.current(); }, [pane, visible, zoom]);
  useLayoutEffect(() => {
    const previous = before.current;
    if (!previous || preview) return;
    before.current = null;
    for (const animation of animations.values()) animation.cancel();
    animations.clear();
    if (previous.focused?.isConnected && document.activeElement === document.body) {
      previous.focused.focus({ preventScroll: true });
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const [host, { rect: from, scale }] of previous.rects) {
      if (!host.isConnected) continue;
      const to = host.getBoundingClientRect();
      if (!to.width || !to.height || (scale === 1 && Math.abs(from.x - to.x) + Math.abs(from.y - to.y)
        + Math.abs(from.width - to.width) + Math.abs(from.height - to.height) < 1)) continue;
      const animation = host.animate([
        paneFrame(to, from, scale),
        paneFrame(to, to)
      ], { duration: 250, easing: 'cubic-bezier(.2,.85,.3,1.12)' });
      animations.set(host, animation);
      animation.onfinish = () => { if (animations.get(host) === animation) animations.delete(host); };
    }
  });

  useEffect(() => {
    const page = pageRef.current!;
    const paintedRects = () => new Map([...hosts.values()].map(host => [host, { rect: host.getBoundingClientRect(), scale: paneScale(host) }]));
    const rememberPositions = () => {
      const focused = document.activeElement;
      before.current = {
        rects: paintedRects(),
        focused: focused instanceof HTMLElement && page.contains(focused) ? focused : null
      };
    };
    const down = (event: PointerEvent) => {
      const { pane: base, visible, zoom } = latest.current;
      if (!visible || zoom || isLeaf(base) || event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return;
      if (event.target.closest('button, input, textarea, select, a, [role="button"], .divider')) return;
      const header = event.target.closest('.pane-tools, .tab-strip');
      const id = header?.closest<HTMLElement>('[data-leaf]')?.dataset.leaf;
      const source = id && hosts.get(id);
      if (!header || !id || !source) return;

      const { clientX: startX, clientY: startY, pointerId } = event;
      let x = startX, y = startY, frame = 0, bounds: DOMRect;
      let targets: Target[] = [], last: Target | undefined, place: Place | undefined;
      const grabbed = source.getBoundingClientRect();
      const grabX = (startX - grabbed.left) / grabbed.width, grabY = (startY - grabbed.top) / paneScale(source);
      let pickup: DOMRect | undefined;
      let proposed: Pane = base;
      const choose = () => {
        if (distance(bounds, x, y) > 0) { last = undefined; place = undefined; return base; }
        // Hit-test the layout at pickup so the moving panels cannot move their own drop zones.
        let target = last;
        if (!target || distance(target.rect, x, y) > 6) {
          target = undefined;
          let nearest = Infinity;
          for (const entry of targets) {
            const gap = distance(entry.rect, x, y);
            if (gap < nearest) { target = entry; nearest = gap; }
          }
        }
        if (!target || target.id === id) { last = target; place = undefined; return base; }
        const fx = (x - target.rect.left) / target.rect.width;
        const fy = (y - target.rect.top) / target.rect.height;
        const side: Place = target === last && place && dragHolds(place, fx, fy, target.header)
          ? place : dragPlace(fx, fy, target.axis, target.header);
        if (target === last && place?.how === side.how && place.axis === side.axis) return proposed;
        last = target; place = side;
        return placeLeaf(base, id, target.id, side.how, side.axis);
      };
      const update = () => {
        frame = 0;
        if (!pickup) return;
        // CSS applies this pointer translation before scaling the local grip offset.
        source.style.translate = `${x - pickup.x}px ${y - pickup.y}px`;
        const next = choose();
        if (next !== proposed) {
          proposed = next;
          setPreview(next);
        }
      };
      const move = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        x = e.clientX; y = e.clientY;
        if (!pickup) {
          if (Math.hypot(x - startX, y - startY) < 5) return;
          const painted = paintedRects();
          // A split can still be opening, or the previous drop may still be settling.
          for (const slot of page.querySelectorAll('.split-slot[data-fresh]')) {
            for (const animation of slot.getAnimations()) animation.finish();
          }
          bounds = page.getBoundingClientRect();
          targets = [...page.querySelectorAll<HTMLElement>('.split-slot[data-leaf]')].flatMap(slot => {
            const leaf = slot.dataset.leaf;
            const host = leaf && hosts.get(leaf);
            if (!host) return [];
            const rect = slot.getBoundingClientRect();
            if (!rect.width || !rect.height) return [];
            const headerHeight = host.querySelector<HTMLElement>('.pane-tools, .tab-strip')?.offsetHeight ?? 0;
            return [{ id: leaf, rect, axis: slot.dataset.dir === 'column' ? 'column' : 'row', header: Math.min(.5, headerHeight / rect.height) }];
          });
          for (const host of hosts.values()) {
            const origin = host.parentElement?.getBoundingClientRect();
            if (origin?.width && origin.height) origins.set(host, origin);
          }
          const origin = origins.get(source);
          if (!origin) { origins.clear(); cancel(); return; }
          pickup = origin;
          for (const animation of animations.values()) animation.cancel();
          animations.clear();
          for (const [host, origin] of origins) {
            const { rect, scale } = painted.get(host)!;
            Object.assign(host.style, paneFrame(origin, rect, scale));
          }
          void source.offsetWidth; // Start the pickup transition at the last painted scale.
          for (const host of origins.keys()) host.style.scale = '';
          source.style.transform = `translate(${-grabX * 100}%, ${-grabY}px)`;
          page.dataset.paneDragging = '';
          source.dataset.paneDragSource = '';
          document.body.classList.add('pane-dragging');
          try { page.setPointerCapture(pointerId); } catch { cancel(); return; }
          const content = source.firstElementChild;
          if (content instanceof HTMLElement) dropCopy.current = copyPaneContent(content);
          setPreview(base);
          update();
        } else if (!frame) {
          frame = requestAnimationFrame(update);
        }
        e.preventDefault();
      };
      const finish = (next: Pane) => {
        cancelDrag.current = () => {};
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', abortPointer);
        window.removeEventListener('keydown', key, true);
        window.removeEventListener('resize', cancel);
        window.removeEventListener('blur', cancel);
        page.removeEventListener('lostpointercapture', abortPointer);
        try { if (page.hasPointerCapture(pointerId)) page.releasePointerCapture(pointerId); } catch { /* pointer already gone */ }
        if (!pickup) return;
        cancelAnimationFrame(frame);
        rememberPositions();
        delete page.dataset.paneDragging;
        for (const host of origins.keys()) Object.assign(host.style, { translate: '', transform: '', width: '', height: '' });
        origins.clear();
        delete source.dataset.paneDragSource;
        document.body.classList.remove('pane-dragging');
        dropCopy.current = null;
        setPreview(null);
        if (next !== base) latest.current.onLayout(next);
      };
      const cancel = () => finish(base);
      const abortPointer = (e: PointerEvent) => { if (e.pointerId === pointerId) cancel(); };
      const key = (e: KeyboardEvent) => {
        if (e.key !== 'Escape' || !pickup) return;
        e.preventDefault(); e.stopPropagation(); cancel();
      };
      const up = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        x = e.clientX; y = e.clientY;
        finish(pickup ? choose() : base);
      };
      cancelDrag.current();
      cancelDrag.current = cancel;
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', abortPointer);
      window.addEventListener('keydown', key, true);
      window.addEventListener('resize', cancel);
      window.addEventListener('blur', cancel);
      page.addEventListener('lostpointercapture', abortPointer);
    };
    page.addEventListener('pointerdown', down, true);
    return () => {
      page.removeEventListener('pointerdown', down, true);
      cancelDrag.current();
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
    };
  }, [hosts, animations, origins]);
  return { preview, pageRef };
}
