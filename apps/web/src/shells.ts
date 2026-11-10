import { useEffect, useState } from 'react';
import { api } from './api';

export type ShellList = { shells: { id: string; label: string; path: string }[]; default: string };
export function useShells() {
  const [list, setList] = useState<ShellList | null>(null);
  useEffect(() => { void api<ShellList>('shell/list').then(setList, () => {}); }, []);
  return list;
}
export const shellLabel = (list: ShellList | null, preferred: string) =>
  (list?.shells.find(item => item.id === preferred) ?? list?.shells.find(item => item.id === list.default))?.label ?? '';
