import { readFileSync, writeFileSync } from 'node:fs'; import { WebSocket, S, sleep } from './lib.mjs'; import { join } from 'node:path';
export const env = () => JSON.parse(readFileSync(join(S, 'env.json'), 'utf8'));
export async function connect(match = () => true) {
  const e = env(); const list = await (await fetch(`${e.cdp}/json/list`)).json(); const t = list.find(x => x.type === 'page' && match(x)); if (!t) throw new Error('no page: ' + JSON.stringify(list.map(x => x.url)));
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0; const waiting = new Map(), problems = [];
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && waiting.has(m.id)) { const p = waiting.get(m.id); waiting.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') problems.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('ERR ' + m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300)); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const k = ++id; waiting.set(k, { resolve, reject }); ws.send(JSON.stringify({ id: k, method, params })); setTimeout(() => { if (waiting.has(k)) { waiting.delete(k); reject(new Error('CDP timeout ' + method)); } }, 20000); });
  const dialogs = []; ws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); send('Page.handleJavaScriptDialog', { accept: true, promptText: m.params.defaultPrompt ?? '' }).catch(() => {}); } });
  await send('Runtime.enable'); await send('Page.enable');
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(S, 'shots', name + '.png'), Buffer.from(r.data, 'base64')); return name; };
  const key = (k, code, mods = 0, text) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers: mods, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : ({ Tab: 9, Enter: 13, Escape: 27 })[k] ?? 0, ...(text && { text }) }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mods }));
  const type = text => send('Input.insertText', { text });
  const click = (x, y) => send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }).then(() => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }));
  const drag = async (x1, y1, x2, y2) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 }); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 }); for (let i = 1; i <= 6; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + (x2 - x1) * i / 6, y: y1 + (y2 - y1) * i / 6, button: 'left', buttons: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 }); };
  const waitFor = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await ev(`return (${expr})`).catch(() => false); if (v) return v; await sleep(150); } throw new Error('waitFor timeout: ' + expr.slice(0, 120)); };
  // viewport centre of the first element matching selector (+ optional text)
  const centre = (sel, text) => ev(`const els=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>${text ? `(e.textContent.includes(${JSON.stringify(text)})||(e.getAttribute('aria-label')||'').includes(${JSON.stringify(text)}))` : 'true'}&&e.getClientRects().length); const e=els[0]; if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]`);
  const clickSel = async (sel, text) => { const c = await centre(sel, text); if (!c) throw new Error('no element ' + sel + ' ' + (text ?? '')); await click(...c); };
  return { dialogs, send, ev, shot, key, type, click, drag, waitFor, centre, clickSel, problems, ws, close: () => ws.close() };
}
