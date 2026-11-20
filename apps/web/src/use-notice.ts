import { useEffect, useSyncExternalStore } from 'react';
import { notices } from './notices';

// True while this notice is the one that shows (see notices.ts). `wanted`: its own condition holds. A notice that is not first renders nothing and waits.
export function useNotice(id: string, wanted: boolean): boolean {
  useEffect(() => { notices.want(id, wanted); return () => notices.want(id, false); }, [id, wanted]);
  return useSyncExternalStore(notices.subscribe, notices.current) === id;
}

