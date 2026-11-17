// No React components here (the notice is ClaudeUpdateNotice.tsx); the hook only reads the store.
import { useSyncExternalStore } from 'react';
import { api } from './api';

// The Claude Code CLI against the newest release. The server answers from its own 30-minute cache and the lookup is one small
// request, so this asks when the window regains focus and every ten minutes while it is visible.
export type ClaudeStatus = { installed: boolean; current: string | null; latest: string | null; outdated: boolean; error?: string };
export type UpdateRun = { phase: 'idle' | 'running' | 'done' | 'failed'; message?: string; before?: string | null; after?: string | null; changed?: boolean };
type Snapshot = { status: ClaudeStatus | null; run: UpdateRun };

let snapshot: Snapshot = { status: null, run: { phase: 'idle' } };
const listeners = new Set<() => void>();
let timer = 0;
const set = (next: Partial<Snapshot>) => { snapshot = { ...snapshot, ...next }; listeners.forEach(listener => listener()); };

async function check(force = false) {
  try { set({ status: await api<ClaudeStatus>('agent/update-check', { force }) }); }
  catch { /* offline or the server is restarting: keep the last answer */ }
}
const onFocus = () => void check();
function subscribe(listener: () => void) {
  if (!listeners.size) {
    void check();
    addEventListener('focus', onFocus);
    timer = window.setInterval(() => { if (!document.hidden) void check(); }, 10 * 60_000);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { removeEventListener('focus', onFocus); clearInterval(timer); }
  };
}
export const useClaudeUpdate = () => useSyncExternalStore(subscribe, () => snapshot);

// Runs `claude update` on the server. Chats and terminals that are already running keep the version they started with.
export async function updateClaude() {
  if (snapshot.run.phase === 'running') return;
  set({ run: { phase: 'running' } });
  try {
    const result = await api<{ ok: boolean; before: string | null; after: string | null; changed?: boolean; message: string; status: ClaudeStatus }>('agent/update');
    set({ status: result.status, run: { phase: result.ok ? 'done' : 'failed', message: result.message, before: result.before, after: result.after, changed: result.changed } });
  } catch (error) { set({ run: { phase: 'failed', message: error instanceof Error ? error.message : String(error) } }); }
}
export const dismissUpdateRun = () => set({ run: { phase: 'idle' } });
export const recheckClaude = () => check(true);

// "나중에" hides the notice for that release only; a newer one shows it again.
const SKIPPED = 'ade.claudeUpdateSkipped';
export const skippedVersion = () => { try { return localStorage.getItem(SKIPPED); } catch { return null; } };
export const skipVersion = (version: string) => { try { localStorage.setItem(SKIPPED, version); } catch { /* private mode */ } set({}); };
