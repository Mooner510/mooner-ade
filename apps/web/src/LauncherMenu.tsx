import { useEffect, useRef } from 'react';
import { Icon, IconButton } from './Icon';
import type { AgentMode, launchersFor } from './launchers';

export function LauncherModes({ mode, onChange }: { mode: AgentMode; onChange(mode: AgentMode): void }) {
  return <div className="launcher-modes" data-mode={mode} role="group" aria-label="실행 모드">
    {(['chat', 'cli'] as const).map(value => <button key={value} type="button" data-mode={value} aria-pressed={mode === value} onClick={() => onChange(value)}><Icon name={value === 'chat' ? 'chat' : 'terminal'} size={13} />{value === 'chat' ? 'Chat 모드' : 'CLI 모드'}</button>)}
  </div>;
}

export function LauncherMenu({ mode, items, onModeChange, onLaunch, onClose }: { mode: AgentMode; items: ReturnType<typeof launchersFor>; onModeChange(mode: AgentMode): void; onLaunch(command: string): void; onClose(): void }) {
  const menu = useRef<HTMLDivElement>(null), providers = items.filter(item => item.id !== 'shell'), shell = items.find(item => item.id === 'shell');
  useEffect(() => { menu.current?.querySelector<HTMLButtonElement>('[aria-pressed=true]')?.focus(); }, []);
  const row = (item: typeof items[number]) => <button key={item.id} type="button" className="launcher-menu-item" onClick={() => onLaunch(item.command)}>
    <span className="launcher-icon"><Icon name={item.icon} size={20} /></span><span className="launcher-copy"><strong>{item.label}</strong><small>{item.id === 'shell' ? item.detail : mode === 'chat' ? '채팅 모드' : 'CLI 모드'}</small></span>
    <span className="launcher-arrow" aria-hidden="true"><Icon name="arrowRight" size={14} /></span>
  </button>;
  return <div ref={menu} className="menu launcher-menu" role="dialog" aria-label="새 탭에서 실행"
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onClose(); }}>
    <header><strong>새 탭에서 실행</strong><IconButton icon="x" label="새 탭 메뉴 닫기" onClick={onClose} /></header>
    <LauncherModes mode={mode} onChange={onModeChange} />
    {providers.length > 0 && <div className="launcher-menu-providers" role="group" aria-label={mode === 'chat' ? 'Chat으로 열기' : 'CLI로 열기'}>{providers.map(row)}</div>}
    {shell && <div className="launcher-menu-shell">{row(shell)}</div>}
  </div>;
}

