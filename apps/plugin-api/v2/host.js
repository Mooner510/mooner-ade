// API v2 = v1 plus the console tab: a plugin that declares `console` gets a tab in the desktop window where a person types
// commands for it and sees their output (docs/PLUGINS.md "콘솔 탭"). Nothing else changes, so the rest is v1's.
// v2 reuses v1's modules: retiring v1 means moving what v2 uses here first (apps/desktop/plugin-api-package.mjs drops v1/).
import { fail, plainText, str } from '../metadata.js';
import * as v1 from '../v1/host.js';

export const { validView, validBadge, pluginTerminal, actionValues } = v1;

const features = Object.freeze(['view.setup', 'view.lists', 'view.document', 'view.password', 'view.folder', 'header', 'updates', 'hub', 'console']);
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_COMMAND = 64 * 1024, MAX_OUT = 64 * 1024, MAX_PASSWORD = 1024;
const SIGNALS = ['INT', 'TERM', 'KILL'];

export function validManifest(value, identity) {
  const manifest = v1.validManifest(value, identity);
  if (value.console !== undefined) {
    if (typeof value.console !== 'boolean') throw fail('console 항목이 올바르지 않습니다.');
    if (value.console) manifest.console = true;
  }
  return manifest;
}

// What the plugin sends about one command run from its console tab. Only these reach the window, as plain text.
export function consoleEvent(message) {
  if (!RUN_ID.test(message?.run ?? '')) return null;
  const run = message.run;
  switch (message.op) {
    case 'started': return { run, op: 'started' };
    case 'prompt': return { run, op: 'prompt' };
    case 'out': return typeof message.data === 'string' && message.data ? { run, op: 'out', fd: message.fd === 2 ? 2 : 1, data: message.data.slice(0, MAX_OUT) } : null;
    case 'exit': return { run, op: 'exit', code: Number.isInteger(message.code) ? message.code : null,
      signal: typeof message.signal === 'string' && /^[A-Z]{2,10}$/.test(message.signal) ? message.signal : null,
      timedOut: message.timedOut === true, durationMs: Number.isFinite(message.durationMs) && message.durationMs >= 0 ? Math.round(message.durationMs) : null };
    case 'error': return { run, op: 'error', message: plainText(String(message.message ?? '')).slice(0, 500) || '명령을 실행하지 못했습니다.' };
    default: return null;
  }
}

// What the console tab asks of the plugin. Typed by a person in the desktop window; nothing else can send it.
export function consoleRequest(request) {
  if (!RUN_ID.test(request?.run ?? '')) throw fail('잘못된 실행 id입니다.');
  const run = request.run;
  if (request.op === 'run') {
    if (!str(request.command, MAX_COMMAND) || Buffer.byteLength(request.command) > MAX_COMMAND) throw fail('명령이 비었거나 너무 깁니다.');
    return { type: 'console', op: 'run', run, command: request.command };
  }
  if (request.op === 'signal') {
    if (!SIGNALS.includes(request.signal)) throw fail('잘못된 신호입니다.');
    return { type: 'console', op: 'signal', run, signal: request.signal };
  }
  if (request.op === 'password') {
    const value = typeof request.value === 'string' && request.value ? request.value : undefined;
    if (value !== undefined && (value.length > MAX_PASSWORD || /[\r\n\0]/.test(value))) throw fail('비밀번호가 올바르지 않습니다.');
    return { type: 'console', op: 'password', run, ...(value !== undefined && { value }), ...(request.save === true && value !== undefined && { save: true }) };
  }
  throw fail('잘못된 콘솔 요청입니다.');
}

export function onMessage(host, message, context) {
  if (message.type !== 'console') return v1.onMessage(host, message, context);
  if (!host.item.manifest.console) return;
  const event = consoleEvent(message);
  if (event) context.emitConsole(host, event);
}

export function encode(message) {
  return message.type === 'init' ? { ...message, features: [...features] } : message;
}
