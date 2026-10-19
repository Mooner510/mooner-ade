import test from 'node:test';
import assert from 'node:assert/strict';
import { playSound } from '../apps/web/src/sound.ts';

test('notification audio doubles its gain at 200% and caps amplification there', t => {
  const peaks = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'AudioContext', original); else delete globalThis.AudioContext; });
  globalThis.AudioContext = class {
    currentTime = 0;
    destination = {};
    createOscillator() { return { frequency: {}, connect() {}, start() {}, stop() {} }; }
    createGain() {
      return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime(value) { if (value > 0.0001) peaks.push(value); } } };
    }
    close() { return Promise.resolve(); }
  };
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); });
  for (const volume of [100, 150, 200, 250]) playSound('ding', volume);
  assert.deepEqual(peaks, [0.25, 0.375, 0.5, 0.5]);
  for (const [id, volume] of [['ding', 0], ['ding', -1], ['none', 200], ['unknown', 200]]) playSound(id, volume);
  assert.equal(peaks.length, 4);
});
