import { useEffect, useRef } from 'react';
import type * as Monaco from 'monaco-editor';
import type { AgentMode } from './launchers';

export type Settings = {
  theme: 'dark' | 'light'; fontSize: number; terminalFontSize: number; wordWrap: boolean; dimInactivePanes: boolean;
  terminalFont: string; lineHeight: number; scrollback: number; cursorStyle: 'bar' | 'block' | 'underline'; cursorBlink: boolean; copyOnSelect: boolean;
  sidebarWidth: number; statusItems: string[]; statusLeft: string[]; statusRight: string[]; usageColors: boolean; notifyDone: boolean; notifyApproval: boolean; notifySound: boolean; soundDone: string; soundAttention: string; soundVolume: number; soundVolumeExtended: boolean; diffRefresh: number; wakatime: boolean; wakatimeBackground: boolean;
  terminalShell: string; claudeSession: boolean;
  // AI tools: `agentsOff` hides an agent from the launchers, `agentsMuted` silences its alerts; *Args are appended to its launch command.
  agentsOff: string[]; agentsMuted: string[]; claudeArgs: string; codexArgs: string; cursorArgs: string; notifyLooking: boolean;
  // cacheSendWarn asks before a message goes to a Claude whose prompt cache is cold or has cacheSendWarnMinutes or less left.
  cacheTimer: boolean; cacheWarn: number; cacheSendWarn: boolean; cacheSendWarnMinutes: number; followUpQueue: boolean; interactiveUi: boolean; usageRefresh: number;
  // Chat composer shortcut overrides (id -> combo, see chat-model chatKeyDefs); a missing id uses its default.
  chatKeys: Record<string, string>; appKeys: Record<string, string>;
  defaultMode: AgentMode; chatTipPending: boolean;
  // tips: hint cards in a pane corner (long context, shortcuts for what was just done with the mouse); contextTipK = context size in thousands of tokens that triggers the /clear tip.
  tips: boolean; contextTipK: number;
  // tmux key guide: shown as soon as the prefix key (Ctrl+<tmuxPrefix>) is pressed. "auto" needs a tmux status line on screen.
  tmuxGuide: 'auto' | 'always' | 'off'; tmuxPrefix: string;
  // Customization. accentColor '' keeps the theme's own accent. The rest map onto xterm / Monaco options of the same meaning.
  accentColor: string; terminalFontWeight: number; rightClickPaste: boolean; optionAsMeta: boolean; confirmClose: boolean;
  letterSpacing: number; scrollSensitivity: number; minimumContrast: number; wordSeparator: string; boldBright: boolean; terminalGpu: boolean;
  diffLayout: 'auto' | 'inline' | 'split'; diffIgnoreWhitespace: boolean; diffFoldUnchanged: boolean; diffContextLines: number;
  clock12h: boolean; clockSeconds: boolean; systemRefresh: number; reviewWidth: number;
  // First-run tutorial finished or skipped. Saved settings from before it existed count as done: those users are not new.
  onboarded: boolean;
  // Chat tab status line (Claude Code's own statusLine, drawn by ADE): which items, their order and side, and a separator.
  chatStatusItems: string[]; chatStatusLeft: string[]; chatStatusRight: string[]; chatStatusSeparator: string;
  // Chat tab behaviour and looks. chatDefaultPermission/chatDefaultEffort apply to a chat when it is first created ('cli' permission and 'auto' effort = the CLI's own settings, like a plain `claude`).
  chatSendKey: 'enter' | 'mod-enter'; chatToolsOpen: boolean; chatToolDisplay: 'summary' | 'detail'; chatThinkingOpen: 'live' | 'always' | 'never'; chatAutoScroll: boolean; chatSmoothStream: boolean;
  chatFontSize: number; chatWidth: 'narrow' | 'default' | 'wide' | 'full'; chatComposerMax: number; chatModelPins: Partial<Record<'claude' | 'codex' | 'cursor', string[]>>; chatDefaultPermission: 'cli' | 'default' | 'acceptEdits' | 'plan' | 'auto'; chatDefaultEffort: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  // App-wide look: uiZoom in percent, diffFont '' = same as the terminal font, sidebarCompact = the icon-only rail.
  uiZoom: number; diffFont: string; sidebarCompact: boolean;
  terminalBell: 'off' | 'visual' | 'sound'; diffComputeMs: number; confirmCloseChat: boolean; confirmCloseProject: boolean;
  // Feedback inbox: feedbackAgentTool lets chat agents put drafts in it; feedbackAiContext adds screen layout and recent errors to an AI draft request.
  feedbackAgentTool: boolean; feedbackAiContext: boolean; feedbackAiModel: '' | 'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'sonnet' | 'opus'; feedbackAiEffort: '' | 'low' | 'medium' | 'high';
};
export const agentNames = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor CLI' } as const;
export const agentArgs = (settings: Settings, agent: string) => ({ claude: settings.claudeArgs, codex: settings.codexArgs, cursor: settings.cursorArgs } as Record<string, string>)[agent]?.trim() ?? '';
// statusItems is the shown set; statusLeft/statusRight hold every item's side and order, shown or not, so hiding one keeps its place.
const defaultLeft = ['connection', 'path', 'branch', 'changes'], defaultRight = ['terminals', 'size', 'cpu', 'memory', 'claudeusage', 'codexusage', 'cursorusage', 'wakatime', 'clock', 'readiness', 'openproject'];
export const statusItemIds = [...defaultLeft, ...defaultRight];
// Items that were fixed or did not exist before the layout could be edited; saved settings from then get them shown.
const addedWithLayout = ['connection', 'readiness', 'openproject', 'claudeusage', 'codexusage', 'cursorusage'];
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
export function migrateSettings(saved: Partial<Settings>): Settings {
  const next = { ...defaultSettings, ...saved, chatModelPins: { ...defaultSettings.chatModelPins, ...(saved.chatModelPins ?? {}) } };
  if (saved.onboarded === undefined) next.onboarded = true;
  // Missing mode marks the first upgrade to Chat: keep existing CLI habits and offer the new mode once.
  if (saved.defaultMode === undefined) { next.defaultMode = 'cli'; next.chatTipPending = next.onboarded; }
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
  return next;
}
// xterm's own default, so an empty-looking field means "unchanged".
const defaultWordSeparator = ' ()[]{}\',"`─‘’“”|';
export const defaultSettings: Settings = {
  theme: 'dark', fontSize: 13, terminalFontSize: 13, wordWrap: true, dimInactivePanes: true,
  terminalFont: '', lineHeight: 1.2, scrollback: 10000, cursorStyle: 'bar', cursorBlink: true, copyOnSelect: false,
  sidebarWidth: 252, statusItems: [...statusItemIds], statusLeft: defaultLeft, statusRight: defaultRight, usageColors: true, notifyDone: true, notifyApproval: true, notifySound: true, soundDone: 'marimba', soundAttention: 'alert', soundVolume: 60, soundVolumeExtended: false, diffRefresh: 3, wakatime: false, wakatimeBackground: true, terminalShell: '', claudeSession: true,
  agentsOff: [], agentsMuted: [], claudeArgs: '', codexArgs: '', cursorArgs: '', notifyLooking: false, cacheTimer: true, cacheWarn: 20, cacheSendWarn: true, cacheSendWarnMinutes: 10, followUpQueue: true, interactiveUi: true, usageRefresh: 120, chatKeys: {}, appKeys: {}, defaultMode: 'chat', chatTipPending: false, tips: true, contextTipK: 400,
  tmuxGuide: 'auto', tmuxPrefix: 'b',
  accentColor: '', terminalFontWeight: 400, rightClickPaste: false, optionAsMeta: false, confirmClose: true,
  letterSpacing: 0, scrollSensitivity: 1, minimumContrast: 1, wordSeparator: defaultWordSeparator, boldBright: true, terminalGpu: true,
  diffLayout: 'auto', diffIgnoreWhitespace: false, diffFoldUnchanged: true, diffContextLines: 3,
  clock12h: false, clockSeconds: false, systemRefresh: 5, reviewWidth: 480, onboarded: false,
  chatStatusItems: ['tokens', 'cost', 'share'], chatStatusLeft: chatDefaultLeft, chatStatusRight: chatDefaultRight, chatStatusSeparator: '',
  chatSendKey: 'enter', chatToolsOpen: false, chatToolDisplay: 'summary', chatThinkingOpen: 'live', chatAutoScroll: true, chatSmoothStream: true,
  chatFontSize: 13, chatWidth: 'default', chatComposerMax: 220, chatModelPins: {}, chatDefaultPermission: 'cli', chatDefaultEffort: 'auto',
  uiZoom: 100, diffFont: '', sidebarCompact: false,
  terminalBell: 'off', diffComputeMs: 2000, confirmCloseChat: true, confirmCloseProject: true,
  feedbackAgentTool: true, feedbackAiContext: true, feedbackAiModel: 'claude-haiku-5-5', feedbackAiEffort: 'low'
};
// Same stack the terminal uses when it has a custom font, so a diff and the terminal beside it match.
// Terminal default = the OS's own monospace font (Mac: Menlo, Windows: Cascadia Mono); a chosen font goes first and falls back to it.
const systemMono = /Mac|iPhone|iPad/.test(navigator.platform) ? "Menlo, Monaco, monospace" : /Windows/.test(navigator.userAgent) ? "'Cascadia Mono', Consolas, monospace" : "'DejaVu Sans Mono', ui-monospace, monospace";
export const terminalFontStack = (name: string) => name.trim() ? `${name.trim()}, ${systemMono}` : systemMono;
const diffFontFamily = (settings: Pick<Settings, 'diffFont' | 'terminalFont'>) => terminalFontStack(settings.diffFont.trim() || settings.terminalFont);
const themeName = (theme: Settings['theme']) => theme === 'dark' ? 'ade-dark' : 'ade-light';

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
  // Matches the app surfaces in style.css so editors and diffs blend into panes.
  monaco.editor.defineTheme('ade-dark', { base: 'vs-dark', inherit: true, rules: [], colors: {
    'editor.background': '#141518', 'editorGutter.background': '#141518', 'minimap.background': '#141518', 'editor.lineHighlightBackground': '#1c1e22', 'editorLineNumber.foreground': '#4b4f57',
    'editorLineNumber.activeForeground': '#a9adb5', 'editorWidget.background': '#1b1d21', 'editorWidget.border': '#2a2d33', 'diffEditor.insertedLineBackground': '#2ea04324', 'diffEditor.removedLineBackground': '#f8514924',
    'diffEditor.insertedTextBackground': '#2ea04340', 'diffEditor.removedTextBackground': '#f8514940', 'diffEditor.unchangedRegionBackground': '#18191c', 'scrollbarSlider.background': '#ffffff18', 'scrollbarSlider.hoverBackground': '#ffffff28'
  } });
  monaco.editor.defineTheme('ade-light', { base: 'vs', inherit: true, rules: [], colors: {
    'editor.background': '#ffffff', 'editorGutter.background': '#ffffff', 'editor.lineHighlightBackground': '#f4f5f7', 'diffEditor.insertedLineBackground': '#2ea04318', 'diffEditor.removedLineBackground': '#cf222e18',
    'diffEditor.unchangedRegionBackground': '#f6f7f9'
  } });
  return monaco;
}

