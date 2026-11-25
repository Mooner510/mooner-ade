// The phone side of the phone <-> PC end-to-end rig: adb, and the app's WebViews over Chrome DevTools (debug builds of the app turn on WebView debugging).
// Never touches com.roufin.ade (the user's own app): every call here names the debug app's package, and cleanup removes only what this rig added.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket, shotsDir, sleep, until, writeManifest, readManifest } from './phone-rig.mjs';

export const PKG = 'com.roufin.ade.dev', MAIN_ACTIVITY = 'kr.mooner510.ade.MainActivity', USER_PKG = 'com.roufin.ade';
const adbExe = () => process.env.ADB ?? join(process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'), 'platform-tools', 'adb.exe');

export function pickSerial() {
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL;
  const devices = execFileSync(adbExe(), ['devices'], { encoding: 'utf8' }).split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(([, state]) => state === 'device').map(([serial]) => serial);
  if (devices.length !== 1) throw new Error(`연결된 폰이 ${devices.length}대입니다. ANDROID_SERIAL로 고르세요: ${devices.join(', ') || '(없음)'}`);
  return devices[0];
}

export function adbTool(serial = pickSerial()) {
  const base = ['-s', serial];
  const run = (args, options = {}) => execFileSync(adbExe(), [...base, ...args], { encoding: options.buffer ? 'buffer' : 'utf8', maxBuffer: 256 << 20, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: options.timeout ?? 120000 });
  // A command line for the phone's shell: arguments with spaces or `&` must be quoted by the caller.
  const sh = (command, options) => run(['shell', command], options).replace(/\r/g, '');
  const tool = {
    serial, run, sh,
    reverse: port => run(['reverse', `tcp:${port}`, `tcp:${port}`]),
    unreverse: port => run(['reverse', '--remove', `tcp:${port}`]),
    reverseList: () => run(['reverse', '--list']),
    forward: remote => Number(run(['forward', 'tcp:0', remote]).trim()),
    unforward: port => run(['forward', '--remove', `tcp:${port}`]),
    install: apk => run(['install', '-r', apk], { timeout: 300000 }),
    pidOf: pkg => sh(`pidof ${pkg}`).trim().split(/\s+/)[0] || null,
    // The app of this rig, started or brought forward. Never the user's own app.
    start: (component = MAIN_ACTIVITY) => sh(`am start -n ${PKG}/${component.replace(/^kr\.mooner510\.ade/, 'kr.mooner510.ade')}`),
    // A deep link, aimed at the debug app only (the user's release app registers the same moonerade://pair link).
    view: uri => sh(`am start -a android.intent.action.VIEW -p ${PKG} -d '${uri.replace(/'/g, "'\\''")}'`),
    focus: () => sh("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'").trim(),
    focusedPackage: () => /\{[^ ]+ u\d+ ([^/ ]+)\//.exec(tool.focus())?.[1] ?? null,
    tapPx: (x, y) => sh(`input tap ${Math.round(x)} ${Math.round(y)}`),
    swipePx: (x1, y1, x2, y2, ms = 300) => sh(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${ms}`),
    key: code => sh(`input keyevent ${code}`),
    // `adb shell input text` for ASCII only (spaces are %s); real keystrokes into whatever has focus.
    typeText: text => sh(`input text '${text.replace(/ /g, '%s').replace(/'/g, '')}'`),
    size: () => { const [, w, h] = /(\d+)x(\d+)/.exec(sh('wm size')) ?? []; return { width: Number(w), height: Number(h) }; },
    screencap(name) {
      mkdirSync(shotsDir, { recursive: true });
      const file = join(shotsDir, `${name}.png`);
      writeFileSync(file, run(['exec-out', 'screencap', '-p'], { buffer: true }));
      return file;
    },
    // The visible nodes with text/description and their centres, from uiautomator (WebView content included when accessibility exposes it).
    uiNodes() {
      const xml = sh('uiautomator dump /sdcard/e2e-ui.xml >/dev/null 2>&1; cat /sdcard/e2e-ui.xml; rm -f /sdcard/e2e-ui.xml');
      return [...xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)]
        .map(([, text, desc, x1, y1, x2, y2]) => ({ text, desc, x: (Number(x1) + Number(x2)) / 2, y: (Number(y1) + Number(y2)) / 2, w: Number(x2) - Number(x1), h: Number(y2) - Number(y1) }));
    },
    uiTap(match) { const node = tool.uiNodes().find(n => match(n)); if (!node) throw new Error('uiautomator에서 찾지 못했습니다'); tool.tapPx(node.x, node.y); return node; },
    logcatTail: (filter = '', lines = 200) => sh(`logcat -d -t ${lines} ${filter}`),
    logcatClear: () => run(['logcat', '-c'])
  };
  return tool;
}

