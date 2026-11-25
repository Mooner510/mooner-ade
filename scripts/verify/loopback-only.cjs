// Preloaded (NODE_OPTIONS=--require=…) into every Node process of the phone <-> PC end-to-end rig (t-phone-e2e.mjs): a socket may only connect to this
// machine. Anything else (the npm registry check of the Claude Code update notice, a usage API, GitHub, the real Hub) is refused before DNS or TCP happen,
// and written to $PHONE_E2E_GUARD_LOG, so a rig run cannot reach beyond loopback whatever a feature tries, and the log shows what tried.
'use strict';
const net = require('node:net');
const fs = require('node:fs');
const original = net.Socket.prototype.connect;
const local = host => !host || host === 'localhost' || host === '::1' || host === '[::1]' || host === '0.0.0.0' || host === '::' || /^127(\.\d{1,3}){3}$/.test(host);
const record = text => { try { if (process.env.PHONE_E2E_GUARD_LOG) fs.appendFileSync(process.env.PHONE_E2E_GUARD_LOG, `${new Date().toISOString()} pid ${process.pid} ${text}\n`); } catch { /* the refusal is what matters */ } };
net.Socket.prototype.connect = function connect(...args) {
  let options;
  try { [options] = net._normalizeArgs(args); } catch { return original.apply(this, args); }
  if (options.path || local(options.host)) return original.apply(this, args);
  const target = `${options.host}:${options.port}`;
  record(`blocked ${target}`);
  process.nextTick(() => this.destroy(Object.assign(new Error(`loopback-only rig: connection to ${target} refused`), { code: 'ECONNREFUSED' })));
  return this;
};
