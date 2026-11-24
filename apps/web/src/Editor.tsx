import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type * as Monaco from 'monaco-editor';
import type { AgentMode } from './launchers';
import { APP_THEMES, isThemeId, themeById, type ThemeId } from './themes';
import { defaultUsageMeters, usageMetersOf, type UsageStyle } from './usage-meters';
import type { FileBuffer } from './file-buffer';
import { TIPS_VERSION } from './tips';

// An MCP tool (`tool` set) or a whole MCP server the user trusts for good, per provider: the approval card adds them, the provider's settings remove them.
export type McpTrust = { server: string; tool?: string };
export type Settings = {
  mcpTrust: Record<'claude' | 'codex' | 'cursor', McpTrust[]>;
  theme: ThemeId; chatDarker: boolean; fontSize: number; terminalFontSize: number; wordWrap: boolean; dimInactivePanes: boolean;
  terminalFont: string; lineHeight: number; scrollback: number; cursorStyle: 'bar' | 'block' | 'underline'; cursorBlink: boolean; copyOnSelect: boolean;
  sidebarWidth: number; statusItems: string[]; statusLeft: string[]; statusRight: string[]; usageColors: boolean; notifyDone: boolean; notifyApproval: boolean; notifySound: boolean; soundDone: string; soundAttention: string; soundVolume: number; soundVolumeExtended: boolean; diffRefresh: number; wakatime: boolean; wakatimeBackground: boolean;
  terminalShell: string; claudeSession: boolean; usageStyle: UsageStyle; usageShown: Record<'claude' | 'codex' | 'cursor', string[]>;
  // AI tools: `agentsOff` hides an agent from the launchers, `agentsMuted` silences its alerts; *Args are appended to its launch command.
  agentsOff: string[]; agentsMuted: string[]; claudeArgs: string; codexArgs: string; cursorArgs: string; notifyLooking: boolean;
  // cacheSendWarn asks before a message goes to a Claude whose prompt cache is cold or has cacheSendWarnMinutes or less left.
  cacheTimer: boolean; cacheWarn: number; cacheSendWarn: boolean; cacheSendWarnMinutes: number; followUpQueue: boolean; interactiveUi: boolean; artifactAlways: boolean; usageRefresh: number;
  // idleCompact: ADE compacts a chat on the 1h cache before it goes cold, once its context is idleCompactMinK thousand tokens or more (a chat can override it with /idlecompact).
  idleCompact: boolean; idleCompactMinK: number;
  // Chat composer shortcut overrides (id -> combo, see chat-model chatKeyDefs); a missing id uses its default.
  chatKeys: Record<string, string>; appKeys: Record<string, string>; termKeys: Record<string, boolean>;
  // chatTipPending: Chat was never opened and its card was not dismissed (new users too: they may pick CLI and never see Chat).
  defaultMode: AgentMode; chatTipPending: boolean;
  // tips: one-time cards and pointers.
  // hintsSeen: pointers the user acknowledged or whose feature they already used.
  tips: boolean; hintsSeen: string[];
  // tmux key guide: shown as soon as the prefix key (Ctrl+<tmuxPrefix>) is pressed. "auto" needs a tmux status line on screen.
  tmuxGuide: 'auto' | 'always' | 'off'; tmuxPrefix: string;
  // Customization. accentColor '' keeps the theme's own accent. The rest map onto xterm / Monaco options of the same meaning.
  accentColor: string; terminalFontWeight: number; rightClickPaste: boolean; optionAsMeta: boolean; confirmClose: boolean;
  letterSpacing: number; scrollSensitivity: number; minimumContrast: number; wordSeparator: string; boldBright: boolean; terminalGpu: boolean;
  diffLayout: 'auto' | 'inline' | 'split'; diffIgnoreWhitespace: boolean; diffFoldUnchanged: boolean; diffContextLines: number;
  clock12h: boolean; clockSeconds: boolean; systemRefresh: number; reviewWidth: number;
  // First-run tutorial finished or skipped. Saved settings from before it existed count as done: those users are not new.
  // `tourVersion`: the tutorial last finished; one below TOUR_VERSION means it is due again, once, and cannot be skipped.
  onboarded: boolean; tourVersion: number;
  // Chat tab status line (Claude Code's own statusLine, drawn by ADE): which items, their order and side, and a separator.
  chatStatusItems: string[]; chatStatusLeft: string[]; chatStatusRight: string[]; chatStatusSeparator: string;
  // Chat tab behaviour and looks. chatDefaultPermission/chatDefaultEffort apply to a chat when it is first created ('cli' permission and 'auto' effort = the CLI's own settings, like a plain `claude`).
  chatSendKey: 'enter' | 'mod-enter'; chatToolsOpen: boolean; chatToolDisplay: 'summary' | 'detail'; chatThinkingOpen: 'live' | 'always' | 'never'; chatAutoScroll: boolean; chatSmoothStream: boolean;
  chatFileChipLabel: 'path' | 'name';
  chatFontSize: number; chatWidth: 'narrow' | 'default' | 'wide' | 'full'; chatComposerMax: number; chatModelPins: Partial<Record<'claude' | 'codex' | 'cursor', string[]>>; chatDefaultPermission: 'cli' | 'default' | 'acceptEdits' | 'plan' | 'auto'; chatPermissionAutoSet: boolean; chatDefaultEffort: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  // App-wide look: uiZoom in percent, diffFont '' = same as the terminal font, sidebarCompact = the icon-only rail.
  uiZoom: number; diffFont: string; sidebarCompact: boolean; animateInBackground: boolean;
  terminalBell: 'off' | 'visual' | 'sound'; diffComputeMs: number; confirmCloseChat: boolean; confirmCloseProject: boolean;
  // Feedback inbox: feedbackAgentTool lets chat agents put drafts in it; feedbackAiContext adds screen layout and recent errors to an AI draft request.
  feedbackAgentTool: boolean; feedbackAiContext: boolean; feedbackAiModel: '' | 'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'sonnet' | 'opus'; feedbackAiEffort: '' | 'low' | 'medium' | 'high';
  // Git tool window (the commit graph drawer), with IntelliJ's options and defaults. Drawer: height, docked (terminals shrink) or floating over them.
  gitLogHeight: number; gitLogDock: boolean; gitLogLimit: number; gitBranchesWidth: number; gitDetailsWidth: number;
  // Graph Options: sort and the merge options; View Options: labels, long edges, timestamp, columns, highlighters.
  gitSort: 'date' | 'topo'; gitLinear: boolean; gitFirstParent: boolean; gitNoMerges: boolean;
  gitCompactRefs: boolean; gitTagNames: boolean; gitLongEdges: boolean; gitCommitTime: boolean; gitRefsLeft: boolean; gitColumns: string[];
  gitMine: boolean; gitMerges: boolean; gitCurrent: boolean; gitPrettyDate: boolean; gitSaturation: number; gitBrightness: number;
  // Changed files and details pane; Branches pane (single click action, grouping, tags, favourites).
  gitDetails: boolean; gitDiffPreview: boolean; gitFilesByDir: boolean; gitBranchesPane: boolean; gitBranchClick: 'none' | 'filter' | 'navigate'; gitBranchDirs: boolean; gitBranchTags: boolean; gitFavorites: string[];
  // Operations: how Update pulls, prune on fetch, branches whose pushed commits may not be rewritten.
  gitUpdateMethod: 'merge' | 'rebase'; gitFetchPrune: boolean; gitProtected: string;
  // The changes panel was replaced by the Git graph: people who used the app before see a one-time card saying so (like the Chat tip).
  gitTipPending: boolean;
  // The tip version last applied to settings.
  tipsVersion: number;
};
export const agentNames = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor CLI' } as const;
export const agentArgs = (settings: Settings, agent: string) => ({ claude: settings.claudeArgs, codex: settings.codexArgs, cursor: settings.cursorArgs } as Record<string, string>)[agent]?.trim() ?? '';
// statusItems is the shown set; statusLeft/statusRight hold every item's side and order, shown or not, so hiding one keeps its place.
const defaultLeft = ['connection', 'path', 'branch'], defaultRight = ['cpu', 'memory', 'claudeusage', 'codexusage', 'cursorusage', 'wakatime', 'clock', 'readiness'];
export const statusItemIds = [...defaultLeft, ...defaultRight];
// Items that were fixed or did not exist before the layout could be edited; saved settings from then get them shown.
const addedWithLayout = ['connection', 'readiness', 'claudeusage', 'codexusage', 'cursorusage'];
export function statusLayout(settings: Pick<Settings, 'statusLeft' | 'statusRight'>) {
  const known = new Set(statusItemIds), seen = new Set<string>();
  const keep = (list: string[] = []) => list.filter(id => known.has(id) && !seen.has(id) && seen.add(id));
  const left = keep(settings.statusLeft), right = keep(settings.statusRight);
  for (const id of statusItemIds) if (!seen.has(id)) (defaultLeft.includes(id) ? left : right).push(id);
  return { left, right };
}
// The chat tab's status line only has items that read the conversation; branch, usage, clock etc. stay in the bottom status bar so nothing shows twice.
const chatDefaultLeft = ['status', 'tokens', 'turns'], chatDefaultRight = ['cost', 'share', 'duration', 'session', 'model', 'mode', 'context']; // model, mode and context are also controls in the composer's footer
export const chatStatusItemIds = [...chatDefaultLeft, ...chatDefaultRight];
export function chatStatusLayout(settings: Pick<Settings, 'chatStatusLeft' | 'chatStatusRight'>) {
  const known = new Set(chatStatusItemIds), seen = new Set<string>();
  const keep = (list: string[] = []) => list.filter(id => known.has(id) && !seen.has(id) && seen.add(id));
  const left = keep(settings.chatStatusLeft), right = keep(settings.chatStatusRight);
  for (const id of chatStatusItemIds) if (!seen.has(id)) (chatDefaultLeft.includes(id) ? left : right).push(id);
  return { left, right };
}
// Green at 0% through yellow to red at 100%, like Claude Code's statusline; the theme picks the lightness.
export const usageHue = (percent: number) => Math.round(120 * (1 - Math.max(0, Math.min(100, percent)) / 100));
// Raise when the tutorial changes enough that users who finished it should go through it again.
export const TOUR_VERSION = 2;
export function migrateSettings(saved: Partial<Settings>): Settings {
  const next = { ...defaultSettings, ...saved, chatModelPins: { ...defaultSettings.chatModelPins, ...(saved.chatModelPins ?? {}) } };
  if (typeof next.theme !== 'string' || !isThemeId(next.theme)) next.theme = 'dark';
  if (saved.onboarded === undefined) next.onboarded = true;
  // New chats start in auto mode now. A saved 'cli' from before that is the old default, not a choice (the marker is set once this ran), so it moves to 'auto' one time.
  if (saved.chatPermissionAutoSet !== true) { next.chatPermissionAutoSet = true; if (saved.chatDefaultPermission === undefined || saved.chatDefaultPermission === 'cli') next.chatDefaultPermission = 'auto'; }
  // Missing mode marks the first upgrade to Chat: keep existing CLI habits and offer the new mode once.
  if (saved.defaultMode === undefined) { next.defaultMode = 'cli'; next.chatTipPending = next.onboarded; }
  // Tips reset: an untouched `saved.tipsVersion` below TIPS_VERSION means this install has not had it yet (new users save the current one).
  if ((saved.tipsVersion ?? 0) < TIPS_VERSION && Object.keys(saved).length > 0) {
    next.hintsSeen = [];
    next.gitTipPending = true;
    next.chatTipPending = next.onboarded || next.tourVersion > 0;
  }
  next.tipsVersion = Math.max(next.tipsVersion, TIPS_VERSION);
  // A tutorial newer than the one finished: everyone sees it once more (after the Chat tip above was decided by the old record).
  // Someone who finished a tour before the version number existed counts as having finished version 1. The new tour clears `onboarded` below, and that gets saved: if the app is
  // closed before the tour ends, the next start must not read `onboarded: false` as a first run (the theme and font screen), so the tour version is the record of "was onboarded once".
  if (next.onboarded && next.tourVersion < 1) next.tourVersion = 1;
  if (next.tourVersion < TOUR_VERSION) next.onboarded = false;
  // Saved settings from before the Git graph belong to someone who knew the changes panel: they get the card once. New users meet it in the tutorial.
  if (saved.gitTipPending === undefined && Object.keys(saved).length > 0) next.gitTipPending = true;
  // The old graph colours (40 / 65, muddy on a dark background) were the default, not a choice: they move to the new default.
  if (saved.gitSaturation === 40 && saved.gitBrightness === 65) { next.gitSaturation = 60; next.gitBrightness = 85; }
  // The changes panel became the Git tool window: a shortcut chosen for it moves along.
  if (saved.appKeys?.review && !saved.appKeys.gitLog) { const { review, ...rest } = saved.appKeys; next.appKeys = { ...rest, gitLog: review }; }
  if (saved.statusItems && !saved.statusLeft) next.statusItems = [...saved.statusItems.filter(id => !addedWithLayout.includes(id)), ...addedWithLayout];
  // Chat status line: model, mode and context moved into the composer's footer, so an untouched old default (ignoring ids that no longer exist) follows the new one.
  const known = (list?: string[]) => JSON.stringify((list ?? []).filter(id => chatStatusItemIds.includes(id)));
  if (saved.chatStatusItems && known(saved.chatStatusItems) === JSON.stringify(['status', 'model', 'mode', 'context', 'cost'])
    && known(saved.chatStatusLeft) === JSON.stringify(['status', 'model', 'mode', 'context']) && known(saved.chatStatusRight) === JSON.stringify(['tokens', 'cost', 'turns', 'duration', 'session'])) {
    next.chatStatusItems = defaultSettings.chatStatusItems; next.chatStatusLeft = defaultSettings.chatStatusLeft; next.chatStatusRight = defaultSettings.chatStatusRight;
  }
  // 'share' (usage contribution) arrived next to the cost: an untouched default layout gets it; a layout saved since then keeps the user's choice.
  else if (saved.chatStatusItems && !saved.chatStatusLeft?.includes('share') && !saved.chatStatusRight?.includes('share') && known(saved.chatStatusItems) === JSON.stringify(['tokens', 'cost'])) {
    next.chatStatusItems = [...saved.chatStatusItems, 'share'];
    if (saved.chatStatusRight?.includes('cost')) next.chatStatusRight = saved.chatStatusRight.flatMap(item => item === 'cost' ? ['cost', 'share'] : [item]);
  }
  if (next.usageStyle !== 'bar' && next.usageStyle !== 'text') next.usageStyle = 'bar';
  next.usageShown = {
    claude: usageMetersOf('claude', Array.isArray(saved.usageShown?.claude) ? saved.usageShown : undefined),
    codex: Array.isArray(saved.usageShown?.codex) ? saved.usageShown.codex : [...defaultUsageMeters.codex],
    cursor: Array.isArray(saved.usageShown?.cursor) ? saved.usageShown.cursor : [...defaultUsageMeters.cursor]
  };
  const trusted = (list: unknown): McpTrust[] => Array.isArray(list) ? list.filter(item => typeof item?.server === 'string' && item.server && (item.tool === undefined || typeof item.tool === 'string')).map(item => ({ server: item.server, ...(item.tool !== undefined && { tool: item.tool }) })) : [];
  next.mcpTrust = { claude: trusted(saved.mcpTrust?.claude), codex: trusted(saved.mcpTrust?.codex), cursor: trusted(saved.mcpTrust?.cursor) };
  return next;
}
// xterm's own default, so an empty-looking field means "unchanged".
const defaultWordSeparator = ' ()[]{}\',"`─‘’“”|';
export const defaultSettings: Settings = {
  mcpTrust: { claude: [], codex: [], cursor: [] },
  theme: 'dark', chatDarker: false, fontSize: 13, terminalFontSize: 13, wordWrap: true, dimInactivePanes: true,
  terminalFont: '', lineHeight: 1.2, scrollback: 10000, cursorStyle: 'bar', cursorBlink: true, copyOnSelect: false,
  sidebarWidth: 252, statusItems: [...statusItemIds], statusLeft: defaultLeft, statusRight: defaultRight, usageColors: true, usageStyle: 'bar', usageShown: { claude: [...defaultUsageMeters.claude], codex: [...defaultUsageMeters.codex], cursor: [...defaultUsageMeters.cursor] }, notifyDone: true, notifyApproval: true, notifySound: true, soundDone: 'marimba', soundAttention: 'alert', soundVolume: 60, soundVolumeExtended: false, diffRefresh: 3, wakatime: false, wakatimeBackground: true, terminalShell: '', claudeSession: true,
  agentsOff: [], agentsMuted: [], claudeArgs: '', codexArgs: '', cursorArgs: '', notifyLooking: false, cacheTimer: true, cacheWarn: 20, cacheSendWarn: true, cacheSendWarnMinutes: 10, followUpQueue: true, interactiveUi: true, artifactAlways: false, usageRefresh: 120, idleCompact: false, idleCompactMinK: 200, chatKeys: {}, appKeys: {}, termKeys: {}, defaultMode: 'chat', chatTipPending: true, tips: true, hintsSeen: [],
  tmuxGuide: 'auto', tmuxPrefix: 'b',
  accentColor: '', terminalFontWeight: 400, rightClickPaste: false, optionAsMeta: false, confirmClose: true,
  letterSpacing: 0, scrollSensitivity: 1, minimumContrast: 1, wordSeparator: defaultWordSeparator, boldBright: true, terminalGpu: true,
  diffLayout: 'auto', diffIgnoreWhitespace: false, diffFoldUnchanged: true, diffContextLines: 3,
  clock12h: false, clockSeconds: false, systemRefresh: 5, reviewWidth: 480, onboarded: false, tourVersion: 0,
  chatStatusItems: ['tokens', 'cost', 'share'], chatStatusLeft: chatDefaultLeft, chatStatusRight: chatDefaultRight, chatStatusSeparator: '',
  chatSendKey: 'enter', chatToolsOpen: false, chatToolDisplay: 'summary', chatThinkingOpen: 'live', chatAutoScroll: true, chatSmoothStream: true,
  chatFileChipLabel: 'path',
  chatFontSize: 13, chatWidth: 'default', chatComposerMax: 220, chatModelPins: {}, chatDefaultPermission: 'auto', chatPermissionAutoSet: true, chatDefaultEffort: 'auto',
  uiZoom: 100, diffFont: '', sidebarCompact: false, animateInBackground: false,
  terminalBell: 'off', diffComputeMs: 2000, confirmCloseChat: true, confirmCloseProject: true,
  feedbackAgentTool: true, feedbackAiContext: true, feedbackAiModel: 'claude-haiku-5-5', feedbackAiEffort: 'low',
  gitLogHeight: 380, gitLogDock: false, gitLogLimit: 5000, gitBranchesWidth: 230, gitDetailsWidth: 400,
  gitSort: 'date', gitLinear: false, gitFirstParent: false, gitNoMerges: false,
  gitCompactRefs: true, gitTagNames: false, gitLongEdges: false, gitCommitTime: false, gitRefsLeft: false, gitColumns: ['author', 'date'],
  gitMine: true, gitMerges: true, gitCurrent: true, gitPrettyDate: true, gitSaturation: 60, gitBrightness: 85,
  gitDetails: true, gitDiffPreview: false, gitFilesByDir: true, gitBranchesPane: true, gitBranchClick: 'none', gitBranchDirs: true, gitBranchTags: false, gitFavorites: ['main', 'master', 'origin/main', 'origin/master'],
  gitUpdateMethod: 'merge', gitFetchPrune: false, gitProtected: 'main, master', gitTipPending: false, tipsVersion: TIPS_VERSION
};

