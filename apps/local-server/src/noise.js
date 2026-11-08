// Noise Protocol Framework (revision 34), only what remote access needs: the IK and IKpsk2 handshakes over 25519, AES-GCM and
// SHA-256, and a transport channel on top that splits large messages and rekeys. Specified in docs/REMOTE_ACCESS.md; the
// Android app has a second implementation, and both pass the same cacophony test vectors (tests/fixtures/noise-vectors.json).
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, timingSafeEqual } from 'node:crypto';

export const DHLEN = 32;
const HASHLEN = 32, TAGLEN = 16;
export const MAX_NOISE_MESSAGE = 65535;
const MAX_NONCE = 2 ** 53; // the spec allows 2^64-1; a session ends long before either
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const ZEROS = Buffer.alloc(32);

const noiseError = (message, code = 'NOISE_FAILED') => Object.assign(new Error(message), { code });
const privateObject = raw => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const publicObject = raw => createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });

// A key pair as raw 32-byte buffers. With `privateKey` the public half is derived from it (test vectors, stored keys).
export function keyPair(privateKey) {
  if (privateKey) {
    if (privateKey.length !== DHLEN) throw noiseError('X25519 개인키 길이가 올바르지 않습니다.');
    const der = createPublicKey(privateObject(privateKey)).export({ format: 'der', type: 'spki' });
    return { publicKey: Buffer.from(der.subarray(SPKI_X25519.length)), privateKey: Buffer.from(privateKey) };
  }
  const pair = generateKeyPairSync('x25519');
  return {
    publicKey: Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length)),
    privateKey: Buffer.from(pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_X25519.length))
  };
}
// OpenSSL refuses an all-zero result (a low-order public key), which ends the handshake as the spec allows.
function dh(pair, publicKey) {
  if (publicKey.length !== DHLEN) throw noiseError('X25519 공개키 길이가 올바르지 않습니다.');
  try { return diffieHellman({ privateKey: privateObject(pair.privateKey), publicKey: publicObject(publicKey) }); }
  catch { throw noiseError('키 교환에 실패했습니다.'); }
}
const hash = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const hmac = (key, ...parts) => createHmac('sha256', key).update(Buffer.concat(parts)).digest();
function hkdf(chainingKey, input, outputs) {
  const temp = hmac(chainingKey, input), out = [];
  let previous = Buffer.alloc(0);
  for (let index = 1; index <= outputs; index++) { previous = hmac(temp, previous, Buffer.from([index])); out.push(previous); }
  return out;
}
function nonceBytes(n) {
  const nonce = Buffer.alloc(12);
  if (n === 'max') nonce.fill(0xff, 4); else nonce.writeBigUInt64BE(BigInt(n), 4);
  return nonce;
}
function aesEncrypt(key, n, ad, plaintext) {
  const cipher = createCipheriv('aes-256-gcm', key, nonceBytes(n));
  cipher.setAAD(ad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
function aesDecrypt(key, n, ad, ciphertext) {
  if (ciphertext.length < TAGLEN) throw noiseError('메시지가 너무 짧습니다.');
  const decipher = createDecipheriv('aes-256-gcm', key, nonceBytes(n));
  decipher.setAAD(ad); decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAGLEN));
  try { return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAGLEN)), decipher.final()]); }
  catch { throw noiseError('메시지 인증에 실패했습니다.'); }
}

