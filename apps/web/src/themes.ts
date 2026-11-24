// Screen themes. The default dark palette also lives in style.css `:root` so the first paint matches;
// every other theme is installed from here. Lightness-dependent rules (scrollbars, usage text, brand marks)
// key off `data-scheme`, not the theme name.

export type ThemeScheme = 'dark' | 'light';

type ThemeSpec = {
  id: string; label: string; scheme: ThemeScheme;
  bg: string; surface: string; raised: string; overlay: string; border: string; borderStrong: string;
  fg: string; muted: string; faint: string; accent: string; input: string;
  add: string; del: string; warn: string; info: string; ask: string;
  done?: string; beta?: string; error?: string; accentStrong?: string; accentFg?: string;
  termBg?: string; termFg?: string;
  ansi: readonly string[];
};

export type AppTheme = {
  id: ThemeId; label: string; scheme: ThemeScheme;
  vars: Record<string, string>;
  monaco: Record<string, string>;
};

const mix = (hex: string, toward: string, amount: number) => {
  const channel = (color: string) => [0, 2, 4].map(index => parseInt(color.slice(1 + index, 3 + index), 16));
  const [from, to] = [channel(hex), channel(toward)];
  return '#' + from.map((value, index) => Math.round(value + (to[index] - value) * amount).toString(16).padStart(2, '0')).join('');
};

// Same ink rule as a custom accent in main.tsx, so a theme accent and the same hex chosen by hand match.
const ink = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#06141a' : '#ffffff';
};

const shades = (scheme: ThemeScheme, colors: readonly string[]) => {
  const toward = scheme === 'dark' ? '#ffffff' : '#000000', amount = scheme === 'dark' ? 0.2 : 0.22;
  return [...colors, ...colors.map(color => mix(color, toward, amount))];
};

const MONACO_KEEP: Record<string, Record<string, string>> = {
  dark: {
    'editor.background': '#141518', 'editor.foreground': '#e4e6ea', 'editorGutter.background': '#141518', 'minimap.background': '#141518',
    'editor.lineHighlightBackground': '#1c1e22', 'editorLineNumber.foreground': '#4b4f57', 'editorLineNumber.activeForeground': '#a9adb5',
    'editorWidget.background': '#1b1d21', 'editorWidget.border': '#2a2d33',
    'diffEditor.insertedLineBackground': '#2ea04324', 'diffEditor.removedLineBackground': '#f8514924',
    'diffEditor.insertedTextBackground': '#2ea04340', 'diffEditor.removedTextBackground': '#f8514940',
    'diffEditor.unchangedRegionBackground': '#18191c', 'scrollbarSlider.background': '#ffffff18', 'scrollbarSlider.hoverBackground': '#ffffff28'
  },
  light: {
    'editor.background': '#ffffff', 'editor.foreground': '#1d2127', 'editorGutter.background': '#ffffff', 'minimap.background': '#ffffff',
    'editor.lineHighlightBackground': '#f4f5f7',
    'diffEditor.insertedLineBackground': '#2ea04318', 'diffEditor.removedLineBackground': '#cf222e18',
    'diffEditor.unchangedRegionBackground': '#f6f7f9'
  }
};

const derivedMonaco = (scheme: ThemeScheme, vars: Record<string, string>) => {
  const add = vars['--add'], del = vars['--del'], surface = vars['--surface'], fg = vars['--fg'], accent = vars['--accent'];
  return {
    'editor.background': surface, 'editor.foreground': fg, 'editorGutter.background': surface, 'minimap.background': surface,
    'editor.lineHighlightBackground': mix(surface, fg, scheme === 'dark' ? 0.06 : 0.045),
    'editorLineNumber.foreground': vars['--faint'], 'editorLineNumber.activeForeground': vars['--muted'],
    'editorWidget.background': vars['--raised'], 'editorWidget.border': vars['--border-strong'],
    'editorCursor.foreground': accent, 'editor.selectionBackground': accent + (scheme === 'dark' ? '40' : '33'),
    'diffEditor.insertedLineBackground': add + (scheme === 'dark' ? '24' : '18'), 'diffEditor.removedLineBackground': del + (scheme === 'dark' ? '24' : '18'),
    'diffEditor.insertedTextBackground': add + '40', 'diffEditor.removedTextBackground': del + '40',
    'diffEditor.unchangedRegionBackground': vars['--bg'],
    'scrollbarSlider.background': scheme === 'dark' ? '#ffffff18' : '#00000014',
    'scrollbarSlider.hoverBackground': scheme === 'dark' ? '#ffffff28' : '#00000024'
  };
};

