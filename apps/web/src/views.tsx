import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, SettingGlyph } from './Icon';

// The app's version in the middle of the sidebar footer. Only the desktop app knows it, so a plain browser shows nothing.
export function AppVersion() {
  const [info, setInfo] = useState({ version: '', dev: false });
  useEffect(() => {
    const desktop = (window as unknown as { adeDesktop?: { appInfo?(): Promise<{ version: string; dev?: boolean }> } }).adeDesktop;
    void desktop?.appInfo?.().then(next => setInfo({ version: next.version, dev: next.dev === true }), () => {});
  }, []);
  const { version, dev } = info, beta = version.includes('-'); // 0.4.1-beta1 is a prerelease: shown in sky blue so it is never mistaken for a stable build
  // `pnpm dev` runs the working tree, not an installed release, so it says so: "v0.4.1 (dev)".
  return version ? <span className={`app-version${beta ? ' beta' : ''}`} title={dev ? '무너에이드 개발 실행 (pnpm dev)' : beta ? '무너에이드 베타 버전' : '무너에이드 버전'}>v{version}{dev && ' (dev)'}</span> : null;
}

export type Ask = { input(title: string, initial?: string): Promise<string | null>; confirm(message: string): Promise<boolean> };
export type GitChange = { path: string; status: string; original?: string; added?: number; deleted?: number };
export type GitState = { branch: string; changes: GitChange[]; additions: number; deletions: number };

export function Modal({ children, onClose, className = '', labelledBy }: { children: ReactNode; onClose(): void; className?: string; labelledBy: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className={className} aria-labelledby={labelledBy} onCancel={event => { event.preventDefault(); onClose(); }}>{children}</dialog>;
}
// A model name whose "(1M)" tail (a 1M-token window) is shown small and gray, next to the name in the model colour.
export const ModelLabel = ({ text }: { text: string }) => { const match = /^(.*?)( \(1M\))$/.exec(text); return match ? <>{match[1]}<span className="model-1m">{match[2]}</span></> : <>{text}</>; };
const DdIcon = ({ icon, bars }: { icon?: string; bars?: number }) => <SettingGlyph icon={icon} bars={bars} size={15} />;
export function Dropdown({ value, options, onChange, label, className = '', placeholder, locked }: { value: string; options: { value: string; label: string; color?: string; icon?: string; bars?: number; hint?: string; divider?: boolean }[]; onChange(value: string): void; label: string; className?: string; placeholder?: string; locked?: string }) {
  const root = useRef<HTMLDetailsElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = () => { root.current!.open = false; root.current!.querySelector('summary')!.focus(); };
  // The list is a manual popover (top layer): position: fixed alone is re-anchored to any ancestor with transform/translate/scale
  // (the draggable, pop-in-animated settings dialog), which pushed the list off-screen and added scrollbars.
  const place = () => {
    const anchor = root.current!.querySelector('summary')!.getBoundingClientRect(), menu = list.current!, gap = 5, margin = 8;
    menu.style.left = `${anchor.left}px`;
    menu.style.setProperty('--anchor-width', `${anchor.width}px`);
    menu.style.maxHeight = '';
    const below = innerHeight - anchor.bottom - gap - margin, above = anchor.top - gap - margin;
    const up = menu.offsetHeight > below && above > below;
    menu.dataset.placement = up ? 'above' : 'below';
    menu.style.maxHeight = `${Math.min(340, up ? above : below)}px`;
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
    const observer = new MutationObserver(() => {
      const menu = list.current!, open = root.current!.open;
      if (open && !menu.matches(':popover-open')) menu.showPopover();
      if (!open && menu.matches(':popover-open')) menu.hidePopover();
      if (open) place();
    });
    observer.observe(root.current!, { attributes: true, attributeFilter: ['open'] });
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('scroll', scroll, true); removeEventListener('resize', resize); observer.disconnect(); };
  }, []);
  return <details className={`dropdown ${className}`} ref={root} data-locked={locked ? '' : undefined} title={locked || `${label}: ${options.find(option => option.value === value)?.label ?? placeholder ?? ''}`}
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
    }}><summary aria-label={locked ? `${label} · ${locked}` : label} aria-haspopup="listbox" aria-disabled={locked ? true : undefined} onClick={locked ? event => event.preventDefault() : undefined}>{(() => { const selected = options.find(option => option.value === value); return <span className="dd-label" style={{ color: selected?.color }}><DdIcon icon={selected?.icon} bars={selected?.bars} />{selected?.label ? <ModelLabel text={selected.label} /> : placeholder}</span>; })()}<Icon name="chevronDown" size={14} /></summary>
    <div role="listbox" popover="manual" aria-label={label} ref={list}>{options.map(option => <button type="button" role="option" tabIndex={-1} aria-selected={option.value === value} data-divider={option.divider || undefined} key={option.value} onClick={() => { onChange(option.value); close(); }}><span className="dd-label" style={{ color: option.color }}><DdIcon icon={option.icon} bars={option.bars} /><ModelLabel text={option.label} />{option.hint && <small className="dd-hint">{option.hint}</small>}</span>{option.value === value && <Icon name="check" size={14} />}</button>)}</div></details>;
}
