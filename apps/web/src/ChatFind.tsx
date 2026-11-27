import { useEffect, useRef, useState, type RefObject } from 'react';
import { IconButton } from './Icon';
import { findRanges, FIND_MAX, findStep } from './chat-find';

// Find in the conversation of one chat pane (Ctrl/⌘+F). The matches are painted with the CSS Custom Highlight API, so the thread's DOM is not touched
// (no wrapping spans, nothing for React to fight over); the ranges are rebuilt a moment after the thread changes. Only what is rendered is searched:
// older pages of a long chat are offered with one button instead of being loaded behind the reader's back. Enter / Shift+Enter: next / previous, Esc: close.
type Painted = { all: Range[]; current: Range | null };
const painted = new Map<symbol, Painted>();
function paint() {
  const highlights = (globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights, Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!highlights || !Highlight) return;
  const all = [...painted.values()], ranges = all.flatMap(item => item.all), current = all.flatMap(item => item.current ? [item.current] : []);
  if (ranges.length) highlights.set('ade-chat-find', new Highlight(...ranges)); else highlights.delete('ade-chat-find');
  if (current.length) highlights.set('ade-chat-find-current', new Highlight(...current)); else highlights.delete('ade-chat-find-current');
}

export function ChatFind({ thread, scroller, version, hidden, onLoadAll, onReveal, onClose, focusKey }: { thread: RefObject<HTMLElement | null>; scroller: RefObject<HTMLElement | null>; version: unknown; hidden: number; onLoadAll(): void; onReveal(): void; onClose(): void; focusKey: number }) {
  const input = useRef<HTMLInputElement>(null), owner = useRef(Symbol('find')).current;
  const [query, setQuery] = useState(''), [ranges, setRanges] = useState<Range[]>([]), [at, setAt] = useState(0);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [focusKey]);
  // Searched again a moment after the query or the thread changes; a new query brings its first match into view, a thread change keeps the reader where they are.
  const searched = useRef('');
  useEffect(() => {
    const root = thread.current; if (!root) return;
    const timer = setTimeout(() => {
      const next = findRanges(root, query), fresh = searched.current !== query; searched.current = query;
      setRanges(next); setAt(index => fresh ? 0 : Math.min(index, Math.max(0, next.length - 1)));
      if (fresh && query) reveal(next[0] ?? null);
    }, query ? 120 : 0);
    return () => clearTimeout(timer);
  }, [query, version, thread]);
  const current = ranges[at] ?? null;
  useEffect(() => { painted.set(owner, { all: ranges, current }); paint(); }, [ranges, current, owner]);
  useEffect(() => () => { painted.delete(owner); paint(); }, [owner]);
  const reveal = (range: Range | null) => {
    const view = scroller.current; if (!range || !view) return;
    const box = range.getBoundingClientRect(), frame = view.getBoundingClientRect();
    if (!box.height && !box.width) return;
    if (box.top < frame.top + 48 || box.bottom > frame.bottom - 16) { onReveal(); view.scrollTop += box.top - frame.top - frame.height / 3; }
  };
  const go = (step: 1 | -1) => { if (!ranges.length) return; const next = findStep(at, ranges.length, step); setAt(next); reveal(ranges[next]); };
  const count = !query ? '' : ranges.length ? `${at + 1}/${ranges.length >= FIND_MAX ? `${FIND_MAX}+` : ranges.length}` : '결과 없음';
  return <div className="chat-find" role="search" aria-label="대화 안 찾기">
    <input ref={input} type="search" value={query} placeholder="대화 안 찾기" aria-label="대화 안 찾기" spellCheck={false} onChange={event => { setQuery(event.target.value); setAt(0); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); go(event.shiftKey ? -1 : 1); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        else if ((event.ctrlKey || event.metaKey) && event.code === 'KeyF') { event.preventDefault(); event.currentTarget.select(); }
      }} />
    <span className="chat-find-count" role="status">{count}</span>
    {hidden > 0 && <button type="button" className="chat-find-more" title="화면에 불러오지 않은 이전 대화까지 찾습니다" onClick={onLoadAll}>이전 {hidden}개 포함</button>}
    <IconButton icon="arrowUp" label="이전 결과 (Shift+Enter)" size={13} disabled={!ranges.length} onClick={() => go(-1)} />
    <IconButton icon="arrowDown" label="다음 결과 (Enter)" size={13} disabled={!ranges.length} onClick={() => go(1)} />
    <IconButton icon="x" label="찾기 닫기 (Esc)" size={13} onClick={onClose} />
  </div>;
}
