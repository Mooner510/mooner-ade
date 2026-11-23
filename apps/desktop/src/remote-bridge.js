// What the page of a remote window says to this app, and the answers (the `AdeRemoteNative` contract of apps/web/src/transport.ts):
// page → app: {k:'call', id, action, input} · {k:'connect'} · {k:'send', message} · {k:'copy', text} · {k:'haptic'} · {k:'close'} · {k:'back', handled}
// app → page: {k:'result', id, ok, value | error} · {k:'message', text} · {k:'state', open}
// Free of Electron: `link` is remote-link.js's link, `post(value)` sends to the page, `copy(text)` and `close()` act on this PC.
const MAX_CLIPBOARD = 8 * 1024 * 1024;

export function createBridge({ link, post, copy, close }) {
  let connected = false;
  return {
    // The link's events reach the page only after it said `connect`: until then it has nothing listening.
    onState(open) { if (connected) post({ k: 'state', open }); },
    onMessage(text) { if (connected) post({ k: 'message', text }); },
    receive(raw) {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (!message || typeof message !== 'object') return;
      switch (message.k) {
        case 'call': {
          const { id, action } = message;
          if (typeof id !== 'string' || id.length > 40 || typeof action !== 'string' || action.length > 100) return;
          const input = message.input && typeof message.input === 'object' && !Array.isArray(message.input) ? message.input : {};
          link.call(action, input).then(
            value => post({ k: 'result', id, ok: true, value }),
            error => post({ k: 'result', id, ok: false, error: { code: error.code ?? 'REMOTE_ERROR', message: error.message ?? '원격 요청이 실패했습니다.', ...(error.files && { files: error.files }) } }));
          return;
        }
        // The page subscribes again whenever it hears the link is open, so say what it is right now.
        case 'connect': connected = true; post({ k: 'state', open: link.open }); return;
        case 'send': if (message.message && typeof message.message === 'object') link.send(message.message); return;
        case 'copy': if (typeof message.text === 'string' && message.text.length <= MAX_CLIPBOARD) copy(message.text); return;
        case 'close': close(); return;
        default: /* haptic, back: nothing on a desktop */
      }
    }
  };
}