// ---- a WebView page over DevTools -------------------------------------------------------------------------------------------------------
// The app process has a `webview_devtools_remote_<pid>` socket per WebView-using process; forwarded to a free local port (recorded for cleanup).
export function webviewPort(adb, pkg = PKG) {
  const pid = adb.pidOf(pkg);
  if (!pid) throw new Error(`${pkg}가 실행 중이 아닙니다`);
  const m = readManifest(), known = m?.phone?.forwards?.find(f => f.pid === pid);
  if (known) return known.port;
  const sockets = adb.sh('cat /proc/net/unix').split('\n').map(l => /@(webview_devtools_remote_\d+)/.exec(l)?.[1]).filter(Boolean);
  const mine = sockets.find(s => s === `webview_devtools_remote_${pid}`);
  if (!mine) throw new Error(`WebView 디버그 소켓이 없습니다(디버그 빌드가 맞나요?): ${sockets.join(', ')}`);
  const port = adb.forward(`localabstract:${mine}`);
  writeManifest({ phone: { ...m?.phone, forwards: [...(m?.phone?.forwards ?? []), { pid, port }] } });
  return port;
}
export const listPages = async port => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page');

// A page driver: ev(js) runs an async function body in the page, waitFor(expr), tap/type with real touch/keyboard events through DevTools.
// `mouse`: a desktop browser (mouse events) instead of the phone's touch events.
export async function attach(target, { mouse = false } = {}) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.once('open', res); socket.once('error', rej); });
  let id = 0; const waiting = new Map(), logs = [];
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) logs.push(`${message.params.type}: ${message.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
    else if (message.method === 'Runtime.exceptionThrown') logs.push(`EXC ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`.slice(0, 400));
    if (message.id && waiting.has(message.id)) { const w = waiting.get(message.id); waiting.delete(message.id); message.error ? w.reject(new Error(message.error.message)) : w.resolve(message.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id; waiting.set(mine, { resolve, reject });
    socket.send(JSON.stringify({ id: mine, method, params }));
    setTimeout(() => { if (waiting.has(mine)) { waiting.delete(mine); reject(new Error(`DevTools timeout ${method}`)); } }, 30000);
  });
  const ev = async expression => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Runtime.enable').catch(() => {}); // a browser-level endpoint has no Runtime domain
  const page = {
    target, send, ev, logs, close: () => socket.close(), get url() { return target.url; },
    waitFor: (expression, ms = 15000, label = expression.slice(0, 100)) => until(() => ev(`const v = (${expression}); return v && typeof v === 'object' && v.nodeType ? true : v`), ms, 250).catch(error => { throw new Error(`waitFor 시간 초과: ${label}${error.message.includes('until timeout') ? '' : ` (${error.message})`}`); }),
    // The element (matching selector, containing text or aria-label text) as a viewport centre, scrolled into view; null when absent or hidden.
    centre: (selector, text) => ev(`const want = ${JSON.stringify(text ?? null)}, els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.getClientRects().length && (want === null || (e.textContent || '').includes(want) || (e.getAttribute('aria-label') || '').includes(want) || (e.getAttribute('title') || '').includes(want)));
      const e = els[0]; if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, top = document.elementFromPoint(x, y); return [x, y, Boolean(top && (e === top || e.contains(top)))];`),
    // A touch tap (touchStart/touchEnd produce the same click a finger does).
    async tapAt(x, y) {
      if (mouse) { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); return; }
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await sleep(40);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    // Waits until the element is really the one under that point (a splash or a dialog on top would take the tap).
    async tap(selector, text) {
      let c = await page.centre(selector, text);
      for (let i = 0; i < 24 && c && !c[2]; i++) { await sleep(250); c = await page.centre(selector, text); }
      if (!c) throw new Error(`요소가 없습니다: ${selector} ${text ?? ''}`);
      if (!c[2]) throw new Error(`요소가 다른 것에 가려져 있습니다: ${selector} ${text ?? ''}`);
      await page.tapAt(c[0], c[1]); return c;
    },
    async swipe(x1, y1, x2, y2, steps = 8) {
      if (mouse) throw new Error('swipe는 폰 페이지 전용입니다');
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] });
      for (let i = 1; i <= steps; i++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps }] }); await sleep(16); }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    insertText: text => send('Input.insertText', { text }),
    pressKey: (key, code = key, vk = 0) => send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }))
  };
  return page;
}
export async function findPage(adb, match, ms = 30000, pkg = PKG) {
  const port = await until(() => webviewPort(adb, pkg), ms, 500);
  const target = await until(async () => (await listPages(port)).find(match), ms, 400);
  return attach(target);
}

// ---- cleanup -------------------------------------------------------------------------------------------------------------------------------
// Removes the adb reverse rules and DevTools forwards this rig added (never `reverse --remove-all`), and with --clear-app the debug app's data.
export async function cleanupPhone(m, log = console.log, { clearApp = false } = {}) {
  if (!m?.phone?.serial) return;
  const adb = adbTool(m.phone.serial);
  for (const port of m.phone.reverses ?? []) { try { adb.unreverse(port); log(`adb reverse 제거 tcp:${port}`); } catch (e) { log(`adb reverse 제거 실패 tcp:${port}: ${String(e.message).split('\n')[0]}`); } }
  for (const f of m.phone.forwards ?? []) { try { adb.unforward(f.port); log(`adb forward 제거 tcp:${f.port}`); } catch { /* already gone */ } }
  if (clearApp) { log(`${PKG} 앱 데이터 삭제: ${adb.sh(`pm clear ${PKG}`).trim()}`); }
  writeManifest({ phone: { ...m.phone, reverses: [], forwards: [] } });
}
