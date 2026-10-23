import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createWakaTime, findWakaTimeCli, heartbeatArgs, pluginName, PULSE } from '../apps/local-server/src/wakatime.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  let clock = 1_000_000;
  const calls = [];
  const wakatime = createWakaTime({ version: '1.2.3', find: () => '/cli', run: async (file, args) => { calls.push(args); return ''; }, now: () => clock });
  return { wakatime, calls, advance(ms) { clock += ms; } };
}

test('the ~/.wakatime install wins over PATH, and the platform build name is mapped', () => {
  const home = '/home/u', bin = '/usr/bin';
  const found = new Set([path.join(home, '.wakatime', 'wakatime-cli-linux-amd64'), path.join(bin, 'wakatime-cli')]);
  assert.equal(findWakaTimeCli({ home, platform: 'linux', arch: 'x64', env: { PATH: bin }, exists: file => found.has(file) }), path.join(home, '.wakatime', 'wakatime-cli-linux-amd64'));
  assert.equal(findWakaTimeCli({ home, platform: 'win32', arch: 'x64', env: { Path: bin }, exists: file => file === path.join(bin, 'wakatime-cli.exe') }), path.join(bin, 'wakatime-cli.exe'));
  assert.equal(findWakaTimeCli({ home, platform: 'darwin', arch: 'arm64', env: {}, exists: () => false }), null);
});

test('heartbeat arguments carry the app entity, project fallback and write flag', () => {
  assert.deepEqual(heartbeatArgs({ entity: 'MoonerADE', entityType: 'app', folder: '/p/demo', project: 'demo', category: 'ai coding', plugin: 'x/1' }),
    ['--entity', 'MoonerADE', '--entity-type', 'app', '--category', 'ai coding', '--plugin', 'x/1', '--project-folder', '/p/demo', '--alternate-project', 'demo']);
  assert.deepEqual(heartbeatArgs({ entity: '/p/a.ts', write: true, plugin: 'x/1' }), ['--entity', '/p/a.ts', '--entity-type', 'file', '--category', 'coding', '--plugin', 'x/1', '--write']);
});

test('nothing is sent until enabled, and repeats of the same activity wait for the pulse', async () => {
  const { wakatime, calls, advance } = harness();
  const beat = { entity: 'MoonerADE', entityType: 'app', folder: '/p' };
  assert.equal(wakatime.heartbeat(beat), false);
  wakatime.configure(true);
  assert.equal(wakatime.heartbeat(beat), true); await tick();
  assert.equal(wakatime.heartbeat(beat), false);
  assert.equal(wakatime.heartbeat({ ...beat, category: 'ai coding' }), true, 'a category change is new activity'); await tick();
  advance(PULSE);
  assert.equal(wakatime.heartbeat({ ...beat, category: 'ai coding' }), true); await tick();
  assert.equal(wakatime.heartbeat({ entity: '/p/a.ts', write: true }), true);
  assert.equal(wakatime.heartbeat({ entity: '/p/a.ts', write: true }), true, 'saves are never throttled');
  assert.equal(wakatime.heartbeat({ ...beat, category: 'ai coding', force: true }), true, 'forced turns skip the pulse');
  assert.equal(calls.length, 6);
  assert.ok(calls[0].includes('MoonerADE/1.2.3 MoonerADE-wakatime/1.2.3'));
});

test('the plugin name keeps its case, which WakaTime shows as the editor name', () => {
  assert.equal(pluginName('0.1.0').split(' ')[0], 'MoonerADE/0.1.0');
});

test('status masks the API key and config writes are validated before reaching the CLI', async () => {
  const calls = [];
  const values = { api_key: 'waka_12345678-1234-1234-1234-1234567890ab' };
  const wakatime = createWakaTime({ version: '1', find: () => '/cli', run: async (file, args) => {
    calls.push(args);
    if (args[0] === '--config-read') { if (!values[args[1]]) throw Object.assign(new Error('missing'), { code: 110 }); return `${values[args[1]]}\n`; }
    if (args[0] === '--today') return '1 hr 2 mins\n';
    return '';
  } });
  let status = await wakatime.status();
  assert.equal(status.apiKey, '••••••••90ab'); assert.equal(status.apiUrl, ''); assert.equal(status.today, '', 'today is only fetched while enabled');
  wakatime.configure(true);
  assert.equal((await wakatime.status()).today, '1 hr 2 mins');
  await assert.rejects(wakatime.writeConfig({ apiKey: 'nope' }), /API 키/);
  await assert.rejects(wakatime.writeConfig({ apiUrl: 'ftp://x' }), /API 주소/);
  await wakatime.writeConfig({ apiKey: ' 12345678-1234-1234-1234-1234567890ab ', apiUrl: 'https://wakapi.local/api' });
  assert.deepEqual(calls.filter(args => args[0] === '--config-write'), [['--config-write', 'api_key=12345678-1234-1234-1234-1234567890ab'], ['--config-write', 'api_url=https://wakapi.local/api']]);
  values.api_url = 'https://wakapi.local/api';
  status = await wakatime.status();
  assert.equal(status.apiUrl, 'https://wakapi.local/api', 'a write drops the cached config');
});

test('a missing CLI and CLI failures are reported in status', async () => {
  let cli = null;
  const wakatime = createWakaTime({ version: '1', find: () => cli, run: async () => { throw Object.assign(new Error('API 키가 올바르지 않습니다.'), { code: 104 }); } });
  wakatime.configure(true);
  assert.equal(wakatime.heartbeat({ entity: 'MoonerADE', entityType: 'app' }), false);
  assert.match((await wakatime.status()).lastError, /wakatime-cli/);
  cli = '/cli'; wakatime.configure(false); wakatime.configure(true);
  assert.equal(wakatime.heartbeat({ entity: 'MoonerADE', entityType: 'app' }), true); await tick(); await tick();
  const status = await wakatime.status();
  assert.equal(status.lastError, 'API 키가 올바르지 않습니다.');
  assert.equal(status.lastSent, 0);
});
