import test from 'node:test';
import assert from 'node:assert/strict';
import { USER_MESSAGE_CLIP_HEIGHT_PX, userMessageExceedsClipHeight } from '../apps/web/src/user-message-limit.ts';

test('a user message clips when its natural box height reaches 525px', () => {
  assert.equal(USER_MESSAGE_CLIP_HEIGHT_PX, 525);
  assert.equal(userMessageExceedsClipHeight(524.9), false);
  assert.equal(userMessageExceedsClipHeight(525), true);
  assert.equal(userMessageExceedsClipHeight(900), true);
});