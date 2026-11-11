import { Fragment, memo, type ReactNode } from 'react';
import { Icon } from './Icon';
import { copyText } from './toast';
import { holdBack, INLINE, parse, stableSplit, type Node } from './markdown-parse';

// A small Markdown renderer for chat replies. It builds React elements (never HTML strings), so model output cannot inject markup,
// and links go through the app's own "open external link?" dialog (ade:link).
// shortcut: no nested lists beyond two levels, no HTML, no syntax highlighting; add a library only if replies need more.

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


// Text with its line breaks: each line through `inline`, joined by <br>.
const lines = (text: string) => text.split('\n').flatMap((line, index) => index ? [<br key={`br${index}`} />, <Fragment key={`l${index}`}>{inline(line)}</Fragment>] : [<Fragment key="l0">{inline(line)}</Fragment>]);

function renderNode(node: Node, key: string) {
  switch (node.t) {
    case 'h': { const Tag = `h${Math.min(6, node.level + 2)}` as 'h3'; return <Tag key={key}>{inline(node.text)}</Tag>; }
    case 'code': return <CodeBlock key={key} code={node.code} lang={node.lang} />;
    case 'quote': return <blockquote key={key}>{lines(node.text)}</blockquote>;
    case 'hr': return <hr key={key} />;
    case 'list': { const Tag = node.ordered ? 'ol' : 'ul'; return <Tag key={key}>{node.items.map((item, i) => <li key={i} className={item.depth ? 'nested' : ''}>{inline(item.text)}</li>)}</Tag>; }
    case 'table': return <div className="md-table" key={key}><table><thead><tr>{node.head.map((cell, i) => <th key={i}>{inline(cell)}</th>)}</tr></thead>
      <tbody>{node.rows.map((row, r) => <tr key={r}>{node.head.map((_, c) => <td key={c}>{inline(row[c] ?? '')}</td>)}</tr>)}</tbody></table></div>;
    default: return <p key={key}>{lines(node.text)}</p>;
  }
}
// Parsed nodes without a wrapper, memoized by text: the finished part of a streaming reply is parsed once, not on every revealed character.
const Nodes = memo(function Nodes({ text, prefix }: { text: string; prefix: string }) { return <>{parse(text).map((node, index) => renderNode(node, `${prefix}${index}`))}</>; });

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md"><Nodes text={text} prefix="n" /></div>;
});

// A reply that is (or was) streaming: the stable head is parsed once per paragraph, only the tail on every step.
export function LiveMarkdown({ text, live }: { text: string; live: boolean }) {
  const [head, tail] = stableSplit(text);
  return <div className="md">{head && <Nodes text={head} prefix="h" />}<Nodes text={live ? holdBack(tail) : tail} prefix="t" /></div>;
}