// WCAG 대비. 테마 원본 팔레트(Solarized·GitHub Dark·Latte 등)는 보조 글자색이 배경 위에서 4.5:1에 못 미치는 것이 있어, 읽히는 만큼만 본문 색 쪽으로 당긴다.
const luminance = (hex: string) => { const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrastRatio = (a: string, b: string) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); };
export const readableOn = (hex: string, toward: string, grounds: string[], min: number) => { let color = hex; for (let step = 1; step <= 25 && grounds.some(ground => contrastRatio(color, ground) < min); step++) color = mix(hex, toward, step * 0.04); return color; };

function build(spec: ThemeSpec): AppTheme {
  const colors = [spec.bg, spec.surface, spec.raised, spec.overlay, spec.border, spec.borderStrong, spec.fg, spec.muted, spec.faint, spec.accent, spec.input, spec.add, spec.del, spec.warn, spec.info, spec.ask, spec.done, spec.beta, spec.error, spec.accentStrong, spec.accentFg, spec.termBg, spec.termFg, ...spec.ansi];
  for (const color of colors) if (color !== undefined && !/^#[0-9a-f]{6}$/.test(color)) throw new Error(`${spec.id} has a bad color ${color}`);
  const ansi = spec.ansi.length === 16 ? spec.ansi : spec.ansi.length === 8 ? shades(spec.scheme, spec.ansi) : null;
  if (!ansi) throw new Error(`${spec.id} needs 8 or 16 terminal colors`);
  const soft = spec.scheme === 'dark' ? '1f' : '1a', selected = spec.scheme === 'dark' ? '26' : '1f', termSel = spec.scheme === 'dark' ? '40' : '33';
  const accentFg = spec.accentFg ?? ink(spec.accent);
  const grounds = [spec.bg, spec.surface, spec.raised, spec.overlay];
  const muted = readableOn(spec.muted, spec.fg, grounds, 4.5), faint = readableOn(spec.faint, spec.fg, [spec.bg, spec.surface], 3);
  const status = (color: string) => readableOn(color, spec.fg, [spec.bg], 3);
  const vars: Record<string, string> = {
    '--bg': spec.bg, '--surface': spec.surface, '--raised': spec.raised, '--overlay': spec.overlay, '--border': spec.border, '--border-strong': spec.borderStrong,
    '--fg': spec.fg, '--muted': muted, '--faint': faint,
    '--accent': spec.accent, '--accent-strong': spec.accentStrong ?? mix(spec.accent, '#000000', 0.18), '--accent-fg': accentFg, '--accent-soft': spec.accent + soft,
    '--hover': spec.scheme === 'dark' ? '#ffffff0d' : '#0000000a', '--selected': spec.accent + selected, '--input': spec.input, '--focus': spec.accent,
    '--add': status(spec.add), '--del': status(spec.del), '--warn': status(spec.warn), '--done': spec.done ?? status(spec.add), '--ask': spec.ask, '--error': spec.error ?? status(spec.del), '--info': status(spec.info), '--beta': spec.beta ?? status(spec.info),
    '--shadow': spec.scheme === 'dark' ? '0 12px 40px #000a' : '0 12px 40px #0002',
    '--term-bg': spec.termBg ?? spec.surface, '--term-fg': spec.termFg ?? spec.fg, '--term-cursor': spec.accent, '--term-selection': spec.accent + termSel
  };
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  names.forEach((name, index) => { vars[`--term-${name}`] = ansi[index]; vars[`--term-bright-${name}`] = ansi[index + 8]; });
  return { id: spec.id as ThemeId, label: spec.label, scheme: spec.scheme, vars, monaco: MONACO_KEEP[spec.id] ?? derivedMonaco(spec.scheme, vars) };
}

const SPECS = define([
  {
    id: 'dark', label: '기본 다크', scheme: 'dark',
    bg: '#0c0d0f', surface: '#141518', raised: '#1b1d21', overlay: '#202227', border: '#24262b', borderStrong: '#33363d',
    fg: '#e4e6ea', muted: '#8b9099', faint: '#5c616b', accent: '#5ec8e5', accentStrong: '#2fb3d6', input: '#101114',
    add: '#3fb950', del: '#f85149', warn: '#e3b341', info: '#58a6ff', ask: '#e879ad', done: '#9bd94b', beta: '#38bdf8',
    ansi: ['#1d1f24', '#f0717a', '#7ccf8a', '#e6c46f', '#6fa8f0', '#c792ea', '#5ec8e5', '#c9ccd3', '#5c616b', '#ff8c94', '#9be3a7', '#f5d98e', '#92c0ff', '#ddb2ff', '#8be0f5', '#ffffff']
  },
  {
    id: 'one-dark', label: 'One Dark', scheme: 'dark',
    bg: '#21252b', surface: '#282c34', raised: '#2c313a', overlay: '#21252b', border: '#3e4451', borderStrong: '#4b5263',
    fg: '#abb2bf', muted: '#8b93a3', faint: '#646b77', accent: '#61afef', input: '#1b1e24',
    add: '#98c379', del: '#e06c75', warn: '#e5c07b', info: '#61afef', ask: '#c678dd', beta: '#56b6c2',
    ansi: ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf']
  },
  {
    id: 'dracula', label: 'Dracula', scheme: 'dark',
    bg: '#21222c', surface: '#282a36', raised: '#343746', overlay: '#2d2f3c', border: '#44475a', borderStrong: '#55586a',
    fg: '#f8f8f2', muted: '#c3c5d4', faint: '#6272a4', accent: '#bd93f9', input: '#21222c',
    add: '#50fa7b', del: '#ff5555', warn: '#f1fa8c', info: '#8be9fd', ask: '#ff79c6',
    ansi: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']
  },
  {
    id: 'nord', label: 'Nord', scheme: 'dark',
    bg: '#2e3440', surface: '#3b4252', raised: '#434c5e', overlay: '#3b4252', border: '#4c566a', borderStrong: '#5e697d',
    fg: '#eceff4', muted: '#c2cad6', faint: '#818b9e', accent: '#88c0d0', input: '#2e3440',
    add: '#a3be8c', del: '#c7757d', warn: '#ebcb8b', info: '#81a1c1', ask: '#b48ead',
    ansi: ['#3b4252', '#c7757d', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0']
  },
  {
    id: 'tokyo-night', label: 'Tokyo Night', scheme: 'dark',
    bg: '#16161e', surface: '#1a1b26', raised: '#24283b', overlay: '#1f2335', border: '#292e42', borderStrong: '#3b4261',
    fg: '#c0caf5', muted: '#9aa5ce', faint: '#565f89', accent: '#7aa2f7', input: '#16161e',
    add: '#9ece6a', del: '#f7768e', warn: '#e0af68', info: '#7dcfff', ask: '#bb9af7',
    ansi: ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6']
  },
  {
    id: 'catppuccin', label: 'Catppuccin', scheme: 'dark',
    bg: '#11111b', surface: '#1e1e2e', raised: '#313244', overlay: '#181825', border: '#45475a', borderStrong: '#585b70',
    fg: '#cdd6f4', muted: '#a6adc8', faint: '#6c7086', accent: '#cba6f7', input: '#181825',
    add: '#a6e3a1', del: '#f38ba8', warn: '#f9e2af', info: '#89b4fa', ask: '#f5c2e7', beta: '#94e2d5',
    ansi: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de', '#585b70', '#eba0ac', '#a6e3a1', '#f9e2af', '#b4befe', '#f5c2e7', '#89dceb', '#cdd6f4']
  },
  {
    id: 'gruvbox', label: 'Gruvbox', scheme: 'dark',
    bg: '#1d2021', surface: '#282828', raised: '#3c3836', overlay: '#32302f', border: '#504945', borderStrong: '#665c54',
    fg: '#ebdbb2', muted: '#bdae93', faint: '#928374', accent: '#fe8019', input: '#1d2021',
    add: '#b8bb26', del: '#fb4934', warn: '#fabd2f', info: '#83a598', ask: '#d3869b',
    ansi: ['#282828', '#fb4934', '#98971a', '#d79921', '#458588', '#b16286', '#689d6b', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']
  },
  {
    id: 'monokai', label: 'Monokai', scheme: 'dark',
    bg: '#221f22', surface: '#2d2a2e', raised: '#403e41', overlay: '#353236', border: '#4a484c', borderStrong: '#5b595c',
    fg: '#fcfcfa', muted: '#b7b6b8', faint: '#727072', accent: '#ffd866', input: '#221f22',
    add: '#a9dc76', del: '#ff6188', warn: '#fc9867', info: '#78dce8', ask: '#ab9df2',
    ansi: ['#2d2a2e', '#ff6188', '#a9dc76', '#ffd866', '#78dce8', '#ab9df2', '#78dce8', '#fcfcfa']
  },
  {
    id: 'solarized-dark', label: 'Solarized Dark', scheme: 'dark',
    bg: '#002b36', surface: '#073642', raised: '#0a4450', overlay: '#073642', border: '#0f5562', borderStrong: '#1a6876',
    fg: '#93a1a1', muted: '#839496', faint: '#657b83', accent: '#2aa198', accentFg: '#06141a', input: '#002b36',
    add: '#859900', del: '#df413f', warn: '#b58900', info: '#268bd2', ask: '#d54088', beta: '#7075c5',
    ansi: ['#073642', '#df413f', '#859900', '#b58900', '#268bd2', '#d54088', '#2aa198', '#eee8d5', '#002b36', '#ce5422', '#859900', '#b58900', '#839496', '#7075c5', '#93a1a1', '#fdf6e3']
  },
  {
    id: 'github-dark', label: 'GitHub Dark', scheme: 'dark',
    bg: '#1c2128', surface: '#22272e', raised: '#2d333b', overlay: '#2d333b', border: '#444c56', borderStrong: '#545d68',
    fg: '#adbac7', muted: '#768390', faint: '#636e7b', accent: '#6cb6ff', input: '#1c2128',
    add: '#57ab5a', del: '#e5534b', warn: '#c69026', info: '#6cb6ff', ask: '#dcbdfb', done: '#6bc46d', beta: '#539bf5',
    ansi: ['#545d68', '#f47067', '#57ab5a', '#c69026', '#539bf5', '#b083f0', '#39c5cf', '#909dab', '#636e7b', '#ff938a', '#6bc46d', '#daaa3f', '#6cb6ff', '#dcbdfb', '#56d4dd', '#cdd9e5']
  },
  {
    id: 'night-owl', label: 'Night Owl', scheme: 'dark',
    bg: '#010e1a', surface: '#011627', raised: '#0e293f', overlay: '#0b2942', border: '#1d3b53', borderStrong: '#234e70',
    fg: '#d6deeb', muted: '#a3bdd0', faint: '#637777', accent: '#82aaff', input: '#010e1a',
    add: '#addb67', del: '#ef5350', warn: '#ecc48d', info: '#82aaff', ask: '#c792ea', beta: '#7fdbca',
    ansi: ['#011627', '#ef5350', '#22da6e', '#addb67', '#82aaff', '#c792ea', '#21c7a8', '#d6deeb']
  },
  {
    id: 'rose-pine', label: 'Rosé Pine', scheme: 'dark',
    bg: '#191724', surface: '#1f1d2e', raised: '#26233a', overlay: '#26233a', border: '#403d52', borderStrong: '#524f67',
    fg: '#e0def4', muted: '#908caa', faint: '#6e6a86', accent: '#c4a7e7', input: '#191724',
    add: '#9ccfd8', del: '#eb6f92', warn: '#f6c177', info: '#9ccfd8', ask: '#ebbcba', beta: '#31748f',
    ansi: ['#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4']
  },
  {
    id: 'kanagawa', label: 'Kanagawa', scheme: 'dark',
    bg: '#16161d', surface: '#1f1f28', raised: '#2a2a37', overlay: '#2a2a37', border: '#363646', borderStrong: '#54546d',
    fg: '#dcd7ba', muted: '#a39e8f', faint: '#727169', accent: '#7e9cd8', input: '#16161d',
    add: '#98bb6c', del: '#e82424', warn: '#e6c384', info: '#7fb4ca', ask: '#d27e99', beta: '#957fb8',
    ansi: ['#1f1f28', '#c34043', '#98bb6c', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#dcd7ba']
  },
  {
    id: 'everforest', label: 'Everforest', scheme: 'dark',
    bg: '#2d353b', surface: '#343f44', raised: '#3d484d', overlay: '#3d484d', border: '#475258', borderStrong: '#56635f',
    fg: '#d3c6aa', muted: '#9da9a0', faint: '#7a8478', accent: '#a7c080', input: '#2d353b',
    add: '#a7c080', del: '#e67e80', warn: '#dbbc7f', info: '#7fbbb3', ask: '#d699b6',
    ansi: ['#343f44', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa']
  },
  {
    id: 'ayu', label: 'Ayu Mirage', scheme: 'dark',
    bg: '#171b24', surface: '#1f2430', raised: '#232834', overlay: '#232834', border: '#2c3340', borderStrong: '#3d475c',
    fg: '#cbccc6', muted: '#8b95a7', faint: '#5c6773', accent: '#ffcc66', input: '#171b24',
    add: '#bae67e', del: '#f28779', warn: '#ffd580', info: '#73d0ff', ask: '#d4bfff',
    ansi: ['#171b24', '#f28779', '#bae67e', '#ffd580', '#73d0ff', '#d4bfff', '#5ccfe6', '#cbccc6']
  },
  {
    id: 'material', label: 'Material Palenight', scheme: 'dark',
    bg: '#1e2233', surface: '#292d3e', raised: '#32374c', overlay: '#292d3e', border: '#3c4260', borderStrong: '#4e5579',
    fg: '#a6accd', muted: '#8f96b5', faint: '#676e95', accent: '#82aaff', input: '#1e2233',
    add: '#c3e88d', del: '#f07178', warn: '#ffcb6b', info: '#89ddff', ask: '#c792ea',
    ansi: ['#292d3e', '#f07178', '#c3e88d', '#ffcb6b', '#82aaff', '#c792ea', '#89ddff', '#a6accd']
  },
  {
    id: 'flexoki', label: 'Flexoki', scheme: 'dark',
    bg: '#100f0f', surface: '#1c1b1b', raised: '#282726', overlay: '#282726', border: '#343331', borderStrong: '#403e3c',
    fg: '#cecdc3', muted: '#9a9890', faint: '#6f6e69', accent: '#4385be', input: '#100f0f',
    add: '#879a39', del: '#d14d41', warn: '#d0a215', info: '#4385be', ask: '#ce5d97', beta: '#3aa99f',
    ansi: ['#1c1b1b', '#d14d41', '#879a39', '#d0a215', '#4385be', '#8b7ec8', '#3aa99f', '#cecdc3']
  },
  {
    id: 'light', label: '기본 라이트', scheme: 'light',
    bg: '#eceef1', surface: '#ffffff', raised: '#f6f7f9', overlay: '#ffffff', border: '#dfe2e7', borderStrong: '#cbd0d7',
    fg: '#1d2127', muted: '#626a75', faint: '#9aa1ab', accent: '#0b8db3', accentStrong: '#087a9b', input: '#ffffff',
    add: '#1a7f37', del: '#cf222e', warn: '#9a6700', info: '#0969da', ask: '#bf477e', done: '#568b20', beta: '#0284c7',
    ansi: ['#24292f', '#cf222e', '#1a7f37', '#9a6700', '#0969da', '#8250df', '#0b8db3', '#6e7781', '#57606a', '#e5534b', '#2da44e', '#bf8700', '#218bff', '#a475f9', '#1aa7cf', '#8c959f']
  },
  {
    id: 'github-light', label: 'GitHub Light', scheme: 'light',
    bg: '#f6f8fa', surface: '#ffffff', raised: '#f6f8fa', overlay: '#ffffff', border: '#d0d7de', borderStrong: '#afb8c1',
    fg: '#1f2328', muted: '#656d76', faint: '#8c959f', accent: '#0969da', input: '#ffffff',
    add: '#1a7f37', del: '#cf222e', warn: '#9a6700', info: '#0969da', ask: '#8250df', done: '#1f883d', beta: '#1b7c83',
    ansi: ['#24292f', '#cf222e', '#116329', '#9a6700', '#0969da', '#8250df', '#1b7c83', '#57606a', '#57606a', '#a40e26', '#1a7f37', '#bf8700', '#218bff', '#a475f9', '#3192aa', '#24292f']
  },
  {
    id: 'solarized-light', label: 'Solarized Light', scheme: 'light',
    bg: '#fdf6e3', surface: '#eee8d5', raised: '#e7e0cb', overlay: '#fdf6e3', border: '#d6cfb8', borderStrong: '#c3baa0',
    fg: '#566b72', muted: '#657b83', faint: '#839496', accent: '#2588cd', input: '#fdf6e3',
    add: '#7b8e00', del: '#dc322f', warn: '#a77f00', info: '#268bd2', ask: '#d33682', beta: '#6c71c4',
    ansi: ['#073642', '#dc322f', '#7b8e00', '#a77f00', '#268bd2', '#d33682', '#269189', '#657b83', '#586e75', '#cb4b16', '#657b83', '#6c71c4', '#268bd2', '#d33682', '#269189', '#566b72']
  },
  {
    id: 'gruvbox-light', label: 'Gruvbox Light', scheme: 'light',
    bg: '#f2e5bc', surface: '#fbf1c7', raised: '#ebdbb2', overlay: '#fbf1c7', border: '#d5c4a1', borderStrong: '#bdae93',
    fg: '#3c3836', muted: '#665c54', faint: '#7c6f64', accent: '#af3a03', input: '#fbf1c7',
    add: '#79740e', del: '#9d0006', warn: '#b57614', info: '#076678', ask: '#8f3f71',
    ansi: ['#3c3836', '#9d0006', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#665c54', '#504945', '#cc241d', '#79740e', '#b57614', '#458588', '#b16286', '#427b58', '#3c3836']
  },
  {
    id: 'catppuccin-latte', label: 'Catppuccin Latte', scheme: 'light',
    bg: '#e6e9ef', surface: '#eff1f5', raised: '#e6e9ef', overlay: '#eff1f5', border: '#ccd0da', borderStrong: '#bcc0cc',
    fg: '#4c4f69', muted: '#6c6f85', faint: '#8c8fa1', accent: '#8839ef', input: '#ffffff',
    add: '#3e9c2a', del: '#d20f39', warn: '#be7919', info: '#1e66f5', ask: '#cd67b2', beta: '#179299',
    ansi: ['#4c4f69', '#d20f39', '#3e9c2a', '#be7919', '#1e66f5', '#cd67b2', '#179299', '#6c6f85', '#5c5f77', '#d20f39', '#3e9c2a', '#be7919', '#1e66f5', '#8839ef', '#179299', '#4c4f69']
  },
  {
    id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', scheme: 'light',
    bg: '#faf4ed', surface: '#fffaf3', raised: '#f2e9e1', overlay: '#fffaf3', border: '#e8dfd6', borderStrong: '#dfdad9',
    fg: '#575279', muted: '#797593', faint: '#9893a5', accent: '#286983', input: '#fffaf3',
    add: '#56949f', del: '#b4637a', warn: '#c1822b', info: '#286983', ask: '#907aa9',
    ansi: ['#575279', '#b4637a', '#56949f', '#c1822b', '#286983', '#907aa9', '#cc7c78', '#797593', '#6e6a86', '#b4637a', '#286983', '#c1822b', '#56949f', '#907aa9', '#cc7c78', '#575279']
  },
  {
    id: 'flexoki-light', label: 'Flexoki Light', scheme: 'light',
    bg: '#f2f0e5', surface: '#fffcf0', raised: '#f2f0e5', overlay: '#fffcf0', border: '#e6e4d9', borderStrong: '#cecdc3',
    fg: '#100f0f', muted: '#6f6e69', faint: '#9c9a90', accent: '#205ea6', input: '#fffcf0',
    add: '#66800b', del: '#af3029', warn: '#ad8301', info: '#205ea6', ask: '#a02f6f', beta: '#24837b',
    ansi: ['#100f0f', '#af3029', '#66800b', '#ad8301', '#205ea6', '#5e409d', '#24837b', '#6f6e69', '#282726', '#d14d41', '#879a39', '#ad8301', '#4385be', '#8b7ec8', '#24837b', '#100f0f']
  }
] as const);

function define<const T extends readonly ThemeSpec[]>(specs: T) { return specs; }

export type ThemeId = (typeof SPECS)[number]['id'];

export const APP_THEMES: AppTheme[] = SPECS.map(spec => build(spec));

const byId = new Map(APP_THEMES.map(theme => [theme.id, theme]));

export const isThemeId = (id: string): id is ThemeId => byId.has(id as ThemeId);

export const themeById = (id: string | undefined): AppTheme => (id && byId.get(id as ThemeId)) || byId.get('dark')!;

// Surfaces on the other dark themes sit well above the default dark. Chat-only darkening pulls each
// surface down toward black until it is no lighter than the same token on the default dark, so the
// hue stays and the steps between background, cards and borders stay.
const CHAT_DARK_KEYS = ['--bg', '--surface', '--raised', '--overlay', '--input', '--border', '--border-strong'] as const;
const towardBlack = (hex: string, ceiling: string) => {
  if (luminance(hex) <= luminance(ceiling)) return hex;
  let lo = 0, hi = 1;
  for (let step = 0; step < 14; step++) {
    const mid = (lo + hi) / 2;
    if (luminance(mix(hex, '#000000', mid)) > luminance(ceiling)) lo = mid;
    else hi = mid;
  }
  return mix(hex, '#000000', hi);
};
export const chatDarkVars = (vars: Record<string, string>) => {
  const cap = themeById('dark').vars;
  return Object.fromEntries(CHAT_DARK_KEYS.map(key => [key, towardBlack(vars[key], cap[key])]));
};

export const nextTheme = (id: string) => APP_THEMES[(APP_THEMES.findIndex(theme => theme.id === id) + 1) % APP_THEMES.length];

export const themeChoices = () => APP_THEMES.map((theme, index) => ({
  value: theme.id, label: theme.label, divider: index > 0 && theme.scheme !== APP_THEMES[index - 1].scheme
}));

export const themeStyleSheet = () => APP_THEMES.filter(theme => theme.id !== 'dark').map(theme => {
  const body = Object.entries(theme.vars).map(([key, value]) => `${key}: ${value}`).join('; ');
  return `:root[data-theme=${theme.id}] { ${body}; color-scheme: ${theme.scheme}; }`;
}).join('\n');

export const installThemes = () => {
  if (typeof document === 'undefined') return;
  let style = document.getElementById('ade-themes');
  if (!style) { style = document.createElement('style'); style.id = 'ade-themes'; }
  style.textContent = themeStyleSheet();
  document.head.appendChild(style);
};
