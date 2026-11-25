import test from 'node:test';
import assert from 'node:assert/strict';
import { signatureStatus } from '../apps/desktop/src/release-signature.js';

const key = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n";
const artifact = {"kind":"plugin","id":"sample","version":"1.2.3","platform":"any","variant":"zip","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":42};
const signature = "{\"issued\":1700000000,\"signature\":\"/TxdfOoC0PxM+bDHc4Ro0AibHtIsVt4mcvEwvbzpR7Qs4OD9MERQTK7aH1JIrqJUU/OF+Nq32O9SYx4HHjdYBA==\"}";

test('release signature follows the selected artifact and key', () => {
  assert.equal(signatureStatus(signature, artifact, [key]), '서명 확인됨');
  for (const changes of [{ size: 43 }, { sha256: 'b'.repeat(64) }, { version: '1.2.2' }, { id: 'other' }, { variant: 'app' }]) {
    assert.equal(signatureStatus(signature, { ...artifact, ...changes }, [key]), '서명 확인 실패');
  }
  const retired = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA'+Buffer.from('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c','hex').toString('base64')+'\n-----END PUBLIC KEY-----';
  assert.equal(signatureStatus(signature, artifact, [retired]), '서명 확인 실패');
  assert.equal(signatureStatus(signature, artifact, [retired, key]), '서명 확인됨');
  assert.equal(signatureStatus(signature, artifact, []), '공개키 대기');
  assert.equal(signatureStatus(null, artifact, [key]), '서명 없음');
  assert.equal(signatureStatus('{}', artifact, [key]), '서명 확인 실패');
});
