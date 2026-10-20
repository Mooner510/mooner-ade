// Built-in notification sounds, synthesized so the app ships no audio files. Each note is [frequency Hz, start s, length s, glide-to Hz?].
type Note = [number, number, number] | [number, number, number, number];
type Sound = { label: string; wave: OscillatorType; tail: number; notes: Note[] };
export const sounds = {
  chime: { label: '차임', wave: 'sine', tail: 0, notes: [[660, 0, 0.16], [880, 0.16, 0.16]] },
  alert: { label: '경보', wave: 'sine', tail: 0, notes: [[880, 0, 0.16], [660, 0.16, 0.16], [880, 0.32, 0.16]] },
  ding: { label: '딩', wave: 'sine', tail: 0.5, notes: [[1046, 0, 0.1]] },
  bell: { label: '벨', wave: 'triangle', tail: 0.8, notes: [[1318, 0, 0.1], [1760, 0.02, 0.1]] },
  marimba: { label: '마림바', wave: 'triangle', tail: 0.2, notes: [[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.12]] },
  pop: { label: '팝', wave: 'sine', tail: 0, notes: [[400, 0, 0.07], [800, 0.07, 0.07]] },
  beep: { label: '삑', wave: 'square', tail: 0, notes: [[880, 0, 0.1], [880, 0.18, 0.1]] },
  coin: { label: '코인', wave: 'square', tail: 0, notes: [[988, 0, 0.07], [1319, 0.07, 0.28]] },
  powerUp: { label: '파워업', wave: 'square', tail: 0, notes: [[392, 0, 0.07, 523], [523, 0.07, 0.07, 659], [659, 0.14, 0.07, 784], [784, 0.21, 0.14, 1046]] },
  laser: { label: '레이저', wave: 'sawtooth', tail: 0, notes: [[1800, 0, 0.18, 220]] },
  droplet: { label: '물방울', wave: 'sine', tail: 0, notes: [[500, 0, 0.08, 1400], [700, 0.14, 0.06, 1800]] },
  whistle: { label: '휘파람', wave: 'sine', tail: 0, notes: [[900, 0, 0.18, 1600], [1200, 0.24, 0.24, 1700]] },
  boing: { label: '뿅', wave: 'triangle', tail: 0.05, notes: [[1200, 0, 0.25, 180]] },
  ufo: { label: 'UFO', wave: 'sine', tail: 0, notes: [[600, 0, 0.1, 900], [900, 0.1, 0.1, 600], [600, 0.2, 0.1, 900], [900, 0.3, 0.1, 600], [600, 0.4, 0.15, 1200]] },
  robot: { label: '로봇', wave: 'square', tail: 0, notes: [[220, 0, 0.06], [330, 0.08, 0.06], [165, 0.16, 0.06], [440, 0.24, 0.1, 220]] },
  harp: { label: '하프', wave: 'triangle', tail: 0.6, notes: [[523, 0, 0.05], [587, 0.04, 0.05], [659, 0.08, 0.05], [784, 0.12, 0.05], [880, 0.16, 0.05], [1046, 0.2, 0.08]] },
  sonar: { label: '소나', wave: 'sine', tail: 1.2, notes: [[1480, 0, 0.06], [1480, 0.5, 0.04]] },
  frog: { label: '개굴', wave: 'sawtooth', tail: 0, notes: [[260, 0, 0.09, 140], [280, 0.14, 0.12, 120]] },
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
    for (const [frequency, at, length, glide] of sound.notes) {
      const osc = context.createOscillator(), gain = context.createGain(), start = context.currentTime + at, stop = start + length + sound.tail;
      osc.frequency.value = frequency; osc.type = sound.wave; osc.connect(gain); gain.connect(context.destination);
      gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), start + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, stop - 0.01);
      if (glide) { osc.frequency.setValueAtTime(frequency, start); osc.frequency.exponentialRampToValueAtTime(glide, start + length); }
      osc.start(start); osc.stop(stop); end = Math.max(end, at + length + sound.tail);
    }
    setTimeout(() => void context.close(), end * 1000 + 300);
  } catch { /* audio blocked or unavailable */ }
}
