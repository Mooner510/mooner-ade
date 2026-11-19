import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasTransform, clampPanZoomScale, fitPanZoomScale } from '../apps/web/src/mermaid-pan-zoom.ts';

test('mermaid pan/zoom keeps viewport-center translate when only scale changes', () => {
  const size = { w: 1000, h: 400 };
  const vpW = 800, vpH = 400;
  const parseOrigin = (s) => {
    const m = s.match(/^translate\(([-\d.]+)px, ([-\d.]+)px\) scale/);
    return { x: Number(m[1]), y: Number(m[2]) };
  };
  const fit = parseOrigin(canvasTransform(vpW, vpH, size, { panX: 0, panY: 0, scale: 0.35 }));
  const zoomed = parseOrigin(canvasTransform(vpW, vpH, size, { panX: 0, panY: 0, scale: 0.7 }));
  assert.equal(fit.x, zoomed.x);
  assert.equal(fit.y, zoomed.y);
});

test('centers the rendered SVG box and preserves the midpoint when zoomed', () => {
  const size = { w: 650, h: 423 };
  const t = canvasTransform(910, 564, size, { panX: 0, panY: 0, scale: 1.25 });
  assert.equal(t, 'translate(455px, 282px) scale(1.25) translate(-325px, -211.5px)');
});

test('fits large diagrams on narrow viewports and zooms in from the fitted scale', () => {
  const fit = fitPanZoomScale(352, 500, { w: 4000, h: 500 });
  assert.equal(fit, 0.08);
  assert.equal(clampPanZoomScale(fit * 1.15, fit), fit * 1.15);
  assert.equal(clampPanZoomScale(fit / 1.15, fit), fit);
});
