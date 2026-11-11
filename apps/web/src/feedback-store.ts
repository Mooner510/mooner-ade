import { useSyncExternalStore } from 'react';
import { api } from './api';
import { isEditable, type Feedback, type FeedbackAvailability } from './feedback-model';

// The feedback inbox is global (not per project), so every open workspace shares this one store: the list, which item is open,
// and a pending screen capture. It loads on first use and again whenever the server pushes {type:'feedback/changed'}.
export type CaptureMode = 'element' | 'window' | 'range';
export type FeedbackState = { items: Feedback[]; available: FeedbackAvailability | null; loaded: boolean; error: string; currentId: string; capture: CaptureMode | null };

let state: FeedbackState = { items: [], available: null, loaded: false, error: '', currentId: '', capture: null };
const listeners = new Set<() => void>();
let started = false, timer = 0, loading: Promise<void> | null = null, again = false;

const set = (patch: Partial<FeedbackState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
export const feedbackState = () => state;

async function load() {
  try {
    const result = await api<{ items: Feedback[]; available: FeedbackAvailability }>('feedback/list');
    set({ items: result.items, available: result.available, loaded: true, error: '' });
  } catch (cause) { set({ loaded: true, error: cause instanceof Error ? cause.message : String(cause) }); }
}
// Every workspace receives the push, so calls within a short window share one request.
export function refreshFeedback(delay = 80): Promise<void> {
  clearTimeout(timer);
  return new Promise(resolve => {
    timer = window.setTimeout(() => {
      if (loading) { again = true; void loading.then(() => resolve()); return; }
      loading = load().finally(() => { loading = null; if (again) { again = false; void refreshFeedback(0); } });
      void loading.then(() => resolve());
    }, delay);
  });
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!started) { started = true; void refreshFeedback(0); }
  return () => { listeners.delete(listener); };
}
export const useFeedback = () => useSyncExternalStore(subscribe, feedbackState, feedbackState);

// A route answered with the updated item: show it right away, without waiting for the push.
export function applyItem(item: Feedback) {
  const exists = state.items.some(entry => entry.id === item.id);
  set({ items: exists ? state.items.map(entry => entry.id === item.id ? item : entry) : [item, ...state.items] });
  return item;
}
export const feedbackCall = async (action: string, input: object) => applyItem(await api<Feedback>(action, input));
export const openFeedback = (id: string) => set({ currentId: id });
export const removeLocal = (id: string) => set({ items: state.items.filter(item => item.id !== id), currentId: state.currentId === id ? '' : state.currentId });
export const createFeedback = async () => { const item = await feedbackCall('feedback/create', {}); openFeedback(item.id); return item; };
// The open item if it can still take images, else a fresh draft.
export async function ensureDraft() {
  const current = state.items.find(item => item.id === state.currentId);
  return current && isEditable(current) ? current : createFeedback();
}

export const requestCapture = (mode: CaptureMode) => set({ capture: mode });
export const endCapture = () => set({ capture: null });

type CaptureBridge = { capture?(rect?: { x: number; y: number; width: number; height: number }): Promise<Uint8Array>; zoomFactor?(): number };
export const desktopCapture = () => (window as unknown as { adeDesktop?: CaptureBridge }).adeDesktop;
export const canCapture = () => typeof desktopCapture()?.capture === 'function';
