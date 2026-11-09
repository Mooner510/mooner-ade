import { useMemo, useSyncExternalStore } from 'react';
import { api } from './api';

// Launcher agents whose CLI is not on the user's PATH. Rechecked when the window regains focus and once a minute while it
// is visible, so a CLI installed (or a PATH edited) while the app runs shows up without a restart.
let missing: string[] = [];
const listeners = new Set<() => void>();
let timer = 0;
async function check() {
  try {
    const next = (await api<{ missing: string[] }>('agent/installed')).missing;
    if (next.join() !== missing.join()) { missing = next; listeners.forEach(listener => listener()); }
  } catch { /* a failed check keeps the last answer instead of hiding everything */ }
}
const onFocus = () => void check();
function subscribe(listener: () => void) {
  if (!listeners.size) {
    void check();
    addEventListener('focus', onFocus);
    timer = window.setInterval(() => { if (!document.hidden) void check(); }, 60_000);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { removeEventListener('focus', onFocus); clearInterval(timer); }
  };
}
export const useMissingAgents = () => useSyncExternalStore(subscribe, () => missing);
// What the launchers hide: agents switched off in settings plus agents that are not installed.
export function useHiddenAgents(off: string[]) {
  const absent = useMissingAgents();
  return useMemo(() => [...off, ...absent], [off, absent]);
}
