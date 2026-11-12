import { useSyncExternalStore } from 'react';
import { api } from './api';
import { isEditable, type Feedback, type FeedbackAvailability, type FeedbackQueue } from './feedback-model';

// The feedback inbox is global (not per project), so every open workspace shares this one store: the list, which item is open,
// and a pending screen capture. It loads on first use and again whenever the server pushes {type:'feedback/changed'}.
export type CaptureMode = 'element' | 'window' | 'range';
export type FeedbackState = { items: Feedback[]; available: FeedbackAvailability | null; queue: FeedbackQueue; loaded: boolean; error: string; currentId: string; capture: CaptureMode | null };

let state: FeedbackState = { items: [], available: null, queue: { size: 0 }, loaded: false, error: '', currentId: '', capture: null };
const listeners = new Set<() => void>();
let started = false, timer = 0, loading: Promise<void> | null = null, again = false;

const set = (patch: Partial<FeedbackState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
export const feedbackState = () => state;

async function load() {
  try {
    const result = await api<{ items: Feedback[]; available: FeedbackAvailability; queue?: FeedbackQueue }>('feedback/list');
    set({ items: result.items, available: result.available, queue: result.queue ?? { size: 0 }, loaded: true, error: '' });
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
export const createFeedback = async () => { const item = await feedbackCall('feedback/create', {}); set({ currentId: item.id }); return item; };
// The open item if it can still take images, else a fresh draft.
export async function ensureDraft() {
  const current = state.items.find(item => item.id === state.currentId);
  return current && isEditable(current) ? current : createFeedback();
}

// Re-renders every 30 s while something is queued, so "약 n분 뒤 전송" counts down.
let clockTimer = 0;
const clockListeners = new Set<() => void>();
function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  if (!clockTimer) clockTimer = window.setInterval(() => clockListeners.forEach(fn => fn()), 30_000);
  return () => { clockListeners.delete(listener); if (!clockListeners.size) { clearInterval(clockTimer); clockTimer = 0; } };
}
const noClock = () => () => {};
export function useQueueClock(on: boolean) {
  return useSyncExternalStore(on ? subscribeClock : noClock, () => on ? Math.floor(Date.now() / 30_000) * 30_000 : 0) || Date.now();
}

export const requestCapture = (mode: CaptureMode) => set({ capture: mode });
export const endCapture = () => set({ capture: null });

type CaptureBridge = { capture?(rect?: { x: number; y: number; width: number; height: number }): Promise<Uint8Array>; zoomFactor?(): number };
export const desktopCapture = () => (window as unknown as { adeDesktop?: CaptureBridge }).adeDesktop;
const hasDisplayMedia = () => typeof navigator.mediaDevices?.getDisplayMedia === 'function';
export const canCapture = () => typeof desktopCapture()?.capture === 'function' || hasDisplayMedia();

// Browser capture (no desktop bridge): the browser's own screen-share of this tab, one frame, cropped to `rect` (CSS px).
// The browser asks permission each time. If the user shares something other than this tab, the whole frame is kept.
// ponytail: the crop assumes the shared frame is exactly this viewport; a browser that shifts the page (share banner) crops slightly off.
export async function browserCapture(rect?: { x: number; y: number; width: number; height: number }): Promise<Uint8Array> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement('video'); video.muted = true; video.srcObject = stream; await video.play();
    await new Promise(resolve => setTimeout(resolve, 500)); // lets the share dialog fade out of the frame
    const scale = video.videoWidth / innerWidth, ownTab = stream.getVideoTracks()[0]?.getSettings().displaySurface === 'browser';
    const crop = rect && ownTab ? { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale } : { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(crop.width)); canvas.height = Math.max(1, Math.round(crop.height));
    canvas.getContext('2d')!.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('화면을 이미지로 만들지 못했습니다.');
    return new Uint8Array(await blob.arrayBuffer());
  } finally { stream.getTracks().forEach(track => track.stop()); }
}
