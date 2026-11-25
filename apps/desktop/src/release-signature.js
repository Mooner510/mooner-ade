import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { releaseKeys } from './release-keys.js';

const fields = ['kind', 'id', 'version', 'platform', 'variant', 'sha256', 'size', 'issued'];

export function statement(artifact) {
  if (!fields.every(key => /^[a-zA-Z0-9._+-]{1,128}$/.test(String(artifact[key] ?? ''))) ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 0 ||
      !Number.isSafeInteger(artifact.issued) || artifact.issued < 1) throw new Error('서명 항목 형식이 올바르지 않습니다.');
  return Buffer.from(['mooner-ade-artifact-v1', ...fields.map(key => `${key}=${artifact[key]}`)].join('\n') + '\n', 'utf8');
}

export function signatureStatus(raw, expected, keys = releaseKeys) {
  if (raw == null) return '서명 없음';
  try {
    const { issued, signature } = JSON.parse(raw);
    if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return '서명 확인 실패';
    const message = statement({ ...expected, issued });
    if (!keys.length) return '공개키 대기';
    return keys.some(pem => {
      const key = createPublicKey(pem);
      return key.asymmetricKeyType === 'ed25519' && verify(null, message, key, Buffer.from(signature, 'base64'));
    }) ? '서명 확인됨' : '서명 확인 실패';
  } catch { return '서명 확인 실패'; }
}

export let lastSignature = '';
let historyFile;
export function loadSignatureStatus(dir) {
  historyFile = join(dir, 'last-release-signature.json');
  try {
    const saved = JSON.parse(readFileSync(historyFile, 'utf8'));
    if (typeof saved === 'string' && saved.length <= 512) lastSignature = saved;
  } catch { /* first observation */ }
}
export function observeSignature(raw, expected) {
  const result = signatureStatus(raw, expected);
  lastSignature = `${expected.id} ${expected.version} · ${result}`;
  if (historyFile) {
    try { writeFileSync(historyFile, JSON.stringify(lastSignature), { mode: 0o600 }); }
    catch { console.warn('서명 확인 결과를 저장하지 못했습니다.'); }
  }
  if (result === '서명 확인됨') console.info(lastSignature);
  else console.warn(lastSignature);
  return lastSignature;
}