export function restoreDefaultSettings({ theme, onboarded, tourVersion, tipsVersion, hintsSeen, chatTipPending, gitTipPending }: Settings): Settings {
  return { ...defaultSettings, theme, onboarded, tourVersion, tipsVersion, hintsSeen, chatTipPending, gitTipPending };
}
// Same stack the terminal uses when it has a custom font, so a diff and the terminal beside it match.
// Terminal default = the OS's own monospace font (Mac: Menlo, Windows: Cascadia Mono); a chosen font goes first and falls back to it.
const systemMono = /Mac|iPhone|iPad/.test(navigator.platform) ? "Menlo, Monaco, monospace" : /Windows/.test(navigator.userAgent) ? "'Cascadia Mono', Consolas, monospace" : "'DejaVu Sans Mono', ui-monospace, monospace";
export const terminalFontStack = (name: string) => name.trim() ? `${name.trim()}, ${systemMono}` : systemMono;
const diffFontFamily = (settings: Pick<Settings, 'diffFont' | 'terminalFont'>) => terminalFontStack(settings.diffFont.trim() || settings.terminalFont);
const themeName = (theme: Settings['theme']) => `ade-${themeById(theme).id}`;

let monacoPromise: Promise<typeof Monaco> | null = null;
function loadMonaco() { return monacoPromise ||= init(); }
async function init() {
  const [monaco, editor, json, css, html, ts] = await Promise.all([
    import('monaco-editor'),
    import('monaco-editor/esm/vs/editor/editor.worker?worker'), import('monaco-editor/esm/vs/language/json/json.worker?worker'),
    import('monaco-editor/esm/vs/language/css/css.worker?worker'), import('monaco-editor/esm/vs/language/html/html.worker?worker'),
    import('monaco-editor/esm/vs/language/typescript/ts.worker?worker')
  ]);
  (self as any).MonacoEnvironment = {
    getWorker(_id: string, label: string) {
      const Worker = label === 'json' ? json.default : ['css', 'scss', 'less'].includes(label) ? css.default : ['html', 'handlebars', 'razor'].includes(label) ? html.default : ['typescript', 'javascript'].includes(label) ? ts.default : editor.default;
      return new Worker();
    }
  };
  // Diffs are read-only, so the TS/JS language service would only spend CPU on diagnostics nobody sees.
  for (const defaults of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
    defaults.setModeConfiguration({ completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false, documentHighlights: false, rename: false, diagnostics: false, documentRangeFormattingEdits: false, signatureHelp: false, onTypeFormattingEdits: false, codeActions: false, inlayHints: false });
  }
  // Chrome follows the app theme. Token colours stay Monaco's own (vs / vs-dark) so every language stays readable.
  for (const theme of APP_THEMES) monaco.editor.defineTheme(`ade-${theme.id}`, { base: theme.scheme === 'light' ? 'vs' : 'vs-dark', inherit: true, rules: [], colors: theme.monaco as Monaco.editor.IColors });
  return monaco;
}

