// How the UI reaches the ADE server. In the desktop window (and a browser on the same PC) that is `POST /api/<action>` plus one
// `/ws` socket on this origin. On a phone the same UI runs inside the MoonerADE app, which loads this bundle from the PC through
// the remote-access plugin; there every request goes through the app's end-to-end encrypted link instead (docs/REMOTE_UI.md).
// Everything that talks to the server goes through here, so the rest of the UI does not know which one it is in.

export class ApiError extends Error {
  code: string;
  files?: string[];
  constructor(code: string, message: string, files?: string[]) { super(message); this.code = code; this.files = files; }
}

// What the PC told the phone it may do (the plugin's `hello`): actions and socket messages outside these lists are refused there.
export type RemoteHello = { scope: 'view' | 'control'; api: string[]; messages: string[]; features: string[]; host?: { name?: string; platform?: string } };

// The app injects `AdeRemoteNative` into this page only (an Android web message listener: the main frame of the app's own origin, so
// a chat's sandboxed UI frame never gets it) and passes what the PC said in the URL: `#remote=<base64url JSON of the hello>`.
// Page → app: {k:'call', id, action, input} · {k:'connect'} · {k:'send', message} · {k:'copy', text} · {k:'haptic'} · {k:'close'} · {k:'back', handled}
// App → page: {k:'result', id, ok, value | error} · {k:'message', text} · {k:'state', open} · {k:'back'}
type Native = { postMessage(text: string): void; addEventListener(type: 'message', listener: (event: { data: string }) => void): void };
const native = (globalThis as unknown as { AdeRemoteNative?: Native }).AdeRemoteNative;

function readHello(): RemoteHello | null {
  if (!native || typeof location === 'undefined') return null;
  const encoded = new URLSearchParams(location.hash.slice(1)).get('remote');
  try {
    const value = JSON.parse(decodeURIComponent(escape(atob((encoded ?? '').replace(/-/g, '+').replace(/_/g, '/')))));
    return { scope: value.scope === 'control' ? 'control' : 'view', api: value.api ?? [], messages: value.messages ?? [], features: value.features ?? [], host: value.host };
  } catch { return { scope: 'view', api: [], messages: [], features: [] }; }
}
export const hello = readHello();
export const isRemote = Boolean(native && hello);
const allowedApi = new Set(hello?.api ?? []), allowedMessages = new Set(hello?.messages ?? []);
// The desktop window may do everything; a phone only what its PC allows, so the UI can hide what would only be refused.
export const can = (action: string) => !hello || allowedApi.has(action);
export const canSend = (type: string) => !hello || allowedMessages.has(type);
// A phone paired for viewing: it sees everything live but changes nothing.
export const readOnly = Boolean(hello && hello.scope !== 'control');
// The stylesheet hides what such a phone could only be refused (mobile.css, [data-remote]).
if (hello && typeof document !== 'undefined') document.documentElement.dataset.remote = hello.scope;

const post = (value: object) => native!.postMessage(JSON.stringify(value));
const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
let listeners: { message(text: string): void; state(open: boolean): void } | null = null;
// The system back gesture: closes what is on top (a dialog, the project drawer) and says whether it did; the app leaves when not.
let backHandler: () => boolean = () => false;
export const onRemoteBack = (handler: () => boolean) => { backHandler = handler; };
if (native && hello) native.addEventListener('message', event => {
  let message: any;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.k === 'result') {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(new ApiError(message.error?.code ?? 'REMOTE_ERROR', message.error?.message ?? '원격 요청이 실패했습니다.', message.error?.files));
  } else if (message.k === 'message' && typeof message.text === 'string') listeners?.message(message.text);
  else if (message.k === 'state') {
    // A dropped link fails what was in flight; the app reconnects and the UI asks again.
    if (!message.open) for (const [id, waiter] of pending) { pending.delete(id); waiter.reject(new ApiError('REMOTE_DISCONNECTED', 'PC와의 연결이 끊겼습니다.')); }
    listeners?.state(Boolean(message.open));
  } else if (message.k === 'back') {
    let handled = false;
    try { handled = backHandler(); } catch { /* the app then leaves */ }
    post({ k: 'back', handled });
  }
});

let sequence = 0;
export async function call<T = any>(action: string, input: object = {}): Promise<T> {
  if (isRemote) {
    if (!can(action)) { console.warn('[remote] not allowed on this device:', action); throw new ApiError('REMOTE_FORBIDDEN', '이 기기에서는 할 수 없는 작업입니다.'); }
    const id = `r${++sequence}`;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { post({ k: 'call', id, action, input }); } catch (cause) { pending.delete(id); reject(cause instanceof Error ? cause : new Error(String(cause))); }
    });
  }
  const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const value = await response.json();
  if (!response.ok) throw new ApiError(value.error.code, value.error.message, value.error.files);
  return value;
}

// One event stream for the whole app: the `/ws` socket, or the phone link's forwarded broadcasts. It reconnects on its own and
// reports each (re)open so the caller can subscribe its projects again.
export type Events = { send(message: object): boolean; close(): void };
export function openEvents(onMessage: (text: string) => void, onState: (open: boolean) => void): Events {
  if (isRemote) {
    listeners = { message: onMessage, state: onState };
    post({ k: 'connect' });
    return {
      send(message) {
        const type = (message as { type?: string }).type ?? '';
        if (!canSend(type)) return false;
        try { post({ k: 'send', message }); return true; } catch { return false; }
      },
      close() { listeners = null; }
    };
  }
  let stopped = false, retry: ReturnType<typeof setTimeout> | undefined, ws: WebSocket | null = null;
  const connect = () => {
    const socket = ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket.onopen = () => onState(true);
    socket.onmessage = event => { if (!stopped) onMessage(event.data); };
    socket.onclose = () => { onState(false); if (!stopped) retry = setTimeout(connect, 1500); };
  };
  connect();
  return {
    send(message) { if (ws?.readyState !== WebSocket.OPEN) return false; ws.send(JSON.stringify(message)); return true; },
    close() { stopped = true; clearTimeout(retry); ws?.close(); }
  };
}

// Render crashes go to the server log. A phone keeps them to itself: the PC's log is not where its bugs are read.
export function reportClientError(body: string) {
  if (isRemote) return;
  void fetch('/api/client/error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, credentials: 'same-origin' }).catch(() => {});
}

// Small things only the app around the page can do on a phone.
export const remoteCopy = (text: string) => { if (!isRemote) return false; post({ k: 'copy', text }); return true; };
export const remoteHaptic = () => { if (isRemote) post({ k: 'haptic' }); };
export const closeRemote = isRemote ? () => post({ k: 'close' }) : null;
