// "채팅으로 보내기" in the ADE editor and the diff views (Monaco): a context-menu entry, the selection as a send source, and (file editor
// only) copies remembered so a chat can paste them as a reference. Editor.tsx calls these once per editor it creates.
import type * as Monaco from 'monaco-editor';
import { changedRanges, copyIsReference, selectionLines, unifiedPatch, type SendPayload, type SourcePath } from './chat-send';
import { recordCopy, registerSendSource, requestSendToChat, type SendGet } from './send-to-chat';

const ACTION = { id: 'ade.sendToChat', label: '채팅으로 보내기', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 9 };

/** The file editor: the selection as `@path#lines` (no selection: the file). Copy and cut of whole lines are remembered for the chat's paste. */
export function wireFileEditor(editor: Monaco.editor.IStandaloneCodeEditor, host: HTMLElement, path: string): () => void {
  const file: SourcePath = { path, base: 'project' };
  const read: SendGet = () => {
    const selection = editor.getSelection();
    return selection && !selection.isEmpty() ? { kind: 'file', file, range: selectionLines(selection) } : { kind: 'file', file };
  };
  const action = editor.addAction({ ...ACTION, run: () => requestSendToChat(read) });
  const off = registerSendSource(host, read);
  // Bubble phase: Monaco's own handler on its textarea has already put the text on the event.
  const onCopy = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain'), selections = editor.getSelections() ?? [];
    // Several cursors copy scattered pieces; those paste as text.
    if (!text || selections.length !== 1) return;
    const selection = selections[0], wholeLine = selection.isEmpty(); // with no selection Monaco copies the whole line
    if (!copyIsReference(text, wholeLine)) return;
    recordCopy(text, { kind: 'file', file, range: wholeLine ? { start: selection.startLineNumber, end: selection.startLineNumber } : selectionLines(selection) });
  };
  host.addEventListener('copy', onCopy); host.addEventListener('cut', onCopy);
  return () => { action.dispose(); off(); host.removeEventListener('copy', onCopy); host.removeEventListener('cut', onCopy); };
}

/** What a diff view knows about where it came from: the file (relative to the Git repository, or absolute) and the revision of a Git diff. */
export type DiffSend = { file: SourcePath; rev?: string };
/** A diff view: the selected lines of either side, else the whole change as a patch (or by location when it is long). */
export function wireDiffEditor(diff: Monaco.editor.IStandaloneDiffEditor, host: HTMLElement, send: () => DiffSend | undefined): () => void {
  let side: 'original' | 'modified' = 'modified';
  const focusOriginal = diff.getOriginalEditor().onDidFocusEditorText(() => { side = 'original'; });
  const focusModified = diff.getModifiedEditor().onDidFocusEditorText(() => { side = 'modified'; });
  const read: SendGet = (): SendPayload | null => {
    const source = send(), original = diff.getOriginalEditor(), modified = diff.getModifiedEditor();
    const a = original.getModel(), b = modified.getModel();
    if (!source || !a || !b) return null;
    const editor = side === 'original' ? original : modified, selection = editor.getSelection(), model = side === 'original' ? a : b;
    if (selection && !selection.isEmpty()) return { kind: 'diff', file: source.file, rev: source.rev, patch: '', ranges: [], selection: { text: model.getValueInRange(selection), range: selectionLines(selection), side } };
    const changes = diff.getLineChanges() ?? [];
    // The patch header names the file the way Git does; an agent's edit (absolute path) is named by its file name, the message mentions the path.
    const patch = unifiedPatch(source.file.base === 'abs' ? source.file.path.replace(/\\/g, '/').split('/').pop()! : source.file.path, a.getValue(), b.getValue(), changes);
    return patch ? { kind: 'diff', file: source.file, rev: source.rev, patch, ranges: changedRanges(changes) } : null;
  };
  const actions = [diff.getOriginalEditor(), diff.getModifiedEditor()].map(editor => editor.addAction({ ...ACTION, run: () => requestSendToChat(read) }));
  const off = registerSendSource(host, read, '바뀐 내용이 없어 보낼 diff가 없습니다.');
  return () => { focusOriginal.dispose(); focusModified.dispose(); actions.forEach(action => action.dispose()); off(); };
}
