import { useEffect, useId, useMemo, useState } from 'react';
import { IconButton } from './Icon';
import { cachedMermaidSvg, renderMermaidSvg } from './mermaid-render';
import { MermaidViewerModal } from './mermaid-viewer';
import { copyText } from './toast';

function colorScheme(): 'dark' | 'light' {
  return document.documentElement.dataset.scheme === 'light' ? 'light' : 'dark';
}

function useColorScheme() {
  const [scheme, setScheme] = useState(colorScheme);
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setScheme(colorScheme());
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-scheme'] });
    return () => observer.disconnect();
  }, []);
  return scheme;
}

let seq = 0;

export function MermaidBlock({ code }: { code: string }) {
  const reactId = useId().replace(/:/g, '');
  const scheme = useColorScheme();
  const [open, setOpen] = useState(false);
  // A diagram drawn before (remount, theme switched back) shows at once, without a "그리는 중" flash.
  const [svg, setSvg] = useState<string | null>(() => cachedMermaidSvg(code, scheme) ?? null);
  const [failed, setFailed] = useState(false);
  const preview = useMemo(() => svg ? `data:image/svg+xml,${encodeURIComponent(svg)}` : null, [svg]);

  useEffect(() => {
    let live = true;
    setFailed(false);
    const hit = cachedMermaidSvg(code, scheme);
    if (hit) setSvg(hit);
    else {
      setSvg(null);
      renderMermaidSvg(code, scheme, `ade-mermaid-${reactId}-${++seq}`).then(
        out => { if (live) setSvg(out); },
        () => { if (live) setFailed(true); });
    }
    return () => { live = false; };
  }, [code, reactId, scheme]);

  return <>
    <div className="md-mermaid">
      <header>
        <span>mermaid</span>
        <div className="md-mermaid-tools">
          {preview && <IconButton className="md-mermaid-expand" icon="maximize" label="다이어그램 크게 보기" size={13} onClick={() => setOpen(true)} />}
          {(preview || failed) && <IconButton className="md-mermaid-copy" icon="copy" label="Mermaid 코드 복사" size={13} onClick={() => copyText(code)} />}
        </div>
      </header>
      {preview ? <button type="button" className="md-mermaid-preview" tabIndex={-1} aria-label="다이어그램 크게 보기" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <img src={preview} alt="" draggable={false} onError={() => { setSvg(null); setFailed(true); }} />
      </button> : <div className="md-mermaid-status" role="status">
        {failed ? '다이어그램을 표시할 수 없습니다.' : '다이어그램 그리는 중…'}
      </div>}
    </div>
    {open && svg && <MermaidViewerModal svg={svg} onClose={() => setOpen(false)} />}
  </>;
}