// `compact` renders an auto-height diff with unchanged regions folded, for the stacked code review list.
// The Monaco editor is created once per mount and later content/option changes are applied to it in place: the review list
// reloads its files while an agent edits, and rebuilding an editor (plus two models and a diff computation) on each change made it stutter.
export const preloadMonaco = () => { void loadMonaco(); };

// Syntax colours for a code block in the chat, from Monaco's tokenizer (already in the app for diffs). `hint` is a fence language ("ts",
// "bash") or a file name ("src/a.ts"); anything unknown, and very long code, stays plain (null). The HTML is Monaco's own escaped markup.
const FENCE_ALIASES: Record<string, string> = { bash: 'shell', zsh: 'shell', console: 'shell', shellscript: 'shell', pwsh: 'powershell', ps: 'powershell', jsonc: 'json', yml: 'yaml' };
const languageOf = (monaco: typeof Monaco, hint: string) => {
  const raw = hint.trim().toLowerCase(), name = FENCE_ALIASES[raw] ?? raw, file = name.split(/[\\/]/).pop() ?? name, dot = file.lastIndexOf('.');
  const ext = dot > 0 ? file.slice(dot) : dot < 0 ? `.${file}` : ''; // a bare fence tag ("py", "rs") is also tried as an extension
  return monaco.languages.getLanguages().find(lang => lang.id === name || lang.aliases?.some(alias => alias.toLowerCase() === name)
    || (ext && lang.extensions?.includes(ext)) || lang.filenames?.some(known => known.toLowerCase() === file))?.id ?? null;
};
// 테마를 바꿀 때 이미 그려 둔 코드 블록(.mtk* 색은 전역 CSS)도 새 테마 색으로 따라오게 한다. 그동안은 편집기를 열거나 새 블록을 칠할 때까지 옛 테마 색이 남아 밝은 테마에서 글자가 안 보였다.
// Monaco를 아직 안 불렀으면(코드 블록도 편집기도 없음) 할 일이 없다.
export function syncMonacoTheme(theme: Settings['theme']) { if (monacoPromise) void monacoPromise.then(monaco => monaco.editor.setTheme(themeName(theme)), () => {}); }
export async function colorize(code: string, hint: string): Promise<string | null> {
  if (!hint.trim() || !code || code.length > 100_000) return null;
  const monaco = await loadMonaco(), id = languageOf(monaco, hint);
  if (!id) return null;
  // The token colours (.mtk*) are global CSS that follows the theme, so set it to the app's own before colouring.
  monaco.editor.setTheme(themeName(themeById(document.documentElement.dataset.theme).id));
  return monaco.editor.colorize(code, id, { tabSize: 2 });
}
export type DiffLayoutChoice = Exclude<Settings['diffLayout'], 'auto'>;

