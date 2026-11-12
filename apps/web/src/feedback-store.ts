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

// Browser capture (no desktop bridge): the browser's own screen-share of this tab. The share starts first and the region is picked afterwards:
// starting it adds the browser's "sharing this tab" bar, which shrinks the viewport and rescales the frame, so coordinates picked before the
// share would no longer match what the frame shows. The browser asks permission each time. If the user shares something other than this tab,
// the whole frame is kept.
export type CaptureRect = { x: number; y: number; width: number; height: number };
export type BrowserShare = { grab(rect?: CaptureRect): Promise<Uint8Array>; stop(): void };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// The frame is usable once the video and the viewport have kept their size for a moment (the share bar and the rescale land over a few hundred ms).
async function settle(video: HTMLVideoElement) {
  const size = () => `${video.videoWidth}x${video.videoHeight}/${innerWidth}x${innerHeight}`;
  let last = '', same = 0;
  for (let i = 0; i < 30 && same < 3; i++) { await pause(100); const now = size(); same = now === last ? same + 1 : 0; last = now; }
}
export async function openBrowserShare(onEnded: () => void): Promise<BrowserShare> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' } as DisplayMediaStreamOptions);
  const stop = () => stream.getTracks().forEach(track => track.stop());
  try {
    const track = stream.getVideoTracks()[0], video = document.createElement('video');
    track?.addEventListener('ended', onEnded); // the user pressed the browser's "Stop sharing" while picking
    video.muted = true; video.srcObject = stream; await video.play(); await settle(video);
    return {
      stop,
      async grab(rect) {
        try {
          await settle(video); // also long enough for the picking overlay to leave the frame
          const scale = video.videoWidth / innerWidth, ownTab = track?.getSettings().displaySurface === 'browser';
          const crop = rect && ownTab ? { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale } : { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
          const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(crop.width)); canvas.height = Math.max(1, Math.round(crop.height));
          canvas.getContext('2d')!.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
          if (!blob) throw new Error('화면을 이미지로 만들지 못했습니다.');
          return new Uint8Array(await blob.arrayBuffer());
        } finally { stop(); }
      }
    };
  } catch (cause) { stop(); throw cause; }
}
