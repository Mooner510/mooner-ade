// The pty-host wire protocol version (apps/local-server/src/pty-host.js). Raise it only for a change an older app or server cannot
// handle. A newer app must keep working with an older host: an update hands the running host (old code) to the new app.
// 1: started by the app over IPC and ended with it (dev only). 2: detached, owner/control roles, linger, hello reply.
export const PTY_PROTOCOL = 2;
export const PTY_MIN_PROTOCOL = 2;
export const ptyProtocolSupported = protocol => Number.isInteger(protocol) && protocol >= PTY_MIN_PROTOCOL;
