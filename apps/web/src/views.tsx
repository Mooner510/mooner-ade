import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

export type Call = <T = any>(action: string, input?: object) => Promise<T>;
export type Ask = { input(title: string, initial?: string): Promise<string | null>; confirm(message: string): Promise<boolean> };
export type GitChange = { path: string; status: string; original?: string; added?: number; deleted?: number };
export type GitState = { branch: string; changes: GitChange[]; additions: number; deletions: number };

export function Modal({ children, onClose, className = '', labelledBy = 'conflict-title' }: { children: ReactNode; onClose(): void; className?: string; labelledBy?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className={className} aria-labelledby={labelledBy} onCancel={event => { event.preventDefault(); onClose(); }}>{children}</dialog>;
}
export function Dropdown({ value, options, onChange, label, className = '' }: { value: string; options: { value: string; label: string }[]; onChange(value: string): void; label: string; className?: string }) {
  const root = useRef<HTMLDetailsElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = () => { root.current!.open = false; root.current!.querySelector('summary')!.focus(); };
  // The list is position: fixed so it escapes scrolling/clipping ancestors such as modal bodies.
  const place = () => {
    const anchor = root.current!.querySelector('summary')!.getBoundingClientRect(), menu = list.current!, gap = 5, margin = 8;
    menu.style.left = `${anchor.left}px`;
    menu.style.setProperty('--anchor-width', `${anchor.width}px`);
    menu.style.maxHeight = '';
    const below = innerHeight - anchor.bottom - gap - margin, above = anchor.top - gap - margin;
    const up = menu.offsetHeight > below && above > below;
    menu.style.maxHeight = `${Math.min(240, up ? above : below)}px`;
    menu.style.top = up ? `${anchor.top - gap - menu.offsetHeight}px` : `${anchor.bottom + gap}px`;
    const overflow = menu.getBoundingClientRect().right - (innerWidth - margin);
    if (overflow > 0) menu.style.left = `${Math.max(margin, anchor.left - overflow)}px`;
  };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) root.current!.open = false; };
    const scroll = (event: Event) => { if (root.current?.open && !list.current?.contains(event.target as Node)) root.current.open = false; };
    const resize = () => { if (root.current?.open) root.current.open = false; };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', scroll, true);
    addEventListener('resize', resize);
    // toggle events are async and coalesced on rapid clicks, so watch the open attribute directly.
    const observer = new MutationObserver(() => { if (root.current?.open) place(); });
    observer.observe(root.current!, { attributes: true, attributeFilter: ['open'] });
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('scroll', scroll, true); removeEventListener('resize', resize); observer.disconnect(); };
  }, []);
  return <details className={`dropdown ${className}`} ref={root}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false; }}
    onKeyDown={event => {
      if (event.key === 'Escape' && root.current!.open) { event.preventDefault(); event.stopPropagation(); close(); }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...root.current!.querySelectorAll<HTMLButtonElement>('[role=option]')];
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const selected = Math.max(0, options.findIndex(option => option.value === value));
      root.current!.open = true;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index < 0 ? selected : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }}><summary aria-label={label} aria-haspopup="listbox"><span>{options.find(option => option.value === value)?.label}</span><Icon name="chevronDown" size={14} /></summary>
    <div role="listbox" aria-label={label} ref={list}>{options.map(option => <button type="button" role="option" tabIndex={-1} aria-selected={option.value === value} key={option.value} onClick={() => { onChange(option.value); close(); }}><span>{option.label}</span>{option.value === value && <Icon name="check" size={14} />}</button>)}</div></details>;
}

export function Transcript({ events }: { events: { sequence: number; kind: string; text?: string; mode?: string; itemId?: string; [key: string]: any }[] }) {
  const text = new Map<string, string>();
  for (const event of events) if (event.kind === 'text') { const id = event.itemId || 'response'; text.set(id, event.mode === 'replace' || event.phase === 'item.completed' ? event.text || '' : (text.get(id) || '') + (event.text || '')); }
  return <>{[...text].map(([id, content]) => <pre className="answer" key={id}>{content}</pre>)}{events.filter(event => ['tool', 'error', 'approval', 'result'].includes(event.kind)).map(event => <details key={event.sequence} open={event.kind === 'error'}><summary>{event.kind} · {event.tool || event.phase || event.status || event.message}</summary><pre>{JSON.stringify(event.data || event.summary || event, null, 2)}</pre></details>)}</>;
}
