import { isPluginApiVersion } from './metadata.js';

export function createPluginRegistry(contracts, removed = []) {
  const active = new Map();
  const retired = new Set(removed);
  for (const contract of contracts) {
    const { version, status } = contract;
    if (!isPluginApiVersion(version) || active.has(version) || retired.has(version) || !['supported', 'deprecated'].includes(status)) {
      throw new Error(`Invalid plugin API configuration for ${version}`);
    }
    active.set(version, Object.freeze(contract));
  }
  if (removed.some(version => !isPluginApiVersion(version)) || retired.size !== removed.length) {
    throw new Error('Invalid removed plugin API versions');
  }
  const versions = Object.freeze([...active.keys()].sort((a, b) => a - b));
  const status = version => active.get(version)?.status ?? (retired.has(version) ? 'removed' : 'unsupported');
  const supportedText = versions.length ? versions.map(version => `v${version}`).join(', ') : '없음';
  return Object.freeze({
    versions,
    defaultContract: active.get(versions[0]),
    get: version => active.get(version),
    status,
    describe(version) {
      return status(version) === 'removed'
        ? `플러그인 API v${version} 지원이 종료되었습니다. 지원하는 버전: ${supportedText}.`
        : `플러그인 API v${version}을 지원하지 않습니다. 지원하는 버전: ${supportedText}.`;
    }
  });
}
