import { useEffect, useMemo, useRef, useState } from 'react';

export type QuickItem = { id: string; label: string; detail?: string; keys?: string };
export type QuickRequest =
  | { kind: 'files'; files: string[]; initial?: string; resolve(value: string | null): void; commands: QuickItem[] }
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

export function QuickInput({ request, onClose }: { request: QuickRequest; onClose(): void }) {
  const [value, setValue] = useState(request.kind === 'files' ? request.initial || '' : request.kind === 'input' ? request.initial || '' : '');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const commandMode = request.kind === 'files' && value.startsWith('>');
  const items = useMemo<QuickItem[]>(() => {
    if (request.kind === 'input') return [];
    const source: QuickItem[] = request.kind === 'pick' ? request.items : commandMode ? request.commands : request.files.map(file => ({ id: file, label: file.split('/').pop() || file, detail: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '' }));
    const query = (commandMode ? value.slice(1) : value).trim();
    if (request.kind === 'pick' && !query) return source;
    return source.map(item => ({ item, score: Math.max(fuzzy(query, item.label), request.kind === 'files' && !commandMode ? fuzzy(query, `${item.detail}/${item.label}`) - 1 : -1) })).filter(entry => entry.score >= 0).sort((a, b) => b.score - a.score).slice(0, 80).map(entry => entry.item);
  }, [request, value, commandMode]);
  useEffect(() => setIndex(0), [value]);
  const finish = (result: string | null) => { onClose(); request.resolve(result); };
  const title = request.kind === 'files' ? commandMode ? '명령 팔레트' : '파일 열기' : request.title;
  return <div className="quick-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) finish(null); }}>
    <div className="quick" role="dialog" aria-label={title}>
      <input ref={input} value={value} aria-label={title} placeholder={request.kind === 'files' ? '파일 이름 입력 (명령은 > 로 시작)' : title} onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); finish(null); }
          else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(current => Math.min(items.length - 1, current + 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(current => Math.max(0, current - 1)); }
          else if (event.key === 'Enter') {
            event.preventDefault();
            if (request.kind === 'input') finish(value.trim() ? value : null);
            else if (items[index]) finish(items[index].id);
            else if (request.kind === 'files' && !commandMode && value.trim()) finish(value.trim());
          }
        }} />
      {request.kind !== 'input' && <ul role="listbox">{items.map((item, position) => <li key={item.id} role="option" aria-selected={position === index} className={position === index ? 'selected' : ''} onMouseMove={() => setIndex(position)} onMouseDown={event => { event.preventDefault(); finish(item.id); }}>
        <span>{item.label}</span>{item.detail && <small>{item.detail}</small>}{item.keys && <kbd>{item.keys}</kbd>}</li>)}{!items.length && <li className="none">일치하는 항목이 없습니다.{request.kind === 'files' && !commandMode && value.trim() ? ' Enter로 이 경로를 엽니다.' : ''}</li>}</ul>}
    </div>
  </div>;
}
