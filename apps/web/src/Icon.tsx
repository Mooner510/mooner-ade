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
  undo: 'undo',
  diff: 'difference',
  bot: 'smart_toy',
  sparkles: 'auto_awesome',
  settings: 'settings',
  tune: 'tune',
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
  block: 'block',
  check: 'check',
  externalLink: 'open_in_new',
  layers: 'layers',
  info: 'info',
  grip: 'drag_indicator',
  flame: 'local_fire_department',
  snowflake: 'ac_unit',
  archive: 'inventory_2',
  plugin: 'extension',
  copy: 'content_copy',
  arrowUp: 'arrow_upward',
  arrowDown: 'arrow_downward',
  merge: 'call_merge',
  book: 'menu_book',
  palette: 'palette',
  arrowRight: 'arrow_forward',
  arrowLeft: 'arrow_back',
  tool: 'build',
  keyboard: 'keyboard',
  chat: 'chat_bubble',
  enter: 'keyboard_return',
  chart: 'monitoring',
  laptop: 'laptop_mac'
} as const;

// Agent CLIs: Claude Code's radial burst, Codex's hexagon with a prompt and Cursor's filled cube logo.
const brands = {
  claude: <path d="M12 12 12 3M12 12l3.3-6.2M12 12l7.8-5.4M12 12l7.4-1M12 12l8.5 3.1M12 12l4.7 5.2M12 12l2.5 9.2M12 12l-2.1 7.7M12 12l-6.4 7.1M12 12l-7.1 2.6M12 12l-8.9-1.2M12 12 5.9 7.7M12 12 8 3.4" />,
  codex: <><path d="M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4z" /><path d="m9 10 2.5 2L9 14M13 14.5h2.5" /></>,
  // A chat tab: a speech bubble holding Claude's asterisk, so it reads differently from a file or a terminal tab.
  'claude-chat': <><path d="M6.5 3.5h11A2.5 2.5 0 0 1 20 6v8a2.5 2.5 0 0 1-2.5 2.5H11.5L7 20.5v-4h-.5A2.5 2.5 0 0 1 4 14V6a2.5 2.5 0 0 1 2.5-2.5z" /><path d="M12 6.6v6.8M9 8.3l6 3.4M15 8.3l-6 3.4" /></>,
  // The cube fills the whole 24 box (the other glyphs keep a margin), so shrink it about the centre.
  cursor: <g transform="translate(2.4 2.4) scale(.8)"><path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" /></g>
} satisfies Record<string, ReactNode>;

// Lucide "siren" (stroke icon, drawn in the same stroke as the other icons).
const strokes = {
  siren: <>
    <path d="M7 18v-6a5 5 0 1 1 10 0v6" />
    <path d="M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z" />
    <path d="M21 12h1" />
    <path d="M18.5 4.5 18 5" />
    <path d="M2 12h1" />
    <path d="M12 2v1" />
    <path d="m4.929 4.929.707.707" />
    <path d="M12 12v6" />
  </>
} satisfies Record<string, ReactNode>;

const effortBars = [{ x: 2.5, h: 6 }, { x: 7.5, h: 9.5 }, { x: 12.5, h: 13 }, { x: 17.5, h: 16.5 }] as const;
const effortBarBottom = 21;

export function EffortSignalIcon({ bars, size = 15 }: { bars: number; size?: number }) {
  const active = Math.max(0, Math.min(4, bars));
  return <svg className="icon effort-signal" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    {effortBars.map((bar, index) => <rect key={index} x={bar.x} y={effortBarBottom - bar.h} width={3.5} height={bar.h} rx={1} fill={index < active ? 'currentColor' : 'var(--faint)'} />)}
  </svg>;
}

export function SettingGlyph({ icon, bars, size = 15 }: { icon?: string; bars?: number; size?: number }) {
  if (bars != null) return <EffortSignalIcon bars={bars} size={size} />;
  if (!icon) return null;
  return <span className="icon material-symbols-outlined" style={{ fontSize: size }} aria-hidden="true">{icon}</span>;
}

export type IconName = keyof typeof glyphs | keyof typeof brands | keyof typeof strokes;
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  if (name in strokes) return <svg className="icon" width={size + 2} height={size + 2} viewBox="0 0 24 24" aria-hidden="true">{strokes[name as keyof typeof strokes]}</svg>;
  if (name in brands) return <svg className={`icon brand-${name}`} width={size + 2} height={size + 2} viewBox="0 0 24 24" aria-hidden="true">{brands[name as keyof typeof brands]}</svg>;
  return <span className="icon material-symbols-outlined" style={{ fontSize: size + 2 }} aria-hidden="true">{glyphs[name as keyof typeof glyphs]}</span>;
}

type IconButtonProps = { icon: IconName; label: string; keys?: string; onClick?(event: MouseEvent<HTMLButtonElement>): void; className?: string; pressed?: boolean; disabled?: boolean; size?: number };
// Icon-only button: the label is both the tooltip and the accessible name, so no glyph has to be guessed.
export function IconButton({ icon, label, keys, onClick, className = '', pressed, disabled, size }: IconButtonProps) {
  return <button type="button" className={`icon-btn ${className}`} title={keys ? `${label} (${keys})` : label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}><Icon name={icon} size={size} /></button>;
}
