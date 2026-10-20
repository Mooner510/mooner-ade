import type { MouseEvent, ReactNode } from 'react';

// Material Symbols (bundled font, so it works offline). Claude Code and Codex have no Material glyph, so they stay inline SVG.
const glyphs = {
  plus: 'add',
  x: 'close',
  edit: 'edit',
  terminal: 'terminal',
  code: 'code',
  chevronDown: 'expand_more',
  chevronRight: 'chevron_right',
  chevronsLeft: 'keyboard_double_arrow_left',
  chevronsRight: 'keyboard_double_arrow_right',
  panelLeft: 'left_panel_open',
  search: 'search',
  branch: 'fork_right',
  diff: 'difference',
  bot: 'smart_toy',
  sparkles: 'auto_awesome',
  settings: 'settings',
  splitH: 'vertical_split',
  splitV: 'horizontal_split',
  maximize: 'fullscreen',
  minimize: 'fullscreen_exit',
  refresh: 'refresh',
  folder: 'folder',
  folderPlus: 'create_new_folder',
  cpu: 'memory',
  memory: 'developer_board',
  clock: 'schedule',
  bell: 'notifications',
  collapseAll: 'unfold_less',
  expandAll: 'unfold_more',
  stop: 'stop',
  send: 'send',
  wifi: 'wifi',
  alert: 'warning',
  check: 'check',
  externalLink: 'open_in_new',
  layers: 'layers',
  info: 'info'
} as const;

// Agent CLIs: Claude Code's radial burst and Codex's hexagon with a prompt.
const brands = {
  claude: <path d="M12 12 12 3M12 12l3.3-6.2M12 12l7.8-5.4M12 12l7.4-1M12 12l8.5 3.1M12 12l4.7 5.2M12 12l2.5 9.2M12 12l-2.1 7.7M12 12l-6.4 7.1M12 12l-7.1 2.6M12 12l-8.9-1.2M12 12 5.9 7.7M12 12 8 3.4" />,
  codex: <><path d="M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4z" /><path d="m9 10 2.5 2L9 14M13 14.5h2.5" /></>
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof glyphs | keyof typeof brands;
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  if (name in brands) return <svg className={`icon brand-${name}`} width={size + 2} height={size + 2} viewBox="0 0 24 24" aria-hidden="true">{brands[name as keyof typeof brands]}</svg>;
  return <span className="icon material-symbols-outlined" style={{ fontSize: size + 2 }} aria-hidden="true">{glyphs[name as keyof typeof glyphs]}</span>;
}

type IconButtonProps = { icon: IconName; label: string; keys?: string; onClick?(event: MouseEvent<HTMLButtonElement>): void; className?: string; pressed?: boolean; disabled?: boolean; size?: number };
// Icon-only button: the label is both the tooltip and the accessible name, so no glyph has to be guessed.
export function IconButton({ icon, label, keys, onClick, className = '', pressed, disabled, size }: IconButtonProps) {
  return <button type="button" className={`icon-btn ${className}`} title={keys ? `${label} (${keys})` : label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}><Icon name={icon} size={size} /></button>;
}
