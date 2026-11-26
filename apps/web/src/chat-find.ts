// Text search over a rendered chat thread for ChatFind. The pure parts (offsets, stepping) are tested in node; findRanges walks the DOM.
export const FIND_MAX = 1000;
const INLINE = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'CODE', 'DEL', 'EM', 'I', 'INS', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR']);

/** Where `needle` occurs in `text`, ignoring case, at most `max` times (non-overlapping). */
export function findOffsets(text: string, needle: string, max = FIND_MAX): number[] {
  const hay = text.toLowerCase(), word = needle.toLowerCase(), out: number[] = [];
  if (!word || hay.length !== text.length) return out;
  for (let at = hay.indexOf(word); at >= 0 && out.length < max; at = hay.indexOf(word, at + word.length)) out.push(at);
  return out;
}
/** The next match index, wrapping round. */
export const findStep = (at: number, count: number, step: 1 | -1) => count ? (at + step + count) % count : 0;

/** Ranges of every match in the visible text under `root`. Text nodes of one block are searched as one string (a word split by <b> still matches);
 *  different blocks are kept apart. Folded rows (inert) and hidden decorations (aria-hidden) are skipped. */
export function findRanges(root: HTMLElement, needle: string, max = FIND_MAX): Range[] {
  const query = needle.trim(); if (!query) return [];
  const blockOf = (node: Node) => { let el = node.parentElement; while (el && el !== root && INLINE.has(el.tagName)) el = el.parentElement; return el; };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: node => {
    const parent = node.parentElement;
    return !node.nodeValue || !parent || parent.closest('[inert], [aria-hidden="true"], style, script, .chat-find') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
  } });
  const ranges: Range[] = [];
  let nodes: { node: Text; start: number }[] = [], text = '', block: Element | null = null;
  const flush = () => {
    for (const at of findOffsets(text, query, max - ranges.length)) {
      const end = at + query.length, from = locate(nodes, at, false), to = locate(nodes, end, true);
      if (!from || !to) continue;
      const range = document.createRange(); range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset); ranges.push(range);
    }
    nodes = []; text = '';
  };
  for (let node = walker.nextNode() as Text | null; node && ranges.length < max; node = walker.nextNode() as Text | null) {
    const owner = blockOf(node);
    if (owner !== block) { flush(); block = owner; }
    nodes.push({ node, start: text.length }); text += node.nodeValue;
  }
  if (ranges.length < max) flush();
  return ranges;
}
// The text node and offset of a position in the joined block text; an end that falls on a node boundary stays in the earlier node.
function locate(nodes: { node: Text; start: number }[], position: number, end: boolean) {
  for (let at = nodes.length - 1; at >= 0; at--) {
    const { node, start } = nodes[at];
    if (end ? position > start : position >= start) return { node, offset: Math.min(position - start, node.length) };
  }
  return nodes[0] && position === 0 ? { node: nodes[0].node, offset: 0 } : null;
}
