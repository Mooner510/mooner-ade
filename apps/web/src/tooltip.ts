// One tooltip for the whole app. Any element with a `title` (the browser's slow, unstyled tooltip), an SVG `<title>` child (chart points) or a `data-tip` shows this one instead, so no
// component has to opt in and a new `title` is covered automatically. `data-tip-overflow` shows clipped text in full. It lives in the top layer (popover), so it also sits above dialogs and
// is never clipped by an `overflow: hidden` parent, and it keeps itself inside the window (flipping above the element when there is no room below).
// Write tooltip copy as short labels, values and shortcuts.
const SHOW_DELAY = 0, GAP = 6, MARGIN = 6;

// "라벨 (⌘⇧G)" / "라벨 (Ctrl+Shift+G)": a trailing parenthesis that holds only key names is drawn as keycaps (the app's showCombo/showAppKey format, so a custom binding shows as set).
// Anything else in parentheses ("(Fetch)", "(/clear)") stays text. Every line of the tooltip is checked on its own.
const KEY = /^(?:[⌘⌃⌥⇧↑↓←→]|Ctrl|Shift|Alt|Win|Meta|Esc|Tab|Enter|Space|Backspace|Delete|Home|End|PageUp|PageDown|Insert|F\d{1,2}|화살표|[A-Za-z0-9`\\,./;'\[\]=-])$/;
const keysOf = (combo: string) => { const parts = combo.includes('+') && combo.length > 1 ? combo.split('+') : [...combo.match(/^[⌘⌃⌥⇧]*/)![0], combo.replace(/^[⌘⌃⌥⇧]*/, '')].filter(Boolean); return parts.length && parts.every(part => KEY.test(part)) ? parts : null; };
const shortcut = /^(.*?)\s*\(([^()]+)\)$/;
const normalized = (text: string) => text.trim().replace(/\s+/g, ' ');

export function tooltipCopy(text: string, visible: string) {
  const seen = new Set([normalized(visible), ...visible.split('\n').map(normalized)]);
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || seen.has(normalized(line))) continue;
    const keys = shortcut.exec(line);
    const copy = keys && keysOf(keys[2]) && seen.has(normalized(keys[1])) ? `(${keys[2]})` : line;
    if (seen.has(normalized(copy))) continue;
    lines.push(copy);
    seen.add(normalized(copy));
  }
  return lines.join('\n');
}

function fill(box: HTMLElement, text: string) {
  box.replaceChildren(...text.split('\n').flatMap((line, index) => {
    const found = shortcut.exec(line), keys = found ? keysOf(found[2]) : null;
    const nodes: (Node | string)[] = index ? ['\n'] : [];
    if (!found || !keys) return [...nodes, line];
    return [...nodes, found[1], ...keys.map(key => Object.assign(document.createElement('kbd'), { textContent: key }))];
  }));
}

const clipsText = (element: Element) => element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight;
// A text field's visible text is its value, not text nodes. It counts as clipped only when the value is wider than the box, so a field that shows its whole value gets no tooltip.
const TEXT_FIELDS = new Set(['text', 'search', 'url', 'tel', 'email']);
const fieldOf = (element: Element) => element instanceof HTMLInputElement && TEXT_FIELDS.has(element.type) ? element : null;
const fieldClips = (field: HTMLInputElement) => {
  const style = getComputedStyle(field), context = document.createElement('canvas').getContext('2d');
  if (!context) return false;
  context.font = style.font;
  return context.measureText(field.value).width > field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
};

function renderedText(element: Element, includeOverflow = false) {
  // Text ranges exclude labels hidden by responsive styles without reading decorative icon glyphs as labels.
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), range = document.createRange();
  const labels: string[] = [];
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const parent = text.parentElement;
    if (!text.textContent?.trim() || !parent || parent.closest('[aria-hidden="true"]')) continue;
    const overflow = parent.closest('[data-tip-overflow]');
    if (!includeOverflow && overflow && element.contains(overflow) && clipsText(overflow)) continue;
    range.selectNodeContents(text);
    if ([...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0) && getComputedStyle(parent).visibility === 'visible') labels.push(text.textContent);
  }
  return labels;
}

let installed = false;
export function installTooltips() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const tip = document.createElement('div');
  tip.className = 'app-tooltip'; tip.id = 'app-tooltip'; tip.setAttribute('popover', 'manual'); tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  let anchor: Element | null = null, muted: Element | null = null, taken: string | null = null, takenNode: Element | null = null, timer = 0, frame = 0;

  const svgTitle = (node: Element) => node instanceof SVGElement ? [...node.children].find(child => child.localName === 'title' && child instanceof SVGElement) ?? null : null;
  const sourceOf = (element: Element | null): Element | null => {
    // The anchor's own title is held back while its tooltip is up, so it no longer shows an attribute: without this a move onto its icon child (or any move at all) finds no source, hides, gives the title back and shows again = flicker.
    for (let node = element; node; node = node.parentElement) {
      if (node.hasAttribute('data-tip-overflow')) {
        if (node.scrollWidth > node.clientWidth) return node;
      } else if (node === anchor || (node as HTMLElement).dataset?.tip || node.getAttribute('title') || svgTitle(node)) return node;
    }
    return null;
  };
  // The native tooltip must not also appear: the title is held back while ours is up (or pending) and put back afterwards, unless the app has set a new one meanwhile.
  const release = () => {
    if (anchor && taken !== null && !anchor.hasAttribute('title')) anchor.setAttribute('title', taken);
    if (anchor && takenNode && !takenNode.isConnected) anchor.prepend(takenNode); // the same node goes back, so React keeps its reference
    taken = null; takenNode = null;
  };
  const hide = (keepOpen = false) => {
    clearTimeout(timer); cancelAnimationFrame(frame);
    if (!keepOpen && tip.matches(':popover-open')) tip.hidePopover();
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
    const overflow = element.hasAttribute('data-tip-overflow');
    const text = overflow ? renderedText(element, true).join(' ') : (element as HTMLElement).dataset?.tip ?? taken ?? takenNode?.textContent;
    if (!text) { hide(); return; }
    const field = fieldOf(element), clipped = overflow || (field ? fieldClips(field) : clipsText(element));
    const copy = tooltipCopy(text, clipped ? '' : field ? field.value : renderedText(element).join('\n'));
    if (!copy) {
      // Keep the native title suspended on this anchor until the pointer or focus leaves it.
      if (tip.matches(':popover-open')) tip.hidePopover();
      return;
    }
    fill(tip, copy);
    // data-tip-nowrap: a single line (a path), kept inside the window by the CSS for .nowrap.
    tip.classList.toggle('nowrap', element.hasAttribute('data-tip-nowrap'));
    if (!tip.matches(':popover-open')) tip.showPopover();
    place(element);
    // An element that is re-rendered away while its tooltip is showing never fires a leave event.
    const watch = () => { if (!anchor || !anchor.isConnected) hide(); else frame = requestAnimationFrame(watch); };
    frame = requestAnimationFrame(watch);
  };
  const open = (element: Element, delay: number) => {
    if (element === anchor) return;
    hide(delay === 0); // moving straight to another element: the box stays up and only changes text and place
    anchor = element;
    if (element.hasAttribute('title')) { taken = element.getAttribute('title'); element.removeAttribute('title'); }
    else { takenNode = svgTitle(element); takenNode?.remove(); }
    if (delay) timer = window.setTimeout(() => reveal(element), delay); else reveal(element);
  };

  // pointermove, not pointerover: after a hide (scroll, key, the element re-rendered away) the pointer is still on the element and no new pointerover would come.
  document.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    const element = sourceOf(event.target as Element | null);
    if (element !== muted) muted = null;
    if (element === anchor || (element && element === muted)) return;
    if (!element) { hide(); return; }
    // Moving between children of one element keeps its tooltip; moving to another element's replaces it at once if one is already showing.
    open(element, tip.matches(':popover-open') ? 0 : SHOW_DELAY);
  }, true);
  document.documentElement.addEventListener('pointerleave', () => hide());
  // A press (click, drag, context menu) hides it until the pointer has left that element; scrolling, keys and the like only hide it and the next move brings it back.
  for (const type of ['pointerdown', 'contextmenu', 'dragstart'] as const) document.addEventListener(type, event => { muted = sourceOf(event.target as Element | null); hide(); }, { capture: true, passive: true });
  for (const type of ['keydown', 'wheel'] as const) document.addEventListener(type, () => hide(), { capture: true, passive: true });
  // Only a scroll that moves the anchor hides it: a chat streaming in or a list refreshing elsewhere must not keep killing the tooltip under the pointer.
  document.addEventListener('scroll', event => { if (anchor && (event.target as Node).contains?.(anchor)) hide(); }, { capture: true, passive: true });
  window.addEventListener('blur', () => hide());
  // Keyboard users get it too, but only for keyboard focus (a click focuses a button as well, and must not pop a tooltip).
  document.addEventListener('focusin', event => { const element = sourceOf(event.target as Element | null); if (element && (event.target as Element).matches(':focus-visible')) open(element, 0); }, true);
  document.addEventListener('focusout', () => hide(), true);
}
