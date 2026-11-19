import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localServerEnv } from '../apps/desktop/src/server-env.js';
import { useBundledTrustStore, useSystemTrustStore } from '../apps/desktop/src/system-trust.js';

test('the local server trusts the OS certificate store only when the switch is on', () => {
  const base = { PATH: '/bin', NODE_USE_SYSTEM_CA: '0' };
  const on = localServerEnv(base, true);
  assert.equal(on.NODE_USE_SYSTEM_CA, '1');
  assert.equal(on.PATH, '/bin');
  assert.equal(base.NODE_USE_SYSTEM_CA, '0', 'the caller environment is left alone');
  assert.equal(localServerEnv({ PATH: '/bin' }, true).NODE_USE_SYSTEM_CA, '1');
  assert.equal('NODE_USE_SYSTEM_CA' in localServerEnv({ PATH: '/bin' }, false), false);
  assert.equal('NODE_USE_SYSTEM_CA' in localServerEnv(base, false), false);
  assert.equal('NODE_USE_SYSTEM_CA' in localServerEnv({ PATH: '/bin', NODE_USE_SYSTEM_CA: '1' }, false), false);
});

test('only the local server spawn receives that environment', () => {
  const main = readFileSync(new URL('../apps/desktop/src/main.js', import.meta.url), 'utf8');
  assert.match(main, /spawn\(nodeBinary, \[serverEntry\], \{ env: localServerEnv\(process\.env, systemCaEnabled\(\)\)/);
  assert.equal(main.includes('NODE_USE_SYSTEM_CA'), false);
  const plugins = readFileSync(new URL('../apps/desktop/src/plugins.js', import.meta.url), 'utf8');
  assert.match(plugins, /localServerEnv\(process\.env, systemCa\(\)\)/);
});

test('the app process adds OS roots the default store does not already have', () => {
  const calls = [];
  const api = {
    getCACertificates: type => type === 'system' ? ['sys-a', 'shared'] : ['bundled', 'shared'],
    setDefaultCACertificates: certs => { calls.push(certs); }
  };
  assert.equal(useSystemTrustStore(api), true);
  assert.deepEqual(calls, [['bundled', 'shared', 'sys-a']]);
  assert.equal(useSystemTrustStore({ getCACertificates: () => ['a'], setDefaultCACertificates: () => { throw new Error('should not set'); } }), false);
  assert.equal(useSystemTrustStore({}), false);
});

test('the switch off puts this process back on the bundled roots', () => {
  const calls = [];
  const api = {
    getCACertificates: type => type === 'bundled' ? ['bundled'] : type === 'extra' ? ['extra', 'bundled'] : ['bundled', 'sys'],
    setDefaultCACertificates: certs => { calls.push(certs); }
  };
  assert.equal(useBundledTrustStore(api), true);
  assert.deepEqual(calls, [['bundled', 'extra']]);
  assert.equal(useBundledTrustStore({ getCACertificates: () => [], setDefaultCACertificates: () => { throw new Error('should not set'); } }), false);
});

test('Hub calls in this process follow the switch, including an inherited system-CA flag', () => {
  const systemCa = readFileSync(new URL('../apps/desktop/src/system-ca.js', import.meta.url), 'utf8');
  assert.match(systemCa, /if \(enabled\(\)\) useSystemTrustStore\(\)/);
  assert.match(systemCa, /else if \(process\.env\.NODE_USE_SYSTEM_CA\) useBundledTrustStore\(\)/);
});
