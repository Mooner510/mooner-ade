import { api } from './api';

// What the usage-share hook learns (k per plan and window) and each chat's reference readings. The server keeps it (usage-share.json): the app's origin changes
// at every launch, so localStorage forgot it. Reads are synchronous from a copy loaded once; writes go through to the server.
let data: Record<string, unknown> = {}, loading: Promise<void> | null = null;
const OLD = /^ade:usage-/;

export function loadShareStore(): Promise<void> {
  return loading ??= api<Record<string, unknown>>('usage/share', {}).then(value => {
    data = value && typeof value === 'object' ? value : {};
    // Whatever an earlier version kept in this origin's localStorage moves to the server once (only where the server has nothing yet).
    const move: Record<string, unknown> = {}, drop: string[] = [];
    try {
      for (let at = 0; at < localStorage.length; at++) { const key = localStorage.key(at); if (key && OLD.test(key)) drop.push(key); }
      for (const key of drop) { if (!(key in data)) { try { move[key] = JSON.parse(localStorage.getItem(key) ?? ''); } catch { /* unreadable: dropped */ } } }
    } catch { /* localStorage blocked */ }
    if (Object.keys(move).length) { Object.assign(data, move); void api('usage/share', { set: move }).catch(() => {}); }
    try { for (const key of drop) localStorage.removeItem(key); } catch { /* ignore */ }
  }, () => { loading = null; }); // a failed load retries on the next call; until then nothing is known
}
export const shareGet = <T,>(key: string, fallback: T): T => (key in data ? data[key] : fallback) as T;
export function shareSet(key: string, value: unknown) { data[key] = value; void api('usage/share', { set: { [key]: value } }).catch(() => {}); }
