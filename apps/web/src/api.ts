export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export async function api<T = any>(action: string, input: object = {}): Promise<T> {
  const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const value = await response.json();
  if (!response.ok) throw new ApiError(value.error.code, value.error.message);
  return value;
}
// A leaf is a terminal, an editor group, a chat (a headless Claude Code drawn as a conversation; its id names the server-side transcript) or a launcher (a fresh pane still choosing what to run); legacy saved layouts have `{ id }` only and mean terminal.
// A terminal leaf also remembers where it was opened and which agent CLI ran in it, so it can be reopened after the server restarts.
export type Leaf = { id: string; kind?: 'terminal' | 'editor' | 'launcher' | 'chat'; tabs?: string[]; active?: string; preview?: string; cwd?: string; agent?: 'claude' | 'codex' | 'cursor' };
export type Pane = Leaf | { direction: 'row' | 'column'; children: Pane[]; sizes: number[] };
export const isLeaf = (pane: Pane): pane is Leaf => 'id' in pane;
export const leafList = (pane: Pane | null): Leaf[] => !pane ? [] : isLeaf(pane) ? [pane] : pane.children.flatMap(leafList);
export const leaves = (pane: Pane | null): string[] => leafList(pane).map(leaf => leaf.id);
export const findLeaf = (pane: Pane | null, id: string) => leafList(pane).find(leaf => leaf.id === id);
export const newId = () => crypto.randomUUID();
export const isTerminal = (leaf: Leaf) => !leaf.kind || leaf.kind === 'terminal';
export const chatLeaf = (cwd?: string, agent: NonNullable<Leaf['agent']> = 'claude'): Leaf => ({ id: newId(), kind: 'chat', agent, ...(cwd ? { cwd } : {}) });
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
// Side by side. A row is opened up so the new pane shares the width with each sibling, instead of sitting beside the whole row.
export function beside(left: Pane, right: Pane): Pane {
  const row = (pane: Pane): Pane[] => !isLeaf(pane) && pane.direction === 'row' ? pane.children : [pane];
  const children = [...row(left), ...row(right)];
  return equalize(children.length === 1 ? children[0] : { direction: 'row', children, sizes: children.map(() => 1) });
}
// Drops terminals that no longer exist on the server; editor groups and launchers never die with a process.
export function pruneDead(pane: Pane | null, live: Set<string>): Pane | null {
  let next = pane;
  for (const leaf of leafList(pane)) if (isTerminal(leaf) && !live.has(leaf.id)) next = next && remove(next, leaf.id);
  return next;
}
export const basename = (path: string) => path.split('/').pop() || path;
export const isDiffTab = (path: string) => path.startsWith('diff:');

// Paths are only ever chosen in the OS folder dialog, never typed: the desktop app uses Electron's, the browser asks the local server to open one.
type DesktopBridge = { pickFolder(options?: { title?: string; defaultPath?: string }): Promise<string | null> };
export async function chooseFolder(title: string, defaultPath: string) {
  const desktop = (window as unknown as { adeDesktop?: DesktopBridge }).adeDesktop;
  if (desktop) return desktop.pickFolder({ title, defaultPath: defaultPath || undefined });
  return (await api<{ path: string | null }>('dialog/folder', { title, defaultPath })).path;
}
