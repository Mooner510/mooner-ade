// One log per project (or "shell" before any project is open). The toast reads toastId/toastAt; the sidebar reads items.
export type AppError = { id: number; message: string; at: number };
export type ErrorLog = { items: AppError[]; toastId: number; toastAt: number };

const TOAST_MS = 10_000;
const MAX = 40;
const empty: ErrorLog = { items: [], toastId: 0, toastAt: 0 };
const logs = new Map<string, ErrorLog>();
const listeners = new Map<string, Set<() => void>>();
let seq = 1;

const emit = (scope: string) => listeners.get(scope)?.forEach(fn => fn());

// A fetch that never reached the server (stopped, restarting) throws a bare TypeError: "Failed to fetch" (Chrome), "Load failed" (Safari), "NetworkError…" (Firefox).
const NETWORK_FAILURE = /^(failed to fetch|load failed|networkerror)/i;
export function errorText(cause: unknown) {
  if (cause instanceof TypeError && NETWORK_FAILURE.test(cause.message)) return '서버에 연결할 수 없습니다. 연결이 돌아오면 다시 시도하세요.';
  return (cause instanceof Error ? cause.message : String(cause ?? '')).trim() || '알 수 없는 오류';
}

export function errorLog(scope: string): ErrorLog {
  return logs.get(scope) ?? empty;
}

export function subscribeErrors(scope: string, fn: () => void) {
  let set = listeners.get(scope);
  if (!set) listeners.set(scope, set = new Set());
  set.add(fn);
  return () => set.delete(fn);
}

// Same text while its toast is still up is ignored, so a polling failure does not stack or restart the timer.
export function pushError(scope: string, message: string) {
  const text = message.trim();
  if (!text) return;
  const prev = logs.get(scope);
  const now = Date.now();
  const items = prev?.items ?? [];
  const same = items.find(item => item.message === text);
  if (same && prev && prev.toastId === same.id && now - prev.toastAt < TOAST_MS) return;
  const item = same ? { ...same, at: now } : { id: seq++, message: text, at: now };
  const rest = items.filter(entry => entry.id !== item.id);
  // ponytail: keep 40, drop the oldest if a project produces more distinct failures than fit on one list
  logs.set(scope, { items: [item, ...rest].slice(0, MAX), toastId: item.id, toastAt: now });
  emit(scope);
}

export function dismissError(scope: string, id: number) {
  const prev = logs.get(scope);
  if (!prev?.items.some(item => item.id === id)) return;
  logs.set(scope, { ...prev, items: prev.items.filter(item => item.id !== id), ...(prev.toastId === id ? { toastId: 0 } : {}) });
  emit(scope);
}

export function clearErrors(scope: string) {
  if (!logs.get(scope)?.items.length) return;
  logs.set(scope, { items: [], toastId: 0, toastAt: 0 });
  emit(scope);
}
