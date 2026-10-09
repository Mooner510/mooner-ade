import type * as Monaco from 'monaco-editor';
import { getModel, modelEntries, pathOf } from './Editor';

export type Diagnostic = { severity: 1 | 2 | 3 | 4; message: string; line: number; column: number; endLine: number; endColumn: number; source?: string };
type Hooks = { diagnostics(path: string, items: Diagnostic[]): void; open(path: string, line: number, column: number): void };
const LANGUAGES = new Set(['typescript', 'javascript']);
const languageId = (path: string) => ({ ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact' } as Record<string, string>)[path.split('.').pop() || ''] || 'javascript';
// LSP and Monaco kinds share order but are offset/differently named; map by name for completion items.
const completionKinds = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'] as const;
const markdown = (value: any): Monaco.IMarkdownString[] => (Array.isArray(value) ? value : [value]).filter(Boolean).map(item => ({ value: typeof item === 'string' ? item : item.language ? `\`\`\`${item.language}\n${item.value}\n\`\`\`` : item.value }));

export function attachLsp(monaco: typeof Monaco, send: (message: object) => void, root: string, hooks: Hooks) {
  let nextId = 0, disposed = false;
  const pending = new Map<number, (result: any) => void>(), versions = new Map<string, number>();
  const rootUri = monaco.Uri.file(root).toString();
  const post = (message: object) => { if (!disposed) send({ jsonrpc: '2.0', ...message }); };
  const request = (method: string, params: object) => new Promise<any>(resolve => { const id = ++nextId; pending.set(id, resolve); post({ id, method, params }); setTimeout(() => { if (pending.delete(id)) resolve(null); }, 15000); });
  const notify = (method: string, params: object) => post({ method, params });
  const uri = (model: Monaco.editor.ITextModel) => model.uri.toString();
  const range = (r: any): Monaco.IRange => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 });
  const position = (p: Monaco.Position) => ({ line: p.lineNumber - 1, character: p.column - 1 });
  const tracked = (model: Monaco.editor.ITextModel) => LANGUAGES.has(model.getLanguageId()) && model.uri.scheme === 'file';

  const ready = request('initialize', { processId: null, rootUri, workspaceFolders: [{ uri: rootUri, name: 'workspace' }], capabilities: { textDocument: { synchronization: { didSave: false }, completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } }, hover: { contentFormat: ['markdown', 'plaintext'] }, definition: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, publishDiagnostics: {} }, workspace: { configuration: true } } }).then(() => notify('initialized', {}));
  const sync = {
    open(model: Monaco.editor.ITextModel, path: string) { if (!tracked(model)) return; versions.set(uri(model), 1); void ready.then(() => notify('textDocument/didOpen', { textDocument: { uri: uri(model), languageId: languageId(path), version: 1, text: model.getValue() } })); },
    change(model: Monaco.editor.ITextModel) { if (!tracked(model) || !versions.has(uri(model))) return; const version = versions.get(uri(model))! + 1; versions.set(uri(model), version); void ready.then(() => notify('textDocument/didChange', { textDocument: { uri: uri(model), version }, contentChanges: [{ text: model.getValue() }] })); },
    close(model: Monaco.editor.ITextModel, path: string) { if (!versions.delete(uri(model))) return; notify('textDocument/didClose', { textDocument: { uri: uri(model) } }); hooks.diagnostics(path, []); monaco.editor.setModelMarkers(model, 'lsp', []); }
  };
  for (const [path, model] of modelEntries()) sync.open(model, path);

  const providers = [...LANGUAGES].flatMap(language => [
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.', '"', "'", '/', '@', '<'],
      async provideCompletionItems(model, at) {
        const result = await request('textDocument/completion', { textDocument: { uri: uri(model) }, position: position(at) });
        const items: any[] = Array.isArray(result) ? result : result?.items || [];
        const word = model.getWordUntilPosition(at), fallback = { startLineNumber: at.lineNumber, endLineNumber: at.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        return { incomplete: Boolean(result?.isIncomplete), suggestions: items.map(item => ({
          label: item.label, kind: monaco.languages.CompletionItemKind[completionKinds[(item.kind || 1) - 1] || 'Text'], detail: item.detail, sortText: item.sortText, filterText: item.filterText,
          documentation: item.documentation ? markdown(item.documentation)[0] : undefined,
          insertText: item.textEdit?.newText ?? item.insertText ?? item.label, insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range: item.textEdit?.range ? range(item.textEdit.range) : item.textEdit?.replace ? range(item.textEdit.replace) : fallback
        })) };
      }
    }),
    monaco.languages.registerHoverProvider(language, {
      async provideHover(model, at) {
        const result = await request('textDocument/hover', { textDocument: { uri: uri(model) }, position: position(at) });
        return result?.contents ? { contents: markdown(result.contents), range: result.range ? range(result.range) : undefined } : null;
      }
    }),
    monaco.languages.registerDefinitionProvider(language, {
      async provideDefinition(model, at) {
        const result = await request('textDocument/definition', { textDocument: { uri: uri(model) }, position: position(at) });
        return ([] as any[]).concat(result || []).map(item => ({ uri: monaco.Uri.parse(item.uri || item.targetUri), range: range(item.range || item.targetSelectionRange) }));
      }
    }),
    monaco.languages.registerDocumentSymbolProvider(language, {
      async provideDocumentSymbols(model) {
        const result: any[] = await request('textDocument/documentSymbol', { textDocument: { uri: uri(model) } }) || [];
        const convert = (item: any): Monaco.languages.DocumentSymbol => ({ name: item.name, detail: item.detail || '', kind: item.kind - 1, tags: [], range: range(item.range || item.location.range), selectionRange: range(item.selectionRange || item.range || item.location.range), children: (item.children || []).map(convert) });
        return result.map(convert);
      }
    })
  ]);
  const opener = monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selection) {
      const path = pathOf(resource); if (!path) return false;
      const target = selection && 'startLineNumber' in selection ? { line: selection.startLineNumber, column: selection.startColumn } : selection ? { line: selection.lineNumber, column: selection.column } : { line: 1, column: 1 };
      hooks.open(path, target.line, target.column); return true;
    }
  });

  function handle(message: any) {
    if (message.id !== undefined && !message.method) { const resolve = pending.get(message.id); pending.delete(message.id); resolve?.(message.result ?? null); return; }
    if (message.method === 'textDocument/publishDiagnostics') {
      const path = pathOf(monaco.Uri.parse(message.params.uri)); if (!path) return;
      const items: Diagnostic[] = message.params.diagnostics.map((item: any) => ({ severity: item.severity || 1, message: item.message, line: item.range.start.line + 1, column: item.range.start.character + 1, endLine: item.range.end.line + 1, endColumn: item.range.end.character + 1, source: item.source }));
      const model = getModel(path);
      if (model) monaco.editor.setModelMarkers(model, 'lsp', items.map(item => ({ severity: ({ 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint })[item.severity], message: item.message, source: item.source, startLineNumber: item.line, startColumn: item.column, endLineNumber: item.endLine, endColumn: item.endColumn })));
      hooks.diagnostics(path, items); return;
    }
    // Server-to-client requests must be answered or tsserver stalls waiting for them.
    if (message.id !== undefined && message.method) post({ id: message.id, result: message.method === 'workspace/configuration' ? (message.params.items || []).map(() => null) : null });
  }
  return { handle, sync, dispose() { disposed = true; providers.forEach(provider => provider.dispose()); opener.dispose(); pending.clear(); } };
}
export type Lsp = ReturnType<typeof attachLsp>;
