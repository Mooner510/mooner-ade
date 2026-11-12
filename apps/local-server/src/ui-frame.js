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
  // The width reported is where the content ends (its right edge plus the body's padding): a reply laid out at a fixed width lets the card shrink
  // to it instead of leaving most of the row empty. Content that reaches the frame's edge is fluid and reports 0 (no width): otherwise a shrunk
  // card, or a scrollbar taking a few pixels, would make the content narrower and the next report smaller, shrinking the card step by step.
  const reach = () => {
    const kids = [...document.body.children].filter(el => !/^(SCRIPT|STYLE|LINK|META|TEMPLATE)$/.test(el.tagName) && el.getClientRects().length);
    if (!kids.length) return 0;
    const pad = parseFloat(getComputedStyle(document.body).paddingRight), right = Math.max(...kids.map(el => el.getBoundingClientRect().right));
    return right >= document.documentElement.clientWidth - pad - 1 ? 0 : right + pad;
  };
  // An open dropdown list hangs below its field, outside the body's box; the frame grows to show it.
  const report = () => post({ type: 'height', width: reach(), height: Math.max(document.body.getBoundingClientRect().height,
    ...[...document.querySelectorAll('.ade-dd-list:not([hidden])')].map(list => list.getBoundingClientRect().bottom + 12)) });
  addEventListener('DOMContentLoaded', () => { new ResizeObserver(report).observe(document.body); report(); });
  addEventListener('load', report);
  // Sliders draw their accent fill from --fill (see the base style), kept in step with the value as the user drags.
  const fill = el => { const min = el.min === '' ? 0 : +el.min, max = el.max === '' ? 100 : +el.max; el.style.setProperty('--fill', `${((+el.value - min) / ((max - min) || 1)) * 100}%`); };
  addEventListener('input', event => { if (event.target instanceof HTMLInputElement && event.target.type === 'range') fill(event.target); }, true);
  addEventListener('DOMContentLoaded', () => document.querySelectorAll('input[type=range]').forEach(fill));
  // Selects: the native popup list is the platform's, so each single <select> gets the app's dropdown (a button and a list). The select stays in the
  // page, hidden, holding the value and firing input/change, so the reply's own script works unchanged.
  const enhance = select => {
    if (select.dataset.adeDd || select.multiple || select.size > 1) return;
    select.dataset.adeDd = '1';
    const wide = select.getBoundingClientRect().width >= (select.parentElement?.getBoundingClientRect().width ?? 0) - 2;
    const wrap = document.createElement('span'), button = document.createElement('button'), list = document.createElement('div');
    wrap.className = 'ade-dd'; if (wide) wrap.style.display = 'block'; else wrap.style.minWidth = `${Math.max(120, select.getBoundingClientRect().width)}px`;
    button.type = 'button'; button.className = 'ade-dd-button'; button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
    list.className = 'ade-dd-list'; list.setAttribute('role', 'listbox'); list.hidden = true;
    select.before(wrap); wrap.append(select, button, list); select.tabIndex = -1;
    const sync = () => { button.textContent = select.selectedOptions[0]?.textContent ?? ''; };
    const choose = index => { if (index < 0 || index >= select.options.length || select.options[index].disabled || index === select.selectedIndex) return; select.selectedIndex = index; select.dispatchEvent(new Event('input', { bubbles: true })); select.dispatchEvent(new Event('change', { bubbles: true })); sync(); };
    const close = () => { if (list.hidden) return; list.hidden = true; button.setAttribute('aria-expanded', 'false'); report(); };
    const open = () => {
      sync();
      list.replaceChildren(...[...select.options].map((option, index) => {
        const item = document.createElement('div');
        item.className = 'ade-dd-item'; item.setAttribute('role', 'option'); item.textContent = option.textContent;
        item.setAttribute('aria-selected', String(index === select.selectedIndex)); if (option.disabled) item.setAttribute('aria-disabled', 'true');
        item.addEventListener('click', () => { if (option.disabled) return; choose(index); close(); button.focus(); });
        return item;
      }));
      list.hidden = false; button.setAttribute('aria-expanded', 'true'); report();
    };
    button.addEventListener('click', () => (list.hidden ? open() : close()));
    button.addEventListener('keydown', event => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault(); choose(select.selectedIndex + (event.key === 'ArrowDown' ? 1 : -1)); if (!list.hidden) open();
    });
    document.addEventListener('pointerdown', event => { if (!wrap.contains(event.target)) close(); });
    select.addEventListener('change', sync); sync();
  };
  addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('select').forEach(enhance);
    new MutationObserver(() => document.querySelectorAll('select:not([data-ade-dd])').forEach(enhance)).observe(document.body, { childList: true, subtree: true });
  });
}

