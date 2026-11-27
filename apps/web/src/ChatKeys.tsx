import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type RefObject } from 'react';
import { chatKey, showCombo, type ChatKeyId } from './chat-model';
import { keyPlace, matches } from './shortcuts';
import { cardKeyAction, cardKeyAllowed, threadKeyAction, threadKeyInComposer, type CardAction, type KeyPlace, type ThreadAction } from './chat-keys';
import { discoverFor, guideParts, type GuideText } from './chat-hints';
import { Icon } from './Icon';
import './chat-keys.css';

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const FIXED: Record<string, string> = { escape: 'Esc', tab: 'Tab', enter: 'Enter' };

/** How a key named in a guide text shows: a chat key id with the user's binding, or a fixed combo ("shift+tab", "escape"). */
export function useKeyName(overrides: Record<string, string> | undefined) {
  return useCallback((name: string) => FIXED[name] ?? showCombo(name.includes('+') || /^(arrow|page|home|end|f\d)/.test(name) ? name : chatKey(overrides, name as ChatKeyId)), [overrides]);
}

/** A guide text with its keys drawn as <kbd>. */
export function GuideTextView({ text, keyName }: { text: GuideText; keyName(name: string): string }) {
  return <>{guideParts(text, keyName).map((part, index) => 'key' in part ? <kbd key={index}>{part.key}</kbd> : <span key={index}>{part.text}</span>)}</>;
}

/** The small key label inside a card button; only the card the keys act on shows them. */
export const CardKey = ({ label }: { label?: string }) => label ? <kbd className="card-key" aria-hidden="true">{label}</kbd> : null;

// The card that answers to the keys registers what each key does; the pane's listener calls it. Only one card at a time (the oldest waiting one).
export type CardActions = { allow?(): void; allowMore?(): void; more?(): void; deny?(): void; focus?(): void };
export type CardKeyLabels = Partial<Record<'allow' | 'allowMore' | 'more' | 'deny', string>>;
export type CardKeyBinding = { labels: CardKeyLabels; register(actions: MutableRefObject<CardActions>, on: boolean): void };
export function useCardBinding(binding: CardKeyBinding | undefined, actions: CardActions) {
  const ref = useRef(actions); ref.current = actions;
  useEffect(() => { if (!binding) return; binding.register(ref, true); return () => binding.register(ref, false); }, [binding]);
}

/** Where a key landed, seen from this pane (chat-keys.ts KeyPlace). */
function placeOf(target: EventTarget | null, pane: HTMLElement): KeyPlace {
  if (typeof Element === 'undefined' || !(target instanceof Element) || target === document.body || target === document.documentElement) {
    // Focus on nothing, but a dialog or palette of the app is up: the key is theirs.
    return document.querySelector('dialog[open], .quick, .tour') ? 'outside' : 'body';
  }
  if (!pane.contains(target)) return 'outside';
  const dialog = target.closest('dialog');
  if (dialog) return dialog.classList.contains('plan-modal') ? (keyPlace(target) === 'text' ? 'field' : 'modal') : 'outside';
  if (target.closest('.monaco-editor, .xterm, iframe, [popover], .menu') || keyPlace(target) !== 'other') return 'field';
  return 'pane';
}

/** The keys of a chat pane outside its message box (the box calls `onComposerKey` itself). Listens on the document so they work when focus is nowhere,
 *  as it is right after the composer steps aside for a card. Only for the pane that has focus and is on screen. */
export function usePaneKeys({ pane, active, cardId, overrides, card, onThread }: { pane: RefObject<HTMLElement | null>; active: boolean; cardId: string; overrides: Record<string, string> | undefined; card: MutableRefObject<MutableRefObject<CardActions> | null>; onThread(action: ThreadAction): void }) {
  const shownAt = useRef(0), live = useRef({ active, cardId, overrides, onThread }); live.current = { active, cardId, overrides, onThread };
  // The grace period counts from the card appearing or from this pane coming up with it, whichever is later.
  useEffect(() => { if (cardId && active) shownAt.current = Date.now(); }, [cardId, active]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { active, cardId, overrides, onThread } = live.current, root = pane.current;
      if (!active || !root || event.defaultPrevented || event.isComposing) return;
      const place = placeOf(event.target, root), is = (id: ChatKeyId) => matches(chatKey(overrides, id), event);
      const actions = cardId ? card.current?.current : undefined;
      if (actions) {
        const action = cardKeyAction(event, is);
        if (action) {
          if (place === 'field' || place === 'outside') return;
          const run = cardKeyAllowed(action, place, { now: Date.now(), shownAt: shownAt.current, repeat: event.repeat }) ? pick(actions, action) : undefined;
          // An approving key pressed too early (or held) is swallowed, so it does nothing else either.
          if (run || action === 'allow' || action === 'allowMore') { event.preventDefault(); event.stopPropagation(); }
          run?.();
          return;
        }
      }
      if (place !== 'body' && place !== 'pane') return;
      const thread = threadKeyAction(event, is);
      if (!thread || (place === 'pane' && (thread === 'pageUp' || thread === 'pageDown'))) return;
      event.preventDefault(); onThread(thread);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pane, card]);
  // The message box's own keys (called first thing from its onKeyDown): true when the key moved the conversation instead.
  return useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const { overrides, onThread } = live.current, field = event.currentTarget;
    const thread = threadKeyAction(event.nativeEvent, id => matches(chatKey(overrides, id), event.nativeEvent));
    if (!thread || !threadKeyInComposer(thread, { empty: !field.value, mac, overflow: field.scrollHeight > field.clientHeight + 1 })) return false;
    event.preventDefault(); onThread(thread); return true;
  }, []);
}
const pick = (actions: CardActions, action: CardAction) => action === 'enter' ? actions.focus : action === 'deny' ? actions.deny : actions[action];

/** The labels a card shows next to its buttons, from the user's bindings. */
export function useCardLabels(overrides: Record<string, string> | undefined): CardKeyLabels {
  return useMemo(() => ({ allow: showCombo(chatKey(overrides, 'cardAllow')), allowMore: showCombo(chatKey(overrides, 'cardAllowMore')), more: showCombo(chatKey(overrides, 'cardMore')), deny: 'Esc' }), [overrides]);
}

// "알아 두면 좋은 기능": a few lines under the start screen's buttons, about what this user has not used yet. Small, folds away (remembered per window), off with tips.
const FOLD_KEY = 'ade:discover-folded';
export function ChatDiscover({ agent, recent, keyName, onInsert }: { agent: string; recent: readonly string[]; keyName(name: string): string; onInsert(text: string): void }) {
  const [folded, setFolded] = useState(() => { try { return localStorage.getItem(FOLD_KEY) === '1'; } catch { return false; } });
  const items = discoverFor(agent, recent);
  if (!items.length) return null;
  const toggle = () => setFolded(value => { try { localStorage.setItem(FOLD_KEY, value ? '0' : '1'); } catch { /* not remembered */ } return !value; });
  return <section className="chat-discover" aria-label="알아 두면 좋은 기능">
    <button type="button" className="chat-discover-head" aria-expanded={!folded} onClick={toggle}><Icon name="info" size={13} />알아 두면 좋은 기능<Icon name={folded ? 'chevronRight' : 'chevronDown'} size={12} /></button>
    {!folded && <ul>{items.map(item => <li key={item.id}>{item.insert
      ? <button type="button" title="입력창에 넣기" onClick={() => onInsert(item.insert!)}><GuideTextView text={item.text} keyName={keyName} /></button>
      : <span><GuideTextView text={item.text} keyName={keyName} /></span>}</li>)}</ul>}
  </section>;
}
