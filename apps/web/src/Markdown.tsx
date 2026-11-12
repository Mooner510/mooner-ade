import { Fragment, memo, useContext, useEffect, useState, type ReactNode } from 'react';
import { colorize } from './Editor';
import { Icon } from './Icon';
import { copyText } from './toast';
import { holdBack, INLINE, parse, stableSplit, type Node } from './markdown-parse';
import { ChatUiContext, UiFrame } from './UiFrame';
import { UI_LANG } from './ui-frame-protocol';
import { NATIVE_LANG, parseUi } from './ui-spec';
import { UiSpecView } from './UiBlocks';

// A small Markdown renderer for chat replies. It builds React elements (no HTML strings except Monaco's escaped syntax colouring), so model output cannot inject markup,
// and links go through the app's own "open external link?" dialog (ade:link).
// shortcut: no nested lists beyond two levels, no HTML; code is coloured by Monaco's tokenizer (CodeBlock). Add a library only if replies need more.

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

// Syntax colours arrive a moment after the text (Monaco loads lazily, and a streaming block is coloured once it pauses). Until then the
// part already coloured stays coloured and only the newer tail is plain, so a growing block never flickers back to monochrome.
function useColored(code: string, hint?: string) {
  const [done, setDone] = useState<{ code: string; html: string } | null>(null);
  useEffect(() => {
    if (!hint) return;
    let live = true;
    const timer = setTimeout(() => { void colorize(code, hint).then(html => { if (live && html) setDone({ code, html: html.replace(/(<br\/>)+$/, '') }); }, () => {}); }, 120);
    return () => { live = false; clearTimeout(timer); };
  }, [code, hint]);
  return done && code.startsWith(done.code) ? done : null;
}
// lang is the header label; syntax (default: lang) picks the colours, so a header like "src/a.ts · 새 파일 · 7줄" can still colour as TypeScript.
export function CodeBlock({ code, lang, syntax }: { code: string; lang?: string; syntax?: string }) {
  const colored = useColored(code, syntax ?? lang);
  return <div className="md-code"><header><span>{lang || 'text'}</span><button type="button" title="코드 복사" aria-label="코드 복사" onClick={() => copyText(code)}><Icon name="copy" size={13} />복사</button></header>
    <pre><code>{colored ? <><span dangerouslySetInnerHTML={{ __html: colored.html }} />{code.slice(colored.code.length)}</> : code}</code></pre></div>;
}

// A ```ui fence (JSON drawn natively, see ui-spec.ts) or an ```ade-ui fence (HTML/JS in a sandboxed iframe): the UI once the fence is closed (half-written code must not run),
// a placeholder while it streams, a plain code block when the feature is off or the JSON is unusable.
function UiBlock({ code, lang, open, live }: { code: string; lang: string; open?: boolean; live: boolean }) {
  const ui = useContext(ChatUiContext);
  if (!ui?.enabled || (open && !live)) return <CodeBlock code={code} lang={lang} />;
  if (open) return <div className="ade-ui-pending"><Icon name="code" size={14} />인터랙티브 UI 생성 중…</div>;
  if (lang === UI_LANG) return <UiFrame chatId={ui.chatId} html={code} />;
  const specs = parseUi(code);
  return specs ? <UiSpecView chatId={ui.chatId} specs={specs} /> : <CodeBlock code={code} lang={lang} />;
}

// Text with its line breaks: each line through `inline`, joined by <br>.
const lines = (text: string) => text.split('\n').flatMap((line, index) => index ? [<br key={`br${index}`} />, <Fragment key={`l${index}`}>{inline(line)}</Fragment>] : [<Fragment key="l0">{inline(line)}</Fragment>]);

function renderNode(node: Node, key: string, live: boolean) {
  switch (node.t) {
    case 'h': { const Tag = `h${Math.min(6, node.level + 2)}` as 'h3'; return <Tag key={key}>{inline(node.text)}</Tag>; }
    case 'code': return node.lang === UI_LANG || node.lang === NATIVE_LANG ? <UiBlock key={key} code={node.code} lang={node.lang} open={node.open} live={live} /> : <CodeBlock key={key} code={node.code} lang={node.lang} />;
    case 'quote': return <blockquote key={key}>{lines(node.text)}</blockquote>;
    case 'hr': return <hr key={key} />;
    case 'list': {
      const Tag = node.ordered ? 'ol' : 'ul';
      return <Tag key={key}>{node.items.map((item, i) => <li key={i} value={node.ordered ? item.num : undefined} className={item.depth ? 'nested' : ''}>
        {inline(item.text)}{item.blocks?.map((block, b) => renderNode(block, `${key}-${i}-${b}`, live))}</li>)}</Tag>;
    }
    case 'table': return <div className="md-table" key={key}><table><thead><tr>{node.head.map((cell, i) => <th key={i}>{inline(cell)}</th>)}</tr></thead>
      <tbody>{node.rows.map((row, r) => <tr key={r}>{node.head.map((_, c) => <td key={c}>{inline(row[c] ?? '')}</td>)}</tr>)}</tbody></table></div>;
    default: return <p key={key}>{lines(node.text)}</p>;
  }
}
// Parsed nodes without a wrapper, memoized by text: the finished part of a streaming reply is parsed once, not on every revealed character.
const Nodes = memo(function Nodes({ text, prefix, live = false }: { text: string; prefix: string; live?: boolean }) { return <>{parse(text).map((node, index) => renderNode(node, `${prefix}${index}`, live))}</>; });

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md"><Nodes text={text} prefix="n" /></div>;
});

// A reply that is (or was) streaming: the stable head is parsed once per paragraph, only the tail on every step.
// ponytail: a reply with an interactive UI (either kind) skips the head/tail split. Moving a finished block from tail to head would remount its iframe and reset what the user typed;
// the whole reply is reparsed per step instead (UiFrame is memoized, so only that parse costs). Fine for one reply; revisit if replies get huge.
export function LiveMarkdown({ text, live }: { text: string; live: boolean }) {
  const [head, tail] = HAS_UI.test(text) ? ['', text] : stableSplit(text);
  return <div className="md">{head && <Nodes text={head} prefix="h" />}<Nodes text={live ? holdBack(tail) : tail} prefix="t" live={live} /></div>;
}
const HAS_UI = new RegExp(`^\\s*(\`{3,}|~{3,})\\s*(${UI_LANG}|${NATIVE_LANG})\\b`, 'm');
