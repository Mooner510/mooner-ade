// Frame-cost harness window: full work-area window on the primary display, loads TARGET, sets up SCENARIO, prints READY. Driven by ../frame-cost.mjs.
const { app, BrowserWindow, screen } = require('electron');
const { SCENARIO: sc = '', TARGET } = process.env;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SPINNER = `document.head.insertAdjacentHTML('beforeend','<style>.perf-sp{position:fixed;z-index:9999;left:50%;top:50%;width:16px;height:16px;border:2px solid #888;border-top-color:transparent;border-radius:50%;animation:perf-r 1s linear infinite}@keyframes perf-r{to{transform:rotate(1turn)}}</style>'); document.body.insertAdjacentHTML('beforeend','<div class=perf-sp></div>')`;
const has = text => `[...document.querySelectorAll('button')].some(b => b.offsetParent && b.textContent.includes(${JSON.stringify(text)}))`;
const click = text => `(() => { const b = [...document.querySelectorAll('button')].find(b => b.offsetParent && b.textContent.includes(${JSON.stringify(text)})); b?.click(); return !!b; })()`;
// A window covered by other windows would stop drawing (macOS occlusion) and measure ~0; keep it drawing as if it were in front.
for (const k of ['disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding', 'disable-background-timer-throttling']) app.commandLine.appendSwitch(k);
// FLAGS='switch[=value] ...': Chromium switches for this run, to try a fix before it goes into apps/desktop
for (const f of (process.env.FLAGS || '').split(' ').filter(Boolean)) { const [k, ...v] = f.replace(/^--/, '').split('='); app.commandLine.appendSwitch(k, v.join('=')); }
app.whenReady().then(async () => { try {
  const d = screen.getPrimaryDisplay(), { width, height } = d.workAreaSize;
  console.log('DISPLAY', `${width}x${height}@${d.scaleFactor}x`, `${Math.round(d.displayFrequency)}Hz`);
  // Out of the way while it runs: no focus, no Dock icon, fully transparent and click-through, so nothing pops up over the work in front.
  // It still draws every frame (the switches above); SHOW=1 makes it visible to watch a run.
  app.dock?.hide();
  const w = new BrowserWindow({ width, height, x: d.workArea.x, y: d.workArea.y, backgroundColor: '#15171c', show: false, focusable: !!process.env.SHOW, webPreferences: { backgroundThrottling: false } });
  if (!process.env.SHOW) { w.setOpacity(0); w.setIgnoreMouseEvents(true); }
  w.showInactive(); await w.loadURL(TARGET);
  const js = s => w.webContents.executeJavaScript(s);
  const until = async (expr, what) => { for (let i = 0; i < 100; i++) { if (await js(expr)) return; await sleep(100); } throw new Error('timeout: ' + what); };
  if (sc.startsWith('ade')) {
    // ADE pauses its loops in a window that is not in use (data-blurred, from document.hasFocus()). This harness often cannot take OS focus
    // from the app in front, so it tells the page it is the window in use: the foreground case. FOCUS lines still report the real OS focus.
    if (!process.env.REAL_FOCUS) await js("Document.prototype.hasFocus = () => true; document.documentElement.removeAttribute('data-blurred'); dispatchEvent(new Event('focus'))");
    await sleep(4000); await js(click('알겠어요')); await sleep(500);
    if (sc.includes('chat')) { await until(has('Chat 모드'), 'Chat 모드'); await js(click('Chat 모드')); await sleep(600); await js(click('Claude')); await until(`!!document.querySelector('textarea[aria-label="메시지 입력"]')`, 'chat composer'); await sleep(2000); }
    if (sc.includes('turn')) { // the fake claude holds a turn that says "slow" (ctl slowms)
      await js(`document.querySelector('textarea[aria-label="메시지 입력"]').focus()`); w.webContents.insertText('slow');
      await sleep(200); w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); await until(`!!document.querySelector('.chat-send.stop')`, 'running turn'); await sleep(1000);
    }
    if (sc.includes('spinner')) await js(SPINNER);
  }
  if (process.env.SHOT) require('node:fs').writeFileSync(process.env.SHOT, (await w.capturePage()).toPNG());
  // SHOTS=n: n more screenshots 250 ms apart (<shot>-1.png ...), to see something move
  for (let i = 1; i <= +(process.env.SHOTS || 0); i++) { await sleep(250); require('node:fs').writeFileSync(process.env.SHOT.replace(/\.png$/, `-${i}.png`), (await w.capturePage()).toPNG()); }
  // ablation, combinable: ade-chat-turn-nospin / -nobreathe / -noring (the work ring hidden) / -freezering (master b8c8fa8 and older: ring shown, its 24 fps clock writes nothing) / -flat (composer without its focus lift and glow) / -nomask (master b8c8fa8 and older: chat scroll without its mask fade) / -noglow (the empty-chat glow) / -unfocus (composer not focused) / -still (every CSS animation and transition) switch those off with CSS, to split the turn cost
  const still = '{ animation: none !important; transition: none !important; }', OFF = { still: `*, *::before, *::after ${still}`, nospin: `.chat-spin ${still}`, nobreathe: `.chat-send.stop::before ${still}`, noring: '.agent-trail { display: none !important; }', flat: '.chat-composer { transform: none !important; box-shadow: none !important; }', nomask: '.chat-scroll { mask-image: none !important; }', noglow: '.chat-dock::before { display: none !important; }' };
  const off = sc.split('-').filter(k => OFF[k]).map(k => OFF[k]).join(' ');
  if (sc.includes('-freezering')) await js("{ const set = CSSStyleDeclaration.prototype.setProperty; CSSStyleDeclaration.prototype.setProperty = function (k, ...a) { if (k !== '--f') return set.call(this, k, ...a); }; } 0"); // the work ring stays on screen but its 24 fps clock stops writing --f
  if (sc.includes('-unfocus')) await js('document.activeElement?.blur()'); // the composer loses focus (no focus-within lift and glow)
  if (off) await js(`document.head.insertAdjacentHTML('beforeend', '<style>${off}</style>')`);
  if (process.env.CSS) await js(`document.head.insertAdjacentHTML('beforeend', ${JSON.stringify(`<style>${process.env.CSS}</style>`)})`); // CSS='...': any extra CSS, to bisect what makes frames costly
  if (process.env.PROBE) { // PROBE=1 (diagnosis, not for the numbers: the probes stay attached): composited layers: size in device px and why each is its own layer
    const dbg = w.webContents.debugger; if (!dbg.isAttached()) dbg.attach('1.3');
    const tree = new Promise(r => dbg.on('message', (_, method, params) => method === 'LayerTree.layerTreeDidChange' && params.layers && r(params.layers)));
    await dbg.sendCommand('LayerTree.enable'); const layers = await tree;
    const rows = [];
    for (const l of layers.filter(l => l.drawsContent)) rows.push([Math.round(l.width) + 'x' + Math.round(l.height), (await dbg.sendCommand('LayerTree.compositingReasons', { layerId: l.layerId }).catch(() => ({}))).compositingReasons?.join(',') ?? '', l.paintCount]);
    console.log('LAYERS', JSON.stringify(rows));
  }
  if (process.env.PROBE) { // who keeps asking for frames: requestAnimationFrame calls per caller over 3 s
    await js("window.__raf = {}; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => { const k = (new Error().stack.split('\\n')[2] || '?').trim(); window.__raf[k] = (window.__raf[k] || 0) + 1; return raf(cb); }; 0");
    await sleep(3000); console.log('RAF', JSON.stringify(await js('window.__raf')));
  }
  if (process.env.PROBE) { // main-thread work over 3 s (CDP Performance metrics): style/layout counts and durations, script and task time
    const dbg = w.webContents.debugger; if (!dbg.isAttached()) dbg.attach('1.3'); await dbg.sendCommand('Performance.enable');
    const m = async () => Object.fromEntries((await dbg.sendCommand('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
    const a = await m(); await sleep(3000); const b = await m();
    console.log('METRICS', JSON.stringify(Object.fromEntries(['RecalcStyleCount', 'LayoutCount', 'RecalcStyleDuration', 'LayoutDuration', 'ScriptDuration', 'TaskDuration'].map(k => [k, +(b[k] - a[k]).toFixed(3)]))));
    // 2 s trace: renderer events by name, and what invalidated style (the reasons Chromium records)
    const events = []; dbg.on('message', (_, method, params) => { if (method === 'Tracing.dataCollected') events.push(...params.value); });
    await dbg.sendCommand('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.invalidationTracking', 'blink.animations', 'cc', 'viz'] } });
    await sleep(2000); const done = new Promise(r => dbg.on('message', (_, method) => method === 'Tracing.tracingComplete' && r())); await dbg.sendCommand('Tracing.end'); await done;
    const count = list => Object.entries(list.reduce((o, k) => (o[k] = (o[k] || 0) + 1, o), {})).sort((x, y) => y[1] - x[1]).slice(0, 25);
    console.log('TRACE', JSON.stringify(count(events.filter(e => e.ph === 'X' || e.ph === 'B' || e.ph === 'I' || e.ph === 'i').map(e => e.name))));
    // where the time goes: total duration (ms) of complete events by name, all processes (renderer, GPU/viz)
    { const t = {}; for (const e of events) if (e.ph === 'X' && e.dur) t[e.name] = (t[e.name] || 0) + e.dur / 1000; console.log('TIME', JSON.stringify(Object.entries(t).sort((x, y) => y[1] - x[1]).slice(0, 30).map(([k, v]) => [k.slice(0, 70), Math.round(v)]))); }
    // ARGS='Event name,Other name': the arguments of the last few events of those names (damage rects, overlay counts, ...)
    for (const n of (process.env.ARGS || '').split(',').filter(Boolean)) console.log('ARGS', n, JSON.stringify(events.filter(e => e.name === n).slice(-3).map(e => e.args)));
    // why the compositor keeps offscreen render surfaces (each one is drawn separately every frame): cc's per-frame reason counts
    console.log('SURFACES', JSON.stringify(count(events.filter(e => e.name === 'RenderSurfaceReasonCount').map(e => JSON.stringify(e.args?.data ?? e.args)))));
    // animations the compositor could not take: Blink's compositeFailed bitmask and the properties it could not run there
    console.log('NOT_COMPOSITED', JSON.stringify(count(events.filter(e => e.name === 'Animation' && e.args?.data?.compositeFailed).map(e => `${e.args.data.name ?? ''} ${e.args.data.nodeName ?? ''} failed=${e.args.data.compositeFailed} ${e.args.data.unsupportedProperties?.join(',') ?? ''}`))));
    console.log('INVALIDATIONS',JSON.stringify(count(events.filter(e => /Invalidation|ScheduleStyle/.test(e.name)).map(e => `${e.name}: ${e.args?.data?.reason ?? ''} ${e.args?.data?.nodeName ?? ''} ${e.args?.data?.changedClass ?? e.args?.data?.changedAttribute ?? e.args?.data?.changedPseudo ?? ''}`))));
  }
  if (process.env.PROBE) console.log('EFFECTS', JSON.stringify(await js(`(() => { // what can make every frame costly: frames, canvases, and visible elements with filters, masks, blending or will-change
    const out = [...document.querySelectorAll('iframe, canvas, video')].map(e => e.tagName + ' ' + e.width + 'x' + e.height + ' ' + (e.src || e.className || ''));
    for (const e of document.querySelectorAll('*')) for (const pseudo of [null, '::before', '::after']) { const c = getComputedStyle(e, pseudo), r = e.getBoundingClientRect();
      const f = [['filter', c.filter], ['backdrop', c.backdropFilter], ['mask', c.maskImage], ['will-change', c.willChange], ['blend', c.mixBlendMode], ['opacity', c.opacity]].filter(([k, v]) => v && v !== 'none' && v !== 'auto' && v !== 'normal' && v !== '1');
      if (f.length && r.width && c.visibility !== 'hidden' && c.display !== 'none') out.push((typeof e.className === 'string' ? e.className : e.tagName) + (pseudo || '') + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + f.map(x => x.join(':').slice(0, 60)).join(' ')); }
    return out; })()`)));
  if (process.env.PROBE) console.log('ANIMATIONS', JSON.stringify(await js("document.getAnimations().map(a => [a.animationName ?? a.transitionProperty ?? a.id, a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? a.effect?.target?.tagName, a.playState, a.effect?.pseudoElement ?? ''].join(' | '))")));
  console.log('READY');
  setInterval(() => console.log('FOCUS', w.isFocused()), 1000); // the real OS focus, for the record
  } catch (e) { console.log('SETUP_FAILED', e.message); app.exit(1); }
});
