// Measures the chat composer's centring in pixels: every control's layout box and the real painted "ink" of each icon / label / text against the row.
// Usage: VERIFY_OUT=… node scripts/verify/t-composer-align.mjs [--attach] [--text "a\nb"] [--width 520] [--name tag]
//   --attach  adds a wide fake screenshot (the thumbnail strip)   --text  types that text (\n = Shift+Enter) so the full, two-row composer shows
// Exit code 1 when any control's ink centre is more than TOL px off its row centre.
import { connect } from './cdp.mjs'; import { inkOf } from './_ink.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1] ?? true; };
const c = await connect(p => p.url.includes('127.0.0.1')); const sleep = ms => new Promise(r => setTimeout(r, ms)); const TOL = 0.55;
const BOX = 'textarea[aria-label="메시지 입력"]';
const agentName = arg('--agent', ''); if (agentName) { await c.ev(`const b=[...document.querySelectorAll('.chat-provider')].find(e=>e.textContent.includes(${JSON.stringify(agentName)})); if (b && b.getAttribute('aria-pressed') !== 'true') b.click();`); await sleep(2500); }
const width = Number(arg('--width', 0)); if (width) { await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(1200); }
await c.ev(`const t=document.querySelector('${BOX}'); const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t,''); t.dispatchEvent(new Event('input',{bubbles:true}));`);
if (process.argv.includes('--attach')) {
  await c.ev(`
    const cv = document.createElement('canvas'); cv.width = 1600; cv.height = 700; const g = cv.getContext('2d'); g.fillStyle = '#334'; g.fillRect(0, 0, 1600, 700); g.fillStyle = '#9c3'; g.fillRect(40, 40, 300, 300);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png')); const file = new File([blob], 'wide.png', { type: 'image/png' });
    const input = document.querySelector('input[type=file][accept*="image"]'); const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));`);
}
const text = arg('--text', ''); if (text) { await c.click(...await c.centre(BOX)); for (const [i, line] of String(text).split('\\n').entries()) { if (i) await c.key('Enter', 'Enter', 8); await c.type(line); } }
await c.ev(`document.activeElement?.blur()`); await sleep(1000); // unfocused: the focus lift (scale/translate) is an animation, not the resting layout
const info = await c.ev(`
  const q = s => [...document.querySelectorAll(s)].filter(e => e.getClientRects().length);
  const box = e => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cy: (r.top + r.bottom) / 2, cx: (r.left + r.right) / 2 }; };
  const comp = q('.chat-composer')[0]; const items = [];
  const add = (name, row, e, kind) => { if (e && e.getClientRects().length) items.push({ name, kind, row, ...box(e) }); };
  for (const [name, s] of [['attach', '.chat-attach'], ['mode', '.chat-mode summary'], ['model', '.chat-model summary'], ['effort', '.effort-wrap summary'], ['ring', '.chat-ring'], ['send', '.chat-send'], ['tune', '.chat-tune'], ['cursor-model', '.cursor-model'], ['switch', '.chat-switch'], ['max', '.chat-max'], ['config', '.chat-model-config summary']]) for (const e of q(s)) if (comp.contains(e) && !e.closest('[popover]')) {
    const ctl = box(e); items.push({ name, kind: 'control', ...ctl });
    for (const i of e.querySelectorAll('.icon, svg')) if (i.getClientRects().length) items.push({ name: name + ' icon', kind: 'glyph', of: name, ...box(i), glyph: i.textContent.trim().slice(0, 12) });
    const lab = e.querySelector('.dd-label'); if (lab && parseFloat(getComputedStyle(lab).fontSize) > 0) { const walker = document.createTreeWalker(lab, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest('.icon') || !n.textContent.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT }); const nodes = []; let tn; while ((tn = walker.nextNode())) nodes.push(tn);
    // Hangul: the whole word (its glyphs differ in height, so one syllable says little). Latin: the first capital/digit only, because the descenders (p, g) would drag the centre down; the eye centres the capitals.
    const first = nodes[0]?.textContent.trim()[0] ?? ''; const latin = /[A-Za-z0-9]/.test(first); const r = document.createRange();
    if (nodes.length) { const t0 = nodes[0]; const k = t0.textContent.length - t0.textContent.trimStart().length; if (latin) { r.setStart(t0, k); r.setEnd(t0, k + 1); } else { r.setStart(t0, k); r.setEnd(nodes[nodes.length - 1], nodes[nodes.length - 1].textContent.length); } } else r.selectNodeContents(lab); const b = r.getBoundingClientRect(); const tx = nodes.length > 0;
    if (tx) { const lb = lab.getBoundingClientRect(); items.push({ name: name + ' text', kind: 'glyph', of: name, l: b.left, t: lb.top, r: b.right, b: lb.bottom, w: b.width, h: lb.height, cy: (lb.top + lb.bottom) / 2, cx: (b.left + b.right) / 2, glyph: lab.textContent.trim().slice(0, 12) }); } }
  }
  const ta = q('.chat-composer textarea')[0]; const row = q('.chat-input-row')[0];
  // the input's own text (placeholder or typed): in the one-line composer its centre must sit on the controls' centre line
  if (comp.dataset.compact) { const tb = box(ta); const cs = getComputedStyle(ta); items.push({ name: 'input text', kind: 'glyph', of: 'attach', ...tb, l: tb.l + 2, r: tb.l + 120, glyph: (ta.value || ta.placeholder).slice(0, 8) }); }
  return { composer: box(comp), compact: comp.dataset.compact ?? null, fit: comp.querySelector('.chat-foot')?.dataset.fit ?? null, items, ta: box(ta), row: row && box(row), thumbs: q('.chat-attachments img').map(i => ({ ...box(i), nat: [i.naturalWidth, i.naturalHeight] })), atts: q('.chat-attachments').map(box), phText: ta.placeholder, taValue: ta.value };`);
