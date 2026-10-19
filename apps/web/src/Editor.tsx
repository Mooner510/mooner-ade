import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';

export type Settings = {
  theme: 'dark' | 'light'; fontSize: number; terminalFontSize: number; tabSize: number; wordWrap: boolean; minimap: boolean; dimInactivePanes: boolean; autoSave: 'off' | 'afterDelay';
  terminalFont: string; lineHeight: number; scrollback: number; cursorStyle: 'bar' | 'block' | 'underline'; cursorBlink: boolean; copyOnSelect: boolean;
  sidebarWidth: number; statusItems: string[]; notifyDone: boolean; notifyApproval: boolean; notifySound: boolean; soundDone: string; soundAttention: string; soundVolume: number; soundVolumeExtended: boolean; diffRefresh: number;
};
export const statusItemIds = ['path', 'branch', 'changes', 'terminals', 'size', 'cpu', 'memory', 'clock'] as const;
export const defaultSettings: Settings = {
  theme: 'dark', fontSize: 13, terminalFontSize: 13, tabSize: 2, wordWrap: true, minimap: false, dimInactivePanes: true, autoSave: 'off',
  terminalFont: '', lineHeight: 1.2, scrollback: 10000, cursorStyle: 'bar', cursorBlink: true, copyOnSelect: false,
  sidebarWidth: 252, statusItems: [...statusItemIds], notifyDone: true, notifyApproval: true, notifySound: true, soundDone: 'chime', soundAttention: 'alert', soundVolume: 60, soundVolumeExtended: false, diffRefresh: 3
};
export const monoFont = "'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'D2Coding', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const themeName = (theme: Settings['theme']) => theme === 'dark' ? 'ade-dark' : 'ade-light';
export type Reveal = { nonce: number; line?: number; column?: number; length?: number };
export type ModelHooks = { created(model: Monaco.editor.ITextModel, path: string): void; changed(model: Monaco.editor.ITextModel, path: string): void; disposed(model: Monaco.editor.ITextModel, path: string): void };

let monacoPromise: Promise<typeof Monaco> | null = null;
export function loadMonaco() { return monacoPromise ||= init(); }
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
  // TS/JS intelligence comes from typescript-language-server (lsp.ts); the bundled worker would duplicate it.
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

// Models are shared by every editor group; the model is the live text, App state mirrors it for dirty/save logic.
// Several projects can be open at once, so models are keyed by absolute location (root + path), never by path alone.
type Entry = { root: string; path: string; model: Monaco.editor.ITextModel };
const models = new Map<string, Entry>();
const viewStates = new Map<string, Monaco.editor.ICodeEditorViewState | null>();
const hooksByRoot = new Map<string, { root: string; hooks: ModelHooks }>();
// "C:\work\app" -> "/C:/work/app", matching how Monaco stores file URI paths.
export const rootKey = (root: string) => { const slashed = root.replace(/\\/g, '/').replace(/\/+$/, ''); return /^[a-zA-Z]:/.test(slashed) ? `/${slashed}` : slashed; };
const fold = (value: string) => /^\/[a-zA-Z]:/.test(value) ? value.toLowerCase() : value;
const modelKey = (root: string, path: string) => `${rootKey(root)}/${path}`;
const hooksOf = (root: string) => hooksByRoot.get(fold(rootKey(root)))?.hooks;
export const setModelHooks = (root: string, value: ModelHooks | null) => { if (value) hooksByRoot.set(fold(rootKey(root)), { root, hooks: value }); else hooksByRoot.delete(fold(rootKey(root))); };
export const modelEntries = (root: string): [string, Monaco.editor.ITextModel][] => [...models.values()].filter(entry => entry.root === root).map(entry => [entry.path, entry.model]);
export const getModel = (root: string, path: string) => models.get(modelKey(root, path))?.model;
export function ensureModel(monaco: typeof Monaco, root: string, path: string, value: string) {
  const key = modelKey(root, path), existing = models.get(key)?.model;
  if (existing && !existing.isDisposed()) return existing;
  const model = monaco.editor.createModel(value, undefined, monaco.Uri.file(key));
  models.set(key, { root, path, model });
  model.onDidChangeContent(() => hooksOf(root)?.changed(model, path));
  hooksOf(root)?.created(model, path);
  return model;
}
export function disposeModel(root: string, path: string) {
  const key = modelKey(root, path), entry = models.get(key); if (!entry) return;
  models.delete(key);
  for (const state of [...viewStates.keys()]) if (state.endsWith(`\0${key}`)) viewStates.delete(state);
  hooksOf(root)?.disposed(entry.model, path); entry.model.dispose();
}
// Resolves a URI to the open project that owns it; the longest matching root wins when projects are nested.
export function locate(uri: Monaco.Uri): { root: string; path: string } | null {
  const target = fold(uri.path); let best: { root: string; path: string; length: number } | null = null;
  for (const [key, { root }] of hooksByRoot) {
    if (target.startsWith(`${key}/`) && (!best || key.length > best.length)) best = { root, path: uri.path.slice(key.length + 1), length: key.length };
  }
  return best && { root: best.root, path: best.path };
}

