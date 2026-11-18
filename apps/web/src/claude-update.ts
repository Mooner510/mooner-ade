// No React components here (the notice is ClaudeUpdateNotice.tsx); the hooks only read the stores.
import { useSyncExternalStore } from 'react';
import { api } from './api';

// One installed CLI (Claude Code or Codex) against its newest release. The server answers from its own 30-minute cache and the lookup
// is one small request, so each store asks when the window regains focus and every ten minutes while it is visible.
export type CliAgent = 'claude' | 'codex';
export type CliStatus = { installed: boolean; current: string | null; latest: string | null; outdated: boolean; error?: string };
export type UpdateRun = { phase: 'idle' | 'running' | 'done' | 'failed'; message?: string; before?: string | null; after?: string | null; changed?: boolean };
type Snapshot = { status: CliStatus | null; run: UpdateRun };

const SNOOZE_MS = 12 * 60 * 60_000;

function createUpdateStore(agent: CliAgent) {
  let snapshot: Snapshot = { status: null, run: { phase: 'idle' } };
  const listeners = new Set<() => void>();
  let timer = 0;
  const set = (next: Partial<Snapshot>) => { snapshot = { ...snapshot, ...next }; listeners.forEach(listener => listener()); };
  const skipped = `ade.${agent}UpdateSnoozeUntil`;

  async function check(force = false) {
    try { set({ status: await api<CliStatus>('agent/update-check', { agent, force }) }); }
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

  return {
    subscribe,
    get: () => snapshot,
    // Runs the CLI's own update on the server. Chats and terminals that are already running keep the version they started with.
    update: async () => {
      if (snapshot.run.phase === 'running') return;
      set({ run: { phase: 'running' } });
      try {
        const result = await api<{ ok: boolean; before: string | null; after: string | null; changed?: boolean; message: string; status: CliStatus }>('agent/update', { agent });
        set({ status: result.status, run: { phase: result.ok ? 'done' : 'failed', message: result.message, before: result.before, after: result.after, changed: result.changed } });
      } catch (error) { set({ run: { phase: 'failed', message: error instanceof Error ? error.message : String(error) } }); }
    },
    dismiss: () => set({ run: { phase: 'idle' } }),
    snoozed: () => { try { return Number(localStorage.getItem(skipped)) > Date.now(); } catch { return false; } },
    // "나중에" hides the notice for 12 hours, whatever the version; the periodic check re-renders it once the time is up.
    snooze: () => { try { localStorage.setItem(skipped, String(Date.now() + SNOOZE_MS)); } catch { /* private mode */ } set({}); },
  };
}

const stores = { claude: createUpdateStore('claude'), codex: createUpdateStore('codex') };

export function useCliUpdate(agent: CliAgent) {
  const store = stores[agent];
  const snapshot = useSyncExternalStore(store.subscribe, store.get);
  return { ...snapshot, update: store.update, dismiss: store.dismiss, snoozed: store.snoozed, snooze: store.snooze };
}
