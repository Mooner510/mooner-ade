type MermaidModule = typeof import('mermaid');

let mermaidModule: MermaidModule | null = null;
let configuredScheme: 'dark' | 'light' | null = null;
let renderChain: Promise<unknown> = Promise.resolve();

async function loadMermaid(scheme: 'dark' | 'light') {
  if (!mermaidModule) mermaidModule = await import('mermaid');
  const mermaid = mermaidModule.default;
  if (configuredScheme !== scheme) {
    mermaid.initialize({
      startOnLoad: false,
      theme: scheme === 'light' ? 'default' : 'dark',
      securityLevel: 'strict',
      fontFamily: 'Inter Variable, Noto Sans KR Variable, Inter, Noto Sans KR, system-ui, sans-serif',
    });
    configuredScheme = scheme;
  }
  return mermaid;
}

// Finished SVGs by scheme and source: a repeated block, a remount, or the theme switched back is not drawn again.
// ponytail: a plain Map capped at 64 entries (oldest out), in memory only; add an LRU with byte sizes if memory ever matters.
const SVG_CACHE_MAX = 64;
const svgs = new Map<string, string>();
const jobs = new Map<string, Promise<string>>();
const keyOf = (code: string, scheme: 'dark' | 'light') => `${scheme}\n${code}`;

export function cachedMermaidSvg(code: string, scheme: 'dark' | 'light') {
  return svgs.get(keyOf(code, scheme));
}

export function renderMermaidSvg(code: string, scheme: 'dark' | 'light', id: string): Promise<string> {
  const key = keyOf(code, scheme);
  const done = svgs.get(key);
  if (done) return Promise.resolve(done);
  const pending = jobs.get(key);
  if (pending) return pending;
  const render = async () => {
    const mermaid = await loadMermaid(scheme);
    await mermaid.parse(code);
    // Without a container mermaid measures in a plain <div> appended to <body>, below the 100vh app: the page scrolls while it renders.
    const host = document.createElement('div');
    host.className = 'mermaid-measure';
    document.body.append(host);
    try {
      const { svg } = await mermaid.render(id, code, host);
      return normalizeMermaidSvg(svg);
    } finally {
      host.remove();
    }
  };
  const job = renderChain.then(render, render);
  renderChain = job.then(() => undefined, () => undefined);
  const tracked = job.then(svg => {
    svgs.set(key, svg);
    if (svgs.size > SVG_CACHE_MAX) svgs.delete(svgs.keys().next().value as string);
    return svg;
  }).finally(() => jobs.delete(key));
  jobs.set(key, tracked);
  return tracked;
}

// Mermaid often emits width/height 100%; inside our pan/zoom canvas the parent has no width yet, so the SVG paints at 0×0.
export function normalizeMermaidSvg(svg: string) {
  let out = svg
    .replace(/\swidth="100%[^"]*"/gi, '')
    .replace(/\sheight="100%[^"]*"/gi, '');
  out = out.replace(/\sstyle="([^"]*)"/gi, (_, style: string) => {
    const trimmed = style
      .replace(/(?:^|;)\s*max-width:\s*[^;]+/gi, '')
      .replace(/(?:^|;)\s*width:\s*100%[^;]*/gi, '')
      .replace(/(?:^|;)\s*height:\s*100%[^;]*/gi, '')
      .replace(/^\s*;\s*|\s*;\s*$/g, '')
      .trim();
    return trimmed ? ` style="${trimmed}"` : '';
  });
  const vb = out.match(/\bviewBox="([^"]+)"/i)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (vb?.length === 4 && vb[2] > 0 && vb[3] > 0) {
    const w = vb[2], h = vb[3];
    const open = out.match(/^<svg\b([^>]*)>/i);
    if (open) {
      const attrs = open[1];
      const hasW = /\bwidth="/i.test(attrs), hasH = /\bheight="/i.test(attrs);
      if (!hasW || !hasH) {
        const inject = `${!hasW ? ` width="${w}"` : ''}${!hasH ? ` height="${h}"` : ''}`;
        out = out.replace(/^<svg\b/i, `<svg${inject}`);
      }
    }
  }
  return out;
}