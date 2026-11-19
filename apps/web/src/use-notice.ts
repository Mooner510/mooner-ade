import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { notices } from './notices';

// True while this notice is the one that shows (see notices.ts). `wanted`: its own condition holds. A notice that is not first renders nothing and waits.
export function useNotice(id: string, wanted: boolean): boolean {
  useEffect(() => { notices.want(id, wanted); return () => notices.want(id, false); }, [id, wanted]);
  return useSyncExternalStore(notices.subscribe, notices.current) === id;
}

// The strip below the workspaces where the card of the current notice is drawn (main.tsx): in the layout, so it covers no button, and one place for every card.
export const NoticeDock = createContext<HTMLElement | null>(null);
export const useNoticeDock = () => useContext(NoticeDock);
