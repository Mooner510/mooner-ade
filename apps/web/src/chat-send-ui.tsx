// The chat composer's side of "채팅으로 보내기" and of pasting an ADE copy as a reference. Kept out of ChatPane.tsx: the pane only calls
// these two hooks, passes the paste and key events through and draws the returned notice.
import { useEffect, useRef, useState, type ClipboardEvent, type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction } from 'react';
import { formatForChat, joinDraft, pasteReference } from './chat-send';
import { lastCopyRecord, noteChatFocus, registerChat } from './send-to-chat';
// The styles of the whole feature (also the "nothing to send" note of send-to-chat.ts): here, because Editor.tsx, which reaches
// send-to-chat.ts, is bundled by tests that cannot load CSS, and every chat pane loads this file.
import './send-to-chat.css';

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** The raw-paste key as the composer shows it. */
export const rawPasteKey = mac ? '⌘⇧V' : 'Ctrl+Shift+V';

function focusEnd(box: RefObject<HTMLTextAreaElement | null>, tries = 20) {
  // Two frames: a chat in another tab becomes visible only once the workspace has rendered the tab switch. A chat that was just opened
  // keeps its composer disabled until it is ready, so it is tried again for a couple of seconds.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const field = box.current;
    if (!field || field.disabled) { if (tries > 0) setTimeout(() => focusEnd(box, tries - 1), 100); return; }
    field.focus(); const end = field.value.length; field.setSelectionRange(end, end); field.scrollTop = field.scrollHeight;
  }));
}

/** Makes this chat a place "채팅으로 보내기" can fill: `cwd` is the folder its paths are written against (the chat's own working folder). */
export function useChatSendTarget(id: string, cwd: string, setText: Dispatch<SetStateAction<string>>, box: RefObject<HTMLTextAreaElement | null>, pane: RefObject<HTMLElement | null>) {
  const cwdRef = useRef(cwd); cwdRef.current = cwd;
  useEffect(() => registerChat(id, {
    cwd: () => cwdRef.current,
    insert: text => { setText(current => joinDraft(current, text)); focusEnd(box); }
  }), [id]);
  useEffect(() => {
    const el = pane.current; if (!el) return;
    const note = () => noteChatFocus(id);
    if (el.contains(document.activeElement)) note();
    el.addEventListener('focusin', note);
    return () => el.removeEventListener('focusin', note);
  }, [id]);
}

/** Inserts at the caret like typing does, so the composer's own undo (Ctrl/⌘+Z) takes it back. */
function insertAtCaret(field: HTMLTextAreaElement, text: string) {
  field.focus();
  // execCommand keeps the native undo stack and fires the input event React listens to; the fallback only runs where it is gone.
  if (!document.execCommand('insertText', false, text)) field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end');
}

type Pasted = { start: number; inserted: string; original: string; key: number };
/**
 * A paste of text that was last copied in ADE's editor or project tree becomes a reference (`@path#lines`) instead of the text. For a few
 * seconds a notice offers the text back; Ctrl/⌘+Shift+V always pastes the text itself. `enabled` is the setting (채팅 › 입력).
 */
export function useChatPasteRefs({ enabled, box, cwd, root }: { enabled: boolean; box: RefObject<HTMLTextAreaElement | null>; cwd: string; root: string }) {
  const [pasted, setPasted] = useState<Pasted | null>(null);
  const raw = useRef(0);
  useEffect(() => { if (!pasted) return; const timer = setTimeout(() => setPasted(current => current?.key === pasted.key ? null : current), 7000); return () => clearTimeout(timer); }, [pasted]);
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (event.defaultPrevented) return; // an image the composer attached
    if (raw.current) { raw.current = 0; return; }
    if (!enabled) return;
    const text = event.clipboardData.getData('text/plain'), ref = pasteReference(lastCopyRecord(), text, Date.now());
    if (!ref) return;
    event.preventDefault();
    const field = event.currentTarget, inserted = `${formatForChat(ref, { project: root }, cwd)} `, start = field.selectionStart;
    insertAtCaret(field, inserted);
    setPasted({ start, inserted, original: text, key: Date.now() });
  };
  /** True when the key was the raw paste (the caller stops there). */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(mac ? event.metaKey : event.ctrlKey) || !event.shiftKey || event.altKey || event.code !== 'KeyV') return false;
    // The browser pastes plain text on this key; mark that paste as raw. Where it does not paste at all (macOS without a menu item for
    // it), read the clipboard ourselves.
    const mark = raw.current = Date.now(), field = event.currentTarget;
    setTimeout(() => {
      if (raw.current !== mark) return;
      raw.current = 0;
      void navigator.clipboard?.readText().then(text => { if (text) insertAtCaret(field, text); }, () => {});
    }, 120);
    return true;
  };
  const restore = () => {
    const field = box.current, item = pasted; setPasted(null);
    if (!field || !item) return;
    // Only while the reference is still where it was put; edits since then win.
    if (field.value.slice(item.start, item.start + item.inserted.length) !== item.inserted) return;
    field.focus(); field.setSelectionRange(item.start, item.start + item.inserted.length);
    insertAtCaret(field, item.original);
  };
  const notice = pasted && <p className="chat-command-args chat-paste-ref" role="status">
    <span>복사한 내용을 파일 참조로 붙여넣었습니다.</span>
    {/* mousedown keeps the focus in the composer */}
    <button type="button" onMouseDown={event => event.preventDefault()} onClick={restore}>원문으로 붙여넣기</button>
    <code>{rawPasteKey}</code>
  </p>;
  return { onPaste, onKeyDown, notice };
}