// ink of the textarea (placeholder/typed text, first line)
const rects = info.items.map(i => ({ l: i.l, t: i.t, r: i.r, b: i.b }));
const ink = await inkOf(c, rects), ink1 = await inkOf(c, rects, 1);
const out = []; info.items.forEach((it, n) => out.push({ ...it, ink: ink[n], ink1: ink1[n] }));
const w = (s, n = 16) => String(s).padEnd(n);
console.log(`composer y ${info.composer.t.toFixed(2)}-${info.composer.b.toFixed(2)} h ${info.composer.h.toFixed(2)} (cy ${info.composer.cy.toFixed(2)})  compact=${info.compact}  fit=${info.fit}  width=${info.composer.w.toFixed(0)}`);
const rowCy = (() => { const k = out.filter(i => i.kind === 'control'); return k.length ? k.map(i => i.cy) : []; })();
let bad = 0; const lastRowTop = Math.max(...out.filter(i => i.kind === 'control').map(i => i.t));
for (const it of out) {
  const par = it.of ? out.find(p => p.kind === 'control' && p.name === it.of) : null; const ref = par ?? it;
  const inkCy = it.ink && !it.ink.none ? it.ink.cy : null; const d = inkCy == null ? null : inkCy - ref.cy;
  if (it.kind === 'glyph' && d != null && Math.abs(d) > TOL) bad++;
  console.log(`${w(it.name, 14)} ${w(it.kind, 8)} box y ${it.t.toFixed(2)}-${it.b.toFixed(2)} cy ${it.cy.toFixed(2)} h ${it.h.toFixed(1)} w ${it.w.toFixed(1)} | ink cy ${inkCy ?? '-'}${d == null ? '' : ` (Δ ${d >= 0 ? '+' : ''}${d.toFixed(2)}${Math.abs(d) > TOL ? ' ✗' : ''}) @1x ${it.ink1 && !it.ink1.none ? (it.ink1.cy - ref.cy >= 0 ? '+' : '') + (it.ink1.cy - ref.cy).toFixed(2) : '-'}`}${it.glyph ? '  "' + it.glyph + '"' : ''}`);
}
const ctl = out.filter(i => i.kind === 'control'); const spread = Math.max(...ctl.map(i => i.cy)) - Math.min(...ctl.map(i => i.cy));
console.log(`controls: centre spread ${spread.toFixed(2)}px; heights ${[...new Set(ctl.map(i => i.h.toFixed(1)))].join('/')}`);
const gl = out.filter(i => i.kind === 'glyph' && i.ink && !i.ink.none); const gSpread = gl.length ? Math.max(...gl.map(i => i.ink.cy)) - Math.min(...gl.map(i => i.ink.cy)) : 0;
console.log(`glyph ink centres: spread ${gSpread.toFixed(2)}px across ${gl.length} glyphs (same row only meaningful when single-row)`);
console.log(`row: ${info.row ? `y ${info.row.t.toFixed(2)}-${info.row.b.toFixed(2)} h ${info.row.h.toFixed(1)}` : '-'}  textarea ${info.ta.h.toFixed(1)}h  padding top ${(info.ta.t - info.composer.t).toFixed(2)} bottom ${(info.composer.b - Math.max(...ctl.map(i => i.b))).toFixed(2)} (bottom row)`);
for (const t of info.thumbs) console.log(`thumb ${t.w.toFixed(0)}x${t.h.toFixed(0)} (natural ${t.nat.join('x')}, ratio ${(t.w / t.h).toFixed(2)} vs ${(t.nat[0] / t.nat[1]).toFixed(2)}) in strip ${info.atts[0]?.w.toFixed(0)}x${info.atts[0]?.h.toFixed(0)}`);
await c.shot(`composer-${arg('--name', 'now')}`); if (width) await c.send('Emulation.clearDeviceMetricsOverride'); c.close();
console.log(bad ? `FAIL ${bad} glyph(s) off-centre > ${TOL}px` : 'PASS glyphs centred'); process.exit(bad ? 1 : 0);
