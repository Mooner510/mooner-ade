import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from './Icon';
import { Modal } from './views';
import { annotateColors, arrowHead, shapeTooSmall, strokeWidth, toNatural, type Shape, type ShapeKind } from './feedback-model';

// Draws boxes and arrows over a feedback image and saves the flattened PNG (base64, no data: prefix).
// Shapes are kept in the image's own pixels, so the stroke and the saved file do not depend on how large the dialog shows it.
export function AnnotateImage({ src, name, onSave, onClose }: { src: string; name: string; onSave(data: string): Promise<void>; onClose(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null), [failed, setFailed] = useState(false);
  const [tool, setTool] = useState<ShapeKind>('rect'), [color, setColor] = useState<string>(annotateColors[0].id);
  const [shapes, setShapes] = useState<Shape[]>([]), [draft, setDraft] = useState<Shape | null>(null), [saving, setSaving] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImage(img); img.onerror = () => setFailed(true);
    img.src = src;
  }, [src]);

  useEffect(() => {
    const element = canvas.current; if (!element || !image) return;
    const natural = { width: image.naturalWidth, height: image.naturalHeight };
    element.width = natural.width; element.height = natural.height;
    const context = element.getContext('2d')!, width = strokeWidth(natural);
    context.drawImage(image, 0, 0);
    context.lineWidth = width; context.lineCap = 'round'; context.lineJoin = 'round';
    for (const shape of draft ? [...shapes, draft] : shapes) {
      context.strokeStyle = shape.color;
      context.beginPath();
      if (shape.kind === 'rect') context.rect(Math.min(shape.from.x, shape.to.x), Math.min(shape.from.y, shape.to.y), Math.abs(shape.to.x - shape.from.x), Math.abs(shape.to.y - shape.from.y));
      else {
        const [a, b] = arrowHead(shape.from, shape.to, width * 5);
        context.moveTo(shape.from.x, shape.from.y); context.lineTo(shape.to.x, shape.to.y);
        context.moveTo(a.x, a.y); context.lineTo(shape.to.x, shape.to.y); context.lineTo(b.x, b.y);
      }
      context.stroke();
    }
  }, [image, shapes, draft]);

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return toNatural({ x: event.clientX - box.left, y: event.clientY - box.top }, box, { width: image!.naturalWidth, height: image!.naturalHeight });
  };
  const save = async () => {
    if (!canvas.current) return;
    setSaving(true);
    try { const url = canvas.current.toDataURL('image/png'); await onSave(url.slice(url.indexOf(',') + 1)); onClose(); }
    finally { setSaving(false); }
  };
  return <Modal className="feedback-annotate" labelledBy="feedback-annotate-title" onClose={() => { if (!saving) onClose(); }}>
    <header className="feedback-annotate-head">
      <strong id="feedback-annotate-title">이미지에 표시 · {name}</strong>
      <span className="spacer" />
      <div className="feedback-tools" role="group" aria-label="도구">
        <button type="button" aria-pressed={tool === 'rect'} onClick={() => setTool('rect')}><Icon name="shapeRect" size={15} />사각형</button>
        <button type="button" aria-pressed={tool === 'arrow'} onClick={() => setTool('arrow')}><Icon name="shapeArrow" size={15} />화살표</button>
      </div>
      <div className="feedback-tools" role="group" aria-label="색">
        {annotateColors.map(item => <button key={item.id} type="button" className="feedback-swatch" aria-pressed={color === item.id} aria-label={item.label} title={item.label} onClick={() => setColor(item.id)}><i style={{ background: item.id }} /></button>)}
      </div>
      <button type="button" disabled={!shapes.length} onClick={() => setShapes(list => list.slice(0, -1))}><Icon name="undo" size={15} />되돌리기</button>
      <button type="button" disabled={!shapes.length} onClick={() => setShapes([])}>모두 지우기</button>
    </header>
    <div className="feedback-annotate-stage">
      {failed ? <p className="hint">이미지를 불러오지 못했습니다.</p> : !image ? <p className="hint">불러오는 중…</p>
        : <canvas ref={canvas} aria-label="표시할 위치를 끌어서 그리세요"
          onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); const at = point(event); setDraft({ kind: tool, color, from: at, to: at }); }}
          onPointerMove={event => { if (draft) setDraft({ ...draft, to: point(event) }); }}
          onPointerUp={() => { if (draft && image && !shapeTooSmall(draft, strokeWidth({ width: image.naturalWidth, height: image.naturalHeight }) * 2)) setShapes(list => [...list, draft]); setDraft(null); }}
          onPointerCancel={() => setDraft(null)} />}
    </div>
    <div className="actions feedback-annotate-actions">
      <span className="hint">끌어서 그립니다. 저장하면 원본은 따로 보관되어 언제든 되돌릴 수 있습니다.</span>
      <span className="spacer" />
      <button type="button" disabled={saving} onClick={onClose}>취소</button>
      <button type="button" className="primary" disabled={saving || !image || !shapes.length} onClick={() => void save().catch(() => {})}>{saving ? '저장 중…' : '저장'}</button>
    </div>
  </Modal>;
}
