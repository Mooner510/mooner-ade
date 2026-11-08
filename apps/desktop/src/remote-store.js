// Remote access settings, owned by the main process: whether it is on, the account link (Hub tokens), this PC's Noise key and
// the paired phones. Sealed with Electron's safeStorage (DPAPI on Windows, Keychain on macOS) in <userData>/remote.bin.
// Without working encryption, or with a file that does not open, remote access stays off; nothing is ever stored in the clear.
// Kept free of Electron so it can be tested: `crypto` is safeStorage or a stand-in.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEVICE_EXPIRY_MS = 90 * 24 * 60 * 60_000;
export const DEFAULT_HUB_URL = 'https://ade-hub.mooner510.kr';
const SCOPES = ['view', 'control'];

export const emptyState = () => ({ version: 1, enabled: false, hubUrl: null, account: null, tokens: null, hostId: null, hostKey: null, devices: [] });

// Only known fields of known shapes survive a load; a device entry that is not exactly right is dropped, not repaired.
export function validState(value) {
  const state = emptyState();
  if (!value || typeof value !== 'object' || value.version !== 1) return state;
  const str = (item, max = 4096) => typeof item === 'string' && item.length > 0 && item.length <= max;
  if (str(value.hubUrl, 512)) state.hubUrl = value.hubUrl;
  if (value.account && str(value.account.id, 128)) state.account = { id: value.account.id, name: String(value.account.name ?? '').slice(0, 200), email: String(value.account.email ?? '').slice(0, 320) };
  if (value.tokens && str(value.tokens.access) && str(value.tokens.refresh) && Number.isFinite(value.tokens.accessExpiresAt)) state.tokens = { access: value.tokens.access, refresh: value.tokens.refresh, accessExpiresAt: value.tokens.accessExpiresAt };
  if (str(value.hostId, 64) && /^[\w-]+$/.test(value.hostId)) state.hostId = value.hostId;
  if (value.hostKey && str(value.hostKey.privateKey, 64) && str(value.hostKey.publicKey, 64)) state.hostKey = { privateKey: value.hostKey.privateKey, publicKey: value.hostKey.publicKey };
  if (Array.isArray(value.devices)) state.devices = value.devices.filter(device =>
    device && str(device.id, 64) && /^[\w-]+$/.test(device.id) && str(device.key, 64) && SCOPES.includes(device.scope) && Number.isFinite(device.addedAt)
  ).map(device => ({ id: device.id, name: String(device.name ?? '').slice(0, 80), key: device.key, scope: device.scope, addedAt: device.addedAt, lastSeenAt: Number.isFinite(device.lastSeenAt) ? device.lastSeenAt : null }));
  // On only with everything it needs; a half-linked state stays off.
  state.enabled = value.enabled === true && Boolean(state.account && state.tokens && state.hostId && state.hostKey);
  return state;
}

// Phones not used for 90 days lose their pairing and must scan a new QR.
export function expireDevices(state, now = Date.now()) {
  const devices = state.devices.filter(device => now - (device.lastSeenAt ?? device.addedAt) < DEVICE_EXPIRY_MS);
  return devices.length === state.devices.length ? state : { ...state, devices };
}

// What the server child process gets over IPC. The refresh token never leaves the main process.
export function childConfig(state, { pairing = null, host = {} } = {}) {
  if (!state.enabled || !state.tokens || !state.hostKey || !state.hostId || !state.hubUrl) return { enabled: false };
  return {
    enabled: true, hubUrl: state.hubUrl, accessToken: state.tokens.access, hostId: state.hostId,
    hostKey: { privateKey: state.hostKey.privateKey }, host,
    devices: state.devices.map(({ id, name, key, scope }) => ({ id, name, key, scope })),
    pairing: pairing && pairing.expiresAt > Date.now() ? { id: pairing.id, psk: pairing.psk, expiresAt: pairing.expiresAt } : null
  };
}

// What the settings page may see: no keys, no tokens.
export function publicState(state) {
  return {
    enabled: state.enabled, hubUrl: state.hubUrl, linked: Boolean(state.account && state.tokens),
    account: state.account && { name: state.account.name, email: state.account.email },
    hostId: state.hostId,
    devices: state.devices.map(({ id, name, scope, addedAt, lastSeenAt }) => ({ id, name, scope, addedAt, lastSeenAt }))
  };
}

export function createRemoteStore({ file, crypto }) {
  let state = emptyState(), problem = null;
  return {
    get state() { return state; },
    // 'unavailable': the OS offers no encryption here; 'unreadable': the file exists but does not open (another user, a reinstalled OS).
    get problem() { return problem; },
    get available() { return crypto.isEncryptionAvailable(); },
    load() {
      problem = null;
      if (!crypto.isEncryptionAvailable()) { problem = 'unavailable'; state = emptyState(); return state; }
      let sealed;
      try { sealed = fs.readFileSync(file); } catch (error) { if (error.code !== 'ENOENT') problem = 'unreadable'; state = emptyState(); return state; }
      try { state = validState(JSON.parse(crypto.decryptString(sealed))); }
      catch { problem = 'unreadable'; state = emptyState(); }
      return state;
    },
    // Written to a temporary file first, so a crash leaves the old settings rather than half of the new ones.
    save(next) {
      if (!crypto.isEncryptionAvailable()) throw Object.assign(new Error('이 컴퓨터에서는 설정을 안전하게 암호화할 수 없어 원격 접속을 쓸 수 없습니다.'), { code: 'ENCRYPTION_UNAVAILABLE' });
      const value = validState(next), sealed = crypto.encryptString(JSON.stringify(value));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      try { fs.writeFileSync(tmp, sealed, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
      finally { fs.rmSync(tmp, { force: true }); }
      state = value; problem = null;
      return state;
    },
    update(change) { return this.save(change(state)); }
  };
}

// One JSON line per event in <userData>/remote-audit.log, rotated to .1 at 2 MB.
export function createAuditLog(file, { maxBytes = 2 * 1024 * 1024 } = {}) {
  return entry => {
    try {
      const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (size > maxBytes) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (error) { console.warn(`원격 접속 기록을 남기지 못했습니다: ${error.message}`); }
  };
}
