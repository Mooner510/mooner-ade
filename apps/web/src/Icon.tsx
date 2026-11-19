import { useId, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { useActionKeys } from './shortcuts';

// Material Symbols (bundled font, so it works offline). Claude Code and Codex have no Material glyph, so they stay inline SVG.
const glyphs = {
  plus: 'add',
  more: 'more_horiz',
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
  folderOpen: 'folder_open',
  fileOpen: 'file_open',
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
  error: 'error', // round badge with "!", used for the error log (no triangle or sharp corners)
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
  download: 'download',
  update: 'update',
  key: 'key',
  link: 'link',
  copy: 'content_copy',
  arrowUp: 'arrow_upward',
  arrowDown: 'arrow_downward',
  merge: 'call_merge',
  star: 'star',
  graph: 'account_tree',
  eye: 'visibility',
  tag: 'sell',
  fetch: 'cloud_download',
  push: 'cloud_upload',
  sync: 'sync',
  commit: 'commit',
  calendar: 'calendar_month',
  regex: 'regular_expression',
  matchCase: 'match_case',
  target: 'my_location',
  reset: 'restart_alt',
  patch: 'content_paste',
  book: 'menu_book',
  palette: 'palette',
  arrowRight: 'arrow_forward',
  arrowLeft: 'arrow_back',
  tool: 'build',
  keyboard: 'keyboard',
  chat: 'chat_bubble',
  enter: 'keyboard_return',
  chart: 'monitoring',
  laptop: 'laptop_mac',
  feedback: 'rate_review',
  person: 'person',
  image: 'image',
  chevronLeft: 'chevron_left',
  draw: 'draw',
  restore: 'settings_backup_restore',
  trash: 'delete',
  captureElement: 'highlight_alt',
  captureWindow: 'screenshot_monitor',
  captureRange: 'screenshot_region',
  shapeRect: 'crop_square',
  shapeArrow: 'north_east',
  plan: 'assignment',
  statusBar: 'call_to_action'
} as const;

// VS Code's ribbon, shared by Insiders and VSCodium (the tint is in CSS).
const VSCODE = 'M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.948-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z';

// Agent CLIs: Claude Code's radial burst, Codex's hexagon with a prompt and Cursor's filled cube logo.
const brands = {
  claude: <path d="M12 12 12 3M12 12l3.3-6.2M12 12l7.8-5.4M12 12l7.4-1M12 12l8.5 3.1M12 12l4.7 5.2M12 12l2.5 9.2M12 12l-2.1 7.7M12 12l-6.4 7.1M12 12l-7.1 2.6M12 12l-8.9-1.2M12 12 5.9 7.7M12 12 8 3.4" />,
  codex: <><path d="M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4z" /><path d="m9 10 2.5 2L9 14M13 14.5h2.5" /></>,
  // Cherry-pick: Material Symbols has no cherry (its nearest glyph is an apple). This is the filled `cherry` from Tabler Icons (MIT), unchanged; the colour is in .brand-cherry.
  cherry: <path d="M16.588 5.191l.058 .045l.078 .074l.072 .084l.013 .018a.998 .998 0 0 1 .182 .727l-.022 .111l-.03 .092c-.99 2.725 -.666 5.158 .679 7.706a4 4 0 1 1 -4.613 4.152l-.005 -.2l.005 -.2a4.002 4.002 0 0 1 2.5 -3.511c-.947 -2.03 -1.342 -4.065 -1.052 -6.207c-.166 .077 -.332 .15 -.499 .218l.094 -.064c-2.243 1.47 -3.552 3.004 -3.98 4.57a4.5 4.5 0 1 1 -7.064 3.906l-.004 -.212l.005 -.212a4.5 4.5 0 0 1 5.2 -4.233c.332 -1.073 .945 -2.096 1.83 -3.069c-1.794 -.096 -3.586 -.759 -5.355 -1.986l-.268 -.19l-.051 -.04l-.046 -.04l-.044 -.044l-.04 -.046l-.04 -.05l-.032 -.047l-.035 -.06l-.053 -.11l-.038 -.116l-.023 -.117l-.005 -.042l-.005 -.118l.01 -.118l.023 -.117l.038 -.115l.03 -.066l.023 -.045l.035 -.06l.032 -.046l.04 -.051l.04 -.046l.044 -.044l.046 -.04l.05 -.04c4.018 -2.922 8.16 -2.922 12.177 0z" />,
  // A chat tab: a speech bubble holding Claude's asterisk, so it reads differently from a file or a terminal tab.
  'claude-chat': <><path d="M6.5 3.5h11A2.5 2.5 0 0 1 20 6v8a2.5 2.5 0 0 1-2.5 2.5H11.5L7 20.5v-4h-.5A2.5 2.5 0 0 1 4 14V6a2.5 2.5 0 0 1 2.5-2.5z" /><path d="M12 6.6v6.8M9 8.3l6 3.4M15 8.3l-6 3.4" /></>,
  // The cube fills the whole 24 box (the other glyphs keep a margin), so shrink it about the centre.
  cursor: <g transform="translate(2.4 2.4) scale(.8)"><path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" /></g>,
  // Editors opened from the project menu. The VS Code ribbon is one shape, tinted per product in CSS.
  vscode: <path d={VSCODE} />,
  'vscode-insiders': <path d={VSCODE} />,
  vscodium: <path d={VSCODE} />,
  zed: <path d="M4.2 4h15.6L11.2 11.1H19.8V20H4.2l8.6-7.1H4.2V4z" />,
  windsurf: <path d="M2.4 15.2c2.1-3.6 3.7-5.4 6-5.4 1.8 0 2.5 2.1 4.3 2.1 2.5 0 3.5-3.8 8.9-6.4v3.1c-3.6 1.8-4.4 4.6-7.2 4.6-1.9 0-2.7-2-4.6-2-1.7 0-2.9 1.5-4.6 4H2.4z" />,
  jetbrains: <path fillRule="evenodd" d="M5 3.2h14a2 2 0 0 1 2 2v13.6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5.2a2 2 0 0 1 2-2zm2.4 2.6h8.8v2.15h-6.55v2.05h5.15v2.15H9.65V18.2H7.4V5.8z" />
} satisfies Record<string, ReactNode>;

const effortBars = [{ x: 2.5, h: 6 }, { x: 7.5, h: 9.5 }, { x: 12.5, h: 13 }, { x: 17.5, h: 16.5 }] as const;
const effortBarBottom = 20.25; // the bars span 3.75-20.25 of the 24 box, so their centre is the box's centre (at 21 they sat .75 low)

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

export type IconName = keyof typeof glyphs | keyof typeof brands;
// The tick inside a checked box or a done step: drawn (a font glyph is hairline-thin and off-centre at this size), in currentColor.
export function Tick({ size = 12 }: { size?: number }) {
  return <svg className="tick" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.4l3.1 3.1 6.5-6.9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  if (name in brands) return <svg className={`icon brand-${name}`} width={size + 2} height={size + 2} viewBox="0 0 24 24" aria-hidden="true">{brands[name as keyof typeof brands]}</svg>;
  return <span className="icon material-symbols-outlined" style={{ fontSize: size + 2 }} aria-hidden="true">{glyphs[name as keyof typeof glyphs]}</span>;
}

type IconButtonProps = { icon: IconName; label: string; keys?: string; onClick?(event: MouseEvent<HTMLButtonElement>): void; className?: string; pressed?: boolean; disabled?: boolean; size?: number; tip?: 'header' | 'none'; dot?: boolean; action?: string };
// Close buttons keep their accessible name without adding a tooltip to the familiar X.

export function IconButton({ icon, label, keys, onClick, className = '', pressed, disabled, size, tip, dot, action }: IconButtonProps) {
  const actionKeys = useActionKeys(action), shown = keys ?? actionKeys;
  const text = shown ? `${label} (${shown})` : label, styled = icon !== 'x' && tip !== 'none';
  // dot: a small red mark for something unread behind the button (the label should say so too).
  return <button type="button" className={`icon-btn ${className}`} data-tip={styled ? text : undefined} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}><Icon name={icon} size={size} />{dot && <span className="icon-dot" aria-hidden="true" />}</button>;
}

