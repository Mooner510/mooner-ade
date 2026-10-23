import test from 'node:test';
import assert from 'node:assert/strict';
import { createModeTracker, createTerminalBuffer } from '../apps/local-server/src/terminal-buffer.js';

test('a replay that lost the start of a TUI restores its screen, mouse and cursor modes', () => {
  const buffer = createTerminalBuffer(16);
  buffer.append('$ turbo dev\r\n\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h\x1b[?25l');
  buffer.append('x'.repeat(100) + 'latest frame');
  assert.equal(buffer.text, '\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h' + 'xxxxlatest frame');
});

test('an untruncated buffer replays as is, and modes the TUI turned off again are not restored', () => {
  const buffer = createTerminalBuffer(16, 'prompt$ ');
  assert.equal(buffer.text, 'prompt$ ');
  buffer.append('\x1b[?1049h\x1b[?1000;1006h\x1b[?2004h');
  buffer.append('\x1b[?1006l\x1b[?1000l\x1b[?1049l' + 'y'.repeat(40));
  assert.equal(buffer.text, '\x1b[?2004h' + 'y'.repeat(16));
});

test('mode sequences split across chunks and a full reset are tracked', () => {
  const tracker = createModeTracker();
  for (const char of '\x1b[?1049;1003h\x1b[?1h') tracker.feed(char);
  assert.equal(tracker.preamble(), '\x1b[?1049h\x1b[?1h\x1b[?1003h');
  tracker.feed('\x1b[1;5H\x1b[?xh plain ? text h');
  assert.equal(tracker.preamble(), '\x1b[?1049h\x1b[?1h\x1b[?1003h');
  tracker.feed('\x1bc');
  assert.equal(tracker.preamble(), '');
});