export class CipherState {
  constructor(key = null) { this.key = key; this.n = 0; }
  hasKey() { return this.key !== null; }
  #next() { if (this.n >= MAX_NONCE) throw noiseError('nonce를 모두 썼습니다.'); return this.n++; }
  encrypt(ad, plaintext) { return this.key ? aesEncrypt(this.key, this.#next(), ad, plaintext) : Buffer.from(plaintext); }
  // A failed decryption does not use up the nonce, as the spec requires; the channel closes on it anyway.
  decrypt(ad, ciphertext) {
    if (!this.key) return Buffer.from(ciphertext);
    if (this.n >= MAX_NONCE) throw noiseError('nonce를 모두 썼습니다.');
    const plaintext = aesDecrypt(this.key, this.n, ad, ciphertext); this.n++;
    return plaintext;
  }
  rekey() { this.key = aesEncrypt(this.key, 'max', Buffer.alloc(0), ZEROS).subarray(0, 32); }
}

class SymmetricState {
  constructor(protocolName) {
    const name = Buffer.from(protocolName, 'ascii');
    this.h = name.length <= HASHLEN ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)]) : hash(name);
    this.ck = this.h; this.cipher = new CipherState();
  }
  mixKey(input) { const [ck, key] = hkdf(this.ck, input, 2); this.ck = ck; this.cipher = new CipherState(key); }
  mixHash(data) { this.h = hash(this.h, data); }
  mixKeyAndHash(input) { const [ck, temp, key] = hkdf(this.ck, input, 3); this.ck = ck; this.mixHash(temp); this.cipher = new CipherState(key); }
  encryptAndHash(plaintext) { const out = this.cipher.encrypt(this.h, plaintext); this.mixHash(out); return out; }
  decryptAndHash(ciphertext) { const out = this.cipher.decrypt(this.h, ciphertext); this.mixHash(ciphertext); return out; }
  split() { const [a, b] = hkdf(this.ck, Buffer.alloc(0), 2); return [new CipherState(a), new CipherState(b)]; }
}

// IK:      <- s / ... / -> e, es, s, ss / <- e, ee, se
// IKpsk2:  the same, with psk after se (a pre-shared key both sides hold; for pairing it comes from the QR code).
const PATTERN = [['e', 'es', 's', 'ss'], ['e', 'ee', 'se']];

// One handshake. `s` is this side's static key pair; the initiator also needs `rs`, the responder's static public key
// (from the QR code). `e` is only for test vectors. After both messages `split()` gives the transport ciphers.
export function createHandshake({ initiator, prologue = Buffer.alloc(0), s, rs = null, psk = null, e = null }) {
  if (psk !== null && psk.length !== 32) throw noiseError('psk 길이가 올바르지 않습니다.');
  if (initiator && !rs) throw noiseError('응답자 공개키가 필요합니다.');
  const state = new SymmetricState(`Noise_IK${psk ? 'psk2' : ''}_25519_AESGCM_SHA256`);
  state.mixHash(prologue);
  // Pre-message: the responder's static key, which the initiator already knows.
  state.mixHash(initiator ? rs : s.publicKey);
  let remoteStatic = initiator ? Buffer.from(rs) : null, remoteEphemeral = null, ephemeral = e, step = 0, done = false;
  const tokens = index => psk && index === 1 ? [...PATTERN[1], 'psk'] : PATTERN[index];
  // Which DH a token means depends on the side: "es" is initiator-ephemeral with responder-static.
  const mix = token => {
    if (token === 'ee') state.mixKey(dh(ephemeral, remoteEphemeral));
    else if (token === 'ss') state.mixKey(dh(s, remoteStatic));
    else if (token === 'es') state.mixKey(initiator ? dh(ephemeral, remoteStatic) : dh(s, remoteEphemeral));
    else if (token === 'se') state.mixKey(initiator ? dh(s, remoteEphemeral) : dh(ephemeral, remoteStatic));
    else if (token === 'psk') state.mixKeyAndHash(psk);
  };
  const writes = () => (step === 0) === initiator;
  return {
    get complete() { return done; },
    get remoteStatic() { return remoteStatic; },
    get handshakeHash() { return state.h; },
    writeMessage(payload = Buffer.alloc(0)) {
      if (done || !writes()) throw noiseError('지금은 보낼 차례가 아닙니다.');
      const parts = [];
      for (const token of tokens(step)) {
        if (token === 'e') {
          ephemeral ??= keyPair();
          parts.push(ephemeral.publicKey); state.mixHash(ephemeral.publicKey);
          if (psk) state.mixKey(ephemeral.publicKey);
        } else if (token === 's') parts.push(state.encryptAndHash(s.publicKey));
        else mix(token);
      }
      parts.push(state.encryptAndHash(payload));
      const message = Buffer.concat(parts);
      if (message.length > MAX_NOISE_MESSAGE) throw noiseError('handshake 메시지가 너무 큽니다.');
      if (++step === 2) done = true;
      return message;
    },
    readMessage(message) {
      if (done || writes()) throw noiseError('지금은 받을 차례가 아닙니다.');
      if (message.length > MAX_NOISE_MESSAGE) throw noiseError('handshake 메시지가 너무 큽니다.');
      let offset = 0;
      const take = length => { if (offset + length > message.length) throw noiseError('handshake 메시지가 잘렸습니다.'); const part = message.subarray(offset, offset + length); offset += length; return part; };
      for (const token of tokens(step)) {
        if (token === 'e') {
          remoteEphemeral = Buffer.from(take(DHLEN)); state.mixHash(remoteEphemeral);
          if (psk) state.mixKey(remoteEphemeral);
        } else if (token === 's') remoteStatic = state.decryptAndHash(take(state.cipher.hasKey() ? DHLEN + TAGLEN : DHLEN));
        else mix(token);
      }
      const payload = state.decryptAndHash(message.subarray(offset));
      if (++step === 2) done = true;
      return payload;
    },
    // [initiator→responder, responder→initiator] ciphers, as { send, receive } for this side.
    split() {
      if (!done) throw noiseError('handshake가 끝나지 않았습니다.');
      const [first, second] = state.split();
      return initiator ? { send: first, receive: second } : { send: second, receive: first };
    }
  };
}

