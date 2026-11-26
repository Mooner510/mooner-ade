// With the extension: Node's tests load this module directly (tests/pane-move.test.mjs).
import { ApiError, call, isRemote } from './transport.ts';
export { ApiError };
export const api = <T = any>(action: string, input: object = {}): Promise<T> => call<T>(action, input);
// A leaf is a terminal, an editor group, a chat (a headless Claude Code drawn as a conversation; its id names the server-side transcript) or a launcher (a fresh pane still choosing what to run); legacy saved layouts have `{ id }` only and mean terminal.
// A terminal leaf also remembers where it was opened and which agent CLI ran in it, so it can be reopened after the server restarts.
// A console leaf is a plugin's console tab (plugin API v2 `console`); `plugin` names the plugin.
export type Leaf = { id: string; kind?: 'terminal' | 'editor' | 'launcher' | 'chat' | 'console'; tabs?: string[]; active?: string; preview?: string; cwd?: string; agent?: 'claude' | 'codex' | 'cursor'; plugin?: string };
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
// Where a dragged pane would land inside a slot. x/y are fractions of the slot (0–1).
// The outer 22% is an edge: left/right insert along a row, top/bottom along a column; a corner uses the nearer edge.
// The center splits the target. The nearer axis (larger offset from the middle) picks row or column.
const DROP_EDGE = 0.22;
export function paneDrop(x: number, y: number): { how: 'before' | 'after' | 'row' | 'column'; axis: 'row' | 'column' } {
  const left = x < DROP_EDGE, right = x > 1 - DROP_EDGE, top = y < DROP_EDGE, bottom = y > 1 - DROP_EDGE;
  if (left || right || top || bottom) {
    const dx = Math.min(x, 1 - x), dy = Math.min(y, 1 - y);
    if ((left || right) && (!(top || bottom) || dx <= dy)) return { how: x < 0.5 ? 'before' : 'after', axis: 'row' };
    return { how: y < 0.5 ? 'before' : 'after', axis: 'column' };
  }
  const axis = Math.abs(x - 0.5) >= Math.abs(y - 0.5) ? 'row' : 'column';
  return { how: axis, axis };
}
type DragSide = { how: 'before' | 'after'; axis: 'row' | 'column' };
function dragEdges(x: number, y: number, header: number) {
  const row: DragSide = { how: x <= .5 ? 'before' : 'after', axis: 'row' };
  const column: DragSide = { how: y <= .5 ? 'before' : 'after', axis: 'column' };
  return { row, column, dx: Math.min(x, 1 - x), dy: y <= header ? Infinity : Math.min(y, 1 - y) };
}
// Header travel reorders side by side. Below the header, even the center resolves to a side.
export function dragPlace(x: number, y: number, parent: 'row' | 'column', header = 0): DragSide {
  const { row, column, dx, dy } = dragEdges(x, y, header);
  return dx < dy || (dx === dy && parent === 'row') ? row : column;
}
export function dragHolds(place: DragSide, x: number, y: number, header = 0) {
  const { dx, dy } = dragEdges(x, y, header);
  const distance = place.axis === 'row'
    ? (place.how === 'before' ? x : 1 - x)
    : (y <= header ? Infinity : place.how === 'before' ? y : 1 - y);
  return distance <= Math.min(dx, dy) + .06;
}
// Moves `id` next to `targetId`, or splits that leaf. `before`/`after` insert along `axis` (default row);
// a parent whose direction differs wraps the target the way `split` wraps a leaf. `row`/`column` split the
// target and the moved leaf is the second child, same as `split`. A split left with one child collapses, same as `remove`.
export function placeLeaf(pane: Pane, id: string, targetId: string, how: 'before' | 'after' | 'row' | 'column', axis?: 'row' | 'column'): Pane {
  if (id === targetId) return pane;
  const leaf = findLeaf(pane, id);
  if (!leaf || !findLeaf(pane, targetId)) return pane;
  if (how === 'row' || how === 'column') {
    const rest = remove(pane, id);
    return rest ? split(rest, targetId, leaf, how) : pane;
  }
  const direction = axis ?? 'row';
  const reordered = reorderSiblings(pane, id, targetId, how, direction);
  if (reordered) return reordered;
  const rest = removeForMove(pane, id);
  return rest ? insertLeaf(rest, targetId, leaf, how, direction) : pane;
}
function reorderSiblings(pane: Pane, id: string, targetId: string, how: 'before' | 'after', direction: 'row' | 'column'): Pane | undefined {
  if (isLeaf(pane)) return;
  const from = pane.children.findIndex(child => isLeaf(child) && child.id === id);
  const to = pane.children.findIndex(child => isLeaf(child) && child.id === targetId);
  if (from >= 0 && to >= 0) {
    if (pane.direction !== direction) return;
    const at = to - Number(from < to) + Number(how === 'after');
    if (from === at) return pane;
    const children = [...pane.children], sizes = [...pane.sizes];
    children.splice(at, 0, children.splice(from, 1)[0]);
    sizes.splice(at, 0, sizes.splice(from, 1)[0]);
    return { ...pane, children, sizes };
  }
  for (const [index, child] of pane.children.entries()) {
    const next = reorderSiblings(child, id, targetId, how, direction);
    if (!next) continue;
    if (next === child) return pane;
    const children = [...pane.children]; children[index] = next;
    return { ...pane, children };
  }
}
function removeForMove(pane: Pane, id: string): Pane | null {
  if (isLeaf(pane)) return pane.id === id ? null : pane;
  const children: Pane[] = [], sizes: number[] = [];
  for (const [index, child] of pane.children.entries()) {
    const next = removeForMove(child, id);
    if (next) { children.push(next); sizes.push(pane.sizes[index]); }
  }
  if (children.length <= 1) return children[0] ?? null;
  return children.every((child, index) => child === pane.children[index]) && children.length === pane.children.length
    ? pane : { ...pane, children, sizes };
}
function insertLeaf(pane: Pane, targetId: string, leaf: Leaf, how: 'before' | 'after', direction: 'row' | 'column'): Pane {
  if (isLeaf(pane)) return pane.id === targetId ? { direction, children: how === 'before' ? [leaf, pane] : [pane, leaf], sizes: [1, 1] } : pane;
  const index = pane.children.findIndex(child => isLeaf(child) && child.id === targetId);
  if (index >= 0 && pane.direction === direction) {
    const children = [...pane.children];
    children.splice(how === 'before' ? index : index + 1, 0, leaf);
    const sizes = [...pane.sizes];
    // A pane joining an even split gets the same share as its siblings.
    const targetSize = sizes[index];
    const share = sizes.every(size => size === targetSize) ? targetSize : targetSize / 2;
    sizes.splice(index, 1, share, share);
    return { ...pane, children, sizes };
  }
  if (index >= 0) {
    const target = pane.children[index];
    const wrapped: Pane = { direction, children: how === 'before' ? [leaf, target] : [target, leaf], sizes: [1, 1] };
    return { ...pane, children: pane.children.map((child, i) => i === index ? wrapped : child) };
  }
  const children = pane.children.map(child => insertLeaf(child, targetId, leaf, how, direction));
  return children.every((child, i) => child === pane.children[i]) ? pane : { ...pane, children };
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
// Either slash: tool inputs on Windows carry "C:\repo\src\a.ts", which a '/'-only split returned whole.
export const basename = (path: string) => path.split(/[\\/]/).pop() || path;
export const isDiffTab = (path: string) => path.startsWith('diff:');

// Paths are only ever chosen in the OS folder dialog, never typed: the desktop app uses Electron's, the browser asks the local server to open one.
type DesktopBridge = { pickFolder(options?: { title?: string; defaultPath?: string }): Promise<string | null> };
export async function chooseFolder(title: string, defaultPath: string) {
  const desktop = (window as unknown as { adeDesktop?: DesktopBridge }).adeDesktop;
  if (desktop) return desktop.pickFolder({ title, defaultPath: defaultPath || undefined });
  // A phone cannot use a dialog that opens on the PC; it browses the PC's folders in the page instead.
  if (isRemote) return (await import('./remote-folder')).pickRemoteFolder(title, defaultPath);
  return (await api<{ path: string | null }>('dialog/folder', { title, defaultPath })).path;
}
