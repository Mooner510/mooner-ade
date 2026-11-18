import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, Tick, type IconName } from './Icon';

// One menu for the Git tool window: right-click menus, toolbar drop-downs and their submenus. Fixed to the viewport (it is opened at
// the pointer or under a button), moved back inside the window when it would overflow, and driven by the keyboard like a native menu.
export type MenuEntry =
  | { label: string; icon?: IconName; keys?: string; disabled?: boolean; hint?: string; checked?: boolean; radio?: boolean; danger?: boolean; run?(): void; items?: MenuEntry[]; keep?: boolean }
  | { header: string } | 'separator' | null | false;
type Item = Exclude<MenuEntry, null | false | 'separator' | { header: string }>;
const isItem = (entry: MenuEntry): entry is Item => Boolean(entry) && entry !== 'separator' && !('header' in (entry as object));

export function PopupMenu({ x, y, items, onClose, label, depth = 0, align = 'start' }: { x: number; y: number; items: MenuEntry[]; onClose(): void; label: string; depth?: number; align?: 'start' | 'end' }) {
  const box = useRef<HTMLDivElement>(null), [at, setAt] = useState({ x, y }), [open, setOpen] = useState(-1), [active, setActive] = useState(-1);
  const list = items.filter((entry, index, all) => entry && !(entry === 'separator' && (index === 0 || all[index - 1] === 'separator' || index === all.length - 1)));
  useLayoutEffect(() => {
    const rect = box.current!.getBoundingClientRect();
    const left = align === 'end' ? x - rect.width : x;
    setAt({ x: Math.max(4, Math.min(left, innerWidth - rect.width - 4)), y: Math.max(4, Math.min(y, innerHeight - rect.height - 4)) });
  }, [x, y, align]);
  useEffect(() => { if (!depth) box.current?.focus(); }, [depth]);
  useEffect(() => {
    if (depth) return;
    const away = (event: PointerEvent) => { if (!(event.target as Element).closest?.('.git-menu')) onClose(); };
    const blur = () => onClose();
    window.addEventListener('pointerdown', away, true); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('blur', blur); };
  }, [depth, onClose]);
  const enabled = list.map((entry, index) => isItem(entry) && !entry.disabled ? index : -1).filter(index => index >= 0);
  const choose = (entry: Item, index: number) => {
    if (entry.disabled) return;
    if (entry.items) { setOpen(index); return; }
    if (!entry.keep) onClose();
    entry.run?.();
  };
  const onKey = (event: React.KeyboardEvent) => {
    const step = (dir: number) => { const at = enabled.indexOf(active); setActive(enabled[(at + dir + enabled.length) % enabled.length] ?? -1); };
    if (event.key === 'ArrowDown') step(1);
    else if (event.key === 'ArrowUp') step(-1);
    else if (event.key === 'ArrowRight' && active >= 0 && isItem(list[active]) && (list[active] as Item).items) setOpen(active);
    else if ((event.key === 'ArrowLeft' && depth) || event.key === 'Escape') onClose();
    else if ((event.key === 'Enter' || event.key === ' ') && active >= 0) choose(list[active] as Item, active);
    else return;
    event.preventDefault(); event.stopPropagation();
  };
  const rows: ReactNode[] = list.map((entry, index) => {
    if (entry === 'separator') return <hr key={index} />;
    if (!isItem(entry)) return <small key={index} className="menu-title">{(entry as { header: string }).header}</small>;
    return <button key={index} type="button" role={entry.radio ? 'menuitemradio' : entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={entry.checked} aria-haspopup={entry.items ? 'menu' : undefined}
      disabled={entry.disabled} title={entry.hint} className={`${index === active ? 'active' : ''} ${entry.danger ? 'danger' : ''}`}
      onPointerEnter={() => { setActive(index); setOpen(entry.items ? index : -1); }} onClick={event => { event.stopPropagation(); choose(entry, index); }}>
      <span className="git-menu-mark">{entry.checked ? (entry.radio ? <i className="dot" /> : <Tick />) : entry.icon ? <Icon name={entry.icon} size={14} /> : null}</span>
      <span className="menu-label">{entry.label}</span>{entry.keys && <kbd>{entry.keys}</kbd>}{entry.items && <Icon name="chevronRight" size={14} />}
    </button>;
  });
  const sub = open >= 0 && isItem(list[open]) ? (list[open] as Item) : null;
  const subAt = () => { const el = box.current?.querySelectorAll(':scope > button, :scope > hr, :scope > small')[open] as HTMLElement | undefined, rect = el?.getBoundingClientRect(), mine = box.current?.getBoundingClientRect(); return { x: (mine?.right ?? 0) - 2, y: (rect?.top ?? 0) - 5 }; };
  return <>
    <div ref={box} className="menu git-menu" role="menu" aria-label={label} tabIndex={-1} style={{ left: at.x, top: at.y }} onKeyDown={onKey} onContextMenu={event => event.preventDefault()}>{rows}</div>
    {sub?.items && <PopupMenu {...subAt()} items={sub.items} label={sub.label} depth={depth + 1} onClose={() => { setOpen(-1); box.current?.focus(); }} />}
  </>;
}
// A submenu entry closes everything when one of its items runs: the items are wrapped so their run also closes the root.
export function closeAll(items: MenuEntry[], close: () => void): MenuEntry[] {
  return items.map(entry => isItem(entry) ? { ...entry, ...(entry.items ? { items: closeAll(entry.items, close) } : {}), ...(entry.run && !entry.items ? { run: () => { if (!entry.keep) close(); entry.run!(); } } : {}) } : entry);
}
