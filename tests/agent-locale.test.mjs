import test from 'node:test';
import assert from 'node:assert/strict';
import { withUtf8Ctype } from '../apps/local-server/src/chat.js';

test('on Windows an agent with no locale gets a UTF-8 LC_CTYPE, so Git Bash tools print non-ASCII names as text', () => {
  assert.equal(withUtf8Ctype({}, 'win32').LC_CTYPE, 'C.UTF-8');
  assert.equal(withUtf8Ctype({}, 'win32').LANG, undefined); // message language untouched
});

test('a locale the user already set, or another platform, is left alone', () => {
  assert.deepEqual(withUtf8Ctype({ LANG: 'ko_KR.UTF-8' }, 'win32'), { LANG: 'ko_KR.UTF-8' });
  assert.deepEqual(withUtf8Ctype({ LC_ALL: 'C' }, 'win32'), { LC_ALL: 'C' });
  assert.deepEqual(withUtf8Ctype({}, 'linux'), {});
});
