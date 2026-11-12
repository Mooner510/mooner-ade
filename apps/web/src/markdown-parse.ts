// The pure half of the chat's Markdown: text -> block nodes, plus the cuts the streaming renderer makes. No React, so tests load it directly.
export type Node =
  | { t: 'p'; text: string } | { t: 'h'; level: number; text: string } | { t: 'code'; lang: string; code: string; open?: true } | { t: 'quote'; text: string } | { t: 'hr' }
  | { t: 'list'; ordered: boolean; items: ListItem[] } | { t: 'table'; head: string[]; rows: string[][] };
type ListItem = { text: string; depth: number; num?: number; blocks?: Node[] };
const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());

// The code fence opening at lines[start], up to its closing line (the returned index; lines.length when it never closed).
// An indented fence (inside a list item) loses that indent from each code line, so the code reads as written.
function fenced(lines: string[], start: number): [Node, number] {
  const [, indent, mark, lang] = /^(\s*)(```+|~~~+)\s*([\w+-]*)/.exec(lines[start])!, strip = new RegExp(`^ {0,${indent.length}}`), code: string[] = [];
  let i = start + 1;
  for (; i < lines.length && !lines[i].trimStart().startsWith(mark); i++) code.push(lines[i].replace(strip, ''));
  // `open` only when the closing fence never arrived (still streaming, or cut off): an interactive block must not run half-written code.
  return [{ t: 'code', lang, code: code.join('\n'), ...(i >= lines.length && { open: true as const }) }, i];
}

export function parse(source: string): Node[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n'), nodes: Node[] = [];
  let paragraph: string[] = [];
  // A single newline inside a paragraph is kept as a line break: models write it as one, and a streamed line then never reflows into the one above.
  const flush = () => { if (paragraph.length) nodes.push({ t: 'p', text: paragraph.join('\n') }); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) { flush(); const [node, end] = fenced(lines, i); nodes.push(node); i = end; continue; }
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flush(); nodes.push({ t: 'h', level: heading[1].length, text: heading[2] }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); nodes.push({ t: 'hr' }); continue; }
    if (line.startsWith('>')) {
      flush(); const quote = [line.replace(/^>\s?/, '')];
      while (i + 1 < lines.length && lines[i + 1].startsWith('>')) quote.push(lines[++i].replace(/^>\s?/, ''));
      nodes.push({ t: 'quote', text: quote.join('\n') }); continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush(); const head = cells(line), rows: string[][] = []; i++;
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) rows.push(cells(lines[++i]));
      nodes.push({ t: 'table', head, rows }); continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      // Each item keeps the number it was written with ("5.", "11."): a list cut by a paragraph would restart at 1, and a gap ("9." "11.") would be renumbered.
      const make = (m: RegExpExecArray): ListItem => ({ text: m[3], depth: Math.min(1, Math.floor(m[1].length / 2)), num: /\d/.test(m[2]) ? Number.parseInt(m[2], 10) : undefined });
      flush(); const ordered = /\d/.test(item[2]), items = [make(item)];
      while (i + 1 < lines.length) {
        const next = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i + 1]);
        const last = items[items.length - 1], tail = last.blocks?.[last.blocks.length - 1];
        if (next) { items.push(make(next)); i++; }
        // A fence indented under an item ("- Create a.ts:\n  ```ts") is that item's code block, not text glued onto its line.
        else if (/^\s{2,}(```|~~~)/.test(lines[i + 1])) { const [node, end] = fenced(lines, i + 1); (last.blocks ??= []).push(node); i = end; }
        // A continuation line joins the item's text, or, once the item has a code block, a paragraph after that block.
        else if (/^\s{2,}\S/.test(lines[i + 1])) {
          const text = lines[++i].trim();
          if (!last.blocks) last.text += ` ${text}`; else if (tail?.t === 'p') tail.text += `\n${text}`; else last.blocks.push({ t: 'p', text });
        }
        else break;
      }
      nodes.push({ t: 'list', ordered, items }); continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return nodes;
}

// Where a streaming text can be cut so the part before it never changes shape again: the last blank line outside a code fence.
export function stableSplit(text: string): [string, string] {
  let fence: string | null = null, cut = -1, at = 0;
  for (const line of text.split('\n')) {
    const mark = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (mark && (!fence || mark.startsWith(fence))) fence = fence ? null : mark;
    else if (!fence && !line.trim() && at > 0) cut = at;
    at += line.length + 1;
  }
  return cut < 0 ? ['', text] : [text.slice(0, cut - 1), text.slice(cut + 1)];
}
// While text streams, a line still being typed that is only a block marker so far ("1", "-", "#", "**") or a table/fence line would render as a
// paragraph and jump to its real shape a moment later; it is held back until it can no longer change shape. So is a table head still waiting for its |---| row.
const PENDING_LINE = /^\s*(?:(?:#{1,6}|[-*+]|\d+[.)]?|>|[-*_]{2,}|`{1,2}|~{1,2})\s*$|\||```|~~~)/;
export function holdBack(tail: string): string {
  const all = tail.split('\n');
  if (all.length && PENDING_LINE.test(all[all.length - 1])) all.pop();
  let last = all.length - 1; while (last >= 0 && !all[last].trim()) last -= 1;
  if (last >= 0 && /^\s*\|/.test(all[last]) && !all.some(line => /^\s*\|?\s*:?-{2,}:?\s*\|/.test(line))) all.splice(last, 1);
  return all.join('\n');
}

// Inline spans, one capture group each: code, **bold**, __bold__, *italic*, _italic_, [label](url), bare URL. Like CommonMark, `__` and `_` only open and close
// at a word edge, so identifiers such as `mcp__server__tool` or `snake_case_name` stay plain text.
export const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\b__[^_\n]+__\b)|(\*[^*\s][^*\n]*\*)|(\b_[^_\s][^_\n]*_\b)|(\[(?:[^\[\]\n]|\[[^\]\n]*\])+\]\([^)\s]+\))|(https?:\/\/[^\s<>)]+)/g;