function shell(runtimeSource) {
  // Base look for what the model writes, in the app's own style: its fonts (handed over by the app), its controls (checkbox rows like the question
  // card's, radio groups as segmented buttons, the app's buttons and inputs), and a few layout classes the prompt names (card, row, stack, label,
  // bar, big, badge, muted, ok/warn/err) so a reply reads as part of ADE rather than as a bare web page.
  const base = 'html{color-scheme:var(--scheme,dark)}'
    + 'body{margin:0;padding:14px 16px;background:transparent;color:var(--fg);font:13px/1.55 "Inter Variable","Noto Sans KR Variable",Inter,"Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;-webkit-font-smoothing:antialiased}'
    + '*{box-sizing:border-box}h1,h2,h3,h4,h5{margin:0 0 10px;font-size:13.5px;font-weight:600;line-height:1.35}h1{font-size:15px}p{margin:0 0 8px}'
    + 'small,.muted{color:var(--muted);font-size:12px}hr{border:0;border-top:1px solid var(--border);margin:12px 0}fieldset{margin:0 0 12px;padding:0;border:0}legend,.label{display:block;padding:0;margin:0 0 6px;color:var(--muted);font-size:12px;font-weight:500}'
    + 'code,pre{font-family:var(--mono,monospace);font-size:12px}table{border-collapse:collapse;width:100%}th{text-align:left;color:var(--muted);font-weight:500;font-size:12px}th,td{padding:6px 10px 6px 0;border-bottom:1px solid var(--border)}'
    + 'input,select,textarea{font:inherit;color:var(--fg);background:var(--input);border:1px solid var(--border);border-radius:7px;padding:6px 10px;min-width:0;transition:border-color .15s,background-color .15s,box-shadow .15s}'
    + 'select{-webkit-appearance:none;appearance:none;padding-right:30px;cursor:pointer}'
    // the dropdown that stands in for a <select>: a field-like button with the chevron, and a list in the app's overlay style
    + '.ade-dd{position:relative;display:inline-block;vertical-align:middle}.ade-dd>select{position:absolute;inset:0;opacity:0;pointer-events:none}'
    + '.ade-dd-button{display:block;width:100%;height:auto;padding:6px 30px 6px 10px;text-align:left;font-size:13px;font-weight:400;color:var(--fg);border:1px solid var(--border);border-radius:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
    + 'background:var(--input) url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 12 12%22%3E%3Cpath d=%22M3 4.5l3 3 3-3%22 fill=%22none%22 stroke=%22%238b9099%22 stroke-width=%221.5%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/%3E%3C/svg%3E") no-repeat right 10px center/12px}'
    + '.ade-dd>.ade-dd-button,.ade-dd>.ade-dd-button:hover{background-color:var(--input);background-image:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 12 12%22%3E%3Cpath d=%22M3 4.5l3 3 3-3%22 fill=%22none%22 stroke=%22%238b9099%22 stroke-width=%221.5%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;background-size:12px}'
    + '.ade-dd-button:hover{border-color:var(--border-strong)}.ade-dd-button[aria-expanded=true],.ade-dd-button:focus-visible{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}'
    + '.ade-dd-list{position:absolute;z-index:10;left:0;right:0;top:calc(100% + 5px);min-width:100%;max-height:240px;overflow:auto;padding:4px;background:var(--overlay,var(--raised));border:1px solid var(--border);border-radius:8px;box-shadow:0 10px 28px rgb(0 0 0 / .35)}'
    + '.ade-dd-item{padding:6px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}.ade-dd-item:hover{background:var(--hover)}.ade-dd-item[aria-selected=true]{color:var(--accent);background:var(--selected)}.ade-dd-item[aria-disabled]{opacity:.4;cursor:default}'
    + 'input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}'
    + 'button{font:inherit;font-size:12.5px;font-weight:500;color:var(--fg);height:30px;padding:0 12px;border-radius:7px;border:1px solid var(--border-strong);background:color-mix(in srgb,var(--fg) 6%,transparent);cursor:pointer;transition:background-color .15s,box-shadow .15s}'
    + 'button:hover{background:color-mix(in srgb,var(--fg) 11%,transparent)}button:disabled{opacity:.4;cursor:default}button:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}'
    + 'button.primary,button[type=submit]{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}button.primary:hover,button[type=submit]:hover{background:var(--accent-strong)}'
    // checkbox: the drawn box and tick of the app; a checkbox in a <label> is a list row with a hover tint
    + 'input[type=checkbox],input[type=radio]{-webkit-appearance:none;appearance:none;position:relative;display:inline-block;flex:none;width:16px;height:16px;padding:0;margin:0 6px 0 0;vertical-align:-3px;border:1.5px solid var(--border-strong);background:var(--input);cursor:pointer}'
    + 'input[type=checkbox]{border-radius:4.5px}input[type=radio]{border-radius:50%}input[type=checkbox]:hover,input[type=radio]:hover{border-color:color-mix(in srgb,var(--accent) 60%,var(--border-strong))}'
    + 'input[type=checkbox]:checked{background:var(--accent);border-color:var(--accent)}input[type=checkbox]:checked::after{content:"";position:absolute;inset:0;background:var(--accent-fg);-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22%3E%3Cpath d=%22M3.2 8.4l3.1 3.1 6.5-6.9%22 fill=%22none%22 stroke=%22black%22 stroke-width=%222.4%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/%3E%3C/svg%3E") center/11px no-repeat}'
    + 'input[type=radio]:checked{border-color:var(--accent);background:var(--accent);box-shadow:inset 0 0 0 3px var(--input)}'
    + 'label:has(>input[type=checkbox]){display:flex;align-items:center;gap:9px;padding:5px 8px;margin:0 -8px;border-radius:7px;cursor:pointer;transition:background-color .15s}label:has(>input[type=checkbox]):hover{background:color-mix(in srgb,var(--fg) 4%,transparent)}label>input[type=checkbox]{margin:0}'
    // models often end each control label with <br>; the rows already stack, so that break would leave an empty line between them
    + 'label:has(>input[type=checkbox])+br,label:has(>input[type=radio])+br{display:none}'
    // radio in a <label>: one segment of a segmented control (the app's pressed-button look); the circle itself is hidden, focus rings the segment
    + 'label:has(>input[type=radio]){display:inline-flex;align-items:center;height:28px;padding:0 12px;margin:0 4px 4px 0;border:1px solid var(--border);border-radius:7px;color:var(--muted);font-size:12.5px;cursor:pointer;transition:background-color .15s,color .15s,border-color .15s}'
    + 'label:has(>input[type=radio]):hover{color:var(--fg);background:var(--hover)}label:has(>input[type=radio]:checked){color:var(--fg);font-weight:500;background:var(--selected);border-color:color-mix(in srgb,var(--accent) 50%,var(--border))}'
    + 'label:has(>input[type=radio]:focus-visible){box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}label>input[type=radio]{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}'
    // slider: the app's drawn track (filled to the value by the runtime) and ring thumb
    + 'input[type=range]{-webkit-appearance:none;appearance:none;height:18px;padding:0;border:0;background:none;box-shadow:none;cursor:pointer}input[type=range]:focus{box-shadow:none}'
    + 'input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:linear-gradient(var(--accent),var(--accent)) 0/var(--fill,50%) 100% no-repeat,color-mix(in srgb,var(--fg) 14%,transparent)}'
    + 'input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:var(--surface);border:2px solid var(--accent);transition:box-shadow .15s}'
    + 'input[type=range]:hover::-webkit-slider-thumb,input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 22%,transparent)}'
    // progress: a <progress> or .bar>i is the app's thin rounded bar
    + 'progress{-webkit-appearance:none;appearance:none;display:block;width:100%;height:6px;border:0;border-radius:3px;overflow:hidden;background:color-mix(in srgb,var(--fg) 10%,transparent)}progress::-webkit-progress-bar{background:transparent}progress::-webkit-progress-value{background:var(--accent);border-radius:3px;transition:width .3s}'
    + '.bar{height:6px;border-radius:3px;overflow:hidden;background:color-mix(in srgb,var(--fg) 10%,transparent)}.bar>i,.bar>span{display:block;height:100%;width:0;border-radius:inherit;background:var(--accent);transition:width .3s}'
    // layout kit
    + '.card{padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--surface)}.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}.stack{display:flex;flex-direction:column;gap:12px}'
    + '.big{font-size:22px;font-weight:650;line-height:1.25;letter-spacing:-.01em;font-variant-numeric:tabular-nums}.badge{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:5px;font-size:11.5px;font-weight:500;background:color-mix(in srgb,var(--fg) 8%,transparent);color:var(--muted)}'
    + '.ok{color:var(--add)}.warn{color:var(--warn)}.err{color:var(--del)}.accent{color:var(--accent)}.badge.ok{background:color-mix(in srgb,var(--add) 16%,transparent)}.badge.warn{background:color-mix(in srgb,var(--warn) 16%,transparent)}.badge.err{background:color-mix(in srgb,var(--del) 16%,transparent)}';
  let done = false;
  addEventListener('message', event => {
    const data = event.data;
    if (done || event.source !== parent || !data || data.ade !== 1 || data.type !== 'init' || typeof data.html !== 'string') return;
    done = true;
    const vars = Object.entries(data.theme || {}).filter(([key, value]) => /^--[\w-]+$/.test(key) && typeof value === 'string').map(([key, value]) => `${key}:${value.replace(/[;{}<]/g, '')}`).join(';');
    // document.write (not innerHTML) so the reply's <script> tags run; the runtime is part of the written text because open() clears this page's listeners.
    document.open();
    const fonts = typeof data.fonts === 'string' ? data.fonts.replace(/</g, '') : '';
    document.write(`<!doctype html><meta charset="utf-8"><style>${fonts}:root{${vars}}${base}</style><script>(${runtimeSource})()</scr` + `ipt>${data.html}`);
    document.close();
  });
  parent.postMessage({ ade: 1, type: 'ready' }, '*');
}

export const UI_FRAME_HTML = `<!doctype html><meta charset="utf-8"><title>ade-ui</title><script>(${shell})(${JSON.stringify(String(runtime))})</script>`;
