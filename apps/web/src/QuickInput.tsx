import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { fuzzy } from './palette-model';

export type QuickItem = { id: string; detail?: string; keys?: string } &
  ({ label: string; icon: IconName } | { label: '확인' | '취소'; icon?: never });
export type QuickRequest =
  | { kind: 'pick'; title: string; items: QuickItem[]; resolve(value: string | null): void; source?: QuickSource; placeholder?: string; initial?: string }
  | { kind: 'input'; title: string; initial?: string; resolve(value: string | null): void };

// A pick with a source (the command palette) asks it for the list on every keystroke instead of filtering `items`; `subscribe` asks again when
// something it reads arrives later (the project's file list), and `empty` is the line shown when nothing matches.
export type QuickSource = { filter(value: string): QuickItem[]; subscribe?(listener: () => void): () => void; empty?(value: string): string };

// The fuzzy score lives with the palette's other pure parts (Node tests load it from there).
export { fuzzy };

// A choice list gets a search box only when it is long enough to need one (the palette, branches, models); a yes/no or a handful of options is just the list.
const SEARCH_FROM = 8;
export function QuickInput({ request, onClose }: { request: QuickRequest; onClose(): void }) {
  const [value, setValue] = useState(request.initial || '');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null), box = useRef<HTMLDivElement>(null);
  // Where the keyboard was when this opened (a sidebar row, a terminal): a cancel puts it back there instead of leaving it on the page body.
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null);
  const source = request.kind === 'pick' ? request.source : undefined, [version, setVersion] = useState(0);
  useEffect(() => source?.subscribe?.(() => setVersion(current => current + 1)), [source]);
  const searchable = request.kind === 'pick' && (Boolean(source) || request.items.length >= SEARCH_FROM), typed = request.kind === 'input' || searchable;
  // A palette opened with a prefix already typed (`@`) keeps the caret after it instead of selecting it.
  useEffect(() => { if (typed) { input.current?.focus(); if (source) input.current?.setSelectionRange(value.length, value.length); else input.current?.select(); } else box.current?.focus(); }, []);
  const items = useMemo<QuickItem[]>(() => {
    if (request.kind === 'input') return [];
    if (source) return source.filter(value);
    const query = searchable ? value.trim() : '';
    // A project's whole file list is thousands long: show the first screenfuls until a search narrows it down.
    if (!query) return request.items.length > 300 ? request.items.slice(0, 300) : request.items;
    return request.items.map(item => ({ item, score: fuzzy(query, item.label) })).filter(entry => entry.score >= 0).sort((a, b) => b.score - a.score).slice(0, 80).map(entry => entry.item);
  }, [request, value, searchable, source, version]);
  useEffect(() => setIndex(0), [value]);
  // Arrow keys past the visible rows of a long list keep the chosen row in view.
  useEffect(() => { box.current?.querySelector('li.selected')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  const finish = (result: string | null) => {
    onClose(); request.resolve(result);
    const back = opener.current;
    if (result === null && back && back !== document.body) requestAnimationFrame(() => {
      const now = document.activeElement;
      if ((!now || now === document.body) && back.isConnected && !back.closest('[hidden], [inert]')) back.focus({ preventScroll: true });
    });
  };
  const title = request.title;
  // The title is always a heading above the field/list (never a placeholder). A short one is bold; a sentence (a warning, a question) is plain text, and
  // whatever follows its first line is the muted detail.
  const [first, ...more] = title.split('\n'), detail = more.join('\n').trim(), sentence = first.length > 40 || Boolean(detail);
  // Modal(views.tsx)과 같은 규칙: 누름과 놓음이 모두 상자 바깥일 때만 닫는다(입력 칸 안에서 글자를 끌어 선택하다 배경에서 놓아도, 배경에서 눌러 안에서 놓아도 닫히지 않는다).
  const pressedOutside = useRef(false);
  const outside = (event: { clientX: number; clientY: number }) => { const rect = box.current?.getBoundingClientRect(); return !rect || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom; };
  return <div className="quick-backdrop" onMouseDown={event => { pressedOutside.current = event.target === event.currentTarget && outside(event); }} onClick={event => { if (pressedOutside.current && outside(event)) finish(null); pressedOutside.current = false; }}>
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
      {typed && <input ref={input} value={value} aria-label={first} placeholder={request.kind === 'input' ? '' : request.placeholder ?? '검색'} onChange={event => setValue(event.target.value)} />}
      {request.kind !== 'input' && <ul role="listbox">{items.map((item, position) => <li key={item.id} role="option" aria-selected={position === index} className={position === index ? 'selected' : ''} onMouseMove={() => setIndex(position)} onMouseDown={event => { event.preventDefault(); finish(item.id); }}>
        {item.icon && <Icon name={item.icon} size={14} />}<span>{item.label}</span>{item.detail && <small>{item.detail}</small>}{item.keys && <kbd>{item.keys}</kbd>}</li>)}{!items.length && <li className="none">{source?.empty?.(value) ?? '일치하는 항목이 없습니다.'}</li>}</ul>}
    </div>
  </div>;
}
