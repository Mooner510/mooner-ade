import { useEffect, useRef } from 'react';
import type * as Monaco from 'monaco-editor';

export type Settings = {
  theme: 'dark' | 'light'; fontSize: number; terminalFontSize: number; wordWrap: boolean; dimInactivePanes: boolean;
  terminalFont: string; lineHeight: number; scrollback: number; cursorStyle: 'bar' | 'block' | 'underline'; cursorBlink: boolean; copyOnSelect: boolean;
  sidebarWidth: number; statusItems: string[]; statusLeft: string[]; statusRight: string[]; usageColors: boolean; notifyDone: boolean; notifyApproval: boolean; notifySound: boolean; soundDone: string; soundAttention: string; soundVolume: number; soundVolumeExtended: boolean; diffRefresh: number; wakatime: boolean; wakatimeBackground: boolean;
  terminalShell: string; claudeSession: boolean;
};
// statusItems is the shown set; statusLeft/statusRight hold every item's side and order, shown or not, so hiding one keeps its place.
const defaultLeft = ['connection', 'path', 'branch', 'changes'], defaultRight = ['terminals', 'size', 'cpu', 'memory', 'claudeusage', 'codexusage', 'wakatime', 'clock', 'readiness', 'openproject'];
export const statusItemIds = [...defaultLeft, ...defaultRight];
// Items that were fixed or did not exist before the layout could be edited; saved settings from then get them shown.
const addedWithLayout = ['connection', 'readiness', 'openproject', 'claudeusage', 'codexusage'];
export function statusLayout(settings: Pick<Settings, 'statusLeft' | 'statusRight'>) {
  const known = new Set(statusItemIds), seen = new Set<string>();
  const keep = (list: string[] = []) => list.filter(id => known.has(id) && !seen.has(id) && seen.add(id));
  const left = keep(settings.statusLeft), right = keep(settings.statusRight);
  for (const id of statusItemIds) if (!seen.has(id)) (defaultLeft.includes(id) ? left : right).push(id);
  return { left, right };
}
// Green at 0% through yellow to red at 100%, like Claude Code's statusline; the theme picks the lightness.
export const usageHue = (percent: number) => Math.round(120 * (1 - Math.max(0, Math.min(100, percent)) / 100));
export function migrateSettings(saved: Partial<Settings>): Settings {
  const next = { ...defaultSettings, ...saved };
  if (saved.statusItems && !saved.statusLeft) next.statusItems = [...saved.statusItems.filter(id => !addedWithLayout.includes(id)), ...addedWithLayout];
  return next;
}
export const defaultSettings: Settings = {
  theme: 'dark', fontSize: 13, terminalFontSize: 13, wordWrap: true, dimInactivePanes: true,
  terminalFont: '', lineHeight: 1.2, scrollback: 10000, cursorStyle: 'bar', cursorBlink: true, copyOnSelect: false,
  sidebarWidth: 252, statusItems: [...statusItemIds], statusLeft: defaultLeft, statusRight: defaultRight, usageColors: true, notifyDone: true, notifyApproval: true, notifySound: true, soundDone: 'marimba', soundAttention: 'alert', soundVolume: 60, soundVolumeExtended: false, diffRefresh: 3, wakatime: false, wakatimeBackground: true, terminalShell: '', claudeSession: true
};
export const monoFont = "'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'D2Coding', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
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

// `compact` renders an inline, auto-height diff with unchanged regions folded, for the stacked code review list.
export function DiffView({ original, modified, path, settings, compact = false }: { original: string; modified: string; path: string; settings: Settings; compact?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false, cleanup = () => {};
    void loadMonaco().then(monaco => {
      if (disposed || !host.current) return;
      monaco.editor.setTheme(themeName(settings.theme));
      const diff = monaco.editor.createDiffEditor(host.current, {
        automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: !compact && host.current.clientWidth > 700, scrollBeyondLastLine: false, fontSize: settings.fontSize, wordWrap: settings.wordWrap ? 'on' : 'off', fontFamily: monoFont,
        ...(compact ? { hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4 }, minimap: { enabled: false }, renderOverviewRuler: false, folding: false, glyphMargin: false, lineDecorationsWidth: 8, scrollbar: { alwaysConsumeMouseWheel: false, vertical: 'hidden' as const } } : {})
      });
      const uri = (side: string) => monaco.Uri.from({ scheme: 'diff', path: `/${side}/${path}`, query: String(Math.random()) });
      const a = monaco.editor.createModel(original, undefined, uri('a')), b = monaco.editor.createModel(modified, undefined, uri('b'));
      diff.setModel({ original: a, modified: b });
      const sized = compact ? diff.getModifiedEditor().onDidContentSizeChange(event => { if (host.current) host.current.style.height = `${Math.min(720, Math.max(60, event.contentHeight))}px`; }) : null;
      cleanup = () => { sized?.dispose(); diff.dispose(); a.dispose(); b.dispose(); };
    });
    return () => { disposed = true; cleanup(); };
  }, [original, modified, path, settings.theme, settings.fontSize, settings.wordWrap, compact]);
  return <div className={compact ? 'editor compact-diff' : 'editor'} ref={host} />;
}
