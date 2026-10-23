// The replay buffer keeps only the tail of a terminal's output, but full-screen TUIs (turbo, vim, htop…) switch the
// alternate screen and mouse reporting on once at startup. Once that falls off the front, a replay leaves xterm on the
// normal screen with mouse reporting off: the wheel scrolls xterm's scrollback and drags select across the TUI's panes.
// So the private modes in effect where the kept tail starts are tracked and restored in front of it.

// Modes that replace each other: xterm keeps one active mouse protocol, mouse encoding and screen, and resetting any
// member of a group turns the group off.
const GROUPS = { 9: 'mouse', 1000: 'mouse', 1002: 'mouse', 1003: 'mouse', 1005: 'encoding', 1006: 'encoding', 1015: 'encoding', 47: 'screen', 1047: 'screen', 1049: 'screen' };
// Independent flags with their power-on values: cursor keys, autowrap, cursor visible, focus reports, bracketed paste.
const FLAGS = { 1: false, 7: true, 25: true, 1004: false, 2004: false };

export function createModeTracker() {
  let groups, flags, state = 0, params = '';
  const reset = () => { groups = { screen: 0, mouse: 0, encoding: 0 }; flags = { ...FLAGS }; };
  const apply = (mode, on) => {
    if (GROUPS[mode]) groups[GROUPS[mode]] = on ? mode : 0;
    else if (mode in FLAGS) flags[mode] = on;
  };
  reset();
  return {
    // Sequences may arrive split across chunks, so the parser state carries over between calls.
    feed(data) {
      for (const char of data) {
        if (state === 1) state = char === '[' ? 2 : char === '\x1b' ? 1 : (char === 'c' && reset(), 0); // ESC c: full reset
        else if (state === 2) { state = char === '?' ? 3 : char === '\x1b' ? 1 : 0; params = ''; }
        else if (state === 3) {
          if (/[0-9;]/.test(char) && params.length < 64) { params += char; continue; }
          if (char === 'h' || char === 'l') for (const mode of params.split(';')) apply(Number(mode), char === 'h');
          state = char === '\x1b' ? 1 : 0;
        } else if (char === '\x1b') state = 1;
      }
    },
    // The sequences that bring a freshly reset terminal into the tracked modes; empty when nothing changed.
    preamble() {
      let result = groups.screen ? `\x1b[?${groups.screen}h` : '';
      for (const [mode, on] of Object.entries(flags)) if (on !== FLAGS[mode]) result += `\x1b[?${mode}${on ? 'h' : 'l'}`;
      for (const mode of [groups.mouse, groups.encoding]) if (mode) result += `\x1b[?${mode}h`;
      return result;
    }
  };
}

// The last `limit` characters of output, replayed with the modes that were in effect where they start.
export function createTerminalBuffer(limit = 262144, initial = '') {
  const head = createModeTracker();
  let tail = '';
  const append = data => {
    tail += data;
    if (tail.length > limit) { head.feed(tail.slice(0, tail.length - limit)); tail = tail.slice(-limit); }
  };
  append(initial);
  return { append, get text() { return head.preamble() + tail; } };
}
