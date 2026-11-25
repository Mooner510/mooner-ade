import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './Icon';
import { Modal } from './views';
import { canvasTransform, clampPanZoomScale, fitPanZoomScale, type PanZoomTransform } from './mermaid-pan-zoom';

export function MermaidViewerModal({ svg, onClose }: { svg: string; onClose(): void }) {
  const titleId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ w: 0, h: 0, svgW: 0, svgH: 0 });
  const [transform, setTransform] = useState<PanZoomTransform | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; origin: PanZoomTransform } | null>(null);
  const { w, h, svgW, svgH } = dimensions;
  const fitScale = fitPanZoomScale(w, h, { w: svgW, h: svgH });
  const current = transform ?? { panX: 0, panY: 0, scale: fitScale };

  useEffect(() => {
    const view = viewport.current, element = canvas.current?.querySelector('svg');
    if (!view || !element) return;
    // SVG viewBox coordinates can start away from zero. Measure the rendered element in CSS pixels.
    const measure = () => {
      if (!view.clientWidth || !view.clientHeight || !element.clientWidth || !element.clientHeight) return;
      setDimensions({ w: view.clientWidth, h: view.clientHeight, svgW: element.clientWidth, svgH: element.clientHeight });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(view);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [svg]);

  const zoomBy = useCallback((factor: number) => {
    setTransform(previous => {
      const value = previous ?? { panX: 0, panY: 0, scale: fitScale };
      return { ...value, scale: clampPanZoomScale(value.scale * factor, fitScale) };
    });
  }, [fitScale]);

  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.deltaY) zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    view.addEventListener('wheel', wheel, { passive: false });
    return () => view.removeEventListener('wheel', wheel);
  }, [zoomBy]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: current };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setTransform({ ...start.origin, panX: start.origin.panX + event.clientX - start.x, panY: start.origin.panY + event.clientY - start.y });
  };

  // 키보드만으로도 보게: 화살표로 옮기고, + −로 확대·축소, 0으로 맞춤(마우스 끌기·휠과 같은 동작).
  const keyView = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const step = event.shiftKey ? 120 : 40, move = (dx: number, dy: number) => { event.preventDefault(); setTransform({ ...current, panX: current.panX + dx, panY: current.panY + dy }); };
    if (event.key === 'ArrowLeft') move(step, 0); else if (event.key === 'ArrowRight') move(-step, 0); else if (event.key === 'ArrowUp') move(0, step); else if (event.key === 'ArrowDown') move(0, -step);
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.15); } else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(1 / 1.15); } else if (event.key === '0') { event.preventDefault(); setTransform(null); }
  };
  return createPortal(<Modal className="mermaid-modal" labelledBy={titleId} region="다이어그램" onClose={onClose}>
    <header className="mermaid-modal-head">
      <h2 id={titleId}>다이어그램</h2>
      <div className="mermaid-modal-actions">
        <div className="mermaid-viewer-tools" role="group" aria-label="확대/축소">
          <button type="button" aria-label="축소" onClick={() => zoomBy(1 / 1.15)}>−</button>
          <button type="button" onClick={() => setTransform(null)}>맞춤</button>
          <button type="button" aria-label="확대" onClick={() => zoomBy(1.15)}>+</button>
        </div>
        <IconButton icon="x" label="닫기" onClick={onClose} />
      </div>
    </header>
    <div ref={viewport} className="mermaid-viewer-viewport" tabIndex={0} role="group" aria-label="다이어그램 (화살표: 이동, + −: 확대/축소, 0: 맞춤)" onKeyDown={keyView} onPointerDown={startDrag} onPointerMove={moveDrag}
      onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) drag.current = null; }}>
      <div ref={canvas} className="mermaid-viewer-canvas" style={w ? { transform: canvasTransform(w, h, { w: svgW, h: svgH }, current) } : undefined} dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  </Modal>, document.body);
}
