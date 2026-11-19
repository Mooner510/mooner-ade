export type PanZoomTransform = { panX: number; panY: number; scale: number };
type Size = { w: number; h: number };

export function canvasTransform(vpW: number, vpH: number, size: Size, transform: PanZoomTransform) {
  const cx = vpW / 2, cy = vpH / 2;
  const { panX, panY, scale } = transform;
  return `translate(${cx + panX}px, ${cy + panY}px) scale(${scale}) translate(${-size.w / 2}px, ${-size.h / 2}px)`;
}

export const clampPanZoomScale = (scale: number, fitScale: number) => Math.min(4, Math.max(Math.min(0.15, fitScale), scale));

export function fitPanZoomScale(vpW: number, vpH: number, size: Size) {
  const vw = Math.max(1, vpW - 32), vh = Math.max(1, vpH - 32);
  return Math.min(1, vw / size.w, vh / size.h);
}
