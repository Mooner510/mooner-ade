import { useEffect, useMemo, useRef, useState } from 'react';

export type QuickItem = { id: string; label: string; detail?: string; keys?: string };
export type QuickRequest =
  | { kind: 'pick'; title: string; items: QuickItem[]; resolve(value: string | null): void }
  | { kind: 'input'; title: string; initial?: string; resolve(value: string | null): void };

// Subsequence match; consecutive and word-start hits score higher. Returns -1 when the query does not match.
export function fuzzy(query: string, text: string) {
  if (!query) return 0;
  const lower = text.toLowerCase(), needle = query.toLowerCase();
  let score = 0, at = -1, streak = 0;
  for (const char of needle) {
    const next = lower.indexOf(char, at + 1);
    if (next < 0) return -1;
    streak = next === at + 1 ? streak + 1 : 0;
    score += 1 + streak * 2 + (next === 0 || '/._- '.includes(lower[next - 1]) ? 3 : 0);
    at = next;
  }
  return score - lower.length * .01;
}

// A choice list gets a search box only when it is long enough to need one (the palette, branches, models); a yes/no or a handful of options is just the list.
const SEARCH_FROM = 8;
export function QuickInput({ request, onClose }: { request: QuickRequest; onClose(): void }) {
  const [value, setValue] = useState(request.kind === 'input' ? request.initial || '' : '');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null), box = useRef<HTMLDivElement>(null);
  const searchable = request.kind === 'pick' && request.items.length >= SEARCH_FROM, typed = request.kind === 'input' || searchable;
  useEffect(() => { if (typed) { input.current?.focus(); input.current?.select(); } else box.current?.focus(); }, []);
  const items = useMemo<QuickItem[]>(() => {
    if (request.kind === 'input') return [];
    const query = searchable ? value.trim() : '';
    if (!query) return request.items;
    return request.items.map(item => ({ item, score: fuzzy(query, item.label) })).filter(entry => entry.score >= 0).sort((a, b) => b.score - a.score).slice(0, 80).map(entry => entry.item);
  }, [request, value, searchable]);
  useEffect(() => setIndex(0), [value]);
  const finish = (result: string | null) => { onClose(); request.resolve(result); };
  const title = request.title;
  // The title is always a heading above the field/list (never a placeholder). A short one is bold; a sentence (a warning, a question) is plain text, and
  // whatever follows its first line is the muted detail.
  const [first, ...more] = title.split('\n'), detail = more.join('\n').trim(), sentence = first.length > 40 || Boolean(detail);
  return <div className="quick-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) finish(null); }}>
    <div className="quick" role="dialog" aria-label={first} ref={box} tabIndex={-1}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); finish(null); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(current => Math.max(0, Math.min(items.length - 1, current + 1))); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(current => Math.max(0, current - 1)); }
        else if (event.key === 'Enter') {
          event.preventDefault();
          if (request.kind === 'input') finish(value.trim() ? value : null);
          else if (items[index]) finish(items[index].id);
        }
      }}>
      <div className="quick-head"><p className={sentence ? 'quick-message' : 'quick-title'}>{first}</p>{detail && <p className="quick-note">{detail}</p>}</div>
      {typed && <input ref={input} value={value} aria-label={first} placeholder={request.kind === 'input' ? '' : '검색'} onChange={event => setValue(event.target.value)} />}
      {request.kind !== 'input' && <ul role="listbox">{items.map((item, position) => <li key={item.id} role="option" aria-selected={position === index} className={position === index ? 'selected' : ''} onMouseMove={() => setIndex(position)} onMouseDown={event => { event.preventDefault(); finish(item.id); }}>
        <span>{item.label}</span>{item.detail && <small>{item.detail}</small>}{item.keys && <kbd>{item.keys}</kbd>}</li>)}{!items.length && <li className="none">일치하는 항목이 없습니다.</li>}</ul>}
    </div>
  </div>;
}
