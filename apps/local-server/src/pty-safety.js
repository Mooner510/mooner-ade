// node-pty's Windows terminal rethrows any error of its ConPTY socket (EPIPE, ECONNRESET when a busy terminal exits) unless the
// terminal has a second 'error' listener, and that uncaught throw takes the whole process down with every other terminal.
// The terminal still closes and reports its exit on its own.
// Kept in its own file without imports: the pty-host runs from a copy of only the files it needs (see apps/desktop/src/pty-host-files.js).
export function ignoreSocketErrors(pty) {
  if (typeof pty.on === 'function') pty.on('error', () => {});
}