export function focusedEditor(monaco: typeof Monaco) { return monaco.editor.getEditors().find(editor => editor.hasTextFocus()) || monaco.editor.getEditors()[0]; }

type EditorProps = { group: string; root: string; path: string; value: string; settings: Settings; onChange(path: string, value: string): void; onSave(): void; onCursor(line: number, column: number): void; onFocus(): void; reveal?: Reveal };
export function EditorView({ group, root, path, value, settings, onChange, onSave, onCursor, onFocus, reveal }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const callbacks = useRef({ onChange, onSave, onCursor, onFocus }); callbacks.current = { onChange, onSave, onCursor, onFocus };
  useEffect(() => {
    let disposed = false, created: Monaco.editor.IStandaloneCodeEditor | undefined;
    void loadMonaco().then(monaco => {
      if (disposed || !host.current) return;
      monacoRef.current = monaco;
      created = monaco.editor.create(host.current, { automaticLayout: true, model: null, scrollBeyondLastLine: false, fontFamily: monoFont, padding: { top: 8 }, renderWhitespace: 'selection', bracketPairColorization: { enabled: true }, smoothScrolling: true, cursorSmoothCaretAnimation: 'on' });
      created.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave());
      created.onDidChangeCursorPosition(event => callbacks.current.onCursor(event.position.lineNumber, event.position.column));
      created.onDidFocusEditorWidget(() => callbacks.current.onFocus());
      setEditor(created);
    });
    return () => { disposed = true; created?.dispose(); };
  }, []);
  useEffect(() => {
    const monaco = monacoRef.current; if (!editor || !monaco) return;
    const model = ensureModel(monaco, root, path, value), key = `${group}\0${modelKey(root, path)}`;
    editor.setModel(model);
    const state = viewStates.get(key); if (state) editor.restoreViewState(state);
    callbacks.current.onCursor(editor.getPosition()?.lineNumber || 1, editor.getPosition()?.column || 1);
    return () => { viewStates.set(key, editor.saveViewState()); };
  }, [editor, root, path, group]);
  useEffect(() => {
    const model = models.get(modelKey(root, path))?.model;
    if (model && !model.isDisposed() && model.getValue() !== value) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
  }, [value, root, path, editor]);
  useEffect(() => {
    if (!editor) return;
    editor.updateOptions({ fontSize: settings.fontSize, tabSize: settings.tabSize, wordWrap: settings.wordWrap ? 'on' : 'off', minimap: { enabled: settings.minimap } });
    monacoRef.current?.editor.setTheme(themeName(settings.theme));
  }, [editor, settings]);
  useEffect(() => {
    if (!editor || !reveal) return;
    if (reveal.line) {
      const position = { lineNumber: reveal.line, column: reveal.column || 1 };
      editor.setPosition(position); editor.revealPositionInCenter(position);
      if (reveal.length) editor.setSelection({ startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column + reveal.length });
    }
    editor.focus();
  }, [editor, reveal?.nonce]);
  return <div className="editor" ref={host} />;
}

// `compact` renders an inline, auto-height diff with unchanged regions folded, for the stacked code review list.
export function DiffView({ original, modified, path, settings, readOnly = true, compact = false }: { original: string; modified: string; path: string; settings: Settings; readOnly?: boolean; compact?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false, cleanup = () => {};
    void loadMonaco().then(monaco => {
      if (disposed || !host.current) return;
      monaco.editor.setTheme(themeName(settings.theme));
      const diff = monaco.editor.createDiffEditor(host.current, {
        automaticLayout: true, readOnly, originalEditable: false, renderSideBySide: !compact && host.current.clientWidth > 700, scrollBeyondLastLine: false, fontSize: settings.fontSize, fontFamily: monoFont,
        ...(compact ? { hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4 }, minimap: { enabled: false }, renderOverviewRuler: false, folding: false, glyphMargin: false, lineDecorationsWidth: 8, scrollbar: { alwaysConsumeMouseWheel: false, vertical: 'hidden' as const } } : {})
      });
      const uri = (side: string) => monaco.Uri.from({ scheme: 'diff', path: `/${side}/${path}`, query: String(Math.random()) });
      const a = monaco.editor.createModel(original, undefined, uri('a')), b = monaco.editor.createModel(modified, undefined, uri('b'));
      diff.setModel({ original: a, modified: b });
      const sized = compact ? diff.getModifiedEditor().onDidContentSizeChange(event => { if (host.current) host.current.style.height = `${Math.min(720, Math.max(60, event.contentHeight))}px`; }) : null;
      cleanup = () => { sized?.dispose(); diff.dispose(); a.dispose(); b.dispose(); };
    });
    return () => { disposed = true; cleanup(); };
  }, [original, modified, path, settings.theme, settings.fontSize, compact]);
  return <div className={compact ? 'editor compact-diff' : 'editor'} ref={host} />;
}
