import { useEffect, useState, useSyncExternalStore } from 'react';
import { notices } from './notices';

// True while this notice is the one that shows (see notices.ts). `wanted`: its own condition holds. A notice that is not first renders nothing and waits.
export function useNotice(id: string, wanted: boolean): boolean {
  useEffect(() => { notices.want(id, wanted); return () => notices.want(id, false); }, [id, wanted]);
  return useSyncExternalStore(notices.subscribe, notices.current) === id;
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
