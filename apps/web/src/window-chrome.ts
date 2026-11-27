// Positions that keep the UI clear of the window controls (Windows overlay buttons on the right, macOS traffic lights on the left,
// both inside the bar at the top). The CSS side is --win-top / --win-left / --win-edge (style.css).

// The bar's height in px: 40 in the desktop shell, 0 in a plain browser and on a phone. Measured through the CSS variable.
export function windowBarHeight(): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:0;height:var(--win-top, 0px)';
  document.body.append(probe);
  const height = probe.offsetHeight;
  probe.remove();
  return height;
}

// An error toast hangs under its button with `right` px to the window's right edge: it may be as wide as what is left of the window,
// or its left side would run off the screen (a long message with the button well inside the window).
export function errorToastMaxWidth(viewport: number, right: number, cap = 800, gap = 8, floor = 120): number {
  return Math.min(cap, Math.max(floor, viewport - right - gap));
}

// How far a dialog (centred at `top`..`bottom`) may be dragged up and down: its top edge stays under the bar (`reserve`) and its bottom
// edge above `bottomGap`. A dialog that already starts higher (a full-screen one) simply does not move up.
export function dialogYRange(top: number, bottom: number, viewportHeight: number, reserve: number, bottomGap = 0): [number, number] {
  return [Math.min(reserve - top, 0), viewportHeight - bottomGap - bottom];
}

// The lowest y a floating card may start at: `margin` from the edge, or just under the bar when the window has controls there.
export function cardTopLimit(margin: number, reserve: number, gap = 4): number {
  return Math.max(margin, reserve > 0 ? reserve + gap : 0);
}
