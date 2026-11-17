// One tooltip for the whole app. Any element with a `title` (the browser's slow, unstyled tooltip), an SVG `<title>` child (chart points) or a `data-tip` shows this one instead, so no
// component has to opt in and a new `title` is covered automatically. It lives in the top layer (popover), so it also sits above dialogs and
// is never clipped by an `overflow: hidden` parent, and it keeps itself inside the window (flipping above the element when there is no room below).
const SHOW_DELAY = 150, GAP = 6, MARGIN = 6;

let installed = false;
export function installTooltips() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const tip = document.createElement('div');
  tip.className = 'app-tooltip'; tip.id = 'app-tooltip'; tip.setAttribute('popover', 'manual'); tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  let anchor: Element | null = null, taken: string | null = null, takenNode: Element | null = null, timer = 0, frame = 0;

  const svgTitle = (node: Element) => node instanceof SVGElement ? [...node.children].find(child => child.localName === 'title' && child instanceof SVGElement) ?? null : null;
  const sourceOf = (element: Element | null): Element | null => {
    for (let node = element; node; node = node.parentElement) if ((node as HTMLElement).dataset?.tip || node.getAttribute('title') || svgTitle(node)) return node;
    return null;
  };
  // The native tooltip must not also appear: the title is held back while ours is up (or pending) and put back afterwards, unless the app has set a new one meanwhile.
  const release = () => {
    if (anchor && taken !== null && !anchor.hasAttribute('title')) anchor.setAttribute('title', taken);
    if (anchor && takenNode && !takenNode.isConnected) anchor.prepend(takenNode); // the same node goes back, so React keeps its reference
    taken = null; takenNode = null;
  };
  const hide = () => {
    clearTimeout(timer); cancelAnimationFrame(frame);
    if (tip.matches(':popover-open')) tip.hidePopover();
    release(); anchor = null;
  };
  const place = (element: Element) => {
    const rect = element.getBoundingClientRect(), box = tip.getBoundingClientRect(), width = window.innerWidth, height = window.innerHeight;
    const left = Math.min(Math.max(MARGIN, rect.left + rect.width / 2 - box.width / 2), Math.max(MARGIN, width - box.width - MARGIN));
    let top = rect.bottom + GAP;
    if (top + box.height > height - MARGIN) top = Math.max(MARGIN, rect.top - box.height - GAP);
    tip.style.left = `${Math.round(left)}px`; tip.style.top = `${Math.round(top)}px`;
  };
  const reveal = (element: Element) => {
    if (anchor !== element || !element.isConnected) return;
    const text = (element as HTMLElement).dataset?.tip ?? taken ?? takenNode?.textContent ?? '';
    if (!text) return;
    tip.textContent = text;
    if (!tip.matches(':popover-open')) tip.showPopover();
    place(element);
    // An element that is re-rendered away while its tooltip is showing never fires a leave event.
    const watch = () => { if (!anchor || !anchor.isConnected) hide(); else frame = requestAnimationFrame(watch); };
    frame = requestAnimationFrame(watch);
  };
  const open = (element: Element, delay: number) => {
    if (element === anchor) return;
    hide();
    anchor = element;
    if (!(element as HTMLElement).dataset?.tip) {
      if (element.hasAttribute('title')) { taken = element.getAttribute('title'); element.removeAttribute('title'); }
      else { takenNode = svgTitle(element); takenNode?.remove(); }
    }
    if (delay) timer = window.setTimeout(() => reveal(element), delay); else reveal(element);
  };

  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const element = sourceOf(event.target as Element | null);
    if (element === anchor) return;
    if (!element) { hide(); return; }
    // Moving between children of one element keeps its tooltip; moving to another element's replaces it at once if one is already showing.
    open(element, tip.matches(':popover-open') ? 0 : SHOW_DELAY);
  }, true);
  document.documentElement.addEventListener('pointerleave', hide);
  for (const type of ['pointerdown', 'keydown', 'wheel', 'contextmenu', 'dragstart', 'scroll'] as const) document.addEventListener(type, hide, { capture: true, passive: true });
  window.addEventListener('blur', hide);
  // Keyboard users get it too, but only for keyboard focus (a click focuses a button as well, and must not pop a tooltip).
  document.addEventListener('focusin', event => { const element = sourceOf(event.target as Element | null); if (element && (event.target as Element).matches(':focus-visible')) open(element, 0); }, true);
  document.addEventListener('focusout', hide, true);
}
