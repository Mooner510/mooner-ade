import { useEffect, useMemo, useRef, useState } from 'react';
import { useUsage, type UsageWindow } from './Usage';
import { addPair, contribution, learnedK, sameWindow, type KSums, type Reading } from './usage-share';

// This chat's share of the plan's usage limits, for the status line. What the chat cost inside each window is read from its transcript on the server
// (chat/spend: requests since the window's start = resetsAt - length), so it does not depend on when this chat was opened or what the UI remembered.
// That cost becomes %p through k, dollars per 1%p: a turn is measured by reading the limits right before and right after it (forced reads, a few
// hundred ms each), pairing the change with what the turn cost; the pairs add up to k, kept across chats and restarts (localStorage), per plan and window.
const WINDOWS = { session: '5h', weekly: '주' } as const;
const LENGTH = { session: 5 * 3_600_000, weekly: 7 * 86_400_000 } as const;
type Key = keyof typeof WINDOWS;
type Readings = Partial<Record<Key, Reading>>;
type Spent = Partial<Record<Key, { resetsAt: number; usd: number; at: number }>>; // usd: the window's cost when the chat's total was `at`
const store = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? '') ?? fallback; } catch { return fallback; } };
const save = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked: k is just not remembered */ } };
const readingsOf = (windows: UsageWindow[] | undefined): Readings => {
  const out: Readings = {};
  for (const item of windows ?? []) if (item.key in WINDOWS) out[item.key as Key] = { util: item.percent, resetsAt: item.resetsAt };
  return out;
};

export function useUsageShare({ id, enabled, ready, projectId, refresh, status, costUsd, call }: { id: string; enabled: boolean; ready: boolean; projectId: string; refresh: number; status: string; costUsd: number | null; call<T>(route: string, input: Record<string, unknown>): Promise<T> }): string | null {
  const { usage, load } = useUsage('claude', projectId, enabled, refresh);
  const [tick, setTick] = useState(0), [spent, setSpent] = useState<Spent>({});
  const now = useRef({ cost: costUsd ?? 0, plan: usage?.plan ?? '' }); now.current = { cost: costUsd ?? 0, plan: usage?.plan ?? '' };
  const previous = useRef(status), turn = useRef<{ cost: number; before: Readings } | null>(null);

  // The window costs, re-read when a window changes or a turn starts/ends. Only once the chat's state has arrived: `at` must be its real total, not the 0 a restoring chat starts with.
  const starts = readingsOf(usage?.windows), sessionEnd = starts.session?.resetsAt, weeklyEnd = starts.weekly?.resetsAt;
  useEffect(() => {
    if (!enabled || !ready) return;
    const asked = ([['session', sessionEnd], ['weekly', weeklyEnd]] as const).filter((entry): entry is [Key, number] => entry[1] != null);
    if (!asked.length) return;
    let live = true; const at = now.current.cost;
    call<{ spent: (number | null)[] }>('chat/spend', { id, since: asked.map(([key, end]) => end - LENGTH[key]) }).then(result => {
      if (!live) return;
      const next: Spent = {};
      asked.forEach(([key, end], index) => { const usd = result.spent?.[index]; if (typeof usd === 'number') next[key] = { resetsAt: end, usd, at }; });
      setSpent(next);
    }, () => { /* no transcript yet (nothing sent) or not readable: no share is shown */ });
    return () => { live = false; };
  }, [enabled, ready, id, call, sessionEnd, weeklyEnd, status]);

  useEffect(() => {
    if (!enabled) return;
    const was = previous.current; previous.current = status;
    if (status === 'working' && was !== 'working') {
      const start = { cost: now.current.cost, before: {} as Readings };
      turn.current = start;
      void load(true).then(fresh => { if (fresh && turn.current === start) start.before = readingsOf(fresh.windows); });
    } else if (status !== 'working' && was === 'working' && turn.current) {
      const start = turn.current; turn.current = null;
      void load(true).then(fresh => {
        if (!fresh) return;
        const after = readingsOf(fresh.windows), spentNow = now.current.cost - start.cost, plan = fresh.plan || now.current.plan;
        const sums = store<Record<string, KSums>>('ade:usage-k', {});
        for (const key of Object.keys(WINDOWS) as Key[]) {
          const a = after[key], b = start.before[key];
          if (!a || !b || !sameWindow(a.resetsAt, b.resetsAt) || spentNow <= 0 || a.util < b.util) continue;
          sums[`${plan}|${key}`] = addPair(sums[`${plan}|${key}`], spentNow, a.util - b.util);
        }
        save('ade:usage-k', sums); setTick(value => value + 1);
      });
    }
  }, [enabled, status, load]);

  return useMemo(() => {
    if (!enabled || !usage || !(costUsd && costUsd > 0)) return null;
    const after = readingsOf(usage.windows), sums = store<Record<string, KSums>>('ade:usage-k', {});
    const parts: string[] = [];
    for (const key of Object.keys(WINDOWS) as Key[]) {
      const reading = after[key], window = spent[key]; if (!reading || !window) continue;
      if (key === 'session' && /ultra/i.test(usage.plan || '')) continue; // Ultra has no 5-hour window
      if (!sameWindow(window.resetsAt, reading.resetsAt)) continue; // the window rolled over; its cost is being read again
      const cost = window.usd + Math.max(0, costUsd - window.at); if (cost <= 0) continue; // + what the chat spent since the cost was read
      const share = contribution({ after: reading, costUsd: cost, cal: learnedK(sums[`${usage.plan}|${key}`]) });
      if (share.quality === 'tiny' || !share.label) continue; // nothing trustworthy yet (k not learned): show nothing rather than a placeholder
      parts.push(share.label.replace(/(\S+?%p)/, `$1(${WINDOWS[key]})`)); // "5.6%p(5h)"
    }
    return parts.length ? parts.join(' ') : null;
    // `tick` bumps whenever k changed
  }, [enabled, usage, costUsd, spent, tick]);
}
