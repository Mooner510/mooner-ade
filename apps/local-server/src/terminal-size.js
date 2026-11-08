// One PTY, several viewers (the app window and each plugin workspace session): the PTY has one size, and it follows the
// viewer that typed last. Every viewer reports the size it would like (`want`); it is applied at once only for the viewer
// that owns the size, or when nobody does. Typing from another viewer makes that viewer the owner and switches the PTY to
// its size before the input is written, so the program draws for the screen the input came from.
// `size` is null when it is unknown (a terminal kept from an older pty-host); the next applied size makes it known.
export function createTerminalSize(native, size, onChange) {
  let owner = null;
  const wants = new Map();
  const apply = ({ cols, rows }) => {
    if (size && size.cols === cols && size.rows === rows) return;
    native.resize(cols, rows);
    size = { cols, rows };
    onChange(size);
  };
  return {
    get size() { return size; },
    get owner() { return owner; },
    // `claim` takes the size even while another viewer owns it (a "fit to this window" button).
    want(client, cols, rows, claim = false) {
      const want = { cols, rows };
      wants.set(client, want);
      if (claim || !owner || owner === client) { owner = client; apply(want); }
    },
    // Called before `client`'s input reaches the PTY.
    input(client) {
      if (owner === client) return;
      owner = client;
      const want = wants.get(client);
      if (want) apply(want);
    },
    // The viewer left (closed or unsubscribed): its wish goes, and so does its ownership. The size stays as it is.
    release(client) {
      wants.delete(client);
      if (owner === client) owner = null;
    }
  };
}

export const validSize = value => value && [value.cols, value.rows].every(n => Number.isInteger(n) && n >= 1 && n <= 1000) ? { cols: value.cols, rows: value.rows } : null;

// What a terminal view sends on its own, not because someone typed: answers to the program's queries (every connected view
// answers them), focus in/out, and mouse movement without a button. These must not move the size to that view, or two devices
// would take it from each other on every query.
const AUTOMATIC = /^(?:\x1b\[[?>=]?[\d;]*(?:c|R|n|\$y|t)|\x1b\[\?[\d;]*u|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b\[[IO]|\x1b\[<(?:35|39|43|47|51|55|59|63);\d+;\d+M)+$/;
export const typedInput = data => !AUTOMATIC.test(data);
