// Arrow keys in a tree (the sidebar's projects, tabs and split panes), as WAI-ARIA's tree pattern: ↑/↓ the next visible row, Home/End the first
// and last, → opens a closed row or steps into an open one, ← closes an open row or goes up to its parent. Pure (tests/workspace-keyboard.test.mjs).

// expanded: undefined for a row without children; fixed: open but cannot be closed (a split tab always shows its panes).
export type TreeRow = { level: number; expanded?: boolean; fixed?: boolean };
export type TreeMove = { focus: number } | { toggle: number; expand: boolean } | null;

export function treeKey(rows: readonly TreeRow[], index: number, key: string): TreeMove {
  if (!rows.length) return null;
  const at = Math.min(Math.max(index, 0), rows.length - 1), row = rows[at];
  const parent = () => { for (let i = at - 1; i >= 0; i--) if (rows[i].level < row.level) return i; return -1; };
  switch (key) {
    case 'ArrowDown': return at < rows.length - 1 ? { focus: at + 1 } : null;
    case 'ArrowUp': return at > 0 ? { focus: at - 1 } : null;
    case 'Home': return at > 0 ? { focus: 0 } : null;
    case 'End': return at < rows.length - 1 ? { focus: rows.length - 1 } : null;
    case 'ArrowRight':
      if (row.expanded === false) return { toggle: at, expand: true };
      return row.expanded && rows[at + 1]?.level > row.level ? { focus: at + 1 } : null;
    case 'ArrowLeft': {
      if (row.expanded && !row.fixed) return { toggle: at, expand: false };
      const up = parent();
      return up >= 0 ? { focus: up } : null;
    }
    default: return null;
  }
}

// A row of tabs (the editor's open files): ←/→ wrap around, Home/End jump to the ends; anything else is not ours.
export const tabStep = (count: number, at: number, key: string) => !count ? null
  : key === 'ArrowRight' ? (at + 1) % count : key === 'ArrowLeft' ? (at - 1 + count) % count : key === 'Home' ? 0 : key === 'End' ? count - 1 : null;

// Two panes trade places in a layout tree (sizes stay with the slots). Leaves are { id }, splits { children }; anything else is kept as is.
export function swapLeaves<T>(tree: T, a: string, b: string): T {
  type Node = { id?: string; children?: Node[] };
  const find = (node: Node, id: string): Node | undefined => node.id === id ? node : node.children?.map(child => find(child, id)).find(Boolean);
  const root = tree as unknown as Node, first = find(root, a), second = find(root, b);
  if (!first || !second || a === b) return tree;
  const walk = (node: Node): Node => node.id === a ? second : node.id === b ? first : node.children ? { ...node, children: node.children.map(walk) } : node;
  return walk(root) as unknown as T;
}
