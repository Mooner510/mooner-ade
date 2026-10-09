export class ApiError extends Error {
  constructor(public code: string, message: string, public details?: { content: string; revision: string }) { super(message); }
}
export async function api<T = any>(action: string, input: object = {}): Promise<T> {
  const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const value = await response.json();
  if (!response.ok) throw new ApiError(value.error.code, value.error.message, value.error.details);
  return value;
}
// A leaf is a terminal or an editor group; legacy saved layouts have `{ id }` only and mean terminal.
export type Leaf = { id: string; kind?: 'terminal' | 'editor'; tabs?: string[]; active?: string; preview?: string };
export type Pane = Leaf | { direction: 'row' | 'column'; children: Pane[]; sizes: number[] };
export const isLeaf = (pane: Pane): pane is Leaf => 'id' in pane;
export const leafList = (pane: Pane | null): Leaf[] => !pane ? [] : isLeaf(pane) ? [pane] : pane.children.flatMap(leafList);
export const leaves = (pane: Pane | null): string[] => leafList(pane).map(leaf => leaf.id);
export const findLeaf = (pane: Pane | null, id: string) => leafList(pane).find(leaf => leaf.id === id);
export const newId = () => crypto.randomUUID();
export const editorLeaf = (tabs: string[] = [], active = tabs[0] || ''): Leaf => ({ id: newId(), kind: 'editor', tabs, active });
export function mapLeaf(pane: Pane, id: string, change: (leaf: Leaf) => Leaf): Pane {
  if (isLeaf(pane)) return pane.id === id ? change(pane) : pane;
  return { ...pane, children: pane.children.map(child => mapLeaf(child, id, change)) };
}
export function split(pane: Pane, id: string, next: Leaf, direction: 'row' | 'column'): Pane {
  if (isLeaf(pane)) return pane.id === id ? { direction, children: [pane, next], sizes: [1, 1] } : pane;
  const index = pane.children.findIndex(child => isLeaf(child) && child.id === id);
  if (pane.direction === direction && index >= 0) {
    const children = [...pane.children]; children.splice(index + 1, 0, next);
    return { ...pane, children, sizes: children.map(() => 1) };
  }
  return { ...pane, children: pane.children.map(child => split(child, id, next, direction)) };
}
export function remove(pane: Pane, id: string): Pane | null {
  if (isLeaf(pane)) return pane.id === id ? null : pane;
  const children = pane.children.map(child => remove(child, id)).filter((child): child is Pane => child !== null);
  return children.length === 0 ? null : children.length === 1 ? children[0] : { ...pane, children, sizes: children.map(() => 1) };
}
export function equalize(pane: Pane): Pane {
  return isLeaf(pane) ? pane : { ...pane, children: pane.children.map(equalize), sizes: pane.children.map(() => 1) };
}
// Drops terminals that no longer exist on the server; editor groups never die with a process.
export function pruneDead(pane: Pane | null, live: Set<string>): Pane | null {
  let next = pane;
  for (const leaf of leafList(pane)) if (leaf.kind !== 'editor' && !live.has(leaf.id)) next = next && remove(next, leaf.id);
  return next;
}
export const basename = (path: string) => path.split('/').pop() || path;
export const isDiffTab = (path: string) => path.startsWith('diff:');