export function FileEditor({ buffer, settings, visible, watch }: {
  buffer: FileBuffer; settings: Settings; visible: boolean;
  watch(listener: (paths: string[]) => void): () => void;
}) {
  const state = useSyncExternalStore(buffer.subscribe, buffer.get);
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<{ monaco: typeof Monaco; editor: Monaco.editor.IStandaloneCodeEditor } | null>(null);
  const latest = useRef({ state, settings, visible });
  const updating = useRef(false);
  latest.current = { state, settings, visible };
  const loaded = state.draft !== undefined;
  const readOnly = Boolean(state.conflict || state.busy);
  useEffect(() => {
    if (!visible) return;
    const refresh = () => { if (!document.hidden) void buffer.refresh(); };
    const unsubscribe = watch(paths => {
      if (!paths.length || paths.some(path => path === buffer.path || buffer.path.startsWith(`${path}/`))) void buffer.refresh();
    });
    void buffer.refresh();
    const timer = setInterval(refresh, 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => { unsubscribe(); clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [visible, buffer, watch]);

  useEffect(() => {
    if (!loaded) return;
    let disposed = false, cleanup = () => {};
    void loadMonaco().then(monaco => {
      if (disposed || !host.current) return;
      const now = latest.current;
      const model = monaco.editor.createModel(now.state.draft ?? '', languageOf(monaco, buffer.path) ?? 'plaintext');
      monaco.editor.setTheme(themeName(now.settings.theme));
      const editor = monaco.editor.create(host.current, {
        model, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
        fontSize: now.settings.fontSize, wordWrap: now.settings.wordWrap ? 'on' : 'off', fontFamily: diffFontFamily(now.settings),
        readOnly: Boolean(now.state.conflict || now.state.busy), ariaLabel: buffer.path
      });
      live.current = { monaco, editor };
      const change = model.onDidChangeContent(() => { if (!updating.current) buffer.edit(model.getValue(undefined, true)); });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void buffer.save(); });
      if (now.visible && !now.state.conflict && document.activeElement?.closest('.project-tree')) editor.focus();
      cleanup = () => { live.current = null; change.dispose(); editor.dispose(); model.dispose(); };
    });
    return () => { disposed = true; cleanup(); };
  }, [buffer, loaded]);

  useEffect(() => {
    const editor = live.current?.editor, model = editor?.getModel();
    if (!model || state.draft === undefined || model.getValue(undefined, true) === state.draft) return;
    const position = editor?.getPosition();
    updating.current = true;
    try { model.setValue(state.draft); if (position) editor?.setPosition(position); }
    finally { updating.current = false; }
  }, [state.draft]);
  useEffect(() => {
    if (!live.current) return;
    const { monaco, editor } = live.current;
    monaco.editor.setTheme(themeName(settings.theme));
    editor.updateOptions({ fontSize: settings.fontSize, wordWrap: settings.wordWrap ? 'on' : 'off', fontFamily: diffFontFamily(settings), readOnly });
  }, [settings.theme, settings.fontSize, settings.wordWrap, settings.diffFont, settings.terminalFont, readOnly]);

  const conflict = state.conflict;
  return <>
    {conflict && <div className="file-conflict">
      <span role="alert">{conflict.file ? '외부에서 파일이 변경되었습니다.' : '외부에서 파일이 삭제되었습니다.'} ADE의 편집 내용은 아직 저장되지 않았습니다.</span>
      <button disabled={state.busy} onClick={buffer.reload}>다시 불러오기</button>
      <button disabled={state.busy} onClick={() => void buffer.save(true)}>덮어쓰기</button>
    </div>}
    {state.error && <div className="file-conflict" role="alert">
      <span>{state.error}</span>
      {!conflict && <button onClick={() => void (buffer.dirty ? buffer.save() : buffer.refresh())}>다시 시도</button>}
    </div>}
    {loaded ? <div className="editor" ref={host} /> : !state.error && <div className="empty">{state.file === null ? '파일이 삭제되었습니다.' : '불러오는 중…'}</div>}
  </>;
}

export function DiffView({ original, modified, path, settings, onLayoutChange, header, compact = false, minHeight = 60, onHeight }: {
  original: string; modified: string; path: string; settings: Settings; onLayoutChange(layout: DiffLayoutChoice): void;
  header?: ReactNode; compact?: boolean; minHeight?: number; onHeight?(height: number): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(true);
  const sideBySide = !narrow && (settings.diffLayout === 'split' || (settings.diffLayout === 'auto' && !compact));
  const live = useRef<{ monaco: typeof Monaco; diff: Monaco.editor.IStandaloneDiffEditor; a: Monaco.editor.ITextModel; b: Monaco.editor.ITextModel } | null>(null);
  const latest = useRef({ original, modified, settings, sideBySide, onHeight }); latest.current = { original, modified, settings, sideBySide, onHeight };
  useEffect(() => {
    const box = host.current!;
    const measure = () => setNarrow(box.clientWidth <= 760);
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let disposed = false, cleanup = () => {};
    void loadMonaco().then(monaco => {
      if (disposed || !host.current) return;
      const now = latest.current.settings;
      monaco.editor.setTheme(themeName(now.theme));
      const diff = monaco.editor.createDiffEditor(host.current, {
        automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: latest.current.sideBySide, useInlineViewWhenSpaceIsLimited: false,
        ignoreTrimWhitespace: now.diffIgnoreWhitespace, maxComputationTime: now.diffComputeMs, scrollBeyondLastLine: false, fontSize: now.fontSize, wordWrap: now.wordWrap ? 'on' : 'off', fontFamily: diffFontFamily(now),
        ...(compact ? { hideUnchangedRegions: { enabled: now.diffFoldUnchanged, contextLineCount: now.diffContextLines, minimumLineCount: 4 }, minimap: { enabled: false }, renderOverviewRuler: false, overviewRulerLanes: 0, overviewRulerBorder: false, hideCursorInOverviewRuler: true, folding: false, glyphMargin: false, lineDecorationsWidth: 8, scrollbar: { alwaysConsumeMouseWheel: false, vertical: 'hidden' as const } } : {})
      });
      const uri = (side: string) => monaco.Uri.from({ scheme: 'diff', path: `/${side}/${path}`, query: String(Math.random()) });
      const a = monaco.editor.createModel(latest.current.original, undefined, uri('a')), b = monaco.editor.createModel(latest.current.modified, undefined, uri('b'));
      diff.setModel({ original: a, modified: b });
      live.current = { monaco, diff, a, b };
      const sized = compact ? diff.getModifiedEditor().onDidContentSizeChange(event => {
        const height = Math.min(720, Math.max(minHeight, event.contentHeight));
        // Ignore 1px jitter: the height depends on the width (wrapping), which a scrollbar appearing in the list changes in turn.
        if (!host.current || Math.abs(height - host.current.offsetHeight) < 2) return;
        host.current.style.height = `${height}px`;
        latest.current.onHeight?.(height);
      }) : null;
      // One click on the bar between the two sides puts it back in the middle (Monaco resets only on a double click); dragging still resizes.
      const box = host.current; let pressed: { x: number; y: number } | null = null;
      const onDown = (event: PointerEvent) => { pressed = (event.target as Element | null)?.closest?.('.monaco-sash') ? { x: event.clientX, y: event.clientY } : null; };
      const onUp = (event: PointerEvent) => {
        const sash = pressed && (event.target as Element | null)?.closest?.('.monaco-sash');
        if (sash && Math.hypot(event.clientX - pressed!.x, event.clientY - pressed!.y) < 4) sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        pressed = null;
      };
      box.addEventListener('pointerdown', onDown, true); box.addEventListener('pointerup', onUp, true);
      cleanup = () => { live.current = null; box.removeEventListener('pointerdown', onDown, true); box.removeEventListener('pointerup', onUp, true); sized?.dispose(); diff.dispose(); a.dispose(); b.dispose(); };
    });
    return () => { disposed = true; cleanup(); };
  }, [path, compact, minHeight, settings.diffFoldUnchanged, settings.diffContextLines]);
  useEffect(() => {
    const editor = live.current; if (!editor) return;
    if (editor.a.getValue() !== original) editor.a.setValue(original);
    if (editor.b.getValue() !== modified) editor.b.setValue(modified);
  }, [original, modified]);
  useEffect(() => {
    const editor = live.current; if (!editor) return;
    editor.monaco.editor.setTheme(themeName(settings.theme));
    editor.diff.updateOptions({ fontSize: settings.fontSize, wordWrap: settings.wordWrap ? 'on' : 'off', renderSideBySide: sideBySide, ignoreTrimWhitespace: settings.diffIgnoreWhitespace, maxComputationTime: settings.diffComputeMs, fontFamily: diffFontFamily(settings) });
  }, [settings.theme, settings.fontSize, settings.wordWrap, sideBySide, settings.diffIgnoreWhitespace, settings.diffComputeMs, settings.diffFont, settings.terminalFont]);
  return <div className={compact ? 'chat-diff-wrap' : 'diff-view'}>
    <div className="diff-view-bar">
      {header}
      <span className="diff-view-choices" role="group" aria-label="diff 보기 방식">
        <button type="button" aria-pressed={!sideBySide} onClick={() => onLayoutChange('inline')}>합쳐 보기</button>
        <button type="button" aria-pressed={sideBySide} disabled={narrow} title={narrow ? '패널이 넓을 때 나눠 볼 수 있습니다.' : undefined} onClick={() => onLayoutChange('split')}>나눠 보기</button>
      </span>
    </div>
    {compact ? <div className="chat-diff"><div className="editor compact-diff" ref={host} /></div> : <div className="editor" ref={host} />}
  </div>;
}
