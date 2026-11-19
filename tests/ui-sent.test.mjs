import test from 'node:test';
import assert from 'node:assert/strict';
import { beginUiSend, releaseUiSends, resetUiSends, subscribeUiSent, syncUiSends, uiSendActive, uiSendOf, UI_SEND_GRACE_MS } from '../apps/web/src/ui-sent.ts';

const idle = { busy: false, queued: [], sending: false }, busy = { busy: true, queued: [], sending: false };
test.beforeEach(() => resetUiSends());

test('a form answer is sent once: a second click while it is on its way is refused, and done keeps it that way', () => {
  assert.equal(beginUiSend('c', 'f', 'A', false, 0), true);
  assert.equal(uiSendOf('c', 'f').stage, 'working');
  assert.equal(beginUiSend('c', 'f', 'A', false, 1), false, 'same form, still working');
  assert.equal(beginUiSend('c', 'f', 'B', false, 1), false, 'another answer of the same form waits for the first too');
  assert.equal(beginUiSend('c', 'other', 'A', false, 1), true, 'a different form is its own');
  assert.equal(beginUiSend('d', 'f', 'A', false, 1), true, 'and so is the same form in another chat');
  syncUiSends('c', busy); // the turn started
  assert.equal(uiSendOf('c', 'f').stage, 'working');
  syncUiSends('c', idle); // the turn ended
  assert.equal(uiSendOf('c', 'f').stage, 'done');
  assert.equal(uiSendActive(uiSendOf('c', 'f')), false);
});

test('an answer that had to queue behind a running turn is pending, then working once it is sent, and is freed when the user cancels it', () => {
  beginUiSend('c', 'f', 'A', true, 0);
  assert.equal(uiSendOf('c', 'f').stage, 'pending');
  syncUiSends('c', { busy: true, queued: ['A'], sending: false });
  assert.equal(uiSendOf('c', 'f').stage, 'pending', 'still in the queue');
  syncUiSends('c', { busy: false, queued: [], sending: true }); // the queue handed it to the chat
  assert.equal(uiSendOf('c', 'f').stage, 'working');
  beginUiSend('c', 'g', 'B', true, 0);
  syncUiSends('c', { busy: true, queued: [], sending: false }); // gone from the queue without being sent: cancelled
  assert.equal(uiSendOf('c', 'g'), undefined);
});

test('interrupting or clearing frees what was on its way, but not what is done', () => {
  beginUiSend('c', 'a', 'A', false, 0); syncUiSends('c', busy); syncUiSends('c', idle);
  beginUiSend('c', 'b', 'B', false, 0); beginUiSend('c', 'q', 'Q', true, 0);
  releaseUiSends('c');
  assert.equal(uiSendOf('c', 'a').stage, 'done');
  assert.equal(uiSendOf('c', 'b'), undefined);
  assert.equal(uiSendOf('c', 'q'), undefined);
  assert.equal(beginUiSend('c', 'b', 'B', false, 1), true, 'the same choice can be made again after the interrupt');
});

test('a send that never started a turn frees the form after a grace period', () => {
  beginUiSend('c', 'f', 'A', false, 0);
  syncUiSends('c', idle, UI_SEND_GRACE_MS - 1);
  assert.equal(uiSendOf('c', 'f').stage, 'working');
  syncUiSends('c', idle, UI_SEND_GRACE_MS);
  assert.equal(uiSendOf('c', 'f'), undefined);
});

test('listeners hear every change and stop after unsubscribing', () => {
  let heard = 0; const off = subscribeUiSent(() => { heard += 1; });
  beginUiSend('c', 'f', 'A', false, 0); syncUiSends('c', busy); syncUiSends('c', idle);
  assert.equal(heard, 3);
  off(); releaseUiSends('c'); beginUiSend('c', 'z', 'Z', false, 0);
  assert.equal(heard, 3);
});
