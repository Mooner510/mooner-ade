// Sign an already verified local release directory on the operator's offline machine.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { signatureStatus, statement } from '../apps/desktop/src/release-signature.js';

const [tag, dir, keyFile] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag ?? '') || !dir || !keyFile)
  throw new Error('사용법: node scripts/sign-release.mjs <v버전> <릴리스 디렉터리> <오프라인 PEM 키 파일>');
const key = createPrivateKey(await readFile(keyFile));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 키가 필요합니다.');
const names = await readdir(dir);
if (!names.includes('SHA256SUMS')) throw new Error('검토한 SHA256SUMS가 필요합니다.');
const sums = new Map();
for (const line of (await readFile(path.join(dir, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/)) {
  const match = /^([0-9a-f]{64})\s+\*?([^/\\]+)$/.exec(line);
  if (!match || sums.has(match[2])) throw new Error('SHA256SUMS 형식이 올바르지 않습니다.');
  sums.set(match[2], match[1]);
}
async function verifiedJson(name) {
  const bytes = await readFile(path.join(dir, name));
  if (sums.get(name) !== createHash('sha256').update(bytes).digest('hex')) throw new Error(name + ' 체크섬 불일치');
  return JSON.parse(bytes);
}
const plugins = new Map();
if (names.includes('plugin-releases.json')) {
  const catalog = await verifiedJson('plugin-releases.json');
  if (!Array.isArray(catalog.plugins)) throw new Error('plugin-releases.json 형식이 올바르지 않습니다.');
  for (const { id, version, apiVersion, asset } of catalog.plugins) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(id) || typeof version !== 'string'
      || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) || !Number.isSafeInteger(apiVersion) || apiVersion < 1
      || typeof asset !== 'string' || !/^[a-zA-Z0-9_.-]+\.zip$/.test(asset) || !names.includes(asset) || plugins.has(asset)) {
      throw new Error('plugin-releases.json 항목이 올바르지 않습니다.');
    }
    plugins.set(asset, { id, version });
  }
} else if (names.includes('versions.json')) {
  const versions = await verifiedJson('versions.json');
  const legacy = { 'mooner-ade-remote-plugin.zip': 'mooner-remote', 'mooner-ade-server-shell-plugin.zip': 'server-shell' };
  for (const [asset, id] of Object.entries(legacy)) if (versions[id]) plugins.set(asset, { id, version: versions[id] });
}
const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' });
const signatures = [];
for (const name of names.filter(name => name.endsWith('.zip') || name === 'SHA256SUMS' || sums.has(name))) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path.join(dir, name))) { size += chunk.length; hash.update(chunk); }
  const sha256 = hash.digest('hex');
  if (name !== 'SHA256SUMS' && sums.get(name) !== sha256) throw new Error(name + ' 체크섬 불일치');
  sums.delete(name);
  const app = /^MoonerADE-((?:darwin|win32)-(?:arm64|x64))(-app)?\.zip$/.exec(name);
  const plugin = plugins.get(name);
  let metadata;
  if (app) metadata = { kind: 'app', id: 'mooner-ade', version: tag.slice(1), platform: app[1], variant: app[2] ? 'app' : 'full' };
  else if (plugin) metadata = { kind: 'plugin', ...plugin, platform: 'any', variant: 'zip' };
  else if (name === 'SHA256SUMS') metadata = { kind: 'checksums', id: 'release', version: tag.slice(1), platform: 'any', variant: 'sums' };
  else if (name.endsWith('.zip')) throw new Error('릴리스 목록에서 식별할 수 없는 파일: ' + name);
  else continue;
  const issued = Math.floor(Date.now() / 1000);
  const expected = { ...metadata, sha256, size };
  const signature = sign(null, statement({ ...expected, issued }), key).toString('base64');
  signatures.push({ name, expected, contents: JSON.stringify({ issued, signature }) + '\n' });
}
if (sums.size || !signatures.some(item => item.name.endsWith('.zip'))) throw new Error('릴리스 파일 목록을 확인하세요.');
for (const { name, expected, contents } of signatures) {
  const target = path.join(dir, name + '.sig');
  try { await writeFile(target, contents, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (signatureStatus(await readFile(target, 'utf8'), expected, [publicKey]) !== '서명 확인됨') {
      throw new Error(name + '의 기존 서명을 확인하세요.');
    }
  }
}