// `compact` renders an auto-height diff with unchanged regions folded, for the stacked code review list.
// The Monaco editor is created once per mount and later content/option changes are applied to it in place: the review list
// reloads its files while an agent edits, and rebuilding an editor (plus two models and a diff computation) on each change made it stutter.
export const preloadMonaco = () => { void loadMonaco(); };
export function DiffView({ original, modified, path, settings, compact = false, onHeight }: { original: string; modified: string; path: string; settings: Settings; compact?: boolean; onHeight?(height: number): void }) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<{ monaco: typeof Monaco; diff: Monaco.editor.IStandaloneDiffEditor; a: Monaco.editor.ITextModel; b: Monaco.editor.ITextModel } | null>(null);
  const latest = useRef({ original, modified, settings, onHeight }); latest.current = { original, modified, settings, onHeight };
  const sideBySide = (value: Settings) => value.diffLayout === 'split' ? true : value.diffLayout !== 'inline';
  useEffect(() => {
    let disposed = false, cleanup = () => {};
    void loadMonaco().then(monaco => {
      if (disposed || !host.current) return;
      const now = latest.current.settings;
      monaco.editor.setTheme(themeName(now.theme));
      const diff = monaco.editor.createDiffEditor(host.current, {
        automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: sideBySide(now), useInlineViewWhenSpaceIsLimited: now.diffLayout === 'auto', renderSideBySideInlineBreakpoint: 760,
        ignoreTrimWhitespace: now.diffIgnoreWhitespace, maxComputationTime: now.diffComputeMs, scrollBeyondLastLine: false, fontSize: now.fontSize, wordWrap: now.wordWrap ? 'on' : 'off', fontFamily: diffFontFamily(now),
        ...(compact ? { hideUnchangedRegions: { enabled: now.diffFoldUnchanged, contextLineCount: now.diffContextLines, minimumLineCount: 4 }, minimap: { enabled: false }, renderOverviewRuler: false, folding: false, glyphMargin: false, lineDecorationsWidth: 8, scrollbar: { alwaysConsumeMouseWheel: false, vertical: 'hidden' as const } } : {})
      });
      const uri = (side: string) => monaco.Uri.from({ scheme: 'diff', path: `/${side}/${path}`, query: String(Math.random()) });
      const a = monaco.editor.createModel(latest.current.original, undefined, uri('a')), b = monaco.editor.createModel(latest.current.modified, undefined, uri('b'));
      diff.setModel({ original: a, modified: b });
      live.current = { monaco, diff, a, b };
      const sized = compact ? diff.getModifiedEditor().onDidContentSizeChange(event => {
        const height = Math.min(720, Math.max(60, event.contentHeight));
        // Ignore 1px jitter: the height depends on the width (wrapping), which a scrollbar appearing in the list changes in turn.
        if (!host.current || Math.abs(height - host.current.offsetHeight) < 2) return;
        host.current.style.height = `${height}px`;
        latest.current.onHeight?.(height);
      }) : null;
      cleanup = () => { live.current = null; sized?.dispose(); diff.dispose(); a.dispose(); b.dispose(); };
    });
    return () => { disposed = true; cleanup(); };
  }, [path, compact, settings.diffFoldUnchanged, settings.diffContextLines]);
  useEffect(() => {
    const editor = live.current; if (!editor) return;
    if (editor.a.getValue() !== original) editor.a.setValue(original);
    if (editor.b.getValue() !== modified) editor.b.setValue(modified);
  }, [original, modified]);
  useEffect(() => {
    const editor = live.current; if (!editor) return;
    editor.monaco.editor.setTheme(themeName(settings.theme));
    editor.diff.updateOptions({ fontSize: settings.fontSize, wordWrap: settings.wordWrap ? 'on' : 'off', renderSideBySide: sideBySide(settings), useInlineViewWhenSpaceIsLimited: settings.diffLayout === 'auto', ignoreTrimWhitespace: settings.diffIgnoreWhitespace, maxComputationTime: settings.diffComputeMs, fontFamily: diffFontFamily(settings) });
  }, [settings.theme, settings.fontSize, settings.wordWrap, settings.diffLayout, settings.diffIgnoreWhitespace, settings.diffComputeMs, settings.diffFont, settings.terminalFont]);
  return <div className={compact ? 'editor compact-diff' : 'editor'} ref={host} />;
}
