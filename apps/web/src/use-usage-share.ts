import { useEffect, useMemo, useRef, useState } from 'react';
import { useUsage, type UsageWindow } from './Usage';
import { addPair, contribution, learnedK, sameWindow, type KSums, type Reading } from './usage-share';

// This chat's share of the plan's usage limits, for the status line. A turn is measured by reading the limits right before and right after it
// (forced reads, a few hundred ms each) and pairing the change with what the turn cost; the pairs add up to k, dollars per 1%p, which turns the
// chat's cost into %p. k is kept across chats and restarts (localStorage), per plan and window.
const WINDOWS = { session: '5시간', weekly: '주간' } as const;
type Key = keyof typeof WINDOWS;
type Readings = Partial<Record<Key, Reading>>;
const store = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? '') ?? fallback; } catch { return fallback; } };
const save = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked: the share just is not remembered */ } };
const readingsOf = (windows: UsageWindow[] | undefined): Readings => {
  const out: Readings = {};
  for (const item of windows ?? []) if (item.key in WINDOWS) out[item.key as Key] = { util: item.percent, resetsAt: item.resetsAt };
  return out;
};

export function useUsageShare({ id, enabled, projectId, refresh, status, costUsd }: { id: string; enabled: boolean; projectId: string; refresh: number; status: string; costUsd: number | null }): string | null {
  const { usage, load } = useUsage('claude', projectId, enabled, refresh);
  const [tick, setTick] = useState(0);
  const now = useRef({ cost: costUsd ?? 0, plan: usage?.plan ?? '' }); now.current = { cost: costUsd ?? 0, plan: usage?.plan ?? '' };
  const previous = useRef(status), turn = useRef<{ cost: number; before: Readings } | null>(null);
  const chatKey = `ade:usage-share:${id}`;

  // The chat's first reading: with nothing spent yet it is the base for "how much did the readings move"; a chat restored with a cost has no such base.
  useEffect(() => {
    if (!enabled || !usage || store<unknown>(chatKey, null)) return;
    const readings = readingsOf(usage.windows);
    if (Object.keys(readings).length) { save(chatKey, { cost: now.current.cost, readings }); setTick(value => value + 1); }
  }, [enabled, usage, chatKey]);

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
        const after = readingsOf(fresh.windows), spent = now.current.cost - start.cost, plan = fresh.plan || now.current.plan;
        const sums = store<Record<string, KSums>>('ade:usage-k', {});
        for (const key of Object.keys(WINDOWS) as Key[]) {
          const a = after[key], b = start.before[key];
          if (!a || !b || !sameWindow(a.resetsAt, b.resetsAt) || spent <= 0 || a.util < b.util) continue;
          sums[`${plan}|${key}`] = addPair(sums[`${plan}|${key}`], spent, a.util - b.util);
        }
        save('ade:usage-k', sums); setTick(value => value + 1);
      });
    }
  }, [enabled, status, load]);

  return useMemo(() => {
    if (!enabled || !usage || !(costUsd && costUsd > 0)) return null;
    const after = readingsOf(usage.windows), sums = store<Record<string, KSums>>('ade:usage-k', {}), first = store<{ cost: number; readings: Readings } | null>(chatKey, null);
    const parts: string[] = [];
    for (const key of Object.keys(WINDOWS) as Key[]) {
      const reading = after[key]; if (!reading) continue;
      if (key === 'session' && /ultra/i.test(usage.plan || '')) continue; // Ultra has no 5-hour window
      const sum = sums[`${usage.plan}|${key}`], cal = learnedK(sum);
      const share = contribution({ before: first && first.cost === 0 ? first.readings[key] : null, after: reading, costUsd, cal });
      if (share.quality === 'tiny') continue;
      if (!share.label) continue; // nothing trustworthy yet (k not learned, no starting reading): show nothing rather than a placeholder
      parts.push(share.label.replace(/(\S+?%p)/, `$1(${WINDOWS[key]})`)); // "≈5.6%p(5시간)"
    }
    return parts.length ? parts.join(' ') : null;
    // `tick` bumps whenever the stored first reading or k changed
  }, [enabled, usage, costUsd, chatKey, tick]);
}
