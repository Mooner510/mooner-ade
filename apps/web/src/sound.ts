// Built-in notification sounds, synthesized so the app ships no audio files. Each note is [frequency Hz, start s, length s].
type Sound = { label: string; wave: OscillatorType; tail: number; notes: [number, number, number][] };
export const sounds = {
  chime: { label: '차임', wave: 'sine', tail: 0, notes: [[660, 0, 0.16], [880, 0.16, 0.16]] },
  alert: { label: '경보', wave: 'sine', tail: 0, notes: [[880, 0, 0.16], [660, 0.16, 0.16], [880, 0.32, 0.16]] },
  ding: { label: '딩', wave: 'sine', tail: 0.5, notes: [[1046, 0, 0.1]] },
  bell: { label: '벨', wave: 'triangle', tail: 0.8, notes: [[1318, 0, 0.1], [1760, 0.02, 0.1]] },
  marimba: { label: '마림바', wave: 'triangle', tail: 0.2, notes: [[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.12]] },
  pop: { label: '팝', wave: 'sine', tail: 0, notes: [[400, 0, 0.07], [800, 0.07, 0.07]] },
  beep: { label: '삑', wave: 'square', tail: 0, notes: [[880, 0, 0.1], [880, 0.18, 0.1]] },
  none: { label: '소리 없음', wave: 'sine', tail: 0, notes: [] }
} satisfies Record<string, Sound>;
export type SoundId = keyof typeof sounds;
export const soundIds = Object.keys(sounds) as SoundId[];
export const isSoundId = (value: unknown): value is SoundId => typeof value === 'string' && value in sounds;

// `volume` is 0–200. Audio can be blocked until the page has been interacted with, so failures are ignored.
export function playSound(id: string, volume: number) {
  const sound: Sound | undefined = isSoundId(id) ? sounds[id] : undefined;
  if (!sound || !sound.notes.length || volume <= 0) return;
  try {
    const context = new AudioContext(), peak = 0.25 * Math.min(volume, 200) / 100;
    let end = 0;
    for (const [frequency, at, length] of sound.notes) {
      const osc = context.createOscillator(), gain = context.createGain(), start = context.currentTime + at, stop = start + length + sound.tail;
      osc.frequency.value = frequency; osc.type = sound.wave; osc.connect(gain); gain.connect(context.destination);
      gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), start + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, stop - 0.01);
      osc.start(start); osc.stop(stop); end = Math.max(end, at + length + sound.tail);
    }
    setTimeout(() => void context.close(), end * 1000 + 300);
  } catch { /* audio blocked or unavailable */ }
}
