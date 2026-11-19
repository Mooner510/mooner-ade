// What became of an answer sent from a reply's form ("바로 보내기"), so the same choice is not sent twice while it is still being handled.
// stage: pending = waiting in the composer's queue behind a running turn, working = sent and the turn is running, done = the turn that took it has ended.
// Pure and framework-free (the form subscribes through `subscribeUiSent`), so tests/ui-sent.test.mjs can load it directly. A page reload forgets it, like the form's own state.
export type UiSendStage = 'pending' | 'working' | 'done';
export type UiSend = { text: string; stage: UiSendStage; at: number; sawBusy: boolean };
export type UiSyncState = { busy: boolean; queued: string[]; sending: boolean };

export const UI_SEND_GRACE_MS = 6000; // a turn that never started (the send failed) frees the form again after this
const sends = new Map<string, UiSend>(), listeners = new Set<() => void>();
const keyOf = (chatId: string, form: string) => `${chatId}\u0000${form}`;
const emit = () => listeners.forEach(listener => listener());
const forChat = (chatId: string) => [...sends.entries()].filter(([key]) => key.startsWith(`${chatId}\u0000`));

export const subscribeUiSent = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const uiSendOf = (chatId: string, form: string): UiSend | undefined => sends.get(keyOf(chatId, form));
export const uiSendActive = (entry: UiSend | undefined) => entry?.stage === 'pending' || entry?.stage === 'working';

/** A form sends its answer. False when the same answer is already on its way: the caller must not send it again. */
export function beginUiSend(chatId: string, form: string, text: string, queued: boolean, now = Date.now()): boolean {
  const current = sends.get(keyOf(chatId, form));
  if (uiSendActive(current)) return false;
  sends.set(keyOf(chatId, form), { text, stage: queued ? 'pending' : 'working', at: now, sawBusy: false });
  emit();
  return true;
}

/** The user interrupted the turn or cleared the chat: what was still on its way is not going to be answered, so the forms are free again. */
export function releaseUiSends(chatId: string) {
  let changed = false;
  for (const [key, entry] of forChat(chatId)) if (uiSendActive(entry)) { sends.delete(key); changed = true; }
  if (changed) emit();
}

/** Follows the chat: a queued answer that left the queue by being sent is working, one that left it any other way (cancelled) is released; a working one is done once the turn it started has ended. */
export function syncUiSends(chatId: string, state: UiSyncState, now = Date.now()) {
  let changed = false;
  for (const [key, entry] of forChat(chatId)) {
    if (entry.stage === 'pending' && !state.queued.includes(entry.text)) {
      if (state.sending) { sends.set(key, { ...entry, stage: 'working', at: now }); } else sends.delete(key);
      changed = true;
    } else if (entry.stage === 'working') {
      if (state.busy && !entry.sawBusy) { sends.set(key, { ...entry, sawBusy: true }); changed = true; }
      else if (!state.busy && entry.sawBusy) { sends.set(key, { ...entry, stage: 'done' }); changed = true; }
      else if (!state.busy && !entry.sawBusy && now - entry.at >= UI_SEND_GRACE_MS) { sends.delete(key); changed = true; }
    }
  }
  if (changed) emit();
}

export const resetUiSends = () => { sends.clear(); emit(); };
