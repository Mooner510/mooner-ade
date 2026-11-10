import { Fragment, memo, type ReactNode } from 'react';
import { Icon } from './Icon';
import { copyText } from './toast';

// A small Markdown renderer for chat replies. It builds React elements (never HTML strings), so model output cannot inject markup,
// and links go through the app's own "open external link?" dialog (ade:link).
// shortcut: no nested lists beyond two levels, no HTML, no syntax highlighting; add a library only if replies need more.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*)|(\b_[^_\s][^_\n]*_\b)|(\[(?:[^\[\]\n]|\[[^\]\n]*\])+\]\([^)\s]+\))|(https?:\/\/[^\s<>)]+)/g;
function link(href: string, label: ReactNode, key: number) {
  if (!/^https?:\/\//i.test(href)) return <Fragment key={key}>{label}</Fragment>;
  return <a key={key} href={href} rel="noreferrer noopener" onClick={event => { event.preventDefault(); window.dispatchEvent(new CustomEvent('ade:link', { detail: href })); }}>{label}</a>;
}
export function inline(source: string): ReactNode[] {
  const out: ReactNode[] = []; let last = 0, key = 0;
  for (const match of source.matchAll(INLINE)) {
    const [text] = match; if (match.index > last) out.push(source.slice(last, match.index));
    if (match[1]) out.push(<code key={key++}>{text.slice(1, -1)}</code>);
    else if (match[2] || match[3]) out.push(<strong key={key++}>{inline(text.slice(2, -2))}</strong>);
    else if (match[4] || match[5]) out.push(<em key={key++}>{inline(text.slice(1, -1))}</em>);
    else if (match[6]) { const split = text.indexOf(']('); out.push(link(text.slice(split + 2, -1), inline(text.slice(1, split)), key++)); }
    else { const url = text.replace(/[.,;:!?]+$/, ''); out.push(link(url, url, key++)); if (url.length < text.length) out.push(text.slice(url.length)); }
    last = match.index + text.length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return <div className="md-code"><header><span>{lang || 'text'}</span><button type="button" title="코드 복사" aria-label="코드 복사" onClick={() => copyText(code)}><Icon name="copy" size={13} />복사</button></header><pre><code>{code}</code></pre></div>;
}

type Node =
  | { t: 'p'; text: string } | { t: 'h'; level: number; text: string } | { t: 'code'; lang: string; code: string } | { t: 'quote'; text: string } | { t: 'hr' }
  | { t: 'list'; ordered: boolean; items: { text: string; depth: number }[] } | { t: 'table'; head: string[]; rows: string[][] };
const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());

export function parse(source: string): Node[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n'), nodes: Node[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) nodes.push({ t: 'p', text: paragraph.join(' ') }); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush(); const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) code.push(lines[i]);
      nodes.push({ t: 'code', lang: fence[2], code: code.join('\n') }); continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flush(); nodes.push({ t: 'h', level: heading[1].length, text: heading[2] }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); nodes.push({ t: 'hr' }); continue; }
    if (line.startsWith('>')) {
      flush(); const quote = [line.replace(/^>\s?/, '')];
      while (i + 1 < lines.length && lines[i + 1].startsWith('>')) quote.push(lines[++i].replace(/^>\s?/, ''));
      nodes.push({ t: 'quote', text: quote.join(' ') }); continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush(); const head = cells(line), rows: string[][] = []; i++;
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) rows.push(cells(lines[++i]));
      nodes.push({ t: 'table', head, rows }); continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush(); const ordered = /\d/.test(item[2]), items = [{ text: item[3], depth: Math.min(1, Math.floor(item[1].length / 2)) }];
      while (i + 1 < lines.length) {
        const next = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i + 1]);
        if (next) { items.push({ text: next[3], depth: Math.min(1, Math.floor(next[1].length / 2)) }); i++; }
        else if (/^\s{2,}\S/.test(lines[i + 1]) && lines[i + 1].trim()) { items[items.length - 1].text += ` ${lines[++i].trim()}`; }
        else break;
      }
      nodes.push({ t: 'list', ordered, items }); continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return nodes;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md">{parse(text).map((node, index) => {
    switch (node.t) {
      case 'h': { const Tag = `h${Math.min(6, node.level + 2)}` as 'h3'; return <Tag key={index}>{inline(node.text)}</Tag>; }
      case 'code': return <CodeBlock key={index} code={node.code} lang={node.lang} />;
      case 'quote': return <blockquote key={index}>{inline(node.text)}</blockquote>;
      case 'hr': return <hr key={index} />;
      case 'list': { const Tag = node.ordered ? 'ol' : 'ul'; return <Tag key={index}>{node.items.map((item, i) => <li key={i} className={item.depth ? 'nested' : ''}>{inline(item.text)}</li>)}</Tag>; }
      case 'table': return <div className="md-table" key={index}><table><thead><tr>{node.head.map((cell, i) => <th key={i}>{inline(cell)}</th>)}</tr></thead>
        <tbody>{node.rows.map((row, r) => <tr key={r}>{node.head.map((_, c) => <td key={c}>{inline(row[c] ?? '')}</td>)}</tr>)}</tbody></table></div>;
      default: return <p key={index}>{inline(node.text)}</p>;
    }
  })}</div>;
});
