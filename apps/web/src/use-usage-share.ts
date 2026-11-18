import { useEffect, useMemo, useRef, useState } from 'react';
import { useUsage, type Usage, type UsageWindow } from './Usage';
import { contribution, learnedK, sameWindow, shareWindows, tokenWeight, type KSums, type Reading } from './usage-share';

// This chat's share of the plan's usage limits, for the status line. What the chat consumed inside each window is read on the server
// (chat/spend: since the window's start = resetsAt - length), so it does not depend on when this chat was opened or what the UI remembered.
// Claude's meter is dollars. Codex and Cursor report no dollar cost, so their meter is token weight (the same ratios), and k is learned in that unit.
// A turn is measured by reading the limits right before and right after it (forced reads, a few hundred ms each), pairing the change with what the turn
// consumed; the pairs add up to k, kept across chats and restarts (usage/k on the server), per agent, plan and window.
const LABEL = { session: '5h', weekly: '주', auto: 'Cursor', api: '기타', total: '전체', grok: 'Grok' } as const;
const LENGTH = { session: 5 * 3_600_000, weekly: 7 * 86_400_000, auto: 30 * 86_400_000, api: 30 * 86_400_000, total: 30 * 86_400_000, grok: 30 * 86_400_000 } as const;
type Agent = Usage['provider'];
type Key = keyof typeof LABEL;
type Readings = Partial<Record<Key, Reading>>;
type Spent = Partial<Record<Key, { resetsAt: number; usd: number; at: number }>>; // usd: the window's meter when the chat's total meter was `at`
const store = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? '') ?? fallback; } catch { return fallback; } };
// k lives on the server (usage/k); the first read also carries over what older versions kept in localStorage.
let kSums: Record<string, KSums> | null = null;
const readingsOf = (windows: UsageWindow[] | undefined): Readings => {
  const out: Readings = {};
  for (const item of windows ?? []) if (item.key in LABEL) out[item.key as Key] = { util: item.percent, resetsAt: item.resetsAt };
  return out;
};
const kKey = (agent: Agent, plan: string, key: Key) => agent === 'claude' ? `${plan}|${key}` : `${agent}|${plan}|${key}`;
const creditUsed = (fresh: Usage | null | undefined) => fresh?.credit?.used ?? fresh?.codexCredits?.limit?.used ?? 0;

