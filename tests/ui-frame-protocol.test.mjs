import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HEIGHT, MAX_SEND, MIN_HEIGHT, parseFrameMessage, sendGate } from '../apps/web/src/ui-frame-protocol.ts';
import { UI_FRAME_CSP, UI_FRAME_HTML } from '../apps/local-server/src/ui-frame.js';
import { UI_PROMPT } from '../apps/local-server/src/chat-ui-prompt.js';

test('only well-formed messages from the frame are accepted', () => {
  assert.deepEqual(parseFrameMessage({ ade: 1, type: 'send', text: '  hi  ' }), { type: 'send', text: 'hi' });
  assert.deepEqual(parseFrameMessage({ ade: 1, type: 'prefill', text: 'a\0b' }), { type: 'prefill', text: 'ab' });
  assert.deepEqual(parseFrameMessage({ ade: 1, type: 'ready' }), { type: 'ready' });
  for (const bad of [null, 'send', {}, { type: 'send', text: 'x' }, { ade: 1, type: 'send', text: '   ' }, { ade: 1, type: 'send', text: 5 }, { ade: 1, type: 'other' }, { ade: 1, type: 'height', height: NaN }, { ade: 1, type: 'height', height: '9' }]) assert.equal(parseFrameMessage(bad), null);
});

test('send text and frame height are clamped', () => {
  assert.equal(parseFrameMessage({ ade: 1, type: 'send', text: 'x'.repeat(MAX_SEND + 50) }).text.length, MAX_SEND);
  assert.equal(parseFrameMessage({ ade: 1, type: 'height', height: 1e6 }).height, MAX_HEIGHT);
  assert.equal(parseFrameMessage({ ade: 1, type: 'height', height: 0 }).height, MIN_HEIGHT);
  assert.equal(parseFrameMessage({ ade: 1, type: 'height', height: 100.2 }).height, 101);
});

test('the send gate lets one message through per gap', () => {
  const gate = sendGate(1000);
  assert.equal(gate(5000), true); assert.equal(gate(5500), false); assert.equal(gate(6000), true);
});

test('the frame page is a closed box: scripts and styles inline, nothing else', () => {
  assert.match(UI_FRAME_CSP, /default-src 'none'/); assert.match(UI_FRAME_CSP, /connect-src 'none'/); assert.match(UI_FRAME_CSP, /sandbox allow-scripts/);
  assert.doesNotMatch(UI_FRAME_CSP, /allow-same-origin/);
  const script = /<script>([\s\S]*)<\/script>/.exec(UI_FRAME_HTML)?.[1];
  assert.ok(script); assert.doesNotThrow(() => new Function(script)); // the stringified shell and runtime are still valid JS
});

test('the agent instructions name both fences and the helpers, say when not to use them, and stay short', () => {
  for (const word of ['```ui', 'ade-ui', 'ade.send', 'ade.prefill', 'never for ordinary answers']) assert.ok(UI_PROMPT.includes(word), word);
  assert.ok(UI_PROMPT.length < 2000, `prompt is sent every turn: ${UI_PROMPT.length} chars`);
});
