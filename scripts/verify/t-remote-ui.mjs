// The phone UI (docs/REMOTE_UI.md) in a tab of the shared test Chrome, without a phone: this script stands in for the MoonerADE app
// and the remote-access plugin. It injects the app's `AdeRemoteNative` (main frame only, like the app's web message listener), loads
// the page with a hello of the chosen scope, and answers the page's requests through the real allowlist of the plugin
// (remote/lib/dispatch.js in mooner-ade-plugins) before they reach this session's server, the way a paired phone's would.
// Usage: VERIFY_TAB=<이름> node scripts/verify/t-remote-ui.mjs [control|view] [--plugins <mooner-ade-plugins>] [--seconds 600]
//   Keeps answering for --seconds (default 600), then leaves the tab as it is. Every request and refusal is logged.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect, env } from './cdp.mjs';
import { WebSocket } from './lib.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
const scope = argv[0] === 'view' ? 'view' : 'control';
const plugins = resolve(opt('--plugins', join(import.meta.dirname, '../../../mooner-ade-plugins')));
const seconds = Number(opt('--seconds', 600));
const { remoteApi, remoteMessage, scopeSummary } = await import(pathToFileURL(join(plugins, 'remote/lib/dispatch.js')).href);
const e = env(), origin = e.origin ?? new URL(e.url).origin, cookie = e.cookie;
const c = await connect(p => p.url.includes('127.0.0.1'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const summary = scopeSummary(scope);
const hello = { ...summary, host: { name: 'Test PC', platform: process.platform } };
const encoded = Buffer.from(JSON.stringify(hello)).toString('base64url');
await c.send('Runtime.addBinding', { name: '__adeHarness' });
await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (window === top) { const listeners = []; window.AdeRemoteNative = { postMessage: text => window.__adeHarness(String(text)), addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); } }; window.__harnessDeliver = text => listeners.forEach(fn => fn({ data: text })); }` });
const deliver = value => c.send('Runtime.evaluate', { expression: `window.__harnessDeliver?.(${JSON.stringify(JSON.stringify(value))})` }).catch(() => {});

let socket = null;
async function api(action, input) {
  const response = await fetch(`${origin}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(input ?? {}) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error?.message ?? 'failed'), { code: value.error?.code ?? 'ERROR' });
  return value;
}
c.ws.on('message', async raw => {
  const m = JSON.parse(raw);
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== '__adeHarness') return;
  let message; try { message = JSON.parse(m.params.payload); } catch { return; }
  if (message.k === 'call') {
    try {
      const request = remoteApi(message.action, message.input, scope);
      const value = await api(request.action, request.input);
      log('api ok  ', message.action); deliver({ k: 'result', id: message.id, ok: true, value });
    } catch (error) {
      log('api FAIL', message.action, error.code, error.message); deliver({ k: 'result', id: message.id, ok: false, error: { code: error.code, message: error.message } });
    }
  } else if (message.k === 'connect') {
    // A reloaded page connects again; the old stream belongs to the page that is gone and must not speak to the new one.
    const previous = socket; socket = null; previous?.close();
    const mine = socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`, { headers: { Origin: origin, Cookie: cookie } });
    mine.on('open', () => { if (socket === mine) { log('events open'); deliver({ k: 'state', open: true }); } });
    // The plugin keeps file change events on the PC (PHONE_SKIPS).
    mine.on('message', data => { const text = String(data); if (socket === mine && !text.startsWith('{"type":"fs",')) deliver({ k: 'message', text }); });
    mine.on('close', () => { if (socket === mine) { log('events closed'); deliver({ k: 'state', open: false }); } });
  } else if (message.k === 'send') {
    try { const clean = remoteMessage(message.message, scope); socket?.send(JSON.stringify(clean)); if (clean.type !== 'terminal/input' && clean.type !== 'terminal/resize') log('send    ', clean.type); }
    catch (error) { log('send FAIL', message.message?.type, error.code); }
  } else log('app     ', message.k, message.text ?? message.handled ?? '');
});
// A hash-only change would not load a new document, and the injected script runs only for new ones.
await c.send('Page.navigate', { url: 'about:blank' });
await c.send('Page.navigate', { url: `${origin}/#remote=${encoded}` });
log(`phone mode (${scope}) on ${origin}; ${summary.api.length} actions allowed; answering for ${seconds}s`);
setTimeout(() => { socket?.close(); c.close(); process.exit(0); }, seconds * 1000);
