// How much of the plan's usage limit (5-hour / weekly window) one chat used, in percentage points (%p).
// The server only reports whole percents, so a before/after difference is off by up to ±1%p; a cost-based estimate (cost ÷ k, k = dollars per 1%p learned
// from the turns seen so far) is finer but only as good as k. The two are combined: the estimate is shown, and clamped into what the readings allow.
export type Reading = { util: number; resetsAt: number | null };
export type Share = { label: string; est: number | null; observed: number | null; quality: 'none' | 'delta' | 'estimate' | 'consistent' | 'clamped' | 'tiny' };
export type KSums = { usd: number; dUtil: number };

const round1 = (value: number) => Math.round(value * 10) / 10;
// Under 0.1%p three decimals, from 0.1%p one; under 0.001%p nothing is worth showing.
export const TINY = 0.001;
const shown = (value: number) => value < 0.1 ? String(Math.round(value * 1000) / 1000) : String(round1(value));
// resets_at jitters by under a second between calls; a different window is at least hours away.
export const sameWindow = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && Math.abs(a - b) < 60_000;

// Dollars per 1%p from the (cost, utilization change) pairs of finished turns. Below 10 points in total the ±0.5 rounding at both ends is too big a share.
export const learnedK = (sums: KSums | undefined) => sums && sums.dUtil >= 10 && sums.usd > 0 ? { k: sums.usd / sums.dUtil, relErr: 1 / sums.dUtil } : null;
export const addPair = (sums: KSums | undefined, usd: number, dUtil: number): KSums => ({ usd: (sums?.usd ?? 0) + usd, dUtil: (sums?.dUtil ?? 0) + dUtil });

// before/after: readings at the chat's start and now. costUsd: what the chat cost over that same stretch (or its whole cost when `before` is not given).
export function contribution({ before, after, costUsd, cal }: { before?: Reading | null; after?: Reading | null; costUsd: number; cal: { k: number } | null }): Share {
  const out: Share = { label: '', est: null, observed: null, quality: 'none' };
  if (!after) return out; // this plan has no such window
  const est = cal ? costUsd / cal.k : null;
  if (est !== null) out.est = est < 0.1 ? Math.round(est * 1000) / 1000 : round1(est);
  let bound: [number, number] | null = null;
  if (before && sameWindow(before.resetsAt, after.resetsAt)) {
    const d = after.util - before.util;
    out.observed = d; bound = [Math.max(0, d - 1), d + 1]; // the true change lies strictly between d-1 and d+1
  }
  // whole-percent readings: a 0 change only means "under 1%p"
  if (est === null) { if (bound) { out.label = out.observed! >= 1 ? `≈${out.observed}%p` : '<1%p'; out.quality = 'delta'; } return out; }
  if (!bound) { if (est < TINY) { out.quality = 'tiny'; return out; } out.label = `≈${shown(est)}%p`; out.quality = 'estimate'; return out; }
  const [lo, hi] = bound;
  if (est >= lo - 1e-9 && est <= hi + 1e-9) { if (est < TINY) { out.quality = 'tiny'; return out; } out.label = `≈${shown(est)}%p`; out.quality = 'consistent'; return out; }
  out.label = `≈${shown(Math.min(Math.max(est, lo), hi))}%p`; out.quality = 'clamped';
  return out;
}
