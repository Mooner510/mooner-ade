import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { notices } from './notices';
import { TIPS_VERSION, type TipCandidate } from './tips';
import { isRemote } from './transport';

// True while this notice is the one that shows (see notices.ts). `wanted`: its own condition holds. A notice that is not first renders nothing and waits.
export function useNotice(id: string, wanted: boolean): boolean {
  useEffect(() => { notices.want(id, wanted); return () => notices.want(id, false); }, [id, wanted]);
  return useSyncExternalStore(notices.subscribe, notices.current) === id;
}

let shownTips = new Map<string, symbol | null>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => shownTips;
function rememberTip(id: string, owner: symbol | null) {
  shownTips = new Map(shownTips).set(id, owner);
  listeners.forEach(listener => listener());
}

async function claimTip(id: string) {
  let seenBefore = false;
  if (id === 'bganim' && TIPS_VERSION === 1) {
    try { seenBefore = JSON.parse(localStorage.getItem('ade:tips') ?? '{}')?.['bg-anim']?.n > 0; } catch { /* legacy storage was optional */ }
  }
  if (isRemote) {
    // Remote clients have their own stable origin and leave the host's local tips alone.
    const key = `ade:tip:${TIPS_VERSION}:${id}`;
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, '1');
    return !seenBefore;
  }
  const { claimed } = await api<{ claimed: boolean }>('app/tip', { id, version: TIPS_VERSION });
  return claimed && !seenBefore;
}

// Once persisted, only the component showing the tip may keep it open until it loses eligibility or is dismissed.
export function useTipNotice(id: string, candidates: TipCandidate[]): string | undefined {
  const owner = useRef(Symbol(id)).current;
  const shown = useSyncExternalStore(subscribe, snapshot);
  const tip = candidates.find(([key, eligible]) => eligible && (!shown.has(key) || shown.get(key) === owner))?.[0];
  const selected = useNotice(id, tip !== undefined);
  useEffect(() => {
    if (!selected || !tip) return;
    let active = true;
    if (!shownTips.has(tip)) {
      void claimTip(tip).then(claimed => {
        if (claimed || !shownTips.has(tip)) rememberTip(tip, claimed && active ? owner : null);
      }).catch(error => {
        if (!shownTips.has(tip)) rememberTip(tip, null);
        console.warn('팁 기록을 저장하지 못했습니다.', error);
      });
    }
    return () => {
      active = false;
      if (shownTips.get(tip) === owner) rememberTip(tip, null);
    };
  }, [selected, tip, owner]);
  return selected && tip && shown.get(tip) === owner ? tip : undefined;
}

/** Keeps a card mounted for `EXIT_MS` after it stops showing, so it can fade out (`closing`) instead of vanishing; keep it in step with the fade-out in style.css. */
export const EXIT_MS = 180;
export function useExit(show: boolean): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) { setMounted(true); return; }
    const timer = setTimeout(() => setMounted(false), EXIT_MS); return () => clearTimeout(timer);
  }, [show]);
  return { mounted: show || mounted, closing: !show };
}
