// The wire format between a chat reply's interactive UI (a sandboxed iframe running model-written HTML/JS) and the app. Pure, so tests load it directly.
// Everything coming out of the frame is untrusted: it is validated here before the app acts on it.
export const UI_LANG = 'ade-ui';
export const MAX_SEND = 4000, MIN_HEIGHT = 40, MAX_HEIGHT = 560, MIN_GAP_MS = 1500;

export type FrameMessage = { type: 'send' | 'prefill'; text: string } | { type: 'height'; height: number } | { type: 'ready' };

export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== 'object' || (data as { ade?: unknown }).ade !== 1) return null;
  const { type, text, height } = data as { type?: unknown; text?: unknown; height?: unknown };
  if (type === 'ready') return { type };
  if (type === 'height') return typeof height === 'number' && Number.isFinite(height) ? { type, height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(height))) } : null;
  if ((type === 'send' || type === 'prefill') && typeof text === 'string') {
    const clean = text.replace(/\0/g, '').trim();
    return clean ? { type, text: clean.slice(0, MAX_SEND) } : null;
  }
  return null;
}

// ponytail: a time gap is the only guard against a script spamming `ade.send`; the app cannot tell a real click from a forged message. Add a confirm chip if abuse shows up.
export function sendGate(gap = MIN_GAP_MS) {
  let last = -Infinity;
  return (now = Date.now()) => { if (now - last < gap) return false; last = now; return true; };
}

// Theme variables the frame's default styles use, read from the app's own CSS variables so the frame follows light/dark.
export const THEME_VARS = ['--bg', '--surface', '--raised', '--border', '--border-strong', '--fg', '--muted', '--faint', '--accent', '--accent-fg', '--accent-soft', '--input', '--error', '--add', '--del', '--mono'] as const;
