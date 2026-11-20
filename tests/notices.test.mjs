import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotices, currentNotice, NOTICE_ORDER } from '../apps/web/src/notices.ts';

test('the notice that shows is the first in the fixed order, whatever order they asked in', () => {
  assert.equal(currentNotice([]), null);
  assert.equal(currentNotice(['hint:a', 'bg-anim', 'git', 'changelog', 'chat-mode', 'tour-hint', 'tour']), 'tour');
  assert.equal(currentNotice(['hint:a', 'bg-anim', 'git', 'chat-mode']), 'git');
  assert.deepEqual(NOTICE_ORDER, ['tour', 'changelog', 'git', 'chat-mode', 'bg-anim', 'tour-hint', 'hint'], 'the order users see: tour, update notes, Git card, Chat card, animation tip, tour pointer, button pointers');
  assert.equal(currentNotice(['mystery', 'hint:a']), 'hint:a', 'an id outside the table goes last');
  assert.equal(currentNotice(['hint:a', 'hint:b']), 'hint:a', 'pointers of two panes: the first that asked goes first');
});

test('dismissing one hands over to the next, one at a time, and listeners hear only real changes', () => {
  const notices = createNotices(), seen = [];
  notices.subscribe(() => seen.push(notices.current()));
  for (const id of ['hint:chat-1', 'bg-anim', 'git', 'changelog']) notices.want(id, true);
  notices.want('git', true); // asking again changes nothing
  assert.deepEqual(seen, ['hint:chat-1', 'bg-anim', 'git', 'changelog']);
  for (const id of ['changelog', 'git', 'bg-anim']) notices.want(id, false);
  assert.deepEqual(seen.slice(4), ['git', 'bg-anim', 'hint:chat-1'], 'update notes, then the Git card, then the tip, then the pointer');
  notices.want('hint:chat-1', false);
  assert.equal(notices.current(), null);
  notices.want('never-asked', false); // withdrawing what was never asked is harmless
  assert.equal(notices.current(), null);
});