// The transport channel: one application message (any size up to `maxMessage`) is one or more Noise messages, each starting
// with a flag byte. FINAL marks the last part; REKEY asks the receiver to rekey its cipher right after this part, which the
// sender does too. The sender rekeys every `rekeyMessages` messages or `rekeyMs`, whichever comes first.
const FINAL = 1, REKEY = 2;
export const MAX_CHUNK = MAX_NOISE_MESSAGE - TAGLEN - 1;
export function createChannel({ send, receive }, { maxMessage = 32 * 1024 * 1024, rekeyMessages = 2 ** 20, rekeyMs = 60 * 60_000, now = Date.now } = {}) {
  let sentSinceRekey = 0, rekeyedAt = now(), parts = [], partsSize = 0;
  const EMPTY = Buffer.alloc(0);
  return {
    // Returns the Noise messages to send, in order.
    seal(message) {
      if (message.length > maxMessage) throw noiseError('메시지가 너무 큽니다.', 'MESSAGE_TOO_LARGE');
      const out = [];
      for (let offset = 0; offset === 0 || offset < message.length; offset += MAX_CHUNK) {
        const chunk = message.subarray(offset, offset + MAX_CHUNK), last = offset + MAX_CHUNK >= message.length;
        const rekey = ++sentSinceRekey >= rekeyMessages || now() - rekeyedAt >= rekeyMs;
        out.push(send.encrypt(EMPTY, Buffer.concat([Buffer.from([(last ? FINAL : 0) | (rekey ? REKEY : 0)]), chunk])));
        if (rekey) { send.rekey(); sentSinceRekey = 0; rekeyedAt = now(); }
        if (last) break;
      }
      return out;
    },
    // Returns the whole application message once its last part arrives, otherwise null. Any error means the peer is broken
    // or hostile and the connection must be closed.
    open(noiseMessage) {
      if (noiseMessage.length > MAX_NOISE_MESSAGE) throw noiseError('메시지가 너무 큽니다.', 'MESSAGE_TOO_LARGE');
      const record = receive.decrypt(EMPTY, noiseMessage);
      if (!record.length || record[0] & ~(FINAL | REKEY)) throw noiseError('잘못된 메시지입니다.');
      const flags = record[0];
      if (flags & REKEY) receive.rekey();
      partsSize += record.length - 1;
      if (partsSize > maxMessage) throw noiseError('메시지가 너무 큽니다.', 'MESSAGE_TOO_LARGE');
      parts.push(record.subarray(1));
      if (!(flags & FINAL)) return null;
      const message = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      parts = []; partsSize = 0;
      return message;
    }
  };
}

// A short, comparable fingerprint of a static public key, shown on both the PC and the phone when pairing.
export function fingerprint(publicKey) {
  const hex = hash(Buffer.from('mooner-ade key v1'), publicKey).subarray(0, 8).toString('hex').toUpperCase();
  return hex.match(/.{4}/g).join('-');
}
// The pairing psk, derived from the QR code's secret so the secret itself never travels.
export const pairingPsk = secret => hkdf(hash(Buffer.from('mooner-ade pair v1')), secret, 1)[0];
export const sameKey = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b);
// Binds the handshake to the protocol version, the pattern, the transport and the host, so none can be swapped in transit.
export const prologue = ({ pattern, transport, hostId }) => Buffer.from(`mooner-ade.v1|${pattern}|${transport}|${hostId}`, 'utf8');