// One split button for every pane header: it opens a small popover with the two directions. Native popover (top layer), so the pane edges never clip it.
export function SplitButton({ onSplit, keys }: { onSplit(direction: 'row' | 'column', event: MouseEvent<HTMLButtonElement>): void; keys?: { row?: string; column?: string } }) {
  const id = useId(), tipText = keys?.row && keys.column ? `분할\n좌우 (${keys.row})\n상하 (${keys.column})` : '분할', name = `--split-${id.replace(/:/g, '')}`;
  const pick = (direction: 'row' | 'column') => (event: MouseEvent<HTMLButtonElement>) => { (event.currentTarget.closest('[popover]') as HTMLElement | null)?.hidePopover(); onSplit(direction, event); };
  return <>
    <button type="button" className="icon-btn" data-tip={tipText} aria-label="분할" aria-haspopup="menu" popoverTarget={id} style={{ anchorName: name } as CSSProperties}><Icon name="splitH" /></button>
    <div id={id} popover="auto" className="split-menu" role="menu" style={{ positionAnchor: name } as CSSProperties}>
      <button type="button" role="menuitem" aria-label="좌우 분할" onClick={pick('row')}><Icon name="splitH" size={16} />좌우 분할{keys?.row && <kbd>{keys.row}</kbd>}</button>
      <button type="button" role="menuitem" aria-label="상하 분할" onClick={pick('column')}><Icon name="splitV" size={16} />상하 분할{keys?.column && <kbd>{keys.column}</kbd>}</button>
    </div>
  </>;
}
