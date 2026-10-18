import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

export type Call = <T = any>(action: string, input?: object) => Promise<T>;
export type Ask = { input(title: string, initial?: string): Promise<string | null>; confirm(message: string): Promise<boolean> };
export type GitChange = { path: string; status: string; original?: string; added?: number; deleted?: number };
export type GitState = { branch: string; changes: GitChange[]; additions: number; deletions: number };

export function Modal({ children, onClose, className = '', labelledBy = 'conflict-title' }: { children: ReactNode; onClose(): void; className?: string; labelledBy?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className={className} aria-labelledby={labelledBy} onCancel={onClose}>{children}</dialog>;
}
export function Dropdown({ value, options, onChange, label, className = '' }: { value: string; options: { value: string; label: string }[]; onChange(value: string): void; label: string; className?: string }) {
  const root = useRef<HTMLDetailsElement>(null);
  return <details className={`dropdown ${className}`} ref={root}><summary aria-label={label}>{options.find(option => option.value === value)?.label}<Icon name="chevronDown" size={14} /></summary><div role="listbox" aria-label={label}>{options.map(option => <button role="option" aria-selected={option.value === value} key={option.value} onClick={() => { onChange(option.value); root.current!.open = false; }}>{option.label}</button>)}</div></details>;
}

export function Transcript({ events }: { events: { sequence: number; kind: string; text?: string; mode?: string; itemId?: string; [key: string]: any }[] }) {
  const text = new Map<string, string>();
  for (const event of events) if (event.kind === 'text') { const id = event.itemId || 'response'; text.set(id, event.mode === 'replace' || event.phase === 'item.completed' ? event.text || '' : (text.get(id) || '') + (event.text || '')); }
  return <>{[...text].map(([id, content]) => <pre className="answer" key={id}>{content}</pre>)}{events.filter(event => ['tool', 'error', 'approval', 'result'].includes(event.kind)).map(event => <details key={event.sequence} open={event.kind === 'error'}><summary>{event.kind} · {event.tool || event.phase || event.status || event.message}</summary><pre>{JSON.stringify(event.data || event.summary || event, null, 2)}</pre></details>)}</>;
}
