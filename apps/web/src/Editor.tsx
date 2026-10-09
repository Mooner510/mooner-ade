import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';

export type Settings = { theme: 'dark' | 'light'; fontSize: number; tabSize: number; wordWrap: boolean; minimap: boolean; autoSave: 'off' | 'afterDelay' };
export const defaultSettings: Settings = { theme: 'dark', fontSize: 13, tabSize: 2, wordWrap: true, minimap: true, autoSave: 'off' };
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
  return monaco;
}

// Models are shared by every editor group; the model is the live text, App state mirrors it for dirty/save logic.
const models = new Map<string, Monaco.editor.ITextModel>();
const viewStates = new Map<string, Monaco.editor.ICodeEditorViewState | null>();
let root = '';
let hooks: ModelHooks | null = null;
export const setRoot = (value: string) => { root = value; };
export const setModelHooks = (value: ModelHooks | null) => { hooks = value; };
export const modelEntries = () => [...models];
export const getModel = (path: string) => models.get(path);
export function ensureModel(monaco: typeof Monaco, path: string, value: string) {
  let model = models.get(path);
  if (model && !model.isDisposed()) return model;
  model = monaco.editor.createModel(value, undefined, monaco.Uri.file(`${root}/${path}`));
  models.set(path, model);
  model.onDidChangeContent(() => hooks?.changed(model!, path));
  hooks?.created(model, path);
  return model;
}
export function disposeModel(path: string) {
  const model = models.get(path); if (!model) return;
  models.delete(path);
  for (const key of [...viewStates.keys()]) if (key.endsWith(`\0${path}`)) viewStates.delete(key);
  hooks?.disposed(model, path); model.dispose();
}
export const pathOf = (uri: Monaco.Uri) => uri.path.startsWith(`${root}/`) ? uri.path.slice(root.length + 1) : null;

export function focusedEditor(monaco: typeof Monaco) { return monaco.editor.getEditors().find(editor => editor.hasTextFocus()) || monaco.editor.getEditors()[0]; }

type EditorProps = { group: string; path: string; value: string; settings: Settings; onChange(path: string, value: string): void; onSave(): void; onCursor(line: number, column: number): void; onFocus(): void; reveal?: Reveal };
export function EditorView({ group, path, value, settings, onChange, onSave, onCursor, onFocus, reveal }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const callbacks = useRef({ onChange, onSave, onCursor, onFocus }); callbacks.current = { onChange, onSave, onCursor, onFocus };
  useEffect(() => {
    let disposed = false, created: Monaco.editor.IStandaloneCodeEditor | undefined;
    void loadMonaco().then(monaco => {
      if (disposed || !host.current) return;
      monacoRef.current = monaco;
      created = monaco.editor.create(host.current, { automaticLayout: true, model: null, scrollBeyondLastLine: false, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', renderWhitespace: 'selection', bracketPairColorization: { enabled: true }, smoothScrolling: true, cursorSmoothCaretAnimation: 'on' });
      created.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave());
      created.onDidChangeCursorPosition(event => callbacks.current.onCursor(event.position.lineNumber, event.position.column));
      created.onDidFocusEditorWidget(() => callbacks.current.onFocus());
      setEditor(created);
    });
    return () => { disposed = true; created?.dispose(); };
  }, []);
  useEffect(() => {
    const monaco = monacoRef.current; if (!editor || !monaco) return;
    const model = ensureModel(monaco, path, value), key = `${group}\0${path}`;
    editor.setModel(model);
    const state = viewStates.get(key); if (state) editor.restoreViewState(state);
    callbacks.current.onCursor(editor.getPosition()?.lineNumber || 1, editor.getPosition()?.column || 1);
    return () => { viewStates.set(key, editor.saveViewState()); };
  }, [editor, path, group]);
  useEffect(() => {
    const model = models.get(path);
    if (model && !model.isDisposed() && model.getValue() !== value) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
  }, [value, path, editor]);
  useEffect(() => {
    if (!editor) return;
    editor.updateOptions({ fontSize: settings.fontSize, tabSize: settings.tabSize, wordWrap: settings.wordWrap ? 'on' : 'off', minimap: { enabled: settings.minimap } });
    monacoRef.current?.editor.setTheme(settings.theme === 'dark' ? 'vs-dark' : 'vs');
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

export function DiffView({ original, modified, path, settings, readOnly = true }: { original: string; modified: string; path: string; settings: Settings; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false, cleanup = () => {};
    void loadMonaco().then(monaco => {
      if (disposed || !host.current) return;
      monaco.editor.setTheme(settings.theme === 'dark' ? 'vs-dark' : 'vs');
      const diff = monaco.editor.createDiffEditor(host.current, { automaticLayout: true, readOnly, originalEditable: false, renderSideBySide: host.current.clientWidth > 700, scrollBeyondLastLine: false, fontSize: settings.fontSize });
      const uri = (side: string) => monaco.Uri.from({ scheme: 'diff', path: `/${side}/${path}`, query: String(Math.random()) });
      const a = monaco.editor.createModel(original, undefined, uri('a')), b = monaco.editor.createModel(modified, undefined, uri('b'));
      diff.setModel({ original: a, modified: b });
      cleanup = () => { diff.dispose(); a.dispose(); b.dispose(); };
    });
    return () => { disposed = true; cleanup(); };
  }, [original, modified, path, settings.theme, settings.fontSize]);
  return <div className="editor" ref={host} />;
}
