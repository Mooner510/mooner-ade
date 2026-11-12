// The page inside an interactive chat UI's iframe (GET /ade-ui-frame.html). The reply's HTML is model-written and runs here, so this page is its whole world:
// the CSP header below allows inline script/style and nothing else (no network, no frames, no forms), and `sandbox` keeps it on an opaque origin
// even when someone opens the URL directly. It holds no secret, which is why the route is served without the session cookie.
export const UI_FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

// Runs inside the written document, before the reply's own markup: the `ade` API and the height report.
// Both functions below are stringified into the page, so they must stay self-contained (no imports, no outer variables).
function runtime() {
  const post = message => parent.postMessage({ ade: 1, ...message }, '*');
  // `send` needs a real click/keypress in this frame (userActivation), so a script cannot fire follow-up requests on its own.
  window.ade = {
    send: text => { if (navigator.userActivation && !navigator.userActivation.isActive) return false; post({ type: 'send', text: String(text) }); return true; },
    prefill: text => post({ type: 'prefill', text: String(text) }),
  };
  const report = () => post({ type: 'height', height: document.body.getBoundingClientRect().height });
  addEventListener('DOMContentLoaded', () => { new ResizeObserver(report).observe(document.body); report(); });
  addEventListener('load', report);
}

function shell(runtimeSource) {
  const base = 'html{color-scheme:var(--scheme,dark)}body{margin:0;padding:12px;background:transparent;color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}'
    + '*{box-sizing:border-box}h1,h2,h3{margin:.2em 0 .5em;line-height:1.3}'
    + 'button,input,select,textarea{font:inherit;color:var(--fg);background:var(--input);border:1px solid var(--border-strong);border-radius:6px;padding:5px 9px}'
    + 'button{cursor:pointer;background:var(--raised)}button:hover{border-color:var(--accent)}button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}'
    + 'input:focus,select:focus,textarea:focus,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}'
    + 'table{border-collapse:collapse}th,td{border:1px solid var(--border);padding:4px 8px}code,pre{font-family:var(--mono,monospace)}';
  let done = false;
  addEventListener('message', event => {
    const data = event.data;
    if (done || event.source !== parent || !data || data.ade !== 1 || data.type !== 'init' || typeof data.html !== 'string') return;
    done = true;
    const vars = Object.entries(data.theme || {}).filter(([key, value]) => /^--[\w-]+$/.test(key) && typeof value === 'string').map(([key, value]) => `${key}:${value.replace(/[;{}<]/g, '')}`).join(';');
    // document.write (not innerHTML) so the reply's <script> tags run; the runtime is part of the written text because open() clears this page's listeners.
    document.open();
    document.write(`<!doctype html><meta charset="utf-8"><style>:root{${vars}}${base}</style><script>(${runtimeSource})()</scr` + `ipt>${data.html}`);
    document.close();
  });
  parent.postMessage({ ade: 1, type: 'ready' }, '*');
}

export const UI_FRAME_HTML = `<!doctype html><meta charset="utf-8"><title>ade-ui</title><script>(${shell})(${JSON.stringify(String(runtime))})</script>`;
