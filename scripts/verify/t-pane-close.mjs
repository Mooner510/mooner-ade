// Frame by frame check of the pane close animation (Panes.tsx useCloseGhost). Run after a split (좌우/상하) exists in the open tab.
// Usage: VERIFY_OUT=… node scripts/verify/t-pane-close.mjs [name]   closes the 2nd pane via its "pane 닫기" button, records every painted frame (CDP screencast) and a per-frame rect log.
// Output: VERIFY_OUT/shots/<name>-NNN.jpg and VERIFY_OUT/results-<name>.json
import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { connect } from './cdp.mjs'; import { S } from './lib.mjs';
const name = process.argv[2] || 'close', sleep = ms => new Promise(r => setTimeout(r, ms));
const c = await connect(p => p.url.includes('127.0.0.1'));
if (process.env.REDUCED) await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); // REDUCED=1: ghost off, measures the close itself
const frames = []; c.ws.on('message', raw => { const m = JSON.parse(raw); if (m.method !== 'Page.screencastFrame') return; frames.push({ t: m.params.metadata.timestamp, data: m.params.data }); c.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {}); });
await c.ev(`window.__log = []; const rect = e => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }; window.__go = () => { const t0 = performance.now(); const tick = () => { const g = document.querySelector('.pane-ghost'); window.__log.push({ t: Math.round(performance.now() - t0), ghost: g ? rect(g) : null, panes: [...document.querySelectorAll('.terminal-pane, .launcher-pane, .editor-group, .chat-pane')].filter(e => e.offsetParent).map(rect) }); if (performance.now() - t0 < 1000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }; return 1`);
await c.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 });
await sleep(300); const start = Date.now();
await c.ev(`window.__go()`); await c.clickSel('.launcher-pane button', 'pane 닫기'); await sleep(1300);
await c.send('Page.stopScreencast'); if (process.env.REDUCED) await c.send('Emulation.setEmulatedMedia', { features: [] });
const log = await c.ev(`return window.__log`);
frames.forEach((f, i) => writeFileSync(join(S, 'shots', `${name}-${String(i).padStart(3, '0')}.jpg`), Buffer.from(f.data, 'base64')));
writeFileSync(join(S, `results-${name}.json`), JSON.stringify({ frames: frames.length, ts: frames.map(f => f.t), log }, null, 1));
const ghosts = log.filter(l => l.ghost); console.log(`screencast frames ${frames.length}, rAF samples ${log.length}, with ghost ${ghosts.length}`);
for (const l of log.filter((_, i) => i % 2 === 0)) console.log(String(l.t).padStart(4), 'ghost', JSON.stringify(l.ghost), 'panes', JSON.stringify(l.panes));
c.close();