export function useUsageShare({ id, agent, enabled, ready, projectId, refresh, status, model, meter, call }: { id: string; agent: Agent; enabled: boolean; ready: boolean; projectId: string; refresh: number; status: string; model: string | null; meter: number; call<T>(route: string, input: Record<string, unknown>): Promise<T> }): string | null {
  const { usage, load } = useUsage(agent, projectId, enabled, refresh);
  const [tick, setTick] = useState(0), [spent, setSpent] = useState<Spent>({});
  const now = useRef({ meter, plan: usage?.plan ?? '' }); now.current = { meter, plan: usage?.plan ?? '' };
  const previous = useRef(status), turn = useRef<{ meter: number; before: Readings; credit: number } | null>(null);
  const keys = shareWindows(agent, model, usage?.windows);

  useEffect(() => {
    if (!enabled || kSums) return;
    const old = store<Record<string, KSums>>('ade:usage-k', {});
    void (async () => {
      try {
        let all = await call<Record<string, KSums>>('usage/k', {});
        for (const [key, sums] of Object.entries(old)) if (!all[key]) all = await call<Record<string, KSums>>('usage/k', { key, usd: sums.usd, dUtil: sums.dUtil });
        kSums = all; setTick(value => value + 1);
      } catch { /* server unreachable: no share until the next try */ }
    })();
  }, [enabled, call]);

  // The window meters, re-read when a window changes or a turn starts/ends. Only once the chat's state has arrived: `at` must be its real total, not the 0 a restoring chat starts with.
  const ends = keys.map(key => usage?.windows.find(item => item.key === key)?.resetsAt ?? null);
  useEffect(() => {
    if (!enabled || !ready) return;
    const asked = keys.flatMap((key, index) => { const end = ends[index]; return end != null ? [[key, end] as [Key, number]] : []; });
    if (!asked.length) return;
    let live = true; const at = now.current.meter;
    call<{ spent: (number | null)[] }>('chat/spend', { id, since: asked.map(([key, end]) => end - LENGTH[key]) }).then(result => {
      if (!live) return;
      const next: Spent = {};
      asked.forEach(([key, end], index) => { const usd = result.spent?.[index]; if (typeof usd === 'number') next[key] = { resetsAt: end, usd, at }; });
      setSpent(next);
    }, () => { /* no transcript yet (nothing sent) or not readable: no share is shown */ });
    return () => { live = false; };
  }, [enabled, ready, id, call, agent, keys.join(','), ends.join(','), status]);

  useEffect(() => {
    if (!enabled) return;
    const was = previous.current; previous.current = status;
    if (status === 'working' && was !== 'working') {
      const start = { meter: now.current.meter, before: {} as Readings, credit: 0 };
      turn.current = start;
      void load(true).then(fresh => { if (fresh && turn.current === start) { start.before = readingsOf(fresh.windows); start.credit = creditUsed(fresh); } });
    } else if (status !== 'working' && was === 'working' && turn.current) {
      const start = turn.current; turn.current = null;
      void load(true).then(fresh => {
        if (!fresh) return;
        const after = readingsOf(fresh.windows), spentNow = now.current.meter - start.meter, plan = fresh.plan || now.current.plan;
        // A turn that ran into a limit (a window at 100% before or after) or spent extra credit is not a clean pair: the plan did not take all of its cost.
        const clean = creditUsed(fresh) <= start.credit;
        void (async () => {
          for (const key of shareWindows(agent, model, fresh.windows)) {
            const a = after[key], b = start.before[key];
            // Cursor pools move separately: a turn on one pool must not teach the others (a 0 change would inflate k).
            if (!clean || !a || !b || a.util >= 100 || b.util >= 100 || !sameWindow(a.resetsAt, b.resetsAt) || spentNow <= 0 || a.util < b.util) continue;
            if (agent === 'cursor' && a.util <= b.util) continue;
            kSums = await call<Record<string, KSums>>('usage/k', { key: kKey(agent, plan, key), usd: spentNow, dUtil: a.util - b.util }).catch(() => kSums);
          }
          setTick(value => value + 1);
        })();
      });
    }
  }, [enabled, status, load, call, agent, model]);

  return useMemo(() => {
    if (!enabled || !usage || !(meter > 0)) return null;
    const after = readingsOf(usage.windows), sums = kSums ?? {};
    const parts: string[] = [];
    for (const key of keys) {
      const reading = after[key], window = spent[key]; if (!reading || !window) continue;
      if (agent === 'claude' && key === 'session' && /ultra/i.test(usage.plan || '')) continue; // Ultra has no 5-hour window
      if (!sameWindow(window.resetsAt, reading.resetsAt)) continue; // the window rolled over; its cost is being read again
      const cost = window.usd + Math.max(0, meter - window.at); if (cost <= 0) continue; // + what the chat spent since the cost was read
      const share = contribution({ after: reading, costUsd: cost, cal: learnedK(sums[kKey(agent, usage.plan || '', key)]) });
      if (share.quality === 'tiny' || !share.label) continue; // nothing trustworthy yet (k not learned): show nothing rather than a placeholder
      parts.push(share.label.replace(/(\S+?%p)/, `$1(${LABEL[key]})`)); // "5.6%p(5h)"
    }
    return parts.length ? parts.join(' ') : null;
    // `tick` bumps whenever k changed
  }, [enabled, usage, meter, spent, tick, agent, keys.join(',')]);
}

export { tokenWeight };
